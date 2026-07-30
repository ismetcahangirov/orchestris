import type { RunEvent, Runner, WorkflowStep } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import { createContext, listRunsForTask } from '../db/repo.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createWorkflow, listStepRuns } from '../db/workflow-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Decomposer } from './decomposer.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'
import { WorkflowEngine } from './workflow-engine.js'

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

function taskStep(id: string, prompt: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { kind: 'task', id, prompt, ...over } as WorkflowStep
}

interface SetupOptions {
  worker?: readonly (readonly RunEvent[])[]
  boss?: readonly (readonly RunEvent[])[]
  profile?: string
  fetchImpl?: typeof fetch
  allowHosts?: string[]
}

function setup(opts: SetupOptions = {}) {
  const db: Db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  // `cheap` — eskalasiyasız tək işçi icrası. Zəncir məntiqi pillələrdən
  // asılı deyil, ona görə ən sadə profil seçilir.
  const ctx = { ...row, amplificationProfile: opts.profile ?? 'cheap', maxParallel: 1 }

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
  const worker = new FakeRunner({
    id: 'api:anthropic',
    kind: 'api',
    capabilities: caps,
    ...(opts.worker !== undefined
      ? { eventsPerCall: opts.worker }
      : { events: answer('İŞÇİ CAVABI') }),
  })
  const boss = new FakeRunner({
    id: 'api:openai',
    kind: 'api',
    capabilities: caps,
    eventsPerCall: opts.boss ?? [answer('BAŞÇI CAVABI')],
  })

  const runners = new Map<string, Runner>([
    ['api:anthropic', worker],
    ['api:openai', boss],
  ])
  const supervisor = new RunSupervisor(db)
  const router = new WorkerRouter(db, runners)
  const ladder = new Ladder(db, supervisor, router)
  const decomposer = new Decomposer(db, supervisor, ladder, router)
  const engine = new WorkflowEngine({
    db,
    ladder,
    decomposer,
    allow: { hosts: opts.allowHosts ?? [] },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })

  const makeWorkflow = (steps: WorkflowStep[]) =>
    createWorkflow(db, { contextId: ctx.id, name: 'W', steps })

  return { db, engine, ctx, worker, boss, makeWorkflow }
}

describe('WorkflowEngine — zəncir', () => {
  it('addımları sıra ilə qaçırır və çıxışı növbətinin girişinə verir', async () => {
    const { db, engine, ctx, worker, makeWorkflow } = setup({
      worker: [answer('BİRİNCİ NƏTİCƏ'), answer('İKİNCİ NƏTİCƏ')],
    })
    const spy = vi.spyOn(worker, 'run')
    const wf = makeWorkflow([
      taskStep('a', 'birinci işi gör'),
      taskStep('b', 'bunun üzərində davam et: {{previous}}'),
    ])

    const result = await engine.run({
      workflowId: wf.id,
      steps: [taskStep('a', 'birinci işi gör'), taskStep('b', 'davam: {{previous}}')],
      context: ctx,
      trigger: 'manual',
    })

    expect(result.status).toBe('succeeded')
    expect(spy.mock.calls[1]?.[0].prompt).toContain('BİRİNCİ NƏTİCƏ')
    expect(result.output).toBe('İKİNCİ NƏTİCƏ')
    expect(listStepRuns(db, result.workflowRunId)).toHaveLength(2)
  })

  it('başlanğıc giriş BİRİNCİ addımın `{{previous}}` dəyəridir', async () => {
    const { engine, ctx, worker, makeWorkflow } = setup()
    const spy = vi.spyOn(worker, 'run')
    const wf = makeWorkflow([taskStep('a', 'giriş: {{previous}}')])

    await engine.run({
      workflowId: wf.id,
      steps: [taskStep('a', 'giriş: {{previous}}')],
      context: ctx,
      trigger: 'manual',
      input: 'XARİCİ GİRİŞ',
    })

    expect(spy.mock.calls[0]?.[0].prompt).toContain('XARİCİ GİRİŞ')
  })

  it('`{{step:id}}` ilə əvvəlki İSTƏNİLƏN addıma müraciət olunur', async () => {
    const { engine, ctx, worker, makeWorkflow } = setup({
      worker: [answer('A-NIN NƏTİCƏSİ'), answer('B'), answer('C')],
    })
    const spy = vi.spyOn(worker, 'run')
    const steps = [
      taskStep('a', 'birinci'),
      taskStep('b', 'ikinci'),
      taskStep('c', 'üçüncü, a-ya baxır: {{step:a}}'),
    ]
    const wf = makeWorkflow(steps)

    await engine.run({ workflowId: wf.id, steps, context: ctx, trigger: 'manual' })

    expect(spy.mock.calls[2]?.[0].prompt).toContain('A-NIN NƏTİCƏSİ')
  })

  it('hər addım öz nərdivanından keçir — ayrıca task və icra yaradılır', async () => {
    const { db, engine, ctx, makeWorkflow } = setup()
    const steps = [taskStep('a', 'bir'), taskStep('b', 'iki')]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    const stepRuns = listStepRuns(db, result.workflowRunId)
    const taskIds = stepRuns.map((s) => s.taskId)
    expect(new Set(taskIds).size).toBe(2)
    for (const id of taskIds) {
      expect(listRunsForTask(db, id as string).length).toBeGreaterThan(0)
    }
  })
})

describe('WorkflowEngine — şərtli budaqlanma', () => {
  it('şərt ödənməsə addım ATLANIR və zəncir davam edir', async () => {
    const { db, engine, ctx, makeWorkflow } = setup()
    const steps: WorkflowStep[] = [
      taskStep('a', 'bir'),
      taskStep('b', 'yalnız sınıqda', { when: { from: 'a', test: 'failed' } }),
      taskStep('c', 'həmişə'),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'skipped', 'succeeded'])
    // Atlanan addım DA sətir yazır: yoxsa istifadəçi "5-ci addım niyə
    // işləmədi?" sualının cavabını heç yerdə tapa bilməzdi.
    const rows = listStepRuns(db, result.workflowRunId)
    expect(rows[1]).toMatchObject({ stepId: 'b', status: 'skipped' })
    expect(rows[1]?.detail).toContain('a.failed')
  })

  it('ATLANAN addım `{{previous}}` üçün ŞƏFFAFDIR', async () => {
    // Əks halda budaqlanma özünü sındırardı: atlanan addımdan sonrakı hər
    // addım boş giriş alardı.
    const { engine, ctx, worker, makeWorkflow } = setup({
      worker: [answer('A-NIN NƏTİCƏSİ'), answer('C')],
    })
    const spy = vi.spyOn(worker, 'run')
    const steps: WorkflowStep[] = [
      taskStep('a', 'bir'),
      taskStep('b', 'atlanacaq', { when: { from: 'a', test: 'failed' } }),
      taskStep('c', 'əvvəlki: {{previous}}'),
    ]
    const wf = makeWorkflow(steps)

    await engine.run({ workflowId: wf.id, steps, context: ctx, trigger: 'manual' })

    expect(spy.mock.calls[1]?.[0].prompt).toContain('A-NIN NƏTİCƏSİ')
  })

  it('zəncir məntiqi SIFIR əlavə icra xərcləyir', async () => {
    // Şərtləri modelə versəydik ("keçək?"), hər addım əlavə icra ödəyərdi.
    const { db, engine, ctx, makeWorkflow } = setup()
    const steps: WorkflowStep[] = [
      taskStep('a', 'bir'),
      taskStep('b', 'iki', { when: { from: 'a', test: 'succeeded' } }),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    const total = listStepRuns(db, result.workflowRunId)
      .map((s) => (s.taskId === null ? 0 : listRunsForTask(db, s.taskId).length))
      .reduce((a, b) => a + b, 0)
    // İki addım = iki icra. Şərt heç nə əlavə etmir.
    expect(total).toBe(2)
  })
})

describe('WorkflowEngine — sınıq addım', () => {
  const failing = [{ t: 'error' as const, class: 'crashed' as const, message: 'sındı' }]

  it('sınıq addım zənciri DAYANDIRIR', async () => {
    const { engine, ctx, makeWorkflow } = setup({ worker: [failing] })
    const steps = [taskStep('a', 'bir'), taskStep('b', 'iki')]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.status).toBe('failed')
    expect(result.steps).toHaveLength(1)
    expect(result.error).toContain('sındı')
  })

  it('`continueOnError` ilə zəncir davam edir və `failed` şərti işlək olur', async () => {
    const { engine, ctx, makeWorkflow } = setup({ worker: [failing, answer('TƏMİR')] })
    const steps: WorkflowStep[] = [
      taskStep('a', 'bir', { continueOnError: true }),
      taskStep('b', 'təmir', { when: { from: 'a', test: 'failed' } }),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'succeeded'])
    // Bir addım sınıbsa zəncirin YEKUNU uğursuzdur — təmir addımı bunu
    // gizlətməməlidir.
    expect(result.status).toBe('failed')
  })
})

describe('WorkflowEngine — təkrar', () => {
  it('`until` ödənənə qədər təkrarlayır və hər cəhd ÖZ əvvəlki çıxışını alır', async () => {
    const { db, engine, ctx, makeWorkflow } = setup({
      worker: [answer('cəhd 1'), answer('cəhd 2'), answer('HAZIRDIR')],
    })
    const steps: WorkflowStep[] = [
      // `{{previous}}` VACİBDİR: onsuz prompt dəyişmir, Pillə 0 keşi eyni cavabı
      // qaytarır və dövrə boş fırlanardı.
      taskStep('a', 'düzəlt: {{previous}}', {
        repeat: { max: 5, until: { from: 'previous', test: 'contains', value: 'HAZIRDIR' } },
      }),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.output).toBe('HAZIRDIR')
    expect(listStepRuns(db, result.workflowRunId)).toHaveLength(3)
  })

  it('`max` həddi aşılmır — hər təkrar YENİ task, yəni yeni xərcdir', async () => {
    const { db, engine, ctx, makeWorkflow } = setup({ worker: [answer('heç vaxt')] })
    const steps: WorkflowStep[] = [
      taskStep('a', 'düzəlt: {{previous}}', {
        repeat: { max: 2, until: { from: 'previous', test: 'contains', value: 'YOXDUR' } },
      }),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(listStepRuns(db, result.workflowRunId)).toHaveLength(2)
  })

  it('promptu dəyişməyən təkrar KEŞƏ düşür — faydasızdır, amma BAHALI deyil', async () => {
    // Pillə 0: eyni prompt → eyni keş açarı. Mənasız təkrar pul yandırmır.
    const { db, engine, ctx, makeWorkflow } = setup({ worker: [answer('eyni')] })
    const steps: WorkflowStep[] = [
      taskStep('a', 'sabit prompt', {
        repeat: { max: 3, until: { from: 'previous', test: 'contains', value: 'YOXDUR' } },
      }),
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    const stepRuns = listStepRuns(db, result.workflowRunId)
    expect(stepRuns).toHaveLength(3)
    const cached = stepRuns
      .slice(1)
      .flatMap((s) => listRunsForTask(db, s.taskId as string))
      .filter((r) => r.cachedHit)
    expect(cached.length).toBeGreaterThan(0)
  })
})

describe('WorkflowEngine — büdcə', () => {
  it('büdcə addımlar ARASINDA paylaşılır', async () => {
    // Hər addım limiti təzədən alsaydı, on addımlı zəncir limitin on mislini
    // xərcləyə bilərdi.
    const { db, engine, ctx, makeWorkflow } = setup({
      worker: [
        [
          { t: 'text', delta: 'cavab' },
          { t: 'usage', inputTokens: 10, outputTokens: 100, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      ],
    })
    const steps = [taskStep('a', 'bir'), taskStep('b', 'iki'), taskStep('c', 'üç')]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
      limits: { maxOutputTokens: 100 },
    })

    expect(result.status).toBe('budget_exceeded')
    const executed = listStepRuns(db, result.workflowRunId).filter((s) => s.taskId !== null)
    expect(executed).toHaveLength(1)
  })
})

describe('WorkflowEngine — HTTP addımı', () => {
  it('gövdədə dəyişən əvəzlənir, URL-də YOX', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('OK'))
    const { engine, ctx, makeWorkflow } = setup({
      worker: [answer('MODEL NƏTİCƏSİ')],
      allowHosts: ['api.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const steps: WorkflowStep[] = [
      taskStep('a', 'işlə'),
      {
        kind: 'http',
        id: 'h',
        method: 'POST',
        url: 'https://api.example.com/hook',
        body: '{"text":"{{previous}}"}',
      },
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.status).toBe('succeeded')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/hook')
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toContain('MODEL NƏTİCƏSİ')
  })

  it('ağ siyahı boşdursa HTTP addımı sınır və ŞƏBƏKƏYƏ ÇIXILMIR', async () => {
    const fetchImpl = vi.fn()
    const { engine, ctx, makeWorkflow } = setup({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const steps: WorkflowStep[] = [
      { kind: 'http', id: 'h', method: 'GET', url: 'https://api.example.com/x' },
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(result.status).toBe('failed')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.output).toContain('ORCHESTRIS_WORKFLOW_HTTP_ALLOW')
  })

  it('HTTP addımı task YARATMIR', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('OK'))
    const { db, engine, ctx, makeWorkflow } = setup({
      allowHosts: ['api.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const steps: WorkflowStep[] = [
      { kind: 'http', id: 'h', method: 'GET', url: 'https://api.example.com/x' },
    ]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(listStepRuns(db, result.workflowRunId)[0]?.taskId).toBeNull()
  })
})

describe('WorkflowEngine — icra tarixçəsi', () => {
  it('tərif icra ANINDA saxlanılır — sonrakı redaktə tarixçəni dəyişmir', async () => {
    const { db, engine, ctx, makeWorkflow } = setup()
    const steps = [taskStep('a', 'ilk tərif')]
    const wf = makeWorkflow(steps)

    const result = await engine.run({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    const { getWorkflowRun } = await import('../db/workflow-repo.js')
    expect(getWorkflowRun(db, result.workflowRunId)?.stepsJson).toContain('ilk tərif')
  })

  it('`start()` id-ni DƏRHAL qaytarır — icranın bitməsini gözləmir', () => {
    const { engine, ctx, makeWorkflow } = setup()
    const steps = [taskStep('a', 'bir')]
    const wf = makeWorkflow(steps)

    const started = engine.start({
      workflowId: wf.id,
      steps,
      context: ctx,
      trigger: 'manual',
    })

    expect(started.workflowRunId).toMatch(/^[0-9a-f-]{36}$/)
    return started.done
  })
})
