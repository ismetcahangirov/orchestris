import { describe, expect, it } from 'vitest'
import { openDb } from './client.js'
import {
  answerQuestion,
  cancelOrphanQuestions,
  createQuestion,
  createReview,
  drainReviews,
  getQuestion,
  hasPendingReviews,
  listPendingQuestions,
  listQuestions,
  listReviews,
} from './interaction-repo.js'
import { createContext, createTask } from './repo.js'

function seed() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  return { db, task }
}

const ASK = { question: 'Q', kind: 'yes_no', options: [] as string[] }

describe('task_questions', () => {
  it('sual pending statusu ilə yaranır', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    expect(q.status).toBe('pending')
    expect(q.answerJson).toBeNull()
    expect(q.optionsJson).toBe('[]')
  })

  it('cavab yazılır və status dəyişir', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    const got = answerQuestion(db, q.id, true)
    expect(got?.status).toBe('answered')
    expect(JSON.parse(got?.answerJson ?? 'null')).toBe(true)
    expect(got?.answeredAt).toBeGreaterThan(0)
  })

  it('cavablanmış suala TƏKRAR cavab qəbul edilmir', () => {
    // İcra artıq davam edib; ikinci cavab heç yerə çatmazdı, istifadəçi isə
    // çatdığını sanardı.
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    answerQuestion(db, q.id, true)
    expect(answerQuestion(db, q.id, false)).toBeUndefined()
    expect(JSON.parse(getQuestion(db, q.id)?.answerJson ?? 'null')).toBe(true)
  })

  it('çoxseçimli cavab massiv kimi saxlanılır', () => {
    const { db, task } = seed()
    const q = createQuestion(db, {
      taskId: task.id,
      runId: 'r1',
      question: 'Q',
      kind: 'multi',
      options: ['a', 'b'],
    })
    const got = answerQuestion(db, q.id, ['a', 'b'])
    expect(JSON.parse(got?.answerJson ?? 'null')).toEqual(['a', 'b'])
  })

  it('task üzrə suallar sıra ilə qaytarılır', () => {
    const { db, task } = seed()
    createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK, question: 'bir' })
    createQuestion(db, { taskId: task.id, runId: 'r2', ...ASK, question: 'iki' })
    expect(listQuestions(db, task.id).map((q) => q.question)).toEqual(['bir', 'iki'])
  })

  it('ləğv edilmiş sual gözləyənlər siyahısından çıxır', () => {
    const { db, task } = seed()
    createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    expect(listPendingQuestions(db)).toHaveLength(1)
    expect(cancelOrphanQuestions(db)).toBe(1)
    expect(listPendingQuestions(db)).toHaveLength(0)
  })

  it('ləğv edilmiş suala cavab qəbul edilmir', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    cancelOrphanQuestions(db)
    expect(answerQuestion(db, q.id, true)).toBeUndefined()
  })
})

describe('task_reviews', () => {
  it('boşaltma applied_at yazır və İKİNCİ dəfə boş qaytarır', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'düzəlt', mode: 'next' })
    expect(drainReviews(db, task.id)).toHaveLength(1)
    expect(drainReviews(db, task.id)).toHaveLength(0)
  })

  it('hasPendingReviews boşaltmadan sonra false verir', () => {
    // Route bundan asılıdır: rəy tətbiq olunmayıbsa yeni icra başlatmalıdır.
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'x', mode: 'next' })
    expect(hasPendingReviews(db, task.id)).toBe(true)
    drainReviews(db, task.id)
    expect(hasPendingReviews(db, task.id)).toBe(false)
  })

  it('rəylər yazılma sırası ilə qaytarılır', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'bir', mode: 'next' })
    createReview(db, { taskId: task.id, text: 'iki', mode: 'interrupt' })
    expect(drainReviews(db, task.id).map((r) => r.text)).toEqual(['bir', 'iki'])
  })

  it('listReviews tətbiq olunmuşları da göstərir', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'x', mode: 'next' })
    drainReviews(db, task.id)
    expect(listReviews(db, task.id)).toHaveLength(1)
  })

  it('runId verilməsə NULL saxlanılır', () => {
    const { db, task } = seed()
    expect(createReview(db, { taskId: task.id, text: 'x', mode: 'next' }).runId).toBeNull()
  })
})
