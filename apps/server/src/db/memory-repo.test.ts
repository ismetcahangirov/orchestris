import { describe, expect, it } from 'vitest'
import { openDb, type Db } from './client.js'
import { listMemoryOps, memoryCostForTask, recordMemoryOp } from './memory-repo.js'
import { createContext, createTask } from './repo.js'

function setup(): { db: Db; taskId: string } {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  return { db, taskId: createTask(db, { contextId: ctx.id, prompt: 'p' }).id }
}

function op(taskId: string, over: Partial<Parameters<typeof recordMemoryOp>[1]> = {}) {
  return {
    taskId,
    provider: 'fake',
    kind: 'recall' as const,
    scope: 's',
    items: 1,
    tokens: 40,
    costUsd: 0,
    ok: true,
    ...over,
  }
}

describe('memoryCostForTask', () => {
  it('əməliyyat yoxdursa xərc SIFIRDIR — "bilinmir" deyil', () => {
    // Yaddaş işə düşməyibsə xərci həqiqətən sıfırdır; `null` qaytarmaq bütün
    // qənaət hesabını səbəbsiz naməlum edərdi.
    const { db, taskId } = setup()
    expect(memoryCostForTask(db, taskId)).toEqual({ costUsd: 0, ops: 0 })
  })

  it('bilinən xərcləri toplayır', () => {
    const { db, taskId } = setup()
    recordMemoryOp(db, op(taskId, { costUsd: 0.001 }))
    recordMemoryOp(db, op(taskId, { kind: 'remember', costUsd: 0.002 }))

    expect(memoryCostForTask(db, taskId).costUsd).toBeCloseTo(0.003, 6)
  })

  it('BİR naməlum xərc bütün cəmi naməlum edir', () => {
    // Gizlətsəydik "bu ay $X qənaət" rəqəmi ödədiyimiz pulu udardı (qayda 23).
    const { db, taskId } = setup()
    recordMemoryOp(db, op(taskId, { costUsd: 0.001 }))
    recordMemoryOp(db, op(taskId, { kind: 'remember', costUsd: null }))

    expect(memoryCostForTask(db, taskId)).toEqual({ costUsd: null, ops: 2 })
  })
})

describe('listMemoryOps', () => {
  it('uğursuz əməliyyat da saxlanılır', () => {
    // Sınmış yaddaş taskı dayandırmır, amma izsiz qalsa istifadəçi cavabların
    // niyə pisləşdiyini heç vaxt tapa bilməzdi.
    const { db, taskId } = setup()
    recordMemoryOp(db, op(taskId, { ok: false, items: 0, detail: 'ECONNREFUSED' }))

    expect(listMemoryOps(db, taskId)).toMatchObject([{ ok: false, detail: 'ECONNREFUSED' }])
  })

  it('task silinəndə sətirlər də gedir (kaskad)', () => {
    const { db, taskId } = setup()
    recordMemoryOp(db, op(taskId))

    db.$client.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    expect(listMemoryOps(db, taskId)).toEqual([])
  })
})
