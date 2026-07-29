import {
  MAX_WORKFLOW_EXECUTIONS,
  type Runner,
  type TaskStep,
  type WorkflowStep,
} from '@orchestris/shared'
import type { Db } from '../db/client.js'
import { createTask, listEvents, listRunsForTask, setTaskStatus } from '../db/repo.js'
import {
  createWorkflowRun,
  finishStepRun,
  finishWorkflowRun,
  getWorkflow,
  startStepRun,
} from '../db/workflow-repo.js'
import { classifyTask } from '../routing/classify.js'
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
import {
  resolveMaxParallel,
  shouldIsolate,
  type Worktree,
  type WorktreeManager,
} from './worktree.js'
import { finalizeWorktree } from './worktree-artifact.js'

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
 * 4. **İzolyasiya ADDIM BAŞINA DEYİL, ZƏNCİR BAŞINADIR** (issue #36). Addımlar
 *    asılıdır: 2-ci addım 1-cinin yazdığı faylı görməlidir. Hər addıma ayrıca
 *    worktree açılsaydı, hər addımın işi öz `pending` diff-ində qalar və növbəti
 *    addım köhnə kod görərdi. Ona görə ağac BİR dəfə — sintetik VALİDEYN task
 *    üçün — açılır və hər addımın `Ladder.run` çağırışına ötürülür; diff sonda
 *    valideynin adına `pending` yazılır (qayda 42-dəki baxış qapısı).
 */

export interface WorkflowRunInput {
  workflowId: string
  steps: readonly WorkflowStep[]
  context: LadderContext
  trigger: 'manual' | 'schedule'
  /**
   * İcranı başladan cədvəl (issue #38) — `trigger: 'schedule'` ilə birgə gəlir.
   *
   * Baxılmamış diff tavanı CƏDVƏL BAŞINA sayılır, ona görə icranın hansı
   * cədvəldən doğduğu jurnalda qalmalıdır: `trigger` yalnız "avtomatikdir"
   * deyir, hansı cədvəl olduğunu yox.
   */
  scheduleId?: string
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
  /** Sintetik valideyn task. `http`-only zəncirdə yoxdur (issue #36). */
  rootTaskId?: string
  error?: string
}

/**
 * Zəncir icrasının ORTAQ vəziyyəti — valideyn task və onun ağacı.
 *
 * İkisi ayrılmazdır: ağac valideynin adına açılır, diff onun adına yazılır,
 * addımların taskları onun altına düşür. Ayrı-ayrı ötürsəydik, "ağac var, sahibi
 * yoxdur" halı tipdə mümkün qalardı — halbuki məhz o hal issue #36-nın özüdür.
 */
interface RootSession {
  taskId: string | undefined
  worktree: Worktree | undefined
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
  /**
   * Zəncirin ORTAQ ağacı (issue #36). Verilməsə izolyasiya söndürülür və
   * addımlar birbaşa kontekstin `cwd`-sində işləyir — yəni `buildApp`-ə
   * `worktrees` ötürməyən testlərin davranışı dəyişmir.
   */
  worktrees?: WorktreeManager
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
    const rootTaskId = this.createRootTask(input)
    const run = createWorkflowRun(this.db, {
      workflowId: input.workflowId,
      trigger: input.trigger,
      stepsJson: JSON.stringify(input.steps),
      rootTaskId,
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    })
    return { workflowRunId: run.id, done: this.execute(run.id, input, rootTaskId) }
  }

  /**
   * Zəncir icrasının SİNTETİK valideyn taskını yaradır (issue #36).
   *
   * NİYƏ ÜMUMİYYƏTLƏ TASK: `artifacts` cədvəli TASKA bağlıdır. Sahib olmadan
   * ortaq ağacın diff-ini yazacaq yer yoxdur — məhz buna görə zəncirin `code`
   * addımları əvvəllər istifadəçinin repo-suna BİRBAŞA yazırdı və qayda 42-dəki
   * baxış qapısı zəncirdə işə düşmürdü. İkinci fayda pulsuz gəlir: addımların
   * taskları bu taskın altına düşür və `/tasks/:id` alt-task ağacı olduğu kimi
   * işləyir.
   *
   * `http`-only zəncirdə YARADILMIR: belə zəncir nə task qaçırır, nə fayla
   * toxunur — boş task yalnız task siyahısını zibilləyərdi.
   *
   * Taskın ÖZ icrası yoxdur, ona görə nə `runs` sətri, nə də ledger sətri yazılır
   * (`Ladder.recordLedger` icrasız taskı onsuz da atır — qayda 24). Statusunu
   * isə `settleRoot` yazır — səbəbi orada.
   */
  private createRootTask(input: WorkflowRunInput): string | undefined {
    if (!input.steps.some((s) => s.kind === 'task')) return undefined
    const workflow = getWorkflow(this.db, input.workflowId)
    const name = workflow?.name ?? 'zəncir'
    const description =
      workflow?.description !== undefined && workflow.description !== null
        ? `\n${workflow.description}`
        : ''
    // Tip TƏSNİFATLA gəlir (0 token) və izolyasiya qərarı ilə EYNİ mənbədəndir:
    // iki yerdə hesablasaydıq, ağac açılan, amma tipi "unknown" görünən task
    // mümkün olardı.
    const taskType = isolatedTaskType(input.steps, input.context)
    return createTask(this.db, {
      contextId: input.context.id,
      prompt: `Zəncir icrası: ${name}${description}`,
      ...(taskType !== undefined ? { taskType } : {}),
    }).id
  }

  /** Bütün zənciri qaçırıb nəticəni qaytarır (testlər və cədvəl icrası üçün). */
  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    return this.start(input).done
  }

  private async execute(
    runId: string,
    input: WorkflowRunInput,
    rootTaskId: string | undefined,
  ): Promise<WorkflowRunResult> {
    const session: RootSession = { taskId: rootTaskId, worktree: undefined }
    session.worktree = await this.openWorktree(input, rootTaskId)
    // `settled` bayrağı MƏCBURİDİR: addım icrası xəta ATA bilər (nərdivan, hovuz,
    // DB) və o halda `workflow_runs` "running", valideyn task isə "pending"
    // qalardı — hər ikisi UI-da HEÇ VAXT bitməyəcək iş kimi görünərdi.
    let settled = false
    try {
      const result = await this.runSteps(runId, input, session)
      this.settleRoot(session.taskId, result.status)
      settled = true
      return result
    } finally {
      if (!settled) {
        finishWorkflowRun(this.db, runId, {
          status: 'failed',
          error: 'zəncir icrası gözlənilməz xəta ilə dayandı',
        })
        this.settleRoot(session.taskId, 'failed')
      }
      // Ağacın bağlanışı `finally`-dədir: xəta atılsa da agentin yazdıqları
      // itməməlidir — diff `pending` yazılır, qovluq isə QALIR (qayda 42).
      await this.closeWorktree(session)
    }
  }

  /**
   * Zəncirin ortaq ağacını açır — YALNIZ valideyn task varsa.
   *
   * Qərar `shouldIsolate` ilə verilir, yəni tək taskla, dekompozisiya ilə TAM
   * eyni üç şərtə tabedir (paralellik, `fileAccess`, kod/test tipi). Zəncirə xas
   * daha sərt qayda YAZILMADI: baxış qapısının hansı hallarda işə düşdüyü bütün
   * yollarda eyni olmalıdır, yoxsa istifadəçi "eyni task tək göndəriləndə niyə
   * başqa cür davranır?" sualı ilə qarşılaşardı — məhz issue #36-nın şikayəti.
   *
   * Alınmasa `undefined`: izolyasiya OPTİMALLAŞDIRMADIR, tələb deyil (qayda 41).
   *
   * Ağac addımlardan ƏVVƏL açılır — tək taskdan fərqli olaraq (orada Pillə 0-dan
   * sonradır, qayda 40). Səbəb: ağac ORTAQDIR və hansı addımın keşdən gələcəyi
   * yalnız `Ladder.run`-ın içində bilinir; hər addımda "açılıbmı?" yoxlaması
   * qazandığından çox mürəkkəblik gətirərdi. Bütün addımlar keşdən gəlsə ağac
   * boş qalır və sonda DƏRHAL silinir (`finalizeWorktree`), yəni qiyməti bir
   * `worktree add`/`remove` cütüdür — `Decomposer` ilə eyni mübadilə.
   */
  private async openWorktree(
    input: WorkflowRunInput,
    rootTaskId: string | undefined,
  ): Promise<Worktree | undefined> {
    const cwd = input.context.cwd
    if (this.deps.worktrees === undefined || cwd === null || rootTaskId === undefined) {
      return undefined
    }
    if (isolatedTaskType(input.steps, input.context) === undefined) return undefined
    return (await this.deps.worktrees.create({ repo: cwd, taskId: rootTaskId })) ?? undefined
  }

  /** Diff-i VALİDEYN taskın adına yazır; dəyişiklik yoxdursa qovluğu silir. */
  private async closeWorktree(session: RootSession): Promise<void> {
    const { worktrees } = this.deps
    if (worktrees === undefined) return
    if (session.worktree === undefined || session.taskId === undefined) return
    await finalizeWorktree({
      db: this.db,
      worktrees,
      taskId: session.taskId,
      worktree: session.worktree,
    })
  }

  /**
   * Valideyn taskın statusunu zəncirin yekununa uyğunlaşdırır.
   *
   * `Decomposer.settle` ilə eyni səbəb: bu taskın öz icrası yoxdur, yəni
   * `RunSupervisor` statusu heç vaxt yazmır və diff-in baxıldığı səhifə
   * (`GET /api/tasks/:id`) bitmiş işi əbədi "pending" göstərərdi. Ledger sətri
   * isə YAZILMIR: icra yoxdursa ölçüləcək xərc də yoxdur (qayda 24).
   */
  private settleRoot(
    taskId: string | undefined,
    status: WorkflowRunResult['status'],
  ): void {
    if (taskId === undefined) return
    setTaskStatus(this.db, taskId, status === 'succeeded' ? 'succeeded' : 'failed')
  }

  private async runSteps(
    runId: string,
    input: WorkflowRunInput,
    session: RootSession,
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
          session,
          // Alt-taskın sırası ADDIM İNDEKSİ DEYİL, icra sayğacıdır: `repeat` eyni
          // addımı bir neçə dəfə qaçırır və hər cəhd AYRI task yaradır. İndeksi
          // işlətsəydik, cəhdlərin hamısı eyni `subtask_index` alar və ağacdakı
          // sıra təsadüfi olardı (məhz `subtask_index`-in qarşısını aldığı hal).
          sequence: executions - 1,
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
      ...(session.taskId !== undefined ? { rootTaskId: session.taskId } : {}),
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
    session: RootSession
    sequence: number
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
        : await this.runTaskStep(step, vars, args.input, args.budget, args.session, args.sequence)

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
    session: RootSession,
    sequence: number,
  ): Promise<StepOutcome> {
    const prompt = substituteVariables(step.prompt, vars)
    const task = createTask(this.db, {
      contextId: input.context.id,
      prompt,
      // Addımın taskı zəncirin sintetik valideyninin ALTINA düşür — dekompozisiya
      // ilə eyni ağac (issue #36). `/tasks/:id` və `SubtaskTree` heç bir
      // dəyişiklik olmadan işləyir.
      ...(session.taskId !== undefined
        ? { parentTaskId: session.taskId, subtaskIndex: sequence }
        : {}),
    })
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
          // Bölgü də zəncirin ORTAQ ağacında qaçır: `Decomposer` verilən ağacı
          // nə açır, nə bağlayır (issue #36). Öz ağacını açsaydı, bu addımın işi
          // ayrıca `pending` diff-də qalar və növbəti addım onu görməzdi.
          ...(session.worktree !== undefined ? { worktree: session.worktree } : {}),
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

      const result = await this.ladderRun(task.id, prompt, input, remaining, session)
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
    session: RootSession,
  ): Promise<{ status: string; runId: string }> {
    return this.deps.ladder.run({
      task: { id: taskId, prompt },
      context: input.context,
      // Zəncir addımları ASILIDIR — AYRICA ağac onları bir-birindən gizlədərdi.
      // Ona görə ya zəncirin ORTAQ ağacı verilir (sahibi valideyn taskdır və
      // nərdivan onu nə açır, nə bağlayır), ya da izolyasiya tamamilə söndürülür.
      ...(session.worktree !== undefined
        ? { worktree: session.worktree }
        : { isolate: false }),
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

/**
 * Zəncirin ortaq ağacı lazımdırsa — hansı task tipi ilə. **Sıfır token**.
 *
 * Hər `task` addımı AYRICA təsnif olunur və ilk izolyasiya tələb edən tip qalib
 * gəlir. Addımların mətnini birləşdirib bir dəfə təsnif etsəydik, dörd mətn
 * addımının yanındakı tək kod addımı siqnalda itərdi — yəni zəncirin YEGANƏ
 * repoya toxunan addımı baxış qapısından kənarda qalardı.
 *
 * `fileAccess: true` sayılır, çünki addımların runner-i hələ seçilməyib
 * (`Decomposer.openWorktree` ilə eyni mühakimə): ən pis halda heç nə yazılmır və
 * boş ağac sonda silinir.
 */
function isolatedTaskType(
  steps: readonly WorkflowStep[],
  ctx: LadderContext,
): string | undefined {
  const cwd = ctx.cwd
  if (cwd === null) return undefined
  for (const step of steps) {
    if (step.kind !== 'task') continue
    const { taskType } = classifyTask({ prompt: step.prompt, cwd })
    const isolate = shouldIsolate({
      maxParallel: ctx.maxParallel ?? 0,
      taskType,
      cwd,
      fileAccess: true,
    })
    if (isolate) return taskType
  }
  return undefined
}
