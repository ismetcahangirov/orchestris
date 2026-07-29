import {
  MAX_WORKFLOW_EXECUTIONS,
  type Runner,
  type TaskStep,
  type WorkflowStep,
} from '@orchestris/shared'
import type { Db } from '../db/client.js'
import { createTask, listEvents, listRunsForTask } from '../db/repo.js'
import {
  createWorkflowRun,
  finishStepRun,
  finishWorkflowRun,
  startStepRun,
} from '../db/workflow-repo.js'
import type { BudgetLimits } from './budget.js'
import type { Decomposer } from './decomposer.js'
import { collectAnswerText } from './escalation.js'
import { RemainingBudget, type Ladder, type LadderContext } from './ladder.js'
import type { TaskPool } from './pool.js'
import {
  capOutput,
  describeStep,
  evaluateCondition,
  substituteVariables,
  type StepResult,
} from './workflow.js'
import { executeHttpStep, readHttpAllowList, type HttpAllowList } from './workflow-http.js'
import { resolveMaxParallel } from './worktree.js'

/**
 * Workflow zəncirlərinin icra motoru (Faza 4).
 *
 * `Decomposer` bir taskı N taska bölür; `WorkflowEngine` isə ƏVVƏLCƏDƏN yazılmış
 * N addımı sıra ilə qaçırır və hər addımın çıxışını növbətinin girişinə verir.
 * İkisi eyni qatdadır və hər ikisi nərdivana TOXUNMUR — hər addım tam
 * nərdivandan (keş, routing, alət yoxlaması, best-of-N, eskalasiya) keçir.
 *
 * DÖRD QƏRAR BÜTÜN DAVRANIŞI İZAH EDİR:
 *
 * 1. **Zəncirin öz məntiqi 0 token xərcləyir.** Şərtlər determinist
 *    predikatlardır (`workflow.ts`), dəyişən əvəzlənməsi isə mətn əməliyyatıdır.
 *    "Növbəti addıma keçək?" sualını modelə versəydik, zəncir uzandıqca
 *    orkestrasiya xərci taskların öz xərcini üstələyərdi.
 * 2. **Sınıq addım zənciri DAYANDIRIR** (`continueOnError` ilə açıq şəkildə
 *    ləğv edilməsə). Əks default sınmış birinci addımdan sonra qalan bütün
 *    addımların pulunu zibil giriş üzərində yandırardı.
 * 3. **Büdcə addımlar ARASINDA paylaşılır.** Hər addım limiti təzədən alsaydı,
 *    on addımlı zəncir limitin on mislini xərcləyə bilərdi (eyni səbəb:
 *    qayda 53).
 * 4. **İzolyasiya SÖNDÜRÜLÜR.** Addımlar asılıdır: 2-ci addım 1-cinin yazdığı
 *    faylı görməlidir. Hər addıma ayrıca worktree açılsaydı, hər addımın işi öz
 *    `pending` diff-ində qalar və növbəti addım köhnə kod görərdi.
 */

export interface WorkflowRunInput {
  workflowId: string
  steps: readonly WorkflowStep[]
  context: LadderContext
  trigger: 'manual' | 'schedule'
  /** Birinci addımın `{{previous}}` başlanğıc dəyəri. */
  input?: string
  limits?: BudgetLimits
  /** Əl ilə işçi seçimi — verilməsə hər addım Auto (Pillə 1) ilə gedir. */
  runner?: Runner
  model?: string
}

export interface WorkflowRunResult {
  workflowRunId: string
  status: 'succeeded' | 'failed' | 'budget_exceeded'
  steps: StepResult[]
  /** Son icra olunmuş addımın çıxışı — zəncirin "cavabı". */
  output: string
  error?: string
}

/** Bir addım icrasının xam nəticəsi — `task` və `http` yolları üçün ortaq. */
interface StepOutcome {
  status: StepResult['status']
  output: string
  /** Model addımında yaradılan task. HTTP addımında yoxdur. */
  taskId?: string
  detail?: string
}

export interface WorkflowEngineDeps {
  db: Db
  ladder: Ladder
  decomposer?: Decomposer
  pool?: TaskPool
  /** Testlərdə şəbəkəyə çıxmamaq üçün. */
  fetchImpl?: typeof fetch
  /** Verilməsə env-dən oxunur (fail-closed — `workflow-http.ts`). */
  allow?: HttpAllowList
}

export class WorkflowEngine {
  private readonly db: Db

  constructor(private readonly deps: WorkflowEngineDeps) {
    this.db = deps.db
  }

  /**
   * İcranı başladır və `workflow_runs` sətrinin id-sini DƏRHAL qaytarır.
   *
   * NİYƏ İKİ HİSSƏ: zəncir onlarla dəqiqə çəkə bilər, `POST .../run` isə `202`
   * (qəbul edildi) qaytarmalıdır. Sətir id-si üçün icranın bitməsini
   * gözləsəydik, brauzer asılı qalar və `202`-nin mənası itərdi. Sətir sinxron
   * yaradılır, ona görə id üçün heç bir gözləmə/yoxlama dövrəsi lazım deyil.
   */
  start(input: WorkflowRunInput): {
    workflowRunId: string
    done: Promise<WorkflowRunResult>
  } {
    const run = createWorkflowRun(this.db, {
      workflowId: input.workflowId,
      trigger: input.trigger,
      stepsJson: JSON.stringify(input.steps),
    })
    return { workflowRunId: run.id, done: this.execute(run.id, input) }
  }

  /** Bütün zənciri qaçırıb nəticəni qaytarır (testlər və cədvəl icrası üçün). */
  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    return this.start(input).done
  }

  private async execute(
    runId: string,
    input: WorkflowRunInput,
  ): Promise<WorkflowRunResult> {
    const run = { id: runId }
    const budget = new RemainingBudget(input.limits)
    const byStepId = new Map<string, StepResult>()
    const results: StepResult[] = []
    // `previous` SON İCRA OLUNMUŞ addımdır — atlanan addım zəncir üçün şəffafdır.
    // Əks halda budaqlanma özünü sındırardı: `when` ödənməyən addımdan sonrakı
    // hər addım boş giriş alardı.
    let previous: StepResult | undefined
    const seed = input.input ?? ''
    let executions = 0
    let stop: string | undefined

    for (const [index, step] of input.steps.entries()) {
      if (stop !== undefined) break
      if (executions >= MAX_WORKFLOW_EXECUTIONS) {
        stop = `addım icrası həddi aşıldı (${MAX_WORKFLOW_EXECUTIONS})`
        break
      }

      // ── Şərtli budaqlanma — 0 token ────────────────────────────────────
      if (step.when !== undefined) {
        const verdict = evaluateCondition(step.when, { previous, byStepId })
        if (!verdict.pass) {
          const skipped: StepResult = { stepId: step.id, status: 'skipped', output: '' }
          this.recordSkip(run.id, step, index, verdict.reason)
          byStepId.set(step.id, skipped)
          results.push(skipped)
          // `previous` DƏYİŞMİR — atlanan addım şəffafdır.
          continue
        }
      }

      if (budget.exhausted()) {
        const exceeded: StepResult = {
          stepId: step.id,
          status: 'budget_exceeded',
          output: '',
        }
        this.recordSkip(run.id, step, index, 'büdcə bitdi', 'budget_exceeded')
        byStepId.set(step.id, exceeded)
        results.push(exceeded)
        previous = exceeded
        stop = 'büdcə bitdi'
        break
      }

      // ── Təkrar (repeat) — hər təkrar YENİ task, yəni yeni xərc ─────────
      const maxAttempts = step.kind === 'task' ? (step.repeat?.max ?? 1) : 1
      let result: StepResult = { stepId: step.id, status: 'failed', output: '' }
      /**
       * Növbəti cəhdin `{{previous}}` dəyəri.
       *
       * TƏKRARDA BU, ADDIMIN ÖZ ƏVVƏLKİ CƏHDİDİR — zəncirin əvvəlki addımı yox.
       * Səbəb Pillə 0-dır: eyni prompt eyni keş açarını verir (`cache-key.ts`),
       * yəni dəyişməyən promptla təkrar HƏMİŞƏ eyni cavabı alardı və dövrə
       * `max`-a qədər boş fırlanardı. Öz çıxışını geri vermək təkrarı
       * "düzəlişlə yenidən cəhd et"ə çevirir — determinist yoxlama dövrəsinin
       * (Pillə 2) zəncir səviyyəsindəki qarşılığı.
       *
       * `{{previous}}`-a toxunmayan prompt yenə keşə düşür və təkrar SIFIR token
       * xərcləyir — yəni mənasız təkrar bahalı yox, sadəcə faydasız olur.
       */
      let attemptInput = previous?.output ?? seed

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        executions += 1
        result = await this.executeStep({
          step,
          index,
          attempt,
          workflowRunId: run.id,
          previousText: attemptInput,
          byStepId,
          input,
          budget,
        })
        attemptInput = result.output
        if (step.kind !== 'task' || step.repeat === undefined) break
        // Dayanma şərti addımın ÖZ nəticəsinə baxır: `until` ödənibsə təkrar
        // mənasızdır. Ödənməyibsə və cəhd qalıbsa yenidən qaçırılır.
        //
        // `from: 'previous'` BURADA addımın özü deməkdir — təkrar dövrəsində
        // "əvvəlki" məhz həmin addımın son cəhdidir. Zəncir səviyyəsindəki
        // `previous`-a baxsaydıq, şərt heç vaxt dəyişməzdi və `max` cəhdin
        // hamısı hər dəfə ödənilərdi.
        const until = evaluateCondition(step.repeat.until, {
          previous: result,
          byStepId: new Map([...byStepId, [step.id, result]]),
        })
        if (until.pass) break
        if (budget.exhausted()) break
        if (executions >= MAX_WORKFLOW_EXECUTIONS) break
      }

      byStepId.set(step.id, result)
      results.push(result)
      // Bundan sonra `previous` təyin olunub, yəni `seed` (başlanğıc giriş)
      // yalnız BİRİNCİ icra olunan addıma çatır — sonrakılar zəncirin öz
      // çıxışını alır.
      previous = result

      if (result.status !== 'succeeded' && step.continueOnError !== true) {
        stop = `addım sındı: ${describeStep(step, index)}`
      }
    }

    const executed = results.filter((r) => r.status !== 'skipped')
    const budgetHit = executed.some((r) => r.status === 'budget_exceeded')
    const status: WorkflowRunResult['status'] = budgetHit
      ? 'budget_exceeded'
      : executed.every((r) => r.status === 'succeeded')
        ? 'succeeded'
        : 'failed'

    finishWorkflowRun(this.db, run.id, {
      status,
      ...(stop !== undefined ? { error: stop } : {}),
    })

    return {
      workflowRunId: run.id,
      status,
      steps: results,
      output: previous?.output ?? '',
      ...(stop !== undefined ? { error: stop } : {}),
    }
  }

  /**
   * Atlanan (və ya büdcəyə görə icra olunmayan) addımı jurnala yazır.
   *
   * ATLANAN ADDIM DA SƏTİR YAZIR: yalnız icra olunanları yazsaydıq, istifadəçi
   * "5-ci addım niyə işləmədi?" sualının cavabını heç yerdə tapa bilməzdi —
   * budaqlanma görünməz olardı.
   */
  private recordSkip(
    workflowRunId: string,
    step: WorkflowStep,
    index: number,
    detail: string,
    status: 'skipped' | 'budget_exceeded' = 'skipped',
  ): void {
    const id = startStepRun(this.db, {
      workflowRunId,
      stepId: step.id,
      stepIndex: index,
      kind: step.kind,
      attempt: 1,
    })
    finishStepRun(this.db, id, { status, detail })
  }

  private async executeStep(args: {
    step: WorkflowStep
    index: number
    attempt: number
    workflowRunId: string
    previousText: string
    byStepId: ReadonlyMap<string, StepResult>
    input: WorkflowRunInput
    budget: RemainingBudget
  }): Promise<StepResult> {
    const { step, index, attempt, workflowRunId } = args
    const rowId = startStepRun(this.db, {
      workflowRunId,
      stepId: step.id,
      stepIndex: index,
      kind: step.kind,
      attempt,
    })

    const vars = {
      previous: args.previousText,
      byStepId: new Map([...args.byStepId].map(([k, v]) => [k, v.output])),
    }

    const outcome: StepOutcome =
      step.kind === 'http'
        ? await this.runHttpStep(step, vars)
        : await this.runTaskStep(step, vars, args.input, args.budget)

    const capped = capOutput(outcome.output)
    finishStepRun(this.db, rowId, {
      status: outcome.status,
      output: capped.output,
      outputTruncated: capped.truncated,
      ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    })

    return { stepId: step.id, status: outcome.status, output: capped.output }
  }

  private async runHttpStep(
    step: Extract<WorkflowStep, { kind: 'http' }>,
    vars: { previous: string; byStepId: ReadonlyMap<string, string> },
  ): Promise<StepOutcome> {
    // URL-də dəyişən əvəzlənmir (bax `HttpStep` şərhi) — yalnız gövdədə.
    const body =
      step.body === undefined ? undefined : substituteVariables(step.body, vars)

    const res = await executeHttpStep(
      {
        method: step.method,
        url: step.url,
        ...(body !== undefined ? { body } : {}),
      },
      {
        allow: this.deps.allow ?? readHttpAllowList(),
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
      },
    )

    return {
      status: res.ok ? 'succeeded' : 'failed',
      output: res.output,
      ...(res.status !== undefined ? { detail: `HTTP ${res.status}` } : {}),
    }
  }

  private async runTaskStep(
    step: TaskStep,
    vars: { previous: string; byStepId: ReadonlyMap<string, string> },
    input: WorkflowRunInput,
    budget: RemainingBudget,
  ): Promise<StepOutcome> {
    const prompt = substituteVariables(step.prompt, vars)
    const task = createTask(this.db, { contextId: input.context.id, prompt })
    const remaining = budget.remaining()

    const manual =
      input.runner !== undefined && input.model !== undefined
        ? { runner: input.runner, model: input.model }
        : {}

    const start = async (): Promise<{ status: StepResult['status']; output: string }> => {
      // Dekompozisiya addım səviyyəsində açıla bilər (qayda 52): zəncirin bir
      // addımı özü böyük task ola bilər.
      if (step.decompose === true && this.deps.decomposer !== undefined) {
        const split = await this.deps.decomposer.run({
          task: { id: task.id, prompt },
          context: input.context,
          requested: true,
          ...manual,
          ...(remaining !== undefined ? { limits: remaining } : {}),
        })
        if (split.decomposed) {
          return {
            status: split.status === 'succeeded' ? 'succeeded' : 'failed',
            // Parçaların cavabları SIRA İLƏ birləşdirilir — bu, zəncirin
            // növbəti addımına gedən mətndir. Birləşdirmə 0 token xərcləyir:
            // başçıdan xülasə istəsəydik, dekompozisiyanın qənaətini geri
            // yeyərdik.
            output: split.subtasks.map((s) => this.answerOf(s.taskId)).join('\n\n'),
          }
        }
        // Bölgü alınmadı — adi nərdivan (monoton qayda, qayda 32).
      }

      const result = await this.ladderRun(task.id, prompt, input, remaining)
      return {
        status: result.status === 'succeeded' ? 'succeeded' : 'failed',
        output: this.answerOf(result.runId),
      }
    }

    const outcome =
      this.deps.pool === undefined
        ? await start()
        : await this.deps.pool.run(
            input.context.id,
            resolveMaxParallel(input.context.maxParallel ?? 0),
            start,
          )

    // Addımın BÜTÜN icraları büdcəyə yazılır (nərdivan bir taskda bir neçə icra
    // qaçıra bilər: yoxlama dövrəsi, best-of-N, başçı).
    for (const run of listRunsForTask(this.db, task.id)) budget.charge(run)

    return { ...outcome, taskId: task.id }
  }

  private async ladderRun(
    taskId: string,
    prompt: string,
    input: WorkflowRunInput,
    limits: BudgetLimits | undefined,
  ): Promise<{ status: string; runId: string }> {
    return this.deps.ladder.run({
      task: { id: taskId, prompt },
      context: input.context,
      // Zəncir addımları ASILIDIR — izolyasiya onları bir-birindən gizlədərdi.
      isolate: false,
      ...(input.runner !== undefined && input.model !== undefined
        ? { runner: input.runner, model: input.model }
        : {}),
      ...(limits !== undefined ? { limits } : {}),
    })
  }

  private answerOf(runId: string): string {
    if (runId === '') return ''
    return collectAnswerText(listEvents(this.db, runId).map((s) => s.event))
  }
}
