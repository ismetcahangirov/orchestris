import type { RunEvent, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client.js'
import { createReview } from '../db/interaction-repo.js'
import { createContext, createTask, getCacheEntry } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import type { QuestionGate, ReviewQueue } from './interaction.js'
import { Ladder } from './ladder.js'
import { DbReviewQueue } from './review-queue.js'
import { RunSupervisor } from './supervisor.js'

const ASK_JSON = JSON.stringify({
  ask: { question: 'Hansı?', kind: 'single', options: ['a', 'b'] },
})

/**
 * Ssenari üzrə cavab verən runner: hər çağırışda növbəti mətni qaytarır və
 * gələn `RunRequest`-i yazır. `FakeRunner` sorğunu saxlamır — bizə isə məhz
 * promptun və `resumeSessionId`-nin çatması lazımdır.
 */
function scripted(answers: string[], sink: RunRequest[]): Runner {
  let i = 0
  const inner = new FakeRunner({ events: [] })
  return {
    id: 'fake',
    kind: 'cli',
    // `fileAccess: false` — QƏSDƏN: `computeCacheKey` fayl icazəli runner
    // üçün repo barmaq izi tələb edir və repo olmayanda açarı `null` qaytarır.
    // Keş iddialarını yoxlaya bilmək üçün mətn runner-i lazımdır.
    capabilities: { ...inner.capabilities, fileAccess: false, sessions: true },
    detect: () => inner.detect(),
    run: (req): AsyncIterable<RunEvent> => {
      sink.push(req)
      const text = answers[Math.min(i, answers.length - 1)] ?? ''
      i += 1
      return (async function* () {
        yield { t: 'start', sessionId: 'sess-1' } as RunEvent
        yield { t: 'text', delta: text } as RunEvent
        yield { t: 'done', stopReason: 'end_turn' } as RunEvent
      })()
    },
  }
}

function setup(over: { questionsEnabled?: boolean } = {}) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: null,
    // `cheap` — tək işçi icrası, eskalasiya yoxdur (Pillə 0, 1, 2).
    amplificationProfile: 'cheap',
    maxParallel: 1,
    questionsEnabled: over.questionsEnabled ?? true,
  }
  return { db, ctx }
}

describe('Ladder — agentin sualı', () => {
  it('sual verilir, cavabdan sonra --resume ilə davam edir', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const runner = scripted([ASK_JSON, 'son cavab'], seen)
    const questions: QuestionGate = { ask: vi.fn(async () => 'a') }
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })

    const result = await ladder.run({ task, context: ctx, runner, model: 'm' })

    expect(questions.ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Hansı?', kind: 'single' }),
    )
    expect(seen).toHaveLength(2)
    // Sessiya davam etdirilir — sıfırdan başlatsaydıq sual verməyin qiyməti
    // TAM icranın qiyməti olardı.
    expect(seen[1]?.resumeSessionId).toBe('sess-1')
    expect(seen[1]?.prompt).toContain('Cavab: a')
    expect(result.status).toBe('succeeded')
  })

  it('sual müqaviləsi promptda görünür', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask: vi.fn() },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner: scripted(['cavab'], seen), model: 'm' })
    expect(seen[0]?.prompt).toContain('"ask"')
  })

  it('cavab gəlməsə task interrupted olur — nəticə itmir', async () => {
    const { db, ctx } = setup()
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask: vi.fn(async () => null) },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    const result = await ladder.run({
      task,
      context: ctx,
      runner: scripted([ASK_JSON], []),
      model: 'm',
    })
    expect(result.status).toBe('interrupted')
  })

  it('questionsEnabled false olanda müqavilə promptda YOXDUR', async () => {
    const { db, ctx } = setup({ questionsEnabled: false })
    const seen: RunRequest[] = []
    const ask = vi.fn()
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner: scripted([ASK_JSON], seen), model: 'm' })
    expect(seen[0]?.prompt).not.toContain('"ask"')
    expect(ask).not.toHaveBeenCalled()
  })

  it('interactive false (cədvəl/zəncir) sualı söndürür', async () => {
    // Orada cavab verəcək insan yoxdur — task ƏBƏDİ gözləyərdi.
    const { db, ctx } = setup()
    const ask = vi.fn(async () => 'a')
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({
      task,
      context: ctx,
      runner: scripted([ASK_JSON, 'x'], []),
      model: 'm',
      interactive: false,
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('rədd olunan sual ADİ cavab kimi qəbul edilir', async () => {
    const { db, ctx } = setup()
    const bad = JSON.stringify({ ask: { question: 'Q', kind: 'dropdown' } })
    const ask = vi.fn()
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    const result = await ladder.run({
      task,
      context: ctx,
      runner: scripted([bad], []),
      model: 'm',
    })
    expect(result.status).toBe('succeeded')
    expect(ask).not.toHaveBeenCalled()
  })

  it('qapı ötürülməyibsə mexanizm tamamilə söndürülür', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const ladder = new Ladder(db, new RunSupervisor(db))
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner: scripted([ASK_JSON], seen), model: 'm' })
    expect(seen[0]?.prompt).not.toContain('"ask"')
  })
})

describe('Ladder — canlı review', () => {
  it('rəy işçinin promptuna qoşulur', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const reviews: ReviewQueue = new DbReviewQueue(db)
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      reviews,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    createReview(db, { taskId: task.id, text: 'httpOnly cookie işlət', mode: 'next' })

    await ladder.run({ task, context: ctx, runner: scripted(['cavab'], seen), model: 'm' })
    expect(seen[0]?.prompt).toContain('httpOnly cookie işlət')
    expect(seen[0]?.prompt).toContain('İSTİFADƏÇİNİN RƏYİ')
  })

  it('rəyli icra KEŞƏ YAZILMIR', async () => {
    // Rəy "əvvəlki cavab səhvdir" deməkdir — onu adi icranın açarı altında
    // saxlamaq sonrakı adi taska səhv cavab verərdi.
    const { db, ctx } = setup()
    const reviews: ReviewQueue = new DbReviewQueue(db)
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      reviews,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    createReview(db, { taskId: task.id, text: 'düzəlt', mode: 'next' })

    const result = await ladder.run({
      task,
      context: ctx,
      runner: scripted(['cavab'], []),
      model: 'm',
    })
    expect(result.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('rəysiz icra keşə yazılır və açar icra sətrində qalır', async () => {
    const { db, ctx } = setup()
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      reviews: new DbReviewQueue(db),
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    const result = await ladder.run({
      task,
      context: ctx,
      runner: scripted(['cavab'], []),
      model: 'm',
    })
    expect(getCacheEntry(db, result.cacheKey as string)).toBeDefined()
  })
})
