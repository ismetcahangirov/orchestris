import type { RunEvent, RunOptions, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import { listMemoryOps } from '../db/memory-repo.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createContext, createTask } from '../db/repo.js'
import { getSavings } from '../db/savings-repo.js'
import type { MemoryItem, MemoryProvider } from '../memory/provider.js'
import { MemorySession } from '../memory/session.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const TEXT_TASK = 'Bu cümləni tərcümə et: salam'

function answer(text: string): RunEvent[] {
  return [
    { t: 'text', delta: text },
    {
      t: 'usage',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
      billed: 'real',
    },
    { t: 'done', stopReason: 'end_turn' },
  ]
}

const ESCALATE = answer('{"escalate": true, "reason": "kontekst çatmır"}')

class FakeProvider implements MemoryProvider {
  readonly id = 'fake'
  readonly recalls: { query: string; scope: string }[] = []
  readonly written: { scope: string; items: readonly MemoryItem[] }[] = []

  constructor(
    private readonly opts: { items?: MemoryItem[]; writeCost?: number | null } = {},
  ) {}

  async recall(query: string, scope: string) {
    this.recalls.push({ query, scope })
    return { items: this.opts.items ?? [], costUsd: 0 }
  }

  async remember(scope: string, items: readonly MemoryItem[]) {
    this.written.push({ scope, items })
    return { costUsd: 'writeCost' in this.opts ? (this.opts.writeCost ?? null) : 0 }
  }

  async health() {
    return { ok: true }
  }
}

/**
 * Promptları yadda saxlayan işçi.
 *
 * Bu testlərin əsas sualı "işçiyə NƏ göndərildi?"dir — `runs` cədvəli promptu
 * saxlamır, ona görə onu runner səviyyəsində tutmaq lazımdır.
 */
class SpyRunner extends FakeRunner {
  readonly prompts: string[] = []

  override async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    this.prompts.push(req.prompt)
    yield* super.run(req, opts)
  }
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
    source: 'models.dev',
    ...over,
  }
}

interface Setup {
  db: Db
  ladder: Ladder
  worker: SpyRunner
  provider: FakeProvider
  ctx: {
    id: string
    cwd: string | null
    verifyCommandsJson: string
    amplificationProfile: string
    memoryEnabled?: boolean
    memoryScope?: string | null
  }
  newTask: (prompt?: string) => ReturnType<typeof createTask>
}

function setup(
  opts: { provider?: FakeProvider; worker?: readonly (readonly RunEvent[])[] } = {},
): Setup {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = { ...row, amplificationProfile: 'balanced' }

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
  const worker = new SpyRunner({
    id: 'api:anthropic',
    kind: 'api',
    capabilities: caps,
    ...(opts.worker !== undefined
      ? { eventsPerCall: opts.worker }
      : { events: answer('cavab') }),
  })
  const boss = new FakeRunner({
    id: 'api:openai',
    kind: 'api',
    capabilities: caps,
    events: answer('başçının cavabı'),
  })
  const runners = new Map<string, Runner>([
    ['api:anthropic', worker],
    ['api:openai', boss],
  ])

  const provider = opts.provider ?? new FakeProvider()
  const ladder = new Ladder(
    db,
    new RunSupervisor(db),
    new WorkerRouter(db, runners),
    undefined,
    new MemorySession(db, provider),
  )

  return {
    db,
    ladder,
    worker,
    provider,
    ctx,
    newTask: (prompt = TEXT_TASK) => createTask(db, { contextId: ctx.id, prompt }),
  }
}

describe('Yaddaş — oxuma (recall)', () => {
  it('qeydlər İŞÇİ promptuna ETİBARSIZ çərçivə ilə qoşulur', async () => {
    const s = setup({
      provider: new FakeProvider({ items: [{ id: 'm1', text: 'bu layihədə pnpm işlədilir' }] }),
    })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    const prompt = s.worker.prompts[0] ?? ''
    expect(prompt).toContain('bu layihədə pnpm işlədilir')
    expect(prompt).toContain('trust="untrusted"')
    expect(prompt).toContain('GÖSTƏRİŞ DEYİL')
  })

  it('yaddaş TASK MƏTNİNDƏN SONRA gəlir — prefiks toxunulmazdır (qayda 29)', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    const prompt = s.worker.prompts[0] ?? ''
    expect(prompt.startsWith(TEXT_TASK)).toBe(true)
  })

  it('müqavilə (Pillə 6) yaddaşdan SONRA qalır — son göstəriş olmalıdır', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    const prompt = s.worker.prompts[0] ?? ''
    expect(prompt.indexOf('QEYD')).toBeLessThan(prompt.indexOf('escalate'))
  })

  it('kontekstdə söndürülübsə prompt DƏYİŞMİR', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    await s.ladder.run({
      task: s.newTask(),
      context: { ...s.ctx, memoryEnabled: false },
    })

    // Müqavilə suffiksi (Pillə 6) qalır — dəyişməməli olan YADDAŞDIR.
    expect(s.worker.prompts[0]).not.toContain('recalled_memory')
    expect(s.provider.recalls).toEqual([])
  })

  it('sahə verilməyibsə kontekstin id-si işlədilir', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(s.provider.recalls[0]?.scope).toBe(s.ctx.id)
  })
})

describe('Yaddaş — keş açarı', () => {
  it('yaddaşlı cavab yaddaşsız icraya QAYTARILMIR', async () => {
    // Açara girməsəydi, ikinci (yaddaşsız) task birincinin cavabını keşdən
    // alardı — halbuki onun promptu tamamilə fərqli idi.
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    const first = await s.ladder.run({ task: s.newTask(), context: s.ctx })
    expect(first.cached).toBe(false)

    const second = await s.ladder.run({
      task: s.newTask(),
      context: { ...s.ctx, memoryEnabled: false },
    })

    expect(second.cached).toBe(false)
  })

  it('yaddaş DƏYİŞMƏYİBSƏ keş işləyir — Pillə 0 itmir', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })
    const second = await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(second.cached).toBe(true)
    expect(second.finalRung).toBe(0)
  })
})

describe('Yaddaş — yazma (remember)', () => {
  it('uğurlu nəticə yazılır', async () => {
    const s = setup()

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(s.provider.written).toHaveLength(1)
    expect(s.provider.written[0]?.items[0]?.text).toContain('cavab')
  })

  it('UĞURSUZ task yazılmır — səhv cavab bütün sahəni zəhərləyərdi', async () => {
    const s = setup({
      worker: [[{ t: 'error', class: 'crashed', message: 'sındı' }, { t: 'done', stopReason: 'error' }]],
    })

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(s.provider.written).toEqual([])
  })

  it('KEŞDƏN gələn nəticə yenidən yazılmır', async () => {
    const s = setup()

    await s.ladder.run({ task: s.newTask(), context: s.ctx })
    const second = await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(second.cached).toBe(true)
    expect(s.provider.written).toHaveLength(1)
  })

  it('işçi imtina edib başçı həll edəndə də yazılır', async () => {
    // Nəticə uğurludur — onu kimin verdiyi yaddaş üçün əhəmiyyətsizdir.
    const s = setup({ worker: [ESCALATE] })

    const result = await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(result.status).toBe('succeeded')
    expect(s.provider.written[0]?.items[0]?.text).toContain('başçının cavabı')
  })
})

describe('Yaddaş — ölçmə', () => {
  it('xərc `savings_ledger`-də AYRICA sütunda görünür', async () => {
    const s = setup({ provider: new FakeProvider({ writeCost: 0.0005 }) })

    const task = s.newTask()
    await s.ladder.run({ task, context: s.ctx })

    expect(getSavings(s.db, task.id)?.memoryCostUsd).toBeCloseTo(0.0005, 6)
  })

  it('naməlum yaddaş xərci net qənaəti NAMƏLUM edir', async () => {
    // Susub `0` yazsaydıq, ödədiyimiz pul qənaət kimi görünərdi.
    const s = setup({ provider: new FakeProvider({ writeCost: null }) })

    const task = s.newTask()
    await s.ladder.run({ task, context: s.ctx })

    const row = getSavings(s.db, task.id)
    expect(row?.memoryCostUsd).toBeNull()
    expect(row?.netSavingUsd).toBeNull()
  })

  it('yaddaş nəticəyə TOXUNMUR — pillə nömrəsi dəyişmir', async () => {
    const s = setup({ provider: new FakeProvider({ items: [{ id: 'm1', text: 'QEYD' }] }) })

    const result = await s.ladder.run({ task: s.newTask(), context: s.ctx })

    // Yoxlama əmri olmayan `balanced` taskı Pillə 3-dən (best-of-N) keçir —
    // yaddaş bu axını NƏ dəyişir, nə də özü ayrıca pillə sayılır.
    expect(result.finalRung).toBe(3)
    expect(result.memory).toEqual({ recalled: 1, tokens: expect.any(Number) })
  })

  it('əməliyyatlar jurnalda qalır', async () => {
    const s = setup({ provider: new FakeProvider({ writeCost: 0.0005 }) })

    const task = s.newTask()
    await s.ladder.run({ task, context: s.ctx })

    expect(listMemoryOps(s.db, task.id)).toMatchObject([
      { kind: 'remember', provider: 'fake', ok: true },
    ])
  })
})
