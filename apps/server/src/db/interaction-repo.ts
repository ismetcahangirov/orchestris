import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from './client.js'
import { taskQuestions, taskReviews } from './schema.js'

export type Question = typeof taskQuestions.$inferSelect
export type Review = typeof taskReviews.$inferSelect

const now = (): number => Date.now()

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} tapılmadı`)
  return row
}

export function createQuestion(
  db: Db,
  input: {
    taskId: string
    runId: string
    question: string
    kind: string
    options: readonly string[]
  },
): Question {
  const id = randomUUID()
  db.insert(taskQuestions)
    .values({
      id,
      taskId: input.taskId,
      runId: input.runId,
      question: input.question,
      kind: input.kind,
      optionsJson: JSON.stringify(input.options),
      askedAt: now(),
    })
    .run()
  return required(getQuestion(db, id), 'task_questions')
}

export function getQuestion(db: Db, id: string): Question | undefined {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id)).get()
}

export function listQuestions(db: Db, taskId: string): Question[] {
  return db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, taskId))
    .orderBy(asc(taskQuestions.askedAt))
    .all()
}

/**
 * Gözləyən suallar — `LiveBar` nişanı üçün.
 *
 * `runs`-dan HESABLANA BİLMƏZ: sualı verən icra ARTIQ bitib
 * (`status = 'succeeded'`), yəni `/api/runs/active` onu görmür.
 */
export function listPendingQuestions(db: Db): Question[] {
  return db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.status, 'pending'))
    .orderBy(asc(taskQuestions.askedAt))
    .all()
}

/**
 * Cavabı yazır.
 *
 * Cavablanmış və ya ləğv edilmiş suala TƏKRAR cavab QƏBUL EDİLMİR: icra artıq
 * davam edib və ikinci cavab heç yerə çatmazdı — istifadəçi isə çatdığını
 * sanardı.
 */
export function answerQuestion(db: Db, id: string, answer: unknown): Question | undefined {
  const row = getQuestion(db, id)
  if (row === undefined || row.status !== 'pending') return undefined
  db.update(taskQuestions)
    .set({ answerJson: JSON.stringify(answer), status: 'answered', answeredAt: now() })
    .where(eq(taskQuestions.id, id))
    .run()
  return getQuestion(db, id)
}

export function cancelQuestion(db: Db, id: string): void {
  db.update(taskQuestions)
    .set({ status: 'cancelled', answeredAt: now() })
    .where(and(eq(taskQuestions.id, id), eq(taskQuestions.status, 'pending')))
    .run()
}

/**
 * Server çökdükdən sonra qalan gözləyən suallar.
 *
 * `markOrphanedRunsInterrupted` ilə eyni məntiq: gözləyən PROSES yoxdur, yəni
 * cavab heç yerə çatmayacaq. Təmizləməsəydik UI əbədi "cavab gözləyir"
 * göstərərdi, halbuki gözləyən heç kim yoxdur.
 */
export function cancelOrphanQuestions(db: Db): number {
  const pending = listPendingQuestions(db)
  for (const q of pending) cancelQuestion(db, q.id)
  return pending.length
}

export function createReview(
  db: Db,
  input: { taskId: string; runId?: string | null; text: string; mode: string },
): Review {
  const id = randomUUID()
  db.insert(taskReviews)
    .values({
      id,
      taskId: input.taskId,
      runId: input.runId ?? null,
      text: input.text,
      mode: input.mode,
      createdAt: now(),
    })
    .run()
  return required(
    db.select().from(taskReviews).where(eq(taskReviews.id, id)).get(),
    'task_reviews',
  )
}

export function listReviews(db: Db, taskId: string): Review[] {
  return db
    .select()
    .from(taskReviews)
    .where(eq(taskReviews.taskId, taskId))
    .orderBy(asc(taskReviews.createdAt))
    .all()
}

/**
 * Tətbiq olunmamış rəyləri GÖTÜRÜR və DƏRHAL `applied_at` yazır.
 *
 * Dərhal yazılır (icradan SONRA yox): əks halda review route onları hələ də
 * "tətbiq olunmayıb" sayıb PARALEL ikinci icra başladardı.
 */
export function drainReviews(db: Db, taskId: string): Review[] {
  const pending = db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), isNull(taskReviews.appliedAt)))
    .orderBy(asc(taskReviews.createdAt))
    .all()
  if (pending.length === 0) return []
  const at = now()
  for (const r of pending) {
    db.update(taskReviews).set({ appliedAt: at }).where(eq(taskReviews.id, r.id)).run()
  }
  return pending
}

export function hasPendingReviews(db: Db, taskId: string): boolean {
  return (
    db
      .select()
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, taskId), isNull(taskReviews.appliedAt)))
      .all().length > 0
  )
}
