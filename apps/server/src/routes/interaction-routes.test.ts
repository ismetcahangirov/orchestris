import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import { createQuestion, listReviews } from '../db/interaction-repo.js'
import {
  createContext,
  createRun,
  createTask,
  getCacheEntry,
  putCacheEntry,
  setRunCacheKey,
} from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, ctx, task, app }
}

const YES_NO = { runId: 'r1', question: 'Davam edim?', kind: 'yes_no', options: [] }
const SINGLE = {
  runId: 'r1',
  question: 'Hansı?',
  kind: 'single',
  options: ['a', 'b'],
}

describe('POST /api/tasks/:id/questions/:qid/answer', () => {
  it('cavab yazılır; gözləyən proses yoxdursa delivered false', async () => {
    // `delivered: false` = server yenidən başladılıb və gözləyən icra yoxdur.
    // İstifadəçi bunu bilməlidir, yoxsa boş yerə gözləyərdi.
    const { db, task, app } = setup()
    const q = createQuestion(db, { taskId: task.id, ...YES_NO })
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, delivered: false })
  })

  it('tanınmayan variant 400 verir', async () => {
    const { db, task, app } = setup()
    const q = createQuestion(db, { taskId: task.id, ...SINGLE })
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: 'z' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('yes_no sualına sətir cavab 400 verir', async () => {
    const { db, task, app } = setup()
    const q = createQuestion(db, { taskId: task.id, ...YES_NO })
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: 'bəli' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cavablanmış suala təkrar cavab 409 verir — 400 YOX', async () => {
    // İstifadəçi səhv etməyib; sual artıq bağlanıb. 400 onu öz göndərişini
    // səhv saymağa məcbur edərdi.
    const { db, task, app } = setup()
    const q = createQuestion(db, { taskId: task.id, ...YES_NO })
    const url = `/api/tasks/${task.id}/questions/${q.id}/answer`
    await app.inject({ method: 'POST', url, payload: { answer: true } })
    const res = await app.inject({ method: 'POST', url, payload: { answer: false } })
    expect(res.statusCode).toBe(409)
  })

  it('başqa taskın sualı 404 verir', async () => {
    const { db, ctx, task, app } = setup()
    const other = createTask(db, { contextId: ctx.id, prompt: 'başqa' })
    const q = createQuestion(db, { taskId: other.id, ...YES_NO })
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: true },
    })
    expect(res.statusCode).toBe(404)
  })

  it('çoxseçimli cavab qəbul edilir', async () => {
    const { db, task, app } = setup()
    const q = createQuestion(db, {
      taskId: task.id,
      runId: 'r1',
      question: 'Hansılar?',
      kind: 'multi',
      options: ['a', 'b'],
    })
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: ['a', 'b'] },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /api/questions/pending', () => {
  it('gözləyən sualı variantları AÇILMIŞ şəkildə qaytarır', async () => {
    const { db, task, app } = setup()
    createQuestion(db, { taskId: task.id, ...SINGLE })
    const res = await app.inject({ method: 'GET', url: '/api/questions/pending' })
    expect(res.statusCode).toBe(200)
    // UI xam JSON sətri oxumamalıdır.
    expect(res.json().questions[0].options).toEqual(['a', 'b'])
  })

  it('cavablanmış sual siyahıda YOXDUR', async () => {
    const { db, task, app } = setup()
    const q = createQuestion(db, { taskId: task.id, ...YES_NO })
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/questions/${q.id}/answer`,
      payload: { answer: true },
    })
    const res = await app.inject({ method: 'GET', url: '/api/questions/pending' })
    expect(res.json().questions).toHaveLength(0)
  })
})

describe('POST /api/tasks/:id/review', () => {
  it('rəy yazılır', async () => {
    const { db, task, app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/review`,
      payload: { text: 'httpOnly cookie işlət', mode: 'next' },
    })
    expect(res.statusCode).toBe(200)
    expect(listReviews(db, task.id)).toHaveLength(1)
  })

  it('KEŞ SƏTRİNİ SİLİR', async () => {
    // Rəy "əvvəlki cavab səhvdir" deməkdir. Silməsəydik eyni prompt bir daha
    // göndəriləndə məhz düzəldilməsi istənən səhv cavab qaytarılardı.
    const { db, task, app } = setup()
    const run = createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    putCacheEntry(db, {
      hash: 'hash-1',
      modelId: 'm',
      runnerId: 'fake',
      events: [{ t: 'done', stopReason: 'end_turn' }],
    })
    setRunCacheKey(db, run.id, 'hash-1')
    expect(getCacheEntry(db, 'hash-1')).toBeDefined()

    await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/review`,
      payload: { text: 'düzəlt', mode: 'next' },
    })
    expect(getCacheEntry(db, 'hash-1')).toBeUndefined()
  })

  it('tanınmayan rejim 400 verir', async () => {
    const { task, app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/review`,
      payload: { text: 'x', mode: 'kill' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('mövcud olmayan task 404 verir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/yoxdur/review',
      payload: { text: 'x', mode: 'next' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/tasks/:id — sual və rəylər', () => {
  it('cavabda questions və reviews var', async () => {
    const { db, task, app } = setup()
    createQuestion(db, { taskId: task.id, ...SINGLE })
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/review`,
      payload: { text: 'x', mode: 'next' },
    })

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` })
    const body = res.json()
    expect(body.questions).toHaveLength(1)
    expect(body.questions[0].options).toEqual(['a', 'b'])
    expect(body.reviews).toHaveLength(1)
  })
})
