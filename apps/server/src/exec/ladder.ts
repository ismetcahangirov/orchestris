import type { RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  appendVerification,
  createRun,
  finishRun,
  getCacheEntry,
  getRun,
  listEvents,
  putCacheEntry,
  recordCacheHit,
  setTaskStatus,
} from '../db/repo.js'
import type { BudgetLimits } from './budget.js'
import { computeCacheKey } from './cache-key.js'
import type { RunSupervisor } from './supervisor.js'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

/** Yoxlama dövrəsinin maksimum cəhd sayı. */
const MAX_ATTEMPTS = 3

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
}

export interface LadderInput {
  task: { id: string; prompt: string }
  context: LadderContext
  runner: Runner
  model: string
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

  constructor(db: Db, supervisor: RunSupervisor) {
    this.db = db
    this.supervisor = supervisor
  }

  async run(input: LadderInput): Promise<LadderResult> {
    const cwd = input.context.cwd ?? undefined
    const cacheKey = computeCacheKey({
      prompt: input.task.prompt,
      modelId: input.model,
      runnerId: input.runner.id,
      needsFileAccess: input.runner.capabilities.fileAccess,
      ...(cwd !== undefined ? { cwd } : {}),
    })

    // ── Pillə 0 — cache ────────────────────────────────────────────────
    if (cacheKey !== null) {
      const hit = this.replayFromCache(input, cacheKey)
      if (hit !== null) return hit
    }

    // ── Pillə 2 — zəif model + alət yoxlaması ──────────────────────────
    const verifyCommands = this.parseVerifyCommands(input.context.verifyCommandsJson)
    const hasVerification = verifyCommands.length > 0
    const rung = hasVerification ? 2 : 7

    let prompt = input.task.prompt
    let attempts = 0
    let last: LadderResult | null = null

    // Bug 1 (whole-branch review): hər cəhdə tam yeni BudgetGuard vermək
    // 3 cəhddə 3x xərc limitinə səbəb olur. `RunSupervisor`/`BudgetGuard`-a
    // toxunmadan (plan bunu tələb edir), xərclənəni burada — Ladder
    // səviyyəsində — izləyirik və qalan büdcəni növbəti cəhdə ötürürük.
    // Bu dəyişənlər `run()` çağırışına aiddir, sinif sahəsi DEYİL — Ladder
    // instansiyaları paralel task-lar arasında paylaşılır.
    const ladderStartedAt = Date.now()
    let spentOutputTokens = 0
    let spentCostUsd = 0
    let currentLimits: BudgetLimits | undefined = input.limits

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1

      const exec = await this.supervisor.execute({
        taskId: input.task.id,
        runner: input.runner,
        model: input.model,
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
        ...(exec.errorClass !== undefined ? { errorClass: exec.errorClass } : {}),
        ...(exec.errorMessage !== undefined ? { errorMessage: exec.errorMessage } : {}),
      }
      last = base

      // İcranın özü uğursuz olubsa yoxlamağa nə isə yoxdur. Təkrar cəhd
      // yalnız təkrarlana bilən xəta siniflərində mənalıdır — `auth` və
      // `budget_exceeded` halında yenidən cəhd etmək pul yandırmaqdır.
      if (exec.status !== 'succeeded') return base

      if (!hasVerification) {
        this.storeInCache(input, cacheKey, exec.runId)
        return base
      }

      // Bu cəhdin faktiki xərcini yekun sayğaca əlavə et (Bug 1).
      const attemptRun = getRun(this.db, exec.runId)
      if (attemptRun !== undefined) {
        spentOutputTokens += attemptRun.tokensOut
        // `costUsd` NULL ola bilər ("bilinmir", Qayda 4) — bilinməyən xərci
        // sayğaca 0 kimi əlavə etmək qərarlı yanaşmadır: tək-cəhdli
        // `BudgetGuard.check` da `costUsd` undefined olduqda dollar
        // yoxlamasını keçir, biz də eyni fərziyyəni davam etdiririk. Daha
        // yaxşısı mümkün deyil — xərc həqiqətən bilinmirsə "0 töhfə" yeganə
        // sərt olmayan seçimdir.
        if (attemptRun.costUsd !== null) spentCostUsd += attemptRun.costUsd
      }

      // Bug 2 (whole-branch review): `RunSupervisor.execute()` artıq
      // task.status-u 'succeeded' yazdı, amma yoxlama hələ bitməyib. Bunu
      // düzəldirik ki, bütün yoxlama müddətincə status düzgün 'running'
      // görünsün — əks halda veb UI-ın pollinqi vaxtından əvvəl dayanır.
      setTaskStatus(this.db, input.task.id, 'running')

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
        this.storeInCache(input, cacheKey, exec.runId)
        setTaskStatus(this.db, input.task.id, 'succeeded')
        return { ...base, verificationPassed: true }
      }

      // Sınıb — xəta mətnini modelə geri ötürüb yenidən cəhd et.
      // Yoxlama SIFIR token xərcləyir; yalnız yeni icra xərcləyir.
      prompt = `${input.task.prompt}\n\n${buildFeedbackPrompt(verification.results)}`
      last = { ...base, status: 'verification_failed', verificationPassed: false }

      // Limit təyin olunmayıbsa daşınacaq heç nə yoxdur — `currentLimits`
      // artıq `undefined`-dir, boş obyekt yaratmağa ehtiyac yoxdur.
      if (attempts < MAX_ATTEMPTS && input.limits !== undefined) {
        const remainingMaxOutputTokens =
          input.limits?.maxOutputTokens !== undefined
            ? Math.max(0, input.limits.maxOutputTokens - spentOutputTokens)
            : undefined
        const remainingMaxCostUsd =
          input.limits?.maxCostUsd !== undefined
            ? Math.max(0, input.limits.maxCostUsd - spentCostUsd)
            : undefined
        const remainingMaxSeconds =
          input.limits?.maxSeconds !== undefined
            ? Math.max(0, input.limits.maxSeconds - (Date.now() - ladderStartedAt) / 1000)
            : undefined

        const exhausted =
          remainingMaxOutputTokens === 0 ||
          remainingMaxCostUsd === 0 ||
          remainingMaxSeconds === 0

        if (exhausted) {
          // Büdcə artıq tükənib — növbəti cəhdə başlamaq pul yandırmaqdır.
          // `RunSupervisor.execute()`-in özünün `budget_exceeded` terminalı
          // üçün istifadə etdiyi eyni konvensiya: status 'failed' yazılır.
          setTaskStatus(this.db, input.task.id, 'failed')
          return { ...base, status: 'budget_exceeded', verificationPassed: false }
        }

        currentLimits = {
          ...(remainingMaxOutputTokens !== undefined
            ? { maxOutputTokens: remainingMaxOutputTokens }
            : {}),
          ...(remainingMaxCostUsd !== undefined ? { maxCostUsd: remainingMaxCostUsd } : {}),
          ...(remainingMaxSeconds !== undefined ? { maxSeconds: remainingMaxSeconds } : {}),
          ...(input.limits?.subscriptionBilled !== undefined
            ? { subscriptionBilled: input.limits.subscriptionBilled }
            : {}),
        }
      }
    }

    const final = last as LadderResult
    setTaskStatus(this.db, input.task.id, 'failed')
    return final
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
  private replayFromCache(input: LadderInput, cacheKey: string): LadderResult | null {
    const entry = getCacheEntry(this.db, cacheKey)
    if (entry === undefined) return null

    const run = createRun(this.db, {
      taskId: input.task.id,
      runnerId: input.runner.id,
      modelId: input.model,
      ladderRung: 0,
      cachedHit: true,
      subscriptionBilled: input.runner.capabilities.subscriptionBilled,
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
  private storeInCache(input: LadderInput, cacheKey: string | null, runId: string): void {
    if (cacheKey === null) return
    const events: RunEvent[] = listEvents(this.db, runId).map((s) => s.event)
    putCacheEntry(this.db, {
      hash: cacheKey,
      modelId: input.model,
      runnerId: input.runner.id,
      events,
    })
  }
}
