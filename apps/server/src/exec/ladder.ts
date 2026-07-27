import type { RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  appendVerification,
  createRun,
  finishRun,
  getCacheEntry,
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
/** Pillə 2 — alət yoxlamasından keçən icra. */
const RUNG_TOOL_VERIFIED = 2
/** Yoxlama əmri yoxdursa — birbaşa güclü model. */
const RUNG_FULL_MODEL = 7

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
    const rung = hasVerification ? RUNG_TOOL_VERIFIED : RUNG_FULL_MODEL

    let prompt = input.task.prompt
    let attempts = 0

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
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
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

      // İcranın özü uğursuz olubsa yoxlamağa nə isə yoxdur. Təkrar cəhd
      // yalnız təkrarlana bilən xəta siniflərində mənalıdır — `auth` və
      // `budget_exceeded` halında yenidən cəhd etmək pul yandırmaqdır.
      if (exec.status !== 'succeeded') return base

      if (!hasVerification) {
        this.storeInCache(input, cacheKey, exec.runId)
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
        this.storeInCache(input, cacheKey, exec.runId)
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
