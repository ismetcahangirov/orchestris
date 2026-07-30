import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
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
import { FakeRunner } from '../runners/fake.js'
import { WorkerRouter } from './decide.js'

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

/** Fayl girişi olan (CLI kimi) və olmayan (API kimi) iki saxta runner. */
function fakeRunners(classifierAnswer?: string): Map<string, Runner> {
  const cli = new FakeRunner({
    kind: 'cli',
    events: [{ t: 'done', stopReason: 'end_turn' }],
    capabilities: { fileAccess: true, subscriptionBilled: true },
  })
  const api = new FakeRunner({
    kind: 'api',
    events:
      classifierAnswer === undefined
        ? [{ t: 'done', stopReason: 'end_turn' }]
        : [
            { t: 'text', delta: classifierAnswer },
            { t: 'usage', inputTokens: 40, outputTokens: 12, costUsd: 0.00002, billed: 'real' },
            { t: 'done', stopReason: 'end_turn' },
          ],
    capabilities: { fileAccess: false, subscriptionBilled: false },
  })
  return new Map<string, Runner>([
    ['cli:claude', cli],
    ['api:anthropic', api],
  ])
}

interface SetupOptions {
  /** İşçi kimi işarələnəcək modellər. */
  workers?: ('cli' | 'api')[]
  classifierAnswer?: string
  boss?: boolean
  classifier?: boolean
}

function setup(opts: SetupOptions = {}): { db: Db; runners: Map<string, Runner> } {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  upsertProvider(db, { id: 'cli:claude', displayName: 'Claude CLI', kind: 'cli' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')

  upsertModels(db, 'anthropic', [model()])
  upsertModels(db, 'cli:claude', [model({ providerId: 'cli:claude', modelId: 'cli-haiku' })])
  upsertModels(db, 'anthropic', [model({ modelId: 'başçı', displayName: 'Başçı' })])

  for (const w of opts.workers ?? ['cli', 'api']) {
    setWorkerRole(
      db,
      w === 'cli' ? modelRowId('cli:claude', 'cli-haiku') : modelRowId('anthropic', 'haiku'),
      true,
    )
  }
  if (opts.boss === true) setExclusiveRole(db, 'boss', modelRowId('anthropic', 'başçı'))
  if (opts.classifier === true) {
    setExclusiveRole(db, 'classifier', modelRowId('anthropic', 'haiku'))
  }

  return { db, runners: fakeRunners(opts.classifierAnswer) }
}

const TASK = { id: 't1', prompt: 'src/app.ts faylını düzəlt' }
const TEXT_TASK = { id: 't2', prompt: 'Bu cümləni tərcümə et: salam' }
const VAGUE_TASK = { id: 't3', prompt: 'x'.repeat(600) }

const CTX = { cwd: null, amplificationProfile: 'balanced', defaultWorkerModelId: null }

describe('WorkerRouter — əl ilə seçim', () => {
  it('istifadəçinin seçdiyi runner-i olduğu kimi işlədir', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({
      task: TASK,
      context: CTX,
      manual: { runnerId: 'cli:claude', modelId: 'istənilən-model' },
    })
    expect(out).toMatchObject({
      ok: true,
      decision: { strategy: 'manual', modelId: 'istənilən-model', decisionTokens: 0 },
    })
  })

  it('mövcud olmayan runner üçün səbəbi ilə xəta qaytarır', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({
      task: TASK,
      context: CTX,
      manual: { runnerId: 'yoxdur', modelId: 'm' },
    })
    expect(out.ok).toBe(false)
  })
})

describe('WorkerRouter — qayda (0 token)', () => {
  it('fayl taskını CLI namizədinə yönləndirir', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({ task: TASK, context: CTX })
    expect(out).toMatchObject({
      ok: true,
      decision: { strategy: 'rule', runnerId: 'cli:claude', decisionTokens: 0, decisionCostUsd: 0 },
    })
  })

  it('qısa mətn taskını API namizədinə yönləndirir', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({ task: TEXT_TASK, context: CTX })
    expect(out).toMatchObject({ ok: true, decision: { runnerId: 'api:anthropic' } })
  })

  it('icazə verilməmiş modelə HEÇ VAXT keçmir', async () => {
    // Yalnız CLI işçi kimi işarələnib; mətn taskı üçün qayda API deyir, amma
    // icazə verilmiş API işçisi yoxdur → API modelinə keçmir.
    const { db, runners } = setup({ workers: ['cli'] })
    const out = await new WorkerRouter(db, runners).decide({ task: TEXT_TASK, context: CTX })
    expect(out).toMatchObject({ ok: true })
    if (out.ok) expect(out.decision.runnerId).toBe('cli:claude')
  })

  it('heç bir işçi icazəli deyilsə səbəbi ilə xəta qaytarır', async () => {
    const { db, runners } = setup({ workers: [] })
    const out = await new WorkerRouter(db, runners).decide({ task: TASK, context: CTX })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/işçi/i)
  })
})

describe('WorkerRouter — klassifikator', () => {
  it('qayda tutmadıqda klassifikatoru çağırır və xərcini qeyd edir', async () => {
    const { db, runners } = setup({
      classifier: true,
      classifierAnswer: '{"model":"cli:claude:cli-haiku","confidence":0.9}',
    })
    const out = await new WorkerRouter(db, runners).decide({ task: VAGUE_TASK, context: CTX })
    expect(out).toMatchObject({
      ok: true,
      decision: {
        strategy: 'classifier',
        runnerId: 'cli:claude',
        decisionTokens: 52,
        decisionCostUsd: 0.00002,
      },
    })
  })

  it('klassifikator təyin olunmayıbsa onu ÇAĞIRMIR', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({ task: VAGUE_TASK, context: CTX })
    expect(out).toMatchObject({ ok: true, decision: { decisionTokens: 0 } })
    if (out.ok) expect(out.decision.strategy).not.toBe('classifier')
  })

  it('klassifikator əmin deyilsə default/fallback-a keçir, xərci isə saxlanılır', async () => {
    const { db, runners } = setup({
      classifier: true,
      classifierAnswer: 'bilmirəm',
    })
    const out = await new WorkerRouter(db, runners).decide({ task: VAGUE_TASK, context: CTX })
    expect(out).toMatchObject({ ok: true })
    // Qərar klassifikatordan gəlmədi, amma çağırış PUL YANDIRDI — o xərc
    // itməməlidir, yoxsa orkestrasiya xərci olduğundan az görünər (issue #8).
    if (out.ok) {
      expect(out.decision.strategy).toBe('fallback')
      expect(out.decision.decisionTokens).toBe(52)
      expect(out.decision.decisionCostUsd).toBe(0.00002)
    }
  })
})

describe('WorkerRouter — default işçi', () => {
  it('kontekstin default işçisini seçir', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({
      task: VAGUE_TASK,
      context: { ...CTX, defaultWorkerModelId: modelRowId('anthropic', 'haiku') },
    })
    expect(out).toMatchObject({ ok: true, decision: { strategy: 'default' } })
  })
})

describe('WorkerRouter — boss-only profili (baseline)', () => {
  it('başçı modelini seçir və qaydaları YAN KEÇİR', async () => {
    // Baseline ölçmək üçün: "hər şey başçı ilə görülsəydi nə olardı?"
    const { db, runners } = setup({ boss: true })
    const out = await new WorkerRouter(db, runners).decide({
      task: TASK,
      context: { ...CTX, amplificationProfile: 'boss-only' },
    })
    expect(out).toMatchObject({
      ok: true,
      decision: { strategy: 'boss', modelId: 'başçı', decisionTokens: 0 },
    })
  })

  it('başçı təyin olunmayıbsa səbəbi ilə xəta qaytarır', async () => {
    const { db, runners } = setup()
    const out = await new WorkerRouter(db, runners).decide({
      task: TASK,
      context: { ...CTX, amplificationProfile: 'boss-only' },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/başçı/i)
  })

  it('əl ilə seçim boss-only profilini ÜSTƏLƏYİR', async () => {
    // İstifadəçi açıq seçim edibsə, profil onu susdurmamalıdır.
    const { db, runners } = setup({ boss: true })
    const out = await new WorkerRouter(db, runners).decide({
      task: TASK,
      context: { ...CTX, amplificationProfile: 'boss-only' },
      manual: { runnerId: 'cli:claude', modelId: 'əl-ilə' },
    })
    expect(out).toMatchObject({ ok: true, decision: { strategy: 'manual' } })
  })
})
