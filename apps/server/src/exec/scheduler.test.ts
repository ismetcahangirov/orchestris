import type { RunEvent, Runner, WorkflowStep } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import {
  modelRowId,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createContext } from '../db/repo.js'
import {
  createSchedule,
  createWorkflow,
  getSchedule,
  listWorkflowRuns,
  updateWorkflow,
} from '../db/workflow-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { Scheduler } from './scheduler.js'
import { RunSupervisor } from './supervisor.js'
import { WorkflowEngine } from './workflow-engine.js'

const T0 = 1_800_000_000_000

/** Xərc bildirən icra — cədvəlin USD tavanı bunun üzərində ölçülür. */
function paidAnswer(costUsd: number): RunEvent[] {
  return [
    { t: 'text', delta: 'cavab' },
    { t: 'usage', inputTokens: 10, outputTokens: 10, costUsd, billed: 'real' },
    { t: 'done', stopReason: 'end_turn' },
  ]
}

/** Abunəlik icrası — REAL xərc `0`-dır, yəni USD tavanı onu heç vaxt tutmur. */
const SUBSCRIPTION_ANSWER: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0.5, billed: 'subscription' },
  { t: 'done', stopReason: 'end_turn' },
]

/** Xərci BİLİNMƏYƏN icra — qiymətsiz model, `usage`-də `costUsd` yoxdur. */
const UNKNOWN_COST_ANSWER: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'usage', inputTokens: 10, outputTokens: 10, billed: 'real' },
  { t: 'done', stopReason: 'end_turn' },
]

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

const STEPS: WorkflowStep[] = [{ kind: 'task', id: 'a', prompt: 'işlə' }]

interface SetupOptions {
  events?: readonly RunEvent[]
  eventsPerCall?: readonly (readonly RunEvent[])[]
  /** Modelin qiyməti — verilməsə `undefined` (xərc bilinmir). */
  price?: { input: number; output: number } | undefined
  steps?: WorkflowStep[]
}

function setup(opts: SetupOptions = {}) {
  const db: Db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })

  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  upsertModels(db, 'anthropic', [
    model(opts.price === undefined ? {} : { price: opts.price }),
  ])
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)

  const runner = new FakeRunner({
    id: 'api:anthropic',
    kind: 'api',
    capabilities: { fileAccess: false, subscriptionBilled: false },
    ...(opts.eventsPerCall !== undefined
      ? { eventsPerCall: opts.eventsPerCall }
      : { events: opts.events ?? paidAnswer(0.01) }),
  })
  const runners = new Map<string, Runner>([['api:anthropic', runner]])
  const supervisor = new RunSupervisor(db)
  const ladder = new Ladder(db, supervisor, new WorkerRouter(db, runners))
  const engine = new WorkflowEngine({ db, ladder })
  const scheduler = new Scheduler(db, engine)

  const workflow = createWorkflow(db, {
    contextId: ctx.id,
    name: 'W',
    steps: opts.steps ?? STEPS,
  })

  const schedule = (over: Partial<Parameters<typeof createSchedule>[1]> = {}) =>
    createSchedule(db, {
      workflowId: workflow.id,
      intervalSeconds: 60,
      budgetUsdPerRun: 1,
      budgetUsdTotal: 10,
      maxRuns: 100,
      startAt: T0,
      ...over,
    })

  return { db, scheduler, workflow, schedule, ctx }
}

describe('Scheduler — vaxt', () => {
  it('vaxtı çatmayan cədvəl qaçmır', async () => {
    const { scheduler, schedule } = setup()
    schedule({ startAt: T0 + 60_000 })

    const result = await scheduler.tick(T0)

    expect(result.started).toEqual([])
  })

  it('vaxtı çatan cədvəl icranı başladır və növbəti vaxtı yazır', async () => {
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule()

    const result = await scheduler.tick(T0)

    expect(result.started).toHaveLength(1)
    expect(listWorkflowRuns(db, workflow.id)[0]?.trigger).toBe('schedule')
    const after = getSchedule(db, s.id)
    expect(after?.nextRunAt).toBe(T0 + 60_000)
    expect(after?.runs).toBe(1)
  })

  it('söndürülmüş cədvəl qaçmır', async () => {
    const { db, scheduler, schedule } = setup()
    const s = schedule()
    const { updateSchedule } = await import('../db/workflow-repo.js')
    updateSchedule(db, s.id, { enabled: false })

    expect((await scheduler.tick(T0)).started).toEqual([])
  })

  it('yeni cədvəl DƏRHAL qaçmır — default bir interval sonradır', () => {
    // Cədvəl yaradan kimi icra başlasaydı, istifadəçi limitləri yoxlamağa
    // macal tapmazdı.
    const { db, workflow } = setup()
    const s = createSchedule(db, {
      workflowId: workflow.id,
      intervalSeconds: 3600,
      budgetUsdPerRun: 1,
      budgetUsdTotal: 10,
      maxRuns: 5,
    })
    expect(s.nextRunAt).toBeGreaterThan(Date.now() + 3_000_000)
  })
})

describe('Scheduler — sərt büdcə (issue #12)', () => {
  it('icranın REAL xərci cədvələ yığılır', async () => {
    const { db, scheduler, schedule } = setup({ events: paidAnswer(0.6) })
    const s = schedule({ budgetUsdTotal: 10 })

    await scheduler.tick(T0)

    expect(getSchedule(db, s.id)?.spentUsd).toBeCloseTo(0.6, 5)
    expect(getSchedule(db, s.id)?.enabled).toBe(true)
  })

  it('ümumi büdcə dolanda cədvəl SÖNDÜRÜLÜR', async () => {
    // Tək `budgetUsdPerRun` kifayət etməzdi: dəqiqədə $0.50 aylıq $21,600-dür.
    const { db, scheduler, schedule } = setup({ events: paidAnswer(0.6) })
    const s = schedule({ budgetUsdTotal: 1 })

    await scheduler.tick(T0)
    // İkinci icra tavanı aşacaq — amma tavan İCRADAN ƏVVƏL yoxlanılır, ona görə
    // yığılmış xərc həddə çatan kimi cədvəl dayanır.
    const { addScheduleSpend } = await import('../db/workflow-repo.js')
    addScheduleSpend(db, s.id, 0.6)

    const next = await scheduler.tick(T0 + 60_000)

    expect(next.started).toEqual([])
    expect(next.disabled[0]?.reason).toContain('ümumi büdcə')
    expect(getSchedule(db, s.id)?.enabled).toBe(false)
  })

  it('eyni promptlu cədvəl icrası KEŞDƏN gəlir — xərc ARTMIR', async () => {
    // ÖLÇÜLMÜŞ DAVRANIŞ, təsadüf deyil: cədvəlin addım mətnləri tərifdə
    // SABİTDİR, yəni hər icra eyni keş açarını verir (Pillə 0). İkinci icradan
    // sonra USD tavanı praktiki olaraq DAYANIR — məhz buna görə `max_runs`
    // ayrıca tavan kimi MƏCBURİDİR: USD tək başına cədvəli heç vaxt
    // dayandırmaya bilər.
    const { db, scheduler, schedule } = setup({ events: paidAnswer(0.6) })
    const s = schedule({ budgetUsdTotal: 100, maxRuns: 100 })

    await scheduler.tick(T0)
    const afterFirst = getSchedule(db, s.id)?.spentUsd ?? 0
    await scheduler.tick(T0 + 60_000)

    expect(getSchedule(db, s.id)?.spentUsd).toBeCloseTo(afterFirst, 5)
    expect(getSchedule(db, s.id)?.runs).toBe(2)
  })

  it('icra sayı həddi ABUNƏLİK icralarında yeganə tavandır', async () => {
    // Abunəlikdə real xərc `0`-dır → USD tavanı HEÇ VAXT işə düşmür. `maxRuns`
    // olmasaydı cədvəl sonsuz qaçar və abunəlik limitini yandırardı.
    const { db, scheduler, schedule } = setup({ events: SUBSCRIPTION_ANSWER })
    const s = schedule({ maxRuns: 2, budgetUsdTotal: 1000 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)
    expect(getSchedule(db, s.id)?.spentUsd).toBe(0)

    const third = await scheduler.tick(T0 + 120_000)
    expect(third.started).toEqual([])
    expect(third.disabled[0]?.reason).toContain('icra sayı')
  })

  it('icra sayı tavanı `>=` ilə yoxlanılır — bir vahid sızmır', async () => {
    const { db, scheduler, schedule } = setup()
    const s = schedule({ maxRuns: 1 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)

    expect(getSchedule(db, s.id)?.runs).toBe(1)
    expect(getSchedule(db, s.id)?.enabled).toBe(false)
  })

  it('per-run limiti hər icraya ötürülür və icra ANINDA kəsir', async () => {
    // `BudgetGuard` limiti icra vaxtı tətbiq edir. Yalnız sonradan
    // hesablasaydıq, tavanı aşan icra ARTIQ ödənilmiş olardı.
    const { db, scheduler, schedule, workflow } = setup({ events: paidAnswer(5) })
    schedule({ budgetUsdPerRun: 0.01, budgetUsdTotal: 1000, maxRuns: 5 })

    const result = await scheduler.tick(T0)

    const { listStepRuns } = await import('../db/workflow-repo.js')
    const { listRunsForTask } = await import('../db/repo.js')
    const steps = listStepRuns(db, result.started[0] as string)
    const runs = listRunsForTask(db, steps[0]?.taskId as string)
    expect(runs.some((r) => r.status === 'budget_exceeded')).toBe(true)
    expect(listWorkflowRuns(db, workflow.id)[0]?.status).toBe('failed')
  })

  it('xərci BİLİNMƏYƏN icra cədvəli söndürür — tavan kor qala bilməz', async () => {
    // Qayda 4: naməlum `0` deyil. Adi taskda bu ölçmə boşluğudur; AVTOMATİK
    // icrada isə "nə qədər xərclədiyimi bilmirəm, amma davam edirəm" deməkdir.
    const { db, scheduler, schedule } = setup({
      events: UNKNOWN_COST_ANSWER,
      price: undefined,
    })
    const s = schedule()

    await scheduler.tick(T0)

    expect(getSchedule(db, s.id)?.enabled).toBe(false)
    expect(getSchedule(db, s.id)?.disabledReason).toContain('bilinmir')
  })
})

describe('Scheduler — sınıq konfiqurasiya', () => {
  it('arxivləşdirilmiş zəncirdə cədvəl söndürülür', async () => {
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule()
    updateWorkflow(db, workflow.id, { archived: true })

    const result = await scheduler.tick(T0)

    expect(result.started).toEqual([])
    expect(getSchedule(db, s.id)?.disabledReason).toContain('arxiv')
  })

  it('tərifi oxunmayan zəncirdə cədvəl söndürülür — hər tikdə təkrarlanmır', async () => {
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule()
    // JSON sütun sxem təminatı vermir: sətir əl ilə (və ya köhnə versiya ilə)
    // korlana bilər və səhv icranın ORTASINDA üzə çıxardı.
    const { workflows } = await import('../db/schema.js')
    const { eq } = await import('drizzle-orm')
    db.update(workflows)
      .set({ stepsJson: '{yararsız' })
      .where(eq(workflows.id, workflow.id))
      .run()

    const result = await scheduler.tick(T0)

    expect(result.started).toEqual([])
    expect(getSchedule(db, s.id)?.enabled).toBe(false)
  })
})
