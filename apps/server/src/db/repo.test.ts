import { describe, expect, it } from 'vitest'
import { openDb } from './client.js'
import {
  appendEvent,
  applyUsageToRun,
  createContext,
  createRun,
  createTask,
  finishRun,
  getContext,
  getRunTaskId,
  getTask,
  listContexts,
  listEvents,
  listRunsForTask,
  markOrphanedRunsInterrupted,
  setTaskStatus,
} from './repo.js'

const db = () => openDb(':memory:')

function seed() {
  const d = db()
  const ctx = createContext(d, { name: 'C' })
  const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
  const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
  return { d, ctx, task, run }
}

describe('createContext', () => {
  it('kontekst yaradır və default dəyərləri qoyur', () => {
    const ctx = createContext(db(), { name: 'Test' })
    expect(ctx.name).toBe('Test')
    expect(ctx.amplificationProfile).toBe('balanced')
    expect(ctx.workerMode).toBe('auto')
    expect(ctx.autoSubmode).toBe('cheap')
    expect(ctx.maxParallel).toBe(1)
    expect(ctx.verifyCommandsJson).toBe('[]')
  })

  it('verifyCommands massivini JSON kimi saxlayır', () => {
    const ctx = createContext(db(), {
      name: 'C',
      verifyCommands: ['pnpm typecheck', 'pnpm test'],
    })
    expect(JSON.parse(ctx.verifyCommandsJson)).toEqual(['pnpm typecheck', 'pnpm test'])
  })

  it('cwd verilməsə null saxlayır', () => {
    expect(createContext(db(), { name: 'C' }).cwd).toBeNull()
  })
})

describe('listContexts / getContext', () => {
  it('yaradılmış kontekstləri qaytarır', () => {
    const d = db()
    createContext(d, { name: 'A' })
    createContext(d, { name: 'B' })
    expect(listContexts(d)).toHaveLength(2)
  })

  it('mövcud olmayan kontekst üçün undefined qaytarır', () => {
    expect(getContext(db(), 'yoxdur')).toBeUndefined()
  })
})

describe('createTask / setTaskStatus', () => {
  it('task yaradır və konteksti bağlayır', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'salam' })
    expect(task.contextId).toBe(ctx.id)
    expect(task.status).toBe('pending')
    expect(task.completedAt).toBeNull()
  })

  it('terminal statusda completedAt yazılır', () => {
    const { d, task } = seed()
    setTaskStatus(d, task.id, 'succeeded')
    expect(getTask(d, task.id)?.completedAt).toBeGreaterThan(0)
  })

  it('running statusda completedAt yazılmır', () => {
    const { d, task } = seed()
    setTaskStatus(d, task.id, 'running')
    expect(getTask(d, task.id)?.completedAt).toBeNull()
  })
})

describe('createRun / listRunsForTask / getRunTaskId', () => {
  it('run yaradır və running statusu ilə başlayır', () => {
    const { run } = seed()
    expect(run.status).toBe('running')
    expect(run.costUsd).toBeNull()
    expect(run.subscriptionBilled).toBe(false)
  })

  it('subscriptionBilled ötürülür', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, {
      taskId: task.id,
      runnerId: 'cli:claude',
      modelId: 'haiku',
      subscriptionBilled: true,
    })
    expect(run.subscriptionBilled).toBe(true)
  })

  it('task üzrə run-ları sadalayır', () => {
    const { d, task } = seed()
    createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm2' })
    expect(listRunsForTask(d, task.id)).toHaveLength(2)
  })

  it('getRunTaskId run-dan task-a keçid verir', () => {
    const { d, task, run } = seed()
    expect(getRunTaskId(d, run.id)).toBe(task.id)
    expect(getRunTaskId(d, 'yoxdur')).toBeUndefined()
  })
})

describe('appendEvent / listEvents', () => {
  it('hadisələri sıra nömrəsi ilə yazır və eyni sırada oxuyur', () => {
    const { d, run } = seed()
    appendEvent(d, run.id, { t: 'text', delta: 'bir' })
    appendEvent(d, run.id, { t: 'text', delta: 'iki' })
    appendEvent(d, run.id, { t: 'done', stopReason: 'end_turn' })

    const events = listEvents(d, run.id)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(events[0]?.event).toEqual({ t: 'text', delta: 'bir' })
    expect(events[2]?.event).toEqual({ t: 'done', stopReason: 'end_turn' })
  })

  it('appendEvent yazdığı hadisəni geri qaytarır', () => {
    const { d, run } = seed()
    const stored = appendEvent(d, run.id, { t: 'text', delta: 'a' })
    expect(stored.seq).toBe(1)
    expect(stored.at).toBeGreaterThan(0)
    expect(stored.event).toEqual({ t: 'text', delta: 'a' })
  })

  it('afterSeq və limit ilə səhifələmə edir', () => {
    const { d, run } = seed()
    for (let i = 0; i < 5; i++) appendEvent(d, run.id, { t: 'text', delta: String(i) })
    expect(listEvents(d, run.id, { afterSeq: 2, limit: 2 }).map((e) => e.seq)).toEqual([
      3, 4,
    ])
  })

  it('sıra nömrələri run-lar arasında müstəqildir', () => {
    const { d, task, run } = seed()
    const run2 = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    appendEvent(d, run.id, { t: 'text', delta: 'a' })
    const s = appendEvent(d, run2.id, { t: 'text', delta: 'b' })
    expect(s.seq).toBe(1)
  })
})

describe('applyUsageToRun', () => {
  it('usage hadisəsini run sətrinə yazır (toplamır, ƏVƏZ EDİR)', () => {
    const { d, run } = seed()
    const u = {
      t: 'usage' as const,
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
      billed: 'subscription' as const,
    }
    applyUsageToRun(d, run.id, u)
    applyUsageToRun(d, run.id, u) // ikinci dəfə eyni kumulyativ dəyər

    const after = finishRun(d, run.id, { status: 'succeeded' })
    expect(after.tokensIn).toBe(10)
    expect(after.tokensOut).toBe(59)
    expect(after.tokensCacheRead).toBe(22411)
    expect(after.tokensCacheWrite).toBe(2655)
    expect(after.costUsd).toBeCloseTo(0.00845, 6)
    expect(after.subscriptionBilled).toBe(true)
  })

  it('costUsd yoxdursa NULL saxlayır — "bilinmir" 0 demək deyil', () => {
    const { d, run } = seed()
    applyUsageToRun(d, run.id, {
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      billed: 'subscription',
    })
    expect(finishRun(d, run.id, { status: 'succeeded' }).costUsd).toBeNull()
  })

  it('billed real olduqda subscriptionBilled false qalır', () => {
    const { d, run } = seed()
    applyUsageToRun(d, run.id, {
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
      billed: 'real',
    })
    expect(finishRun(d, run.id, { status: 'succeeded' }).subscriptionBilled).toBe(false)
  })

  it('keş sahələri yoxdursa 0 yazır', () => {
    const { d, run } = seed()
    applyUsageToRun(d, run.id, {
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      billed: 'real',
    })
    const after = finishRun(d, run.id, { status: 'succeeded' })
    expect(after.tokensCacheRead).toBe(0)
    expect(after.tokensCacheWrite).toBe(0)
  })
})

describe('finishRun', () => {
  it('statusu, bitmə vaxtını və sessionId-i yazır', () => {
    const { d, run } = seed()
    const done = finishRun(d, run.id, { status: 'succeeded', sessionId: 's-9' })
    expect(done.status).toBe('succeeded')
    expect(done.endedAt).toBeGreaterThan(0)
    expect(done.sessionId).toBe('s-9')
  })

  it('xəta sinfini və mesajını yazır', () => {
    const { d, run } = seed()
    const done = finishRun(d, run.id, {
      status: 'failed',
      errorClass: 'auth',
      errorMessage: 'Not logged in',
    })
    expect(done.errorClass).toBe('auth')
    expect(done.errorMessage).toBe('Not logged in')
  })

  it('çox uzun xəta mesajını kəsir', () => {
    const { d, run } = seed()
    const done = finishRun(d, run.id, {
      status: 'failed',
      errorClass: 'crashed',
      errorMessage: 'x'.repeat(5000),
    })
    expect(done.errorMessage?.length).toBe(2000)
  })
})

describe('markOrphanedRunsInterrupted', () => {
  it('yetim running icraları interrupted edir və hadisə jurnalını İTİRMİR', () => {
    const { d, run } = seed()
    appendEvent(d, run.id, { t: 'text', delta: 'yarımçıq' })

    expect(markOrphanedRunsInterrupted(d)).toBe(1)
    expect(listRunsForTask(d, getRunTaskId(d, run.id)!)[0]?.status).toBe('interrupted')
    expect(listEvents(d, run.id)).toHaveLength(1)
  })

  it('artıq bitmiş icralara toxunmur', () => {
    const { d, run } = seed()
    finishRun(d, run.id, { status: 'succeeded' })
    expect(markOrphanedRunsInterrupted(d)).toBe(0)
  })

  it('yetim icra yoxdursa 0 qaytarır', () => {
    expect(markOrphanedRunsInterrupted(db())).toBe(0)
  })
})

describe('foreign key CASCADE', () => {
  it('foreign_keys pragma aktivdir — mövcud olmayan task-a run yaradılmır', () => {
    expect(() =>
      createRun(db(), { taskId: 'yoxdur', runnerId: 'fake', modelId: 'm' }),
    ).toThrow()
  })
})
