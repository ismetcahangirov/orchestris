import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createContext, listRunsForTask, listSubtasks } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

function answer(text: string): RunEvent[] {
  return [
    { t: 'text', delta: text },
    { t: 'done', stopReason: 'end_turn' },
  ]
}

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
    outputModalities: ['text'],
    source: 'models.dev',
    ...over,
  }
}

/** Fon icrası bitənə qədər gözləyir — `POST /api/tasks` 202 ilə dərhal qayıdır. */
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

function setup(bossAnswer: RunEvent[]) {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })

  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  upsertProvider(db, { id: 'openai', displayName: 'OpenAI' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  setProviderCredentialRef(db, 'openai', 'provider:openai')
  upsertModels(db, 'anthropic', [model()])
  upsertModels(db, 'openai', [
    model({ providerId: 'openai', modelId: 'başçı', displayName: 'Başçı' }),
  ])
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)
  setExclusiveRole(db, 'boss', modelRowId('openai', 'başçı'))

  const caps = { fileAccess: false, subscriptionBilled: false }
  const runners = new Map<string, Runner>([
    [
      'api:anthropic',
      new FakeRunner({ id: 'api:anthropic', kind: 'api', capabilities: caps, events: answer('parça cavabı') }),
    ],
    [
      'api:openai',
      new FakeRunner({ id: 'api:openai', kind: 'api', capabilities: caps, events: bossAnswer }),
    ],
  ])

  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, app, ctx }
}

async function submit(
  app: ReturnType<typeof buildApp>,
  contextId: string,
  decompose: boolean,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      contextId,
      prompt: 'Sənədi hazırla: giriş, əsas hissə və nəticə',
      ...(decompose ? { decompose: true } : {}),
    },
  })
  expect(res.statusCode).toBe(202)
  return (res.json() as { taskId: string }).taskId
}

describe('POST /api/tasks — dekompozisiya', () => {
  it('`decompose: true` alt-tasklar yaradır və ağac cavabda görünür', async () => {
    const { db, app, ctx } = setup(
      answer(JSON.stringify({ subtasks: ['giriş yaz', 'nəticə yaz'] })),
    )
    const taskId = await submit(app, ctx.id, true)

    await settle(() => listSubtasks(db, taskId).length === 2)

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })
    const body = detail.json() as { subtasks: { prompt: string; subtaskIndex: number }[] }
    expect(body.subtasks.map((s) => s.prompt)).toEqual(['giriş yaz', 'nəticə yaz'])
    expect(body.subtasks.map((s) => s.subtaskIndex)).toEqual([0, 1])
  })

  it('bölgü alınmasa task ADİ nərdivandan keçir — nəticə itmir', async () => {
    // MONOTON QAYDA (qayda 32): bir orkestrasiya qərarının uğursuzluğu
    // istifadəçinin nəticəsini məhv etməməlidir.
    const { db, app, ctx } = setup(answer('bölgü verə bilmirəm'))
    const taskId = await submit(app, ctx.id, true)

    // Bölgü icrası (-2) + adi işçi icrası.
    await settle(() => listRunsForTask(db, taskId).some((r) => r.ladderRung >= 0))

    expect(listSubtasks(db, taskId)).toHaveLength(0)
    const rungs = listRunsForTask(db, taskId).map((r) => r.ladderRung)
    expect(rungs).toContain(-2)
    expect(rungs.some((r) => r >= 0)).toBe(true)
  })

  it('bayraq verilməsə başçı ÜMUMİYYƏTLƏ çağırılmır', async () => {
    const { db, app, ctx } = setup(
      answer(JSON.stringify({ subtasks: ['giriş yaz', 'nəticə yaz'] })),
    )
    const taskId = await submit(app, ctx.id, false)

    await settle(() => listRunsForTask(db, taskId).length > 0)

    expect(listSubtasks(db, taskId)).toHaveLength(0)
    expect(listRunsForTask(db, taskId).every((r) => r.ladderRung !== -2)).toBe(true)
  })
})
