import type { Db } from '../db/client.js'
import { cancelQuestion, createQuestion, getQuestion } from '../db/interaction-repo.js'
import { setTaskStatus } from '../db/repo.js'
import type { AskInput, QuestionAnswer, QuestionGate } from './interaction.js'
import type { TaskPool } from './pool.js'

export interface QuestionEvent {
  kind: 'asked' | 'answered' | 'cancelled'
  taskId: string
  questionId: string
}

export interface QuestionGateInput {
  db: Db
  pool: TaskPool
  broadcast: (event: QuestionEvent) => void
}

/**
 * Sual gözləmə qapısı (Faza 5B).
 *
 * Gözləmə HOVUZ SLOTUNU BURAXARAQ baş verir (`pool.yield`): `max_parallel = 1`
 * olan kontekstdə cavabsız bir sual bütün iş sahəsini kilidləyərdi və
 * istifadəçi səbəbini heç yerdə görməzdi.
 *
 * TIMEOUT YOXDUR və bu, şüurlu qərardır. Avtomatik davam etmək iki pis
 * variantdan birini seçmək olardı: ya modelə "cavab yoxdur" deyib təxmin
 * etdirmək (o, məhz bunun qarşısını almaq üçün soruşdu), ya da taskı uğursuz
 * sayıb görülmüş işi atmaq. Slot onsuz da buraxıldığı üçün gözləmənin qiyməti
 * sıfırdır — tələsməyə səbəb yoxdur.
 */
export class DbQuestionGate implements QuestionGate {
  private readonly db: Db
  private readonly pool: TaskPool
  private readonly broadcast: (event: QuestionEvent) => void
  private readonly waiters = new Map<string, (a: QuestionAnswer | null) => void>()

  constructor(input: QuestionGateInput) {
    this.db = input.db
    this.pool = input.pool
    this.broadcast = input.broadcast
  }

  async ask(input: AskInput): Promise<QuestionAnswer | null> {
    const row = createQuestion(this.db, {
      taskId: input.taskId,
      runId: input.runId,
      question: input.question,
      kind: input.kind,
      options: input.options,
    })
    // `waiting_input` TERMINAL DEYİL — `setTaskStatus` ona `completed_at`
    // yazmır (bax `TERMINAL_TASK_STATUSES`), yoxsa task bitmiş görünərdi və
    // `/history` onu tamamlanmış sayardı.
    setTaskStatus(this.db, input.taskId, 'waiting_input')
    this.broadcast({ kind: 'asked', taskId: input.taskId, questionId: row.id })

    const answer = await this.pool.yield(
      input.contextId,
      input.maxParallel,
      () =>
        new Promise<QuestionAnswer | null>((resolve) => {
          this.waiters.set(row.id, resolve)
        }),
    )

    this.waiters.delete(row.id)
    setTaskStatus(this.db, input.taskId, 'running')
    return answer
  }

  /**
   * Cavab gəldi — route çağırır.
   *
   * `false` = belə gözləyən YOXDUR (server yenidən başladılıb). Route bunu
   * istifadəçiyə bildirir: cavab DB-yə yazılır, amma icra davam etməyəcək.
   */
  resolve(questionId: string, answer: QuestionAnswer): boolean {
    const waiter = this.waiters.get(questionId)
    if (waiter === undefined) return false
    this.waiters.delete(questionId)
    const row = getQuestion(this.db, questionId)
    if (row !== undefined) {
      this.broadcast({ kind: 'answered', taskId: row.taskId, questionId })
    }
    waiter(answer)
    return true
  }

  /** Task ləğv edildi və ya server bağlanır. */
  cancel(questionId: string): void {
    const row = getQuestion(this.db, questionId)
    cancelQuestion(this.db, questionId)
    const waiter = this.waiters.get(questionId)
    if (waiter !== undefined) {
      this.waiters.delete(questionId)
      waiter(null)
    }
    if (row !== undefined) {
      this.broadcast({ kind: 'cancelled', taskId: row.taskId, questionId })
    }
  }

  /**
   * Server bağlananda bütün gözləyənləri buraxır.
   *
   * MƏCBURİDİR: gözləyən `Promise` prosesi asılı saxlayardı və `SIGINT`-dən
   * sonra server bağlanmazdı — istifadəçi onu `kill` etməli olardı.
   */
  cancelAll(): void {
    for (const id of [...this.waiters.keys()]) this.cancel(id)
  }
}
