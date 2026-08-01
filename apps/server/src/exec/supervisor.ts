import type {
  ActiveRun,
  ErrorClass,
  FileAccess,
  RunCustomizations,
  RunEvent,
  Runner,
} from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  applyUsageToRun,
  createRun,
  finishRun,
  getActiveRun,
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
  /**
   * İzolyasiya edilmiş worktree-nin yolu — YALNIZ qeyd üçün (`runs.worktree_path`).
   *
   * İcra onsuz da `cwd` ilə yönləndirilir; sütun "bu icra hansı ağacda işlədi?"
   * sualının cavabıdır və worktree silindikdən sonra da qalır.
   */
  worktreePath?: string
  resumeSessionId?: string
  /**
   * Kontekstin fayl icazəsi — `resolveFileAccess` nəticəsi (Faza 5A).
   *
   * Verilməsə runner öz konstruktor default-una düşür. Nərdivan bunu
   * `where()`-dən BİR yerdən verir ki, çağırış yerlərindən biri unudulanda
   * həmin icra səhv icazə ilə işləməsin.
   */
  fileAccess?: FileAccess
  /**
   * MCP / plugin / daxili skill seçimi (Faza 5C).
   *
   * Verilməsə runner ÖZ DEFAULT bayraq dəstini işlədir və əmr sətri bayt-bayt
   * köhnə qalır — mövcud keşlər sınmır.
   */
  customizations?: RunCustomizations
  subscriptionBilled?: boolean
  ladderRung?: number
  /** Yoxlama dövrəsində neçənci cəhd. Default 1. */
  attempt?: number
  /** Pillə qalxaraq başlanan icra üçün — hansı icradan sonra gəldi. */
  escalatedFromRunId?: string
  limits?: BudgetLimits
}

export interface ExecuteResult {
  runId: string
  status: RunStatus
  errorClass?: ErrorClass
  errorMessage?: string
}

export type EventListener = (runId: string, stored: StoredEvent) => void

/** Canlı zolaq üçün icra həyat dövrü mesajı (Faza 5A). */
export interface ActivityMessage {
  kind: 'started' | 'ended'
  runId: string
  /** YALNIZ `'started'`-da olur — `'ended'` üçün `runId` kifayətdir. */
  run?: ActiveRun
}

export type ActivityListener = (msg: ActivityMessage) => void

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
  private readonly activityListeners = new Set<ActivityListener>()
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

  /**
   * Canlı zolaq üçün icra HƏYAT DÖVRÜ hadisələri (Faza 5A).
   *
   * `onEvent`-dən AYRIDIR: ora hər delta düşür və onları qlobal kanala
   * yaysaydıq, zolaq açıq olan hər brauzer bütün icraların hərf-hərf axınını
   * alardı.
   */
  onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener)
    return () => {
      this.activityListeners.delete(listener)
    }
  }

  private emitActivity(msg: ActivityMessage): void {
    for (const l of this.activityListeners) {
      try {
        l(msg)
      } catch {
        // Bir dinləyicinin xətası icranı dayandırmamalıdır.
      }
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
      ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.escalatedFromRunId !== undefined
        ? { escalatedFromRunId: input.escalatedFromRunId }
        : {}),
    })
    setTaskStatus(this.db, input.taskId, 'running')

    // Zolaq üçün yük DB-dən oxunur, əl ilə qurulmur: kontekst adı və prompt
    // parçası orada onsuz da var və iki yerdə iki fərqli formalaşdırma
    // yaratmaq `/api/runs/active` ilə WS arasında səssiz uyğunsuzluq verərdi.
    const active = getActiveRun(this.db, run.id)
    if (active !== undefined) {
      this.emitActivity({ kind: 'started', runId: run.id, run: active })
    }

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
          ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
          ...(input.customizations !== undefined
            ? { customizations: input.customizations }
            : {}),
          ...(input.resumeSessionId !== undefined
            ? { resumeSessionId: input.resumeSessionId }
            : {}),
        },
        { signal: ac.signal },
      )

      for await (const event of stream) {
        // HESAB ƏVVƏLCƏ YAZILIR — büdcə qərarından ÖNCƏ.
        //
        // `usage` görülmüş işin QEYDİdir, icazə istəyi deyil: ona baxanda pul
        // ARTIQ xərclənib. Əvvəl bu sətir pozuntu yoxlamasından SONRA idi,
        // yəni limiti aşan icranın tokenləri DB-yə heç vaxt düşmürdü. Nəticə
        // ölçülüb (2026-08-01): 26,007 çıxış tokeni `tokens_out = 0` kimi
        // yazıldı, `RemainingBudget` onları xərcə saymadı və ledger ödənilmiş
        // pulu gizlətdi — qayda 22/23/49-un birbaşa pozulması.
        if (event.t === 'usage') applyUsageToRun(this.db, run.id, event)

        const violation = guard.check(event)
        if (violation !== null && violation.enforce) {
          // Sərt rejim: hadisə jurnala YAZILMADAN kəsilir — limitin mənası
          // odur ki, ondan sonrakı heç nə qəbul edilmir.
          terminal = {
            status: 'budget_exceeded',
            cls: violation.class,
            msg: violation.message,
          }
          ac.abort()
          break
        }
        // `'report'` rejimində pozuntu icranı DAYANDIRMIR: `usage` işin
        // sonunda gəlir, yəni burada kəsmək ödənilmiş nəticəni atmaqdan başqa
        // heç nə etmir. Aşım `runs.tokens_out`-da onsuz da görünür.

        this.record(run.id, event)

        // `sessionId` üç yerdən gələ bilər. Uğursuz və ya kəsilmiş icra
        // `done` verməz — halbuki `--resume` məhz o hallarda lazımdır.
        if (event.t === 'start' || event.t === 'done' || event.t === 'error') {
          sessionId = event.sessionId ?? sessionId
        }
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
    this.emitActivity({ kind: 'ended', runId: run.id })

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
