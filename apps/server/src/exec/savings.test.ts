import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import {
  appendEvent,
  applyUsageToRun,
  createContext,
  createRun,
  createTask,
  finishRun,
  setTaskStatus,
} from '../db/repo.js'
import {
  modelRowId,
  setExclusiveRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { recordRoutingDecision } from '../db/routing-repo.js'
import { computeTaskSavings } from './savings.js'

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
    outputModalities: ['text'],
    source: 'models.dev',
    ...over,
  }
}

interface Setup {
  db: Db
  taskId: string
}

/** Başçı: 1M giriş = $15, 1M çıxış = $75 (Opus səviyyəsi). İşçi ucuzdur. */
function setup(opts: { boss?: boolean } = {}): Setup {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  upsertModels(db, 'anthropic', [
    model(),
    model({ modelId: 'başçı', displayName: 'Başçı', price: { input: 15, output: 75 } }),
  ])
  if (opts.boss !== false) setExclusiveRole(db, 'boss', modelRowId('anthropic', 'başçı'))

  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'salam' })
  setTaskStatus(db, task.id, 'succeeded')
  return { db, taskId: task.id }
}

interface RunSpec {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  subscription?: boolean
  cached?: boolean
  rung?: number
}

function addRun(db: Db, taskId: string, spec: RunSpec = {}): string {
  const run = createRun(db, {
    taskId,
    runnerId: 'api:anthropic',
    modelId: 'ucuz',
    subscriptionBilled: spec.subscription ?? false,
    cachedHit: spec.cached ?? false,
    ladderRung: spec.rung ?? 2,
  })
  const usage = {
    t: 'usage' as const,
    inputTokens: spec.inputTokens ?? 1000,
    outputTokens: spec.outputTokens ?? 500,
    ...(spec.costUsd !== undefined ? { costUsd: spec.costUsd } : {}),
    billed: (spec.subscription === true ? 'subscription' : 'real') as 'subscription' | 'real',
  }
  if (spec.cached === true) {
    // Keş təkrarı hadisələri jurnala YAZIR, amma run sətrinin tokenlərinə
    // toxunmur — heç nə xərclənməyib. Ladder-in real davranışı budur.
    appendEvent(db, run.id, usage)
  } else {
    applyUsageToRun(db, run.id, usage)
  }
  finishRun(db, run.id, { status: 'succeeded' })
  return run.id
}

describe('computeTaskSavings — real xərc', () => {
  it('icraların real xərcini toplayır', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    addRun(db, taskId, { costUsd: 0.02 })

    expect(computeTaskSavings(db, taskId).actualCostUsd).toBeCloseTo(0.03, 6)
  })

  it('abunəlik xərcini real pula QARIŞDIRMIR', () => {
    // CLI icraları abunəlikdən gedir — kartdan pul çıxmır. Onu `actual`-a
    // qatsaq "bu qədər xərclədin" yalanı olardı (CLAUDE.md qayda 5).
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.0085, subscription: true })

    const s = computeTaskSavings(db, taskId)
    expect(s.actualCostUsd).toBe(0)
    expect(s.actualSubscriptionUsd).toBeCloseTo(0.0085, 6)
  })

  it('xərci bilinməyən icra varsa real xərc BİLİNMİR', () => {
    // `codex` xərc bildirmir. `0` saysaq qənaət olduğundan böyük görünərdi.
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    addRun(db, taskId, {}) // costUsd yoxdur

    expect(computeTaskSavings(db, taskId).actualCostUsd).toBeNull()
  })

  it('token xərcləməyən icranın naməlum xərci nəticəni pozmur', () => {
    // Sıfır token = xərc yoxdur; qiymətin bilinməməsi əhəmiyyətsizdir
    // (eyni prinsip `computeCostUsd`-dədir, qayda 15).
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    addRun(db, taskId, { inputTokens: 0, outputTokens: 0 })

    expect(computeTaskSavings(db, taskId).actualCostUsd).toBeCloseTo(0.01, 6)
  })
})

describe('computeTaskSavings — baseline', () => {
  it('eyni tokenləri başçının qiymətləri ilə hesablayır', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 6 })

    const s = computeTaskSavings(db, taskId)
    // 1M × $15 + 1M × $75 = $90
    expect(s.baselineCostUsd).toBeCloseTo(90, 6)
    expect(s.baselineModelId).toBe('anthropic:başçı')
  })

  it('başçı təyin olunmayıbsa baseline BİLİNMİR', () => {
    const { db, taskId } = setup({ boss: false })
    addRun(db, taskId, { costUsd: 0.01 })

    const s = computeTaskSavings(db, taskId)
    expect(s.baselineCostUsd).toBeNull()
    expect(s.netSavingUsd).toBeNull()
  })

  it('uğursuz task üçün baseline hesablanmır', () => {
    // Uğursuz taskda "qənaət etdim" demək olmaz — nəticə alınmayıb.
    // Xərc isə real gedib, ona görə o, saxlanılır.
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    setTaskStatus(db, taskId, 'failed')

    const s = computeTaskSavings(db, taskId)
    expect(s.baselineCostUsd).toBeNull()
    expect(s.netSavingUsd).toBeNull()
    expect(s.actualCostUsd).toBeCloseTo(0.01, 6)
  })

  it('başçının qiyməti abunəlikdirsə bunu bildirir', () => {
    // CLI başçısı ilə müqayisə "istinad qiyməti"dir — UI onu real pul kimi
    // göstərməməlidir.
    const { db, taskId } = setup()
    upsertProvider(db, { id: 'cli:claude', displayName: 'Claude CLI', kind: 'cli' })
    upsertModels(db, 'cli:claude', [
      model({ providerId: 'cli:claude', modelId: 'cli-başçı', price: { input: 15, output: 75 } }),
    ])
    setExclusiveRole(db, 'boss', modelRowId('cli:claude', 'cli-başçı'))
    addRun(db, taskId, { costUsd: 0.01 })

    expect(computeTaskSavings(db, taskId).baselineSubscription).toBe(true)
  })
})

describe('computeTaskSavings — keş vurması', () => {
  it('keşdən gələn nəticədə real xərc SIFIRDIR', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { cached: true, inputTokens: 1_000_000, outputTokens: 1_000_000 })

    const s = computeTaskSavings(db, taskId)
    expect(s.actualCostUsd).toBe(0)
    expect(s.cachedHit).toBe(true)
  })

  it('keş vurmasında qənaət TAM sayılır (baseline − 0)', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { cached: true, inputTokens: 1_000_000, outputTokens: 1_000_000 })

    const s = computeTaskSavings(db, taskId)
    expect(s.baselineCostUsd).toBeCloseTo(90, 6)
    expect(s.netSavingUsd).toBeCloseTo(90, 6)
  })
})

describe('computeTaskSavings — orkestrasiya xərci', () => {
  it('routing qərarlarının öz xərcini toplayır', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    recordRoutingDecision(db, taskId, {
      strategy: 'classifier',
      runnerId: 'api:anthropic',
      modelId: 'ucuz',
      chosenRowId: 'anthropic:ucuz',
      confidence: 0.9,
      reason: 'klassifikator',
      decisionTokens: 52,
      decisionCostUsd: 0.00002,
    })

    expect(computeTaskSavings(db, taskId).orchestrationCostUsd).toBeCloseTo(0.00002, 8)
  })

  it('orkestrasiya xərci NET QƏNAƏTDƏN ÇIXILIR', () => {
    // Bu, issue-nun mahiyyətidir: orkestratorun öz xərci sayılmasa rəqəm yalan olar.
    const { db, taskId } = setup()
    addRun(db, taskId, { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 6 })
    recordRoutingDecision(db, taskId, {
      strategy: 'classifier',
      runnerId: 'api:anthropic',
      modelId: 'ucuz',
      chosenRowId: 'anthropic:ucuz',
      confidence: 0.9,
      reason: 'klassifikator',
      decisionTokens: 52,
      decisionCostUsd: 1,
    })

    // baseline 90 − (icra 6 + orkestrasiya 1) = 83
    expect(computeTaskSavings(db, taskId).netSavingUsd).toBeCloseTo(83, 6)
  })

  it('qayda routing-i orkestrasiyaya 0 qatır', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    recordRoutingDecision(db, taskId, {
      strategy: 'rule',
      runnerId: 'api:anthropic',
      modelId: 'ucuz',
      chosenRowId: 'anthropic:ucuz',
      confidence: 0.9,
      reason: 'qayda',
      ruleId: 'short-text-to-api',
      decisionTokens: 0,
      decisionCostUsd: 0,
    })

    expect(computeTaskSavings(db, taskId).orchestrationCostUsd).toBe(0)
  })

  it('qərarın xərci bilinmirsə orkestrasiya xərci də BİLİNMİR', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    recordRoutingDecision(db, taskId, {
      strategy: 'classifier',
      runnerId: 'cli:claude',
      modelId: 'haiku',
      chosenRowId: null,
      confidence: 0.9,
      reason: 'klassifikator (abunəlik)',
      decisionTokens: 52,
      decisionCostUsd: undefined,
    })

    const s = computeTaskSavings(db, taskId)
    expect(s.orchestrationCostUsd).toBeNull()
    expect(s.netSavingUsd).toBeNull()
  })
})

describe('computeTaskSavings — yaddaş xərci', () => {
  it('Faza 3-ə qədər 0-dır, amma sahə mövcuddur', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01 })
    expect(computeTaskSavings(db, taskId).memoryCostUsd).toBe(0)
  })
})

describe('computeTaskSavings — pillə bölgüsü', () => {
  it('hansı pillənin nə qədər xərclədiyini verir', () => {
    const { db, taskId } = setup()
    addRun(db, taskId, { costUsd: 0.01, rung: 2 })
    addRun(db, taskId, { costUsd: 0.05, rung: 7 })

    const byRung = computeTaskSavings(db, taskId).byRung
    expect(byRung).toEqual([
      { rung: 2, runs: 1, costUsd: 0.01, subscriptionUsd: 0 },
      { rung: 7, runs: 1, costUsd: 0.05, subscriptionUsd: 0 },
    ])
  })
})
