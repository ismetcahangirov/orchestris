import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb, type Db } from '../db/client.js'
import { MEMORY_TOKEN_BUDGET } from '../memory/budget.js'
import type { MemoryProvider } from '../memory/provider.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

class SickProvider implements MemoryProvider {
  readonly id = 'claude-mem'
  async recall() {
    return { items: [], costUsd: 0 }
  }
  async remember() {
    return { costUsd: null }
  }
  async health() {
    return { ok: false, detail: 'worker əlçatmazdır' }
  }
}

function makeApp(memory?: MemoryProvider): {
  app: ReturnType<typeof buildApp>
  db: Db
} {
  const db = openDb(':memory:')
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  return {
    app: buildApp({
      db,
      runners,
      credentials: new MemoryStore(),
      ...(memory !== undefined ? { memory } : {}),
    }),
    db,
  }
}

describe('GET /api/memory', () => {
  it('provayder verilməyibsə yaddaş SÖNDÜRÜLÜ görünür', async () => {
    const { app } = makeApp()

    const body = (await app.inject({ method: 'GET', url: '/api/memory' })).json()

    expect(body).toMatchObject({ provider: 'null', active: false })
    // `NullProvider` "sınıq" deyil — söndürülmüş yaddaş XƏTA DEYİL, seçimdir.
    expect(body.health.ok).toBe(true)
  })

  it('hədd SERVERDƏN gəlir — UI öz rəqəmini uydurmamalıdır', async () => {
    const { app } = makeApp()

    const body = (await app.inject({ method: 'GET', url: '/api/memory' })).json()

    expect(body.tokenBudget).toBe(MEMORY_TOKEN_BUDGET)
  })

  it('provayder sınıqdırsa səbəb GÖRÜNÜR', async () => {
    const { app } = makeApp(new SickProvider())

    const body = (await app.inject({ method: 'GET', url: '/api/memory' })).json()

    expect(body).toMatchObject({
      provider: 'claude-mem',
      active: true,
      health: { ok: false, detail: 'worker əlçatmazdır' },
    })
  })
})

describe('PATCH /api/contexts/:id — yaddaş ayarları', () => {
  it('sahə və opt-out saxlanılır', async () => {
    const { app } = makeApp()
    const ctx = (
      await app.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json() as { id: string }

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { memoryScope: 'orchestris', memoryEnabled: false },
    })

    expect(res.json()).toMatchObject({ memoryScope: 'orchestris', memoryEnabled: false })
  })

  it('`null` sahəni AVTOMATİK-ə qaytarır', async () => {
    const { app } = makeApp()
    const ctx = (
      await app.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json() as { id: string }

    await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { memoryScope: 'orchestris' },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { memoryScope: null },
    })

    expect(res.json()).toMatchObject({ memoryScope: null })
  })

  it('verilməyən yaddaş sahəsi DƏYİŞMİR', async () => {
    const { app } = makeApp()
    const ctx = (
      await app.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json() as { id: string }

    await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { memoryEnabled: false },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { amplificationProfile: 'quality' },
    })

    expect(res.json()).toMatchObject({ memoryEnabled: false, amplificationProfile: 'quality' })
  })
})

describe('GET /api/tasks/:id — yaddaş əməliyyatları', () => {
  it('task cavabında `memory` sahəsi var — ayrıca sorğu lazım deyil', async () => {
    const { app } = makeApp()
    const ctx = (
      await app.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json() as { id: string }
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'salam', runner: 'fake', model: 'm' },
      })
    ).json() as { taskId: string }

    const body = (await app.inject({ method: 'GET', url: `/api/tasks/${task.taskId}` })).json()

    expect(body.memory).toEqual([])
  })
})
