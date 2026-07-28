import type { RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  appendVerification,
  createRun,
  finishRun,
  listRunsForTask,
  getCacheEntry,
  getRun,
  listEvents,
  putCacheEntry,
  recordCacheHit,
  setTaskStatus,
  setTaskType,
} from '../db/repo.js'
import { recordRoutingDecision } from '../db/routing-repo.js'
import { recordSavings } from '../db/savings-repo.js'
import type { WorkerRouter } from '../routing/decide.js'
import type { RoutingDecision } from '../routing/router.js'
import type { BudgetLimits } from './budget.js'
import { computeCacheKey } from './cache-key.js'
import { computeTaskSavings } from './savings.js'
import type { RunSupervisor } from './supervisor.js'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

/** Yoxlama dövrəsinin maksimum cəhd sayı. */
const MAX_ATTEMPTS = 3
/** Pillə 0 — hazır nəticə keşi. */
const RUNG_CACHE = 0
/** Pillə 2 — alət yoxlamasından keçən icra. */
const RUNG_TOOL_VERIFIED = 2
/** Yoxlama əmri yoxdursa — birbaşa güclü model. */
const RUNG_FULL_MODEL = 7

/**
 * Amplifikasiya profilləri — kontekst səviyyəsində seçilir.
 *
 * Pillə 3–7 hələ tətbiq olunmayıb (Faza 2), ona görə `cheap`, `balanced` və
 * `quality` hazırda eyni pillələri işlədir. `boss-only` isə FƏRQLİDİR və
 * indidən lazımdır: qənaəti sübut etmək üçün baseline ölçməsi ondan asılıdır.
 */
export const AMPLIFICATION_PROFILES = ['cheap', 'balanced', 'quality', 'boss-only'] as const

export function activeRungs(profile: string): ReadonlySet<number> {
  // Baseline: nə keş, nə yoxlama dövrəsi — yalnız güclü modelin tək icrası.
  if (profile === 'boss-only') return new Set([RUNG_FULL_MODEL])
  return new Set([RUNG_CACHE, RUNG_TOOL_VERIFIED])
}

export type LadderStatus =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'budget_exceeded'
  | 'verification_failed'

export interface LadderContext {
  id: string
  cwd: string | null
  verifyCommandsJson: string
  /** `cheap` | `balanced` | `quality` | `boss-only`. Default `balanced`. */
  amplificationProfile?: string
  /** Qayda tutmadıqda seçilən işçi (`models.id`). */
  defaultWorkerModelId?: string | null
}

export interface LadderInput {
  task: { id: string; prompt: string }
  context: LadderContext
  /**
   * İstifadəçinin ƏL İLƏ seçimi. Verilməsə Pillə 1 (Auto) işə düşür —
   * bunun üçün `Ladder` konstruktoruna router ötürülməlidir.
   */
  runner?: Runner
  model?: string
  limits?: BudgetLimits
}

export interface LadderResult {
  runId: string
  status: LadderStatus
  /** Nəticə keşdən gəldimi (Pillə 0). */
  cached: boolean
  /** Keşləmək təhlükəlidirsə `null`. */
  cacheKey: string | null
  /** Neçə icra cəhdi edildi (Pillə 2 dövrəsi). */
  attempts: number
  /** Yoxlama əmrləri varsa nəticəsi; yoxdursa `null`. */
  verificationPassed: boolean | null
  /** Pillə 1-in qərarı — UI-da "niyə bu model?" sualına cavab verir. */
  decision?: RoutingDecision
  errorClass?: string
  errorMessage?: string
}

/**
 * Amplifikasiya nərdivanı — Pillə 0 və Pillə 2.
 *
 * `RunSupervisor` bir icranı idarə edir və bu sinif ona toxunmur. Ladder
 * onun üzərində oturur: keşə baxır, lazım olsa supervisor-u bir neçə dəfə
 * çağırır, hər dəfə determinist yoxlamadan keçirir.
 */
export class Ladder {
  private readonly db: Db
  private readonly supervisor: RunSupervisor
  private readonly router: WorkerRouter | undefined

  constructor(db: Db, supervisor: RunSupervisor, router?: WorkerRouter) {
    this.db = db
    this.supervisor = supervisor
    this.router = router
  }

  /**
   * Taskı başdan-sona aparır və SONDA qənaət ledger-ini yazır.
   *
   * Ledger yazılışı `run()`-ın hər `return`-ündən sonra təkrarlanmasın deyə
   * burada, bir yerdə edilir — unudulan bir yol ölçmədə səssiz boşluq yaradardı.
   */
  async run(input: LadderInput): Promise<LadderResult> {
    const result = await this.execute(input)
    this.recordLedger(input.task.id)
    return result
  }

  /**
   * Ledger sətrini yazır — YALNIZ həqiqətən icra olubsa.
   *
   * İcrasız uğursuzluqda (məs. "işçi təyin olunmayıb") ölçüləcək bir şey
   * yoxdur: pul yanmayıb. Belə taskı ledger-ə yazsaq, "task sayı" şişər və
   * orta qənaət olduğundan kiçik görünərdi.
   */
  private recordLedger(taskId: string): void {
    if (listRunsForTask(this.db, taskId).length === 0) return
    recordSavings(this.db, computeTaskSavings(this.db, taskId))
  }

  private async execute(input: LadderInput): Promise<LadderResult> {
    const cwd = input.context.cwd ?? undefined
    const profile = input.context.amplificationProfile ?? 'balanced'

    // ── Pillə 1 — işçi seçimi ──────────────────────────────────────────
    // Pillə 0-dan ƏVVƏL gəlir, çünki keş açarı model və runner id-sini
    // ehtiva edir (`cache-key.ts`) — hansı modelin işlədiləcəyini bilmədən
    // keşə baxmaq mümkün deyil. Qayda routing-i 0 token xərcləyir, ona görə
    // bu sıra adi halda heç nəyə başa gəlmir; yalnız klassifikator işə
    // düşəndə (qeyri-müəyyən task) keş yoxlanışından əvvəl ~50 token gedir.
    const selected = await this.selectWorker(input, profile)
    if ('error' in selected) {
      setTaskStatus(this.db, input.task.id, 'failed')
      return {
        runId: '',
        status: 'failed',
        cached: false,
        cacheKey: null,
        attempts: 0,
        verificationPassed: null,
        errorClass: 'crashed',
        errorMessage: selected.error,
      }
    }
    const { runner, model, decision } = selected

    // `RunSupervisor.execute` hər çağırışda TAM YENİ BudgetGuard yaradır (öz
    // limitlərinə görə). Yoxlama dövrəsi eyni task üçün onu bir neçə dəfə
    // çağırır — limiti cəhdlər arasında ÖZ DAXİLİMİZDƏ izləməsək, hər cəhd
    // orijinal limiti təzədən alar və MAX_ATTEMPTS dəfə xərclənə bilər.
    // `RunSupervisor`-a toxunmuruq (plan: "RunSupervisor dəyişmir"); bunun
    // əvəzinə Ladder xərclənəni özü izləyir və qalanını növbəti cəhdə ötürür.
    // Bunlar `run()`-a LOKALDIR — sinif sahəsi DEYİL, çünki `Ladder` eyni anda
    // paralel tasklar arasında paylaşılır.
    const ladderStartedAt = Date.now()
    let spentOutputTokens = 0
    let spentCostUsd = 0

    // `boss-only` baseline profilidir: "hər şey başçı ilə görülsəydi nə
    // olardı?" sualına cavab verir. Keş və yoxlama dövrəsi amplifikasiyadır —
    // onları baseline-a qatsaq müqayisə mənasız olar, ona görə söndürülür.
    const rungs = activeRungs(profile)

    const cacheKey = rungs.has(RUNG_CACHE)
      ? computeCacheKey({
          prompt: input.task.prompt,
          modelId: model,
          runnerId: runner.id,
          needsFileAccess: runner.capabilities.fileAccess,
          ...(cwd !== undefined ? { cwd } : {}),
        })
      : null

    // ── Pillə 0 — cache ────────────────────────────────────────────────
    if (cacheKey !== null) {
      const hit = this.replayFromCache(input, runner, model, cacheKey)
      if (hit !== null) return { ...hit, decision }
    }

    // ── Pillə 2 — zəif model + alət yoxlaması ──────────────────────────
    const verifyCommands = rungs.has(RUNG_TOOL_VERIFIED)
      ? this.parseVerifyCommands(input.context.verifyCommandsJson)
      : []
    const hasVerification = verifyCommands.length > 0
    const rung = hasVerification ? RUNG_TOOL_VERIFIED : RUNG_FULL_MODEL

    let prompt = input.task.prompt
    let attempts = 0
    // İlk cəhd DƏYİŞMƏMİŞ `input.limits`-lə gedir — hələ heç nə xərclənməyib.
    // Yoxlama sınıb yenidən cəhd edilməli olanda bu, aşağıda azaldılmış
    // büdcə ilə əvəz olunur.
    let currentLimits = input.limits

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1

      const exec = await this.supervisor.execute({
        taskId: input.task.id,
        runner,
        model,
        prompt,
        attempt: attempts,
        ladderRung: rung,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(currentLimits !== undefined ? { limits: currentLimits } : {}),
      })

      const base: LadderResult = {
        runId: exec.runId,
        status: exec.status,
        cached: false,
        cacheKey,
        attempts,
        verificationPassed: null,
        decision,
        ...(exec.errorClass !== undefined ? { errorClass: exec.errorClass } : {}),
        ...(exec.errorMessage !== undefined ? { errorMessage: exec.errorMessage } : {}),
      }

      // İcranın özü uğursuz olubsa yoxlamağa nə isə yoxdur. Təkrar cəhd
      // yalnız təkrarlana bilən xəta siniflərində mənalıdır — `auth` və
      // `budget_exceeded` halında yenidən cəhd etmək pul yandırmaqdır.
      if (exec.status !== 'succeeded') return base

      // Bu cəhdin nə xərclədiyini toplayırıq ki, yenidən cəhd lazım olsa
      // növbəti `execute()` çağırışına TAM deyil, QALAN büdcə ötürülsün.
      const finishedRun = getRun(this.db, exec.runId)
      if (finishedRun !== undefined) {
        spentOutputTokens += finishedRun.tokensOut
        // `costUsd` NULL-dursa xərc BİLİNMİR (bax CLAUDE.md qayda #4) — belə
        // cəhd cari məbləğə `0` qatır, çünki bilinməyəni bundan yaxşı təxmin
        // edə bilmərik. `BudgetGuard.check` da eyni səbəbdən `costUsd`
        // `undefined` olanda xərc yoxlamasını tamamilə keçir.
        if (finishedRun.costUsd !== null) spentCostUsd += finishedRun.costUsd
      }

      if (!hasVerification) {
        this.storeInCache(runner, model, cacheKey, exec.runId)
        return base
      }

      const verification = await runVerifications(verifyCommands, { cwd: cwd ?? process.cwd() })
      for (const r of verification.results) {
        appendVerification(this.db, exec.runId, {
          command: r.command,
          exitCode: r.exitCode,
          passed: r.passed,
          outputExcerpt: r.output,
          durationMs: r.durationMs,
        })
      }

      if (verification.passed) {
        this.storeInCache(runner, model, cacheKey, exec.runId)
        return { ...base, verificationPassed: true }
      }

      // Sınıb. Son cəhddirsə burada dayanırıq — task həqiqətən bitib.
      if (attempts === MAX_ATTEMPTS) {
        setTaskStatus(this.db, input.task.id, 'failed')
        return { ...base, status: 'verification_failed', verificationPassed: false }
      }

      // Hələ cəhd qalıb — icra özü uğurlu olsa da task HƏLƏ BİTMƏYİB. Supervisor
      // exec.status === 'succeeded' görüb task-ı `succeeded` işarələyib, amma
      // yoxlama sınıb və yenidən cəhd ediləcək — statusu geri `running`-ə
      // qaytarırıq ki UI "bitdi" yalanı danışmasın (bax CLAUDE.md qayda #5,
      // eyni prinsip: `billed` sahəsi kimi, status da real vəziyyəti əks
      // etdirməlidir).
      setTaskStatus(this.db, input.task.id, 'running')

      // ── Növbəti cəhd üçün QALAN büdcəni hesabla ─────────────────────
      // `input.limits` heç vaxt təyin olunmayıbsa heç bir məhdudiyyət
      // gətirmirik — limitsiz tasklar üçün davranış tamamilə dəyişməz qalır.
      if (input.limits !== undefined) {
        const remainingMaxOutputTokens =
          input.limits.maxOutputTokens !== undefined
            ? Math.max(0, input.limits.maxOutputTokens - spentOutputTokens)
            : undefined
        const remainingMaxCostUsd =
          input.limits.maxCostUsd !== undefined
            ? Math.max(0, input.limits.maxCostUsd - spentCostUsd)
            : undefined
        const remainingMaxSeconds =
          input.limits.maxSeconds !== undefined
            ? Math.max(0, input.limits.maxSeconds - (Date.now() - ladderStartedAt) / 1000)
            : undefined

        if (
          remainingMaxOutputTokens === 0 ||
          remainingMaxCostUsd === 0 ||
          remainingMaxSeconds === 0
        ) {
          // Qalan büdcə sıfırdır — növbəti cəhdi başlatmaq özü pul yandırmaq
          // olardı. Dövrəni burada dayandırırıq, `execute()`-i BİR DƏFƏ də
          // çağırmadan.
          setTaskStatus(this.db, input.task.id, 'failed')
          return { ...base, status: 'budget_exceeded', verificationPassed: false }
        }

        currentLimits = {
          ...input.limits,
          ...(remainingMaxOutputTokens !== undefined
            ? { maxOutputTokens: remainingMaxOutputTokens }
            : {}),
          ...(remainingMaxCostUsd !== undefined ? { maxCostUsd: remainingMaxCostUsd } : {}),
          ...(remainingMaxSeconds !== undefined ? { maxSeconds: remainingMaxSeconds } : {}),
        }
      }

      // Xəta mətnini modelə geri ötürüb yenidən cəhd et. Yoxlama SIFIR token
      // xərcləyir; yalnız yeni icra xərcləyir.
      prompt = `${input.task.prompt}\n\n${buildFeedbackPrompt(verification.results)}`
    }

    // Bura yalnız MAX_ATTEMPTS < 1 olsa çatıla bilər — bu proqramçı xətasıdır,
    // konfiqurasiya xətası deyil. Hər cəhd öz daxilində return edir, ona görə
    // `attempts === MAX_ATTEMPTS` budağı MAX_ATTEMPTS >= 1 olduqca həmişə
    // işə düşür və bura çatılmır.
    throw new Error('Ladder: MAX_ATTEMPTS ən azı 1 olmalıdır')
  }

  private parseVerifyCommands(json: string): string[] {
    try {
      const parsed: unknown = JSON.parse(json)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    } catch {
      return []
    }
  }

  /**
   * Keşdən nəticə tapılıbsa, onu YENİ run sətri kimi qeyd edir və hadisələri
   * jurnala yazır. Belə olsa UI heç bir xüsusi hal bilmədən eyni şeyi göstərir,
   * amma sətir `cachedHit: true` və `ladderRung: 0` ilə işarələnir.
   */
  private replayFromCache(
    input: LadderInput,
    runner: Runner,
    model: string,
    cacheKey: string,
  ): LadderResult | null {
    const entry = getCacheEntry(this.db, cacheKey)
    if (entry === undefined) return null

    const run = createRun(this.db, {
      taskId: input.task.id,
      runnerId: runner.id,
      modelId: model,
      ladderRung: 0,
      cachedHit: true,
      subscriptionBilled: runner.capabilities.subscriptionBilled,
    })
    for (const event of entry.events) appendEvent(this.db, run.id, event)
    recordCacheHit(this.db, cacheKey)
    finishRun(this.db, run.id, { status: 'succeeded' })
    setTaskStatus(this.db, input.task.id, 'succeeded')

    return {
      runId: run.id,
      status: 'succeeded',
      cached: true,
      cacheKey,
      attempts: 0,
      verificationPassed: null,
    }
  }

  /** Yalnız uğurlu VƏ yoxlamadan keçmiş nəticə keşlənir. */
  private storeInCache(
    runner: Runner,
    model: string,
    cacheKey: string | null,
    runId: string,
  ): void {
    if (cacheKey === null) return
    const events: RunEvent[] = listEvents(this.db, runId).map((s) => s.event)
    putCacheEntry(this.db, { hash: cacheKey, modelId: model, runnerId: runner.id, events })
  }

  /**
   * Pillə 1 — kim icra edəcək?
   *
   * Əl ilə seçim varsa router-ə TOXUNULMUR. Hər iki halda qərar
   * `routing_decisions`-a yazılır: istifadəçi `/tasks/:id` səhifəsində
   * "niyə bu model?" sualının cavabını görməlidir.
   */
  private async selectWorker(
    input: LadderInput,
    profile: string,
  ): Promise<
    { runner: Runner; model: string; decision: RoutingDecision } | { error: string }
  > {
    if (input.runner !== undefined && input.model !== undefined) {
      const decision: RoutingDecision = {
        strategy: 'manual',
        runnerId: input.runner.id,
        modelId: input.model,
        chosenRowId: null,
        confidence: 1,
        reason: 'istifadəçi əl ilə seçdi',
        decisionTokens: 0,
        decisionCostUsd: 0,
      }
      recordRoutingDecision(this.db, input.task.id, decision)
      return { runner: input.runner, model: input.model, decision }
    }

    if (this.router === undefined) {
      return { error: 'Auto rejimi üçün router qurulmayıb — runner və model açıq verilməlidir' }
    }

    const outcome = await this.router.decide({
      task: input.task,
      context: {
        cwd: input.context.cwd,
        amplificationProfile: profile,
        defaultWorkerModelId: input.context.defaultWorkerModelId ?? null,
      },
    })
    if (!outcome.ok) return { error: outcome.error }

    recordRoutingDecision(this.db, input.task.id, outcome.decision)
    setTaskType(this.db, input.task.id, outcome.taskType)
    return {
      runner: outcome.runner,
      model: outcome.decision.modelId,
      decision: outcome.decision,
    }
  }
}
