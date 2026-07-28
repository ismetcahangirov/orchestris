import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import { createContext, createTask, getTask, listRunsForTask } from '../db/repo.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { latestRoutingDecision } from '../db/routing-repo.js'
import { getSavings } from '../db/savings-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

function model(over: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    providerId: 'cli:claude',
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
  cli: FakeRunner
  api: FakeRunner
  ctx: ReturnType<typeof createContext>
  newTask: (prompt?: string) => ReturnType<typeof createTask>
}

/**
 * İki işçi: fayl girişi olan CLI və olmayan API.
 *
 * `fileAccess` keş açarına birbaşa təsir edir (`cache-key.ts`): iş qovluğu
 * bilinmədən fayl taskının nəticəsini keşləmək təhlükəlidir, ona görə keş
 * testləri fayl girişi OLMAYAN işçi ilə aparılır.
 */
function setup(opts: { verifyCommands?: string[]; boss?: boolean } = {}): Setup {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C', verifyCommands: opts.verifyCommands ?? [] })

  upsertProvider(db, { id: 'cli:claude', displayName: 'Claude CLI', kind: 'cli' })
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')

  upsertModels(db, 'cli:claude', [model()])
  upsertModels(db, 'anthropic', [
    model({ providerId: 'anthropic' }),
    model({ providerId: 'anthropic', modelId: 'başçı', displayName: 'Başçı' }),
  ])
  setWorkerRole(db, modelRowId('cli:claude', 'haiku'), true)
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)
  if (opts.boss === true) setExclusiveRole(db, 'boss', modelRowId('anthropic', 'başçı'))

  const cli = new FakeRunner({ id: 'cli:claude', kind: 'cli', events: DONE })
  const api = new FakeRunner({
    id: 'api:anthropic',
    kind: 'api',
    events: DONE,
    capabilities: { fileAccess: false, subscriptionBilled: false },
  })
  const runners = new Map<string, Runner>([
    ['cli:claude', cli],
    ['api:anthropic', api],
  ])
  const ladder = new Ladder(db, new RunSupervisor(db), new WorkerRouter(db, runners))

  return {
    db,
    ladder,
    cli,
    api,
    ctx,
    newTask: (prompt = 'src/app.ts faylını düzəlt') =>
      createTask(db, { contextId: ctx.id, prompt }),
  }
}

describe('Ladder — Pillə 1 inteqrasiyası', () => {
  it('runner verilməyəndə router seçir və icra edir', async () => {
    const { ladder, ctx, newTask } = setup()
    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.decision).toMatchObject({ strategy: 'rule', runnerId: 'cli:claude' })
  })

  it('qərarı routing_decisions cədvəlinə yazır', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const task = newTask()
    await ladder.run({ task, context: ctx })

    expect(latestRoutingDecision(db, task.id)).toMatchObject({
      strategy: 'rule',
      runnerId: 'cli:claude',
      modelId: 'haiku',
      chosenModelId: 'cli:claude:haiku',
      ruleId: 'file-work-to-cli',
      // Qayda routing-i SIFIR token xərcləyir — qəbul kriteriyası budur.
      decisionTokens: 0,
      decisionCostUsd: 0,
    })
  })

  it('icra qərar verilən model ilə gedir', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const task = newTask()
    await ladder.run({ task, context: ctx })

    expect(listRunsForTask(db, task.id)[0]).toMatchObject({
      runnerId: 'cli:claude',
      modelId: 'haiku',
    })
  })

  it('əl ilə runner verilibsə router-ə TOXUNMUR', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const manual = new FakeRunner({ kind: 'api', events: DONE })
    const task = newTask()

    await ladder.run({ task, context: ctx, runner: manual, model: 'əl-ilə-model' })

    expect(latestRoutingDecision(db, task.id)).toMatchObject({
      strategy: 'manual',
      modelId: 'əl-ilə-model',
    })
  })

  it('uyğun işçi yoxdursa task uğursuz olur və İCRA BAŞLAMIR', async () => {
    const { db, ladder, ctx, newTask } = setup()
    // İşçi rolunu geri alırıq → namizəd qalmır.
    setWorkerRole(db, modelRowId('cli:claude', 'haiku'), false)
    setWorkerRole(db, modelRowId('anthropic', 'haiku'), false)

    const task = newTask()
    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toMatch(/işçi/i)
    // Heç bir model çağırılmadı — pul yanmadı.
    expect(listRunsForTask(db, task.id)).toHaveLength(0)
    expect(getTask(db, task.id)?.status).toBe('failed')
  })
})

describe('Ladder — amplifikasiya profilləri', () => {
  it('boss-only profilində başçı seçilir', async () => {
    const { ladder, ctx, newTask } = setup({ boss: true })
    const result = await ladder.run({
      task: newTask(),
      context: { ...ctx, amplificationProfile: 'boss-only' },
    })
    expect(result.decision).toMatchObject({ strategy: 'boss', modelId: 'başçı' })
  })

  it('boss-only profilində keş OXUNMUR — baseline dürüst olmalıdır', async () => {
    // Keşdən cavab qaytarsaq "başçı bu taskı nə qədər xərcləyir" sualına
    // cavab ala bilmərik; baseline ölçməsi mənasız olar.
    const { ladder, ctx, api, newTask } = setup({ boss: true })
    const spy = vi.spyOn(api, 'run')
    const bossCtx = { ...ctx, amplificationProfile: 'boss-only' }

    await ladder.run({ task: newTask('Bu cümləni tərcümə et: salam'), context: bossCtx })
    await ladder.run({ task: newTask('Bu cümləni tərcümə et: salam'), context: bossCtx })

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('boss-only profilində nəticə keşə YAZILMIR', async () => {
    const { ladder, ctx, newTask } = setup({ boss: true })
    const result = await ladder.run({
      task: newTask('Bu cümləni tərcümə et: salam'),
      context: { ...ctx, amplificationProfile: 'boss-only' },
    })
    expect(result.cacheKey).toBeNull()
  })

  it('boss-only profilində yoxlama dövrəsi işləmir', async () => {
    // Baseline "güclü model bir dəfə işlədi" deməkdir; alət dövrəsi
    // amplifikasiyadır və baseline-a girməməlidir.
    const failCmd = `"${process.execPath}" -e "process.exit(1)"`
    const { ladder, ctx, newTask } = setup({ boss: true, verifyCommands: [failCmd] })

    const result = await ladder.run({
      task: newTask(),
      context: { ...ctx, amplificationProfile: 'boss-only' },
    })
    expect(result.attempts).toBe(1)
    expect(result.verificationPassed).toBeNull()
  })

  it('balanslı profildə keş və yoxlama işləyir', async () => {
    const { ladder, ctx, api, newTask } = setup()
    const spy = vi.spyOn(api, 'run')

    const prompt = 'Bu cümləni tərcümə et: salam'
    await ladder.run({ task: newTask(prompt), context: ctx })
    const second = await ladder.run({ task: newTask(prompt), context: ctx })

    expect(second.cached).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('Ladder — savings_ledger', () => {
  it('task bitəndə ledger sətri yazılır', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const task = newTask('Bu cümləni tərcümə et: salam')
    await ladder.run({ task, context: ctx })

    expect(getSavings(db, task.id)).toMatchObject({ taskId: task.id })
  })

  it('routing-in təyin etdiyi task tipi ledger-ə düşür', async () => {
    // "Mətn tasklarında qənaət kod tasklarından az olacaq" iddiasını yoxlamaq
    // üçün bölgü lazımdır — tip `unknown` qalsaydı bölgü mənasız olardı.
    const { db, ladder, ctx, newTask } = setup()
    const task = newTask('Bu cümləni tərcümə et: salam')
    await ladder.run({ task, context: ctx })

    expect(getTask(db, task.id)?.taskType).toBe('translate')
    expect(getSavings(db, task.id)?.taskType).toBe('translate')
  })

  it('qərarın öz xərci ledger-ə düşür', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const task = newTask()
    await ladder.run({ task, context: ctx })

    // Qayda routing-i 0 token xərcləyir — ledger bunu 0 kimi yazır, NULL yox.
    expect(getSavings(db, task.id)?.orchestrationCostUsd).toBe(0)
  })

  it('heç bir icra baş verməyibsə ledger sətri yazılmır', async () => {
    // "İşçi yoxdur" xətası pul yandırmayıb — ledger-də ölçüləcək bir şey yoxdur.
    const { db, ladder, ctx, newTask } = setup()
    setWorkerRole(db, modelRowId('cli:claude', 'haiku'), false)
    setWorkerRole(db, modelRowId('anthropic', 'haiku'), false)

    const task = newTask()
    await ladder.run({ task, context: ctx })

    expect(getSavings(db, task.id)).toBeUndefined()
  })

  it('keş vurmasında da ledger yazılır', async () => {
    const { db, ladder, ctx, newTask } = setup()
    const prompt = 'Bu cümləni tərcümə et: salam'
    await ladder.run({ task: newTask(prompt), context: ctx })

    const second = newTask(prompt)
    const result = await ladder.run({ task: second, context: ctx })

    expect(result.cached).toBe(true)
    expect(getSavings(db, second.id)?.cachedHit).toBe(true)
  })
})
