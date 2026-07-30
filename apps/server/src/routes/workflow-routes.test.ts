import type { RunEvent, Runner, WorkflowStep } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import {
  modelRowId,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createContext } from '../db/repo.js'
import { getWorkflowRun } from '../db/workflow-repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }
const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

function model(): ModelUpsert {
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
  }
}

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
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
        capabilities: { fileAccess: false, subscriptionBilled: false },
        events: DONE,
      }),
    ],
  ])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, app, ctx }
}

const STEPS: WorkflowStep[] = [
  { kind: 'task', id: 'a', prompt: 'birinci' },
  { kind: 'task', id: 'b', prompt: 'ikinci: {{previous}}' },
]

async function createWf(app: ReturnType<typeof buildApp>, contextId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: { contextId, name: 'Zəncir', steps: STEPS },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { workflow: { id: string } }).workflow.id
}

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('workflow REST', () => {
  it('zəncir yaradılır və siyahıda görünür', async () => {
    const { app, ctx } = setup()
    const id = await createWf(app, ctx.id)

    const list = await app.inject({ method: 'GET', url: '/api/workflows' })
    const body = list.json() as { workflows: { id: string; lastRun: unknown }[] }
    expect(body.workflows.map((w) => w.id)).toEqual([id])
    // Son icra siyahı ilə birlikdə gəlir — ayrıca sorğu N+1 yaradardı.
    expect(body.workflows[0]?.lastRun).toBeNull()
  })

  it('yararsız addım siyahısı 400 verir', async () => {
    const { app, ctx } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { contextId: ctx.id, name: 'X', steps: [{ kind: 'task', id: 'a' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('təkrarlanan addım id-si 400 verir', async () => {
    // Təkrar id səssiz səhv olardı: `{{step:x}}` və şərtlər HANSI `x`-ə
    // baxdığını bilməzdi.
    const { app, ctx } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        contextId: ctx.id,
        name: 'X',
        steps: [
          { kind: 'task', id: 'a', prompt: 'bir' },
          { kind: 'task', id: 'a', prompt: 'iki' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('icra 202 ilə DƏRHAL qayıdır və vəziyyət ayrıca sorğulanır', async () => {
    const { db, app, ctx } = setup()
    const id = await createWf(app, ctx.id)

    const res = await app.inject({ method: 'POST', url: `/api/workflows/${id}/run` })
    expect(res.statusCode).toBe(202)
    const { workflowRunId } = res.json() as { workflowRunId: string }

    await settle(() => getWorkflowRun(db, workflowRunId)?.status !== 'running')

    const detail = await app.inject({ method: 'GET', url: `/api/workflow-runs/${workflowRunId}` })
    const body = detail.json() as {
      run: { status: string }
      steps: { stepId: string; status: string }[]
    }
    expect(body.run.status).toBe('succeeded')
    expect(body.steps.map((s) => s.stepId)).toEqual(['a', 'b'])
  })

  it('arxivləşdirilmiş zəncir işə salınmır və siyahıdan çıxır', async () => {
    const { app, ctx } = setup()
    const id = await createWf(app, ctx.id)

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${id}`,
      payload: { archived: true },
    })
    expect(patched.statusCode).toBe(200)

    const run = await app.inject({ method: 'POST', url: `/api/workflows/${id}/run` })
    expect(run.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: '/api/workflows' })
    expect((list.json() as { workflows: unknown[] }).workflows).toHaveLength(0)

    // Tarixçə üçün sətir QALIR — arxivləşdirmə silmək deyil.
    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}` })
    expect(detail.statusCode).toBe(200)
  })

  it('cədvəl LİMİTSİZ qurula bilmir', async () => {
    // Issue #12: nəzarətsiz cədvəl "$0.50 testdə → $50,000/ay" ssenarisinin ən
    // asan yoludur. Limitlər sxemdə MƏCBURİDİR, ona görə hər biri ayrıca
    // yoxlanılır — biri opsional qalsaydı, məhz o istiqamətdən sızardı.
    const { app, ctx } = setup()
    const id = await createWf(app, ctx.id)
    const base = {
      workflowId: id,
      intervalSeconds: 3600,
      budgetUsdPerRun: 0.5,
      budgetUsdTotal: 10,
      maxRuns: 20,
      maxPendingDiffs: 5,
    }

    for (const missing of ['budgetUsdPerRun', 'budgetUsdTotal', 'maxRuns', 'maxPendingDiffs'] as const) {
      const payload: Record<string, unknown> = { ...base }
      delete payload[missing]
      const res = await app.inject({ method: 'POST', url: '/api/schedules', payload })
      expect(res.statusCode, `${missing} olmadan qəbul edildi`).toBe(400)
    }

    const ok = await app.inject({ method: 'POST', url: '/api/schedules', payload: base })
    expect(ok.statusCode).toBe(201)
  })

  it('minimum intervaldan qısa cədvəl rədd olunur', async () => {
    const { app, ctx } = setup()
    const id = await createWf(app, ctx.id)
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: {
        workflowId: id,
        intervalSeconds: 5,
        budgetUsdPerRun: 0.5,
        budgetUsdTotal: 10,
        maxRuns: 20,
        maxPendingDiffs: 5,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('arxivləşdirilmiş zəncirə cədvəl qurulmur', async () => {
    const { app, ctx } = setup()
    const id = await createWf(app, ctx.id)
    await app.inject({
      method: 'PATCH',
      url: `/api/workflows/${id}`,
      payload: { archived: true },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: {
        workflowId: id,
        intervalSeconds: 3600,
        budgetUsdPerRun: 0.5,
        budgetUsdTotal: 10,
        maxRuns: 20,
        maxPendingDiffs: 5,
      },
    })
    expect(res.statusCode).toBe(409)
  })

  it('cədvəli yenidən açanda söndürülmə səbəbi TƏMİZLƏNİR', async () => {
    // Köhnə "büdcə doldu" mətni işləyən cədvəlin yanında qalsaydı, istifadəçi
    // onu hələ də söndürülmüş sayardı.
    const { db, app, ctx } = setup()
    const id = await createWf(app, ctx.id)
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: {
        workflowId: id,
        intervalSeconds: 3600,
        budgetUsdPerRun: 0.5,
        budgetUsdTotal: 10,
        maxRuns: 20,
        maxPendingDiffs: 5,
      },
    })
    const scheduleId = (created.json() as { schedule: { id: string } }).schedule.id

    const { disableSchedule, getSchedule } = await import('../db/workflow-repo.js')
    disableSchedule(db, scheduleId, 'ümumi büdcə doldu')

    await app.inject({
      method: 'PATCH',
      url: `/api/schedules/${scheduleId}`,
      payload: { enabled: true },
    })

    expect(getSchedule(db, scheduleId)?.disabledReason).toBeNull()
  })

  it('tanınmayan kontekst 404 verir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { contextId: 'yoxdur', name: 'X', steps: STEPS },
    })
    expect(res.statusCode).toBe(404)
  })
})
