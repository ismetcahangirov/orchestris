import type { ErrorClass, RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  applyUsageToRun,
  createRun,
  finishRun,
  setTaskStatus,
  type StoredEvent,
} from '../db/repo.js'
import { BudgetGuard, type BudgetLimits } from './budget.js'

export type RunStatus = 'succeeded' | 'failed' | 'interrupted' | 'budget_exceeded'

export interface ExecuteInput {
  taskId: string
  runner: Runner
  model: string
  prompt: string
  cwd?: string
  resumeSessionId?: string
  subscriptionBilled?: boolean
  ladderRung?: number
  /** Yoxlama dövrəsində neçənci cəhd. Default 1. */
  attempt?: number
  limits?: BudgetLimits
}

export interface ExecuteResult {
  runId: string
  status: RunStatus
  errorClass?: ErrorClass
  errorMessage?: string
}

export type EventListener = (runId: string, stored: StoredEvent) => void

/** Vaxt limiti bu intervalda yoxlanılır (ms). */
const CLOCK_CHECK_INTERVAL_MS = 250

/**
 * Bir icranı başdan-sona idarə edir: runner-i işə salır, hadisələri DB-yə
 * yazır, dinləyicilərə ötürür, büdcəni yoxlayır və pozuntuda kəsir.
 *
 * `FakeRunner` ilə tam test olunur — sıfır token.
 */
export class RunSupervisor {
  private readonly listeners = new Set<EventListener>()
  private readonly active = new Map<string, AbortController>()
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  cancel(runId: string): boolean {
    const ac = this.active.get(runId)
    if (ac === undefined) return false
    ac.abort()
    return true
  }

  cancelAll(): void {
    for (const ac of this.active.values()) ac.abort()
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const subscriptionBilled =
      input.subscriptionBilled ?? input.runner.capabilities.subscriptionBilled

    const run = createRun(this.db, {
      taskId: input.taskId,
      runnerId: input.runner.id,
      modelId: input.model,
      subscriptionBilled,
      ...(input.ladderRung !== undefined ? { ladderRung: input.ladderRung } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    })
    setTaskStatus(this.db, input.taskId, 'running')

    const ac = new AbortController()
    this.active.set(run.id, ac)

    // DİQQƏT: guard-a `subscriptionBilled`-i runner capability-dən DEFAULT
    // ETMİRİK. `BudgetGuard.check` onsuz da hər `usage` hadisəsinin öz
    // `billed` sahəsinə baxır — bu, konfiqurasiyadan daha etibarlıdır (bax
    // budget.ts-in şərhi). Əgər çağıran konteksti tam abunəlik kimi
    // MƏCBUR etmək istəyirsə, bunu `input.limits.subscriptionBilled` ilə
    // özü göstərməlidir; capability-dən avtomatik miras almaq real ödənişli
    // hadisələrdə belə dollar limitini səssizcə keçərdi (FakeRunner-in
    // default capability-si `subscriptionBilled: true`-dur).
    const guard = new BudgetGuard({ ...input.limits })
    const clock = setInterval(() => {
      if (guard.checkClock() !== null) ac.abort()
    }, CLOCK_CHECK_INTERVAL_MS)

    let sessionId: string | undefined
    let sawDone = false
    let terminal: { status: RunStatus; cls?: ErrorClass; msg?: string } | null = null

    try {
      const stream = input.runner.run(
        {
          prompt: input.prompt,
          model: input.model,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.resumeSessionId !== undefined
            ? { resumeSessionId: input.resumeSessionId }
            : {}),
        },
        { signal: ac.signal },
      )

      for await (const event of stream) {
        // Büdcə pozuntusu — hadisəni jurnala YAZMADAN kəsirik. Sərt limitin
        // mənası odur ki, ondan sonrakı heç nə qəbul edilmir.
        const violation = guard.check(event)
        if (violation !== null) {
          terminal = {
            status: 'budget_exceeded',
            cls: violation.class,
            msg: violation.message,
          }
          ac.abort()
          break
        }

        this.record(run.id, event)

        // `sessionId` üç yerdən gələ bilər. Uğursuz və ya kəsilmiş icra
        // `done` verməz — halbuki `--resume` məhz o hallarda lazımdır.
        if (event.t === 'start' || event.t === 'done' || event.t === 'error') {
          sessionId = event.sessionId ?? sessionId
        }
        if (event.t === 'usage') applyUsageToRun(this.db, run.id, event)
        if (event.t === 'done') sawDone = true
        if (event.t === 'error' && terminal === null) {
          terminal = { status: 'failed', cls: event.class, msg: event.message }
        }

        if (ac.signal.aborted) break
      }

      if (terminal === null) {
        if (ac.signal.aborted) {
          terminal = {
            status: 'interrupted',
            msg: 'İstifadəçi və ya vaxt limiti kəsdi',
          }
        } else if (!sawDone) {
          terminal = {
            status: 'failed',
            cls: 'crashed',
            msg: 'Axın `done` hadisəsi olmadan bitdi',
          }
        } else {
          terminal = { status: 'succeeded' }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      terminal = { status: 'failed', cls: 'crashed', msg }
      this.record(run.id, { t: 'error', class: 'crashed', message: msg })
    } finally {
      clearInterval(clock)
      this.active.delete(run.id)
    }

    finishRun(this.db, run.id, {
      status: terminal.status,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(terminal.cls !== undefined ? { errorClass: terminal.cls } : {}),
      ...(terminal.msg !== undefined ? { errorMessage: terminal.msg } : {}),
    })
    setTaskStatus(
      this.db,
      input.taskId,
      terminal.status === 'succeeded' ? 'succeeded' : 'failed',
    )

    return {
      runId: run.id,
      status: terminal.status,
      ...(terminal.cls !== undefined ? { errorClass: terminal.cls } : {}),
      ...(terminal.msg !== undefined ? { errorMessage: terminal.msg } : {}),
    }
  }

  private record(runId: string, event: RunEvent): void {
    const stored = appendEvent(this.db, runId, event)
    for (const l of this.listeners) {
      try {
        l(runId, stored)
      } catch {
        // Bir dinləyicinin xətası icranı dayandırmamalıdır.
      }
    }
  }
}
