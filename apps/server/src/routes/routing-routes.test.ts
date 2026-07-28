import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb, type Db } from '../db/client.js'
import {
  modelRowId,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

const CATALOG: Catalog = { source: 'bundled', providers: [] }

function model(over: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    providerId: 'anthropic',
    modelId: 'haiku',
    displayName: 'Haiku',
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

function makeApp(): { app: ReturnType<typeof buildApp>; db: Db } {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  upsertModels(db, 'anthropic', [model()])
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)

  const runners = new Map<string, Runner>([
    [
      'api:anthropic',
      new FakeRunner({
        id: 'api:anthropic',
        kind: 'api',
        events: DONE,
        capabilities: { fileAccess: false, subscriptionBilled: false },
      }),
    ],
  ])

  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { app, db }
}

async function newContext(app: ReturnType<typeof buildApp>): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contexts',
    payload: { name: 'C' },
  })
  return res.json() as { id: string }
}

/** Task fon rejimində icra olunur — bitməsini gözləyir. */
async function waitForTask(
  app: ReturnType<typeof buildApp>,
  taskId: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const body = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    if (body.task.status !== 'pending' && body.task.status !== 'running') return body
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('task bitmədi')
}

describe('POST /api/tasks — Auto rejimi', () => {
  it('model verilməsə router seçir', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'Bu cümləni tərcümə et: salam' },
    })
    expect(res.statusCode).toBe(202)

    const body = await waitForTask(app, res.json().taskId)
    expect(body.task).toMatchObject({ status: 'succeeded' })
    expect(body.routing).toMatchObject({
      strategy: 'rule',
      runnerId: 'api:anthropic',
      modelId: 'haiku',
      decisionTokens: 0,
    })
  })

  it('qərarın səbəbi cavabda görünür', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'Bu cümləni tərcümə et: salam' },
    })

    const body = await waitForTask(app, res.json().taskId)
    expect(String((body.routing as { reason: string }).reason)).toContain('qayda')
  })

  it('model verilibsə əl ilə seçim sayılır', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'p', runner: 'api:anthropic', model: 'əl-ilə' },
    })

    const body = await waitForTask(app, res.json().taskId)
    expect(body.routing).toMatchObject({ strategy: 'manual', modelId: 'əl-ilə' })
  })

  it('işçi təyin olunmayıbsa task səbəbi ilə uğursuz olur', async () => {
    const { app, db } = makeApp()
    setWorkerRole(db, modelRowId('anthropic', 'haiku'), false)
    const ctx = await newContext(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'Bu cümləni tərcümə et: salam' },
    })
    const body = await waitForTask(app, res.json().taskId)
    expect(body.task).toMatchObject({ status: 'failed' })
  })
})

describe('GET /api/routing/rules', () => {
  it('quraşdırılmış qaydaları izahı ilə qaytarır', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/api/routing/rules' })).json()

    expect(body.rules.length).toBeGreaterThan(0)
    expect(body.rules[0]).toMatchObject({ id: expect.any(String), prefer: expect.any(String) })
    expect(String(body.rules[0].description).length).toBeGreaterThan(10)
  })

  it('amplifikasiya profillərini sadalayır', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/api/routing/rules' })).json()
    expect(body.profiles).toContain('boss-only')
  })
})

describe('PATCH /api/contexts/:id', () => {
  it('amplifikasiya profilini dəyişir', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { amplificationProfile: 'boss-only' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().amplificationProfile).toBe('boss-only')
  })

  it('default işçini təyin edir', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { defaultWorkerModelId: 'anthropic:haiku' },
    })
    expect(res.json().defaultWorkerModelId).toBe('anthropic:haiku')
  })

  it('naməlum profili 400 ilə rədd edir', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { amplificationProfile: 'uydurma' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('mövcud olmayan kontekst üçün 404', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/contexts/yoxdur',
      payload: { amplificationProfile: 'cheap' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('verilməyən sahələri dəyişmir', async () => {
    const { app } = makeApp()
    const ctx = await newContext(app)
    await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { amplificationProfile: 'cheap' },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { workerMode: 'manual' },
    })
    expect(res.json()).toMatchObject({ amplificationProfile: 'cheap', workerMode: 'manual' })
  })
})
