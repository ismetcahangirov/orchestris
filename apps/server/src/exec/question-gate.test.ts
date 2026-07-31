import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client.js'
import { listPendingQuestions } from '../db/interaction-repo.js'
import { createContext, createTask, getTask } from '../db/repo.js'
import { TaskPool } from './pool.js'
import { DbQuestionGate } from './question-gate.js'

function seed() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  return { db, ctx, task }
}

const ASK = {
  runId: 'r1',
  question: 'Davam edim?',
  kind: 'yes_no' as const,
  options: [] as string[],
}

/** Mikro-taskların növbəsini boşaldır — `ask` içindəki `await` üçün. */
const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('DbQuestionGate', () => {
  it('sual yazılır, task waiting_input olur və cavab gözlənilir', async () => {
    const { db, ctx, task } = seed()
    const broadcast = vi.fn()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast })

    const pending = gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK })
    await tick()

    expect(getTask(db, task.id)?.status).toBe('waiting_input')
    // `waiting_input` TERMINAL DEYİL — `completed_at` yazılmamalıdır.
    expect(getTask(db, task.id)?.completedAt).toBeNull()

    const q = listPendingQuestions(db)[0]
    expect(q?.question).toBe('Davam edim?')
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'asked', taskId: task.id }),
    )

    expect(gate.resolve(q?.id ?? '', true)).toBe(true)
    expect(await pending).toBe(true)
    // Cavabdan sonra task yenidən işləyir — `waiting_input` qalsaydı UI
    // "hələ də sual gözləyir" yalanı danışardı.
    expect(getTask(db, task.id)?.status).toBe('running')
  })

  it('ləğv null qaytarır — nərdivan dayanmır', async () => {
    const { db, ctx, task } = seed()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast: vi.fn() })

    const pending = gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK })
    await tick()
    gate.cancel(listPendingQuestions(db)[0]?.id ?? '')

    expect(await pending).toBeNull()
  })

  it('cancelAll bütün gözləyənləri buraxır — proses asılı qalmamalıdır', async () => {
    const { db, ctx, task } = seed()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast: vi.fn() })

    const pending = gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK })
    await tick()
    gate.cancelAll()

    expect(await pending).toBeNull()
    expect(listPendingQuestions(db)).toHaveLength(0)
  })

  it('tanınmayan sual id-si üçün resolve false verir', () => {
    const { db } = seed()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast: vi.fn() })
    expect(gate.resolve('yoxdur', true)).toBe(false)
  })

  it('gözləyərkən hovuz slotu BURAXILIR', async () => {
    // Bu test mexanizmin bütün mənasını qoruyur: `max_parallel = 1`-də cavabsız
    // bir sual iş sahəsini kilidləməməlidir.
    const { db, ctx, task } = seed()
    const pool = new TaskPool()
    const gate = new DbQuestionGate({ db, pool, broadcast: vi.fn() })
    let secondRan = false

    const first = pool.run(ctx.id, 1, () =>
      gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK }),
    )
    const second = pool.run(ctx.id, 1, async () => {
      secondRan = true
    })

    await second
    expect(secondRan).toBe(true)

    gate.cancel(listPendingQuestions(db)[0]?.id ?? '')
    await first
  })
})
