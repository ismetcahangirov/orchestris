import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb, type Db } from '../db/client.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

/** İşçi 1M giriş = $1; başçı 1M giriş = $15 — qənaət görünən olsun. */
function model(over: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    providerId: 'anthropic',
    modelId: 'ucuz',
    displayName: 'Ucuz',
    price: { input: 1, output: 5 },
    contextLimit: 200_000,
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    inputModalities: ['text'],
    source: 'models.dev',
    ...over,
  }
}

const EVENTS: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  {
    t: 'usage',
    inputTokens: 1_000_000,
    outputTokens: 0,
    costUsd: 1,
    billed: 'real',
  },
  { t: 'done', stopReason: 'end_turn' },
]

function makeApp(): { app: ReturnType<typeof buildApp>; db: Db } {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  upsertModels(db, 'anthropic', [
    model(),
    model({ modelId: 'başçı', displayName: 'Başçı', price: { input: 15, output: 75 } }),
  ])
  setWorkerRole(db, modelRowId('anthropic', 'ucuz'), true)
  setExclusiveRole(db, 'boss', modelRowId('anthropic', 'başçı'))

  const runners = new Map<string, Runner>([
    [
      'api:anthropic',
      new FakeRunner({
        id: 'api:anthropic',
        kind: 'api',
        events: EVENTS,
        capabilities: { fileAccess: false, subscriptionBilled: false },
      }),
    ],
  ])

  return { app: buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG }), db }
}

async function runTask(
  app: ReturnType<typeof buildApp>,
  prompt = 'Bu cümləni tərcümə et: salam',
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contexts',
    payload: { name: 'C' },
  })
  const ctx = res.json() as { id: string }
  const created = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { contextId: ctx.id, prompt },
  })
  const taskId = (created.json() as { taskId: string }).taskId

  for (let i = 0; i < 60; i++) {
    const body = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    if (body.task.status === 'succeeded' || body.task.status === 'failed') return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('task bitmədi')
}

describe('GET /api/stats/savings', () => {
  it('task yoxdursa sıfırlarla cavab verir, çökmür', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/stats/savings' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ summary: { taskCount: 0, netSavingUsd: 0 } })
  })

  it('icra olunmuş taskın qənaətini hesablayır', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (await app.inject({ method: 'GET', url: '/api/stats/savings' })).json()
    // baseline: 1M × $15 = $15; real xərc $1; orkestrasiya 0 (qayda routing)
    expect(body.summary.taskCount).toBe(1)
    expect(body.summary.actualCostUsd).toBeCloseTo(1, 6)
    expect(body.summary.baselineCostUsd).toBeCloseTo(15, 6)
    expect(body.summary.netSavingUsd).toBeCloseTo(14, 6)
  })

  it('orkestrasiya xərcini ayrıca sətir kimi verir', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (await app.inject({ method: 'GET', url: '/api/stats/savings' })).json()
    expect(body.summary).toHaveProperty('orchestrationCostUsd')
    expect(body.summary.orchestrationCostUsd).toBe(0)
  })

  it('abunəlik xərcini real puldan ayrı verir', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (await app.inject({ method: 'GET', url: '/api/stats/savings' })).json()
    expect(body.summary).toHaveProperty('actualSubscriptionUsd')
  })

  it('task tipinə görə bölgü qaytarır', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (await app.inject({ method: 'GET', url: '/api/stats/savings' })).json()
    expect(body.summary.byTaskType[0]).toMatchObject({ taskType: 'translate', tasks: 1 })
  })

  it('dövr filtri qəbul edir', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (
      await app.inject({ method: 'GET', url: '/api/stats/savings?period=day' })
    ).json()
    expect(body.period).toBe('day')
    expect(body.summary.taskCount).toBe(1)
  })

  it('naməlum dövr üçün 400 verir', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/stats/savings?period=əsr' })
    expect(res.statusCode).toBe(400)
  })

  it('son taskların siyahısını da verir — /history üçün', async () => {
    const { app } = makeApp()
    await runTask(app)

    const body = (await app.inject({ method: 'GET', url: '/api/stats/savings' })).json()
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({ taskType: 'translate', netSavingUsd: 14 })
    expect(body.tasks[0].prompt).toContain('tərcümə')
  })
})
