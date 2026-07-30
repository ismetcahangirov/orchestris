import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
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
import { createContext, createTask, getTask, listRunsForTask } from '../db/repo.js'
import { getTemplate, saveTemplate } from '../db/template-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { DISTILL_RUNG } from './distill.js'
import { Ladder } from './ladder.js'
import { computeTaskSavings } from './savings.js'
import { RunSupervisor } from './supervisor.js'

/**
 * Mətn taskı — `classify.ts` onu `translate` sayır və routing API işçisinə
 * yönləndirir (fayl yolu yoxdur, ona görə CLI lazım deyil).
 */
const TEXT_TASK = 'Bu cümləni tərcümə et: salam'
const OTHER_TEXT_TASK = 'Bu cümləni də tərcümə et: sağ ol'
const THIRD_TEXT_TASK = 'Bu cümləni tərcümə et: gecən xeyrə qalsın'

function answer(text: string, usage?: { out: number; costUsd: number }): RunEvent[] {
  return [
    { t: 'text', delta: text },
    ...(usage !== undefined
      ? [
          {
            t: 'usage' as const,
            inputTokens: 10,
            outputTokens: usage.out,
            costUsd: usage.costUsd,
            billed: 'real' as const,
          },
        ]
      : []),
    { t: 'done', stopReason: 'end_turn' },
  ]
}

const ESCALATE = answer('{"escalate": true, "reason": "kontekst çatmır", "partial": "YARIMÇIQ"}')

/** Başçının müqaviləyə əməl edən distillə cavabı. */
const TEMPLATE_ANSWER = answer(
  [
    '### İŞÇİ PROMPTU',
    'Əvvəlcə mənbə dilini müəyyən et, sonra cümlə-cümlə tərcümə et.',
    '',
    '### RUBRİKA',
    '- tərcümə tam olmalıdır',
    '- terminlər dəyişdirilməməlidir',
  ].join('\n'),
)

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

interface SetupOptions {
  worker?: readonly (readonly RunEvent[])[]
  /**
   * Başçının cavabı. Default DİSTİLLƏ formatındadır və eyni mətn Pillə 7-nin
   * cavabı kimi də qaytarılır — testlər saxlanılan şablona və icra sətirlərinə
   * baxır, başçının mətninə yox.
   */
  boss?: readonly RunEvent[]
  profile?: string
  verifyCommands?: string[]
}

interface Setup {
  db: Db
  ladder: Ladder
  worker: FakeRunner
  boss: FakeRunner
  ctx: { id: string; cwd: string | null; verifyCommandsJson: string; amplificationProfile: string }
  newTask: (prompt?: string) => ReturnType<typeof createTask>
}

function setup(opts: SetupOptions = {}): Setup {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C', verifyCommands: opts.verifyCommands ?? [] })
  const ctx = { ...row, amplificationProfile: opts.profile ?? 'balanced' }

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
      : { events: answer('cavab') }),
  })
  const boss = new FakeRunner({
    id: 'api:openai',
    kind: 'api',
    capabilities: caps,
    events: opts.boss ?? TEMPLATE_ANSWER,
  })

  const runners = new Map<string, Runner>([
    ['api:anthropic', worker],
    ['api:openai', boss],
  ])
  const ladder = new Ladder(db, new RunSupervisor(db), new WorkerRouter(db, runners))

  return {
    db,
    ladder,
    worker,
    boss,
    ctx,
    newTask: (prompt = TEXT_TASK) => createTask(db, { contextId: ctx.id, prompt }),
  }
}

/** İşçinin imtina etdiyi bir task — hər çağırış qapıya bir sayğac əlavə edir. */
async function escalatedTask(s: Setup, prompt: string): Promise<void> {
  await s.ladder.run({ task: s.newTask(prompt), context: s.ctx })
}

describe('Prompt distilləsi — şablonun YAZILMASI', () => {
  it('tip BİR dəfə ilişəndə şablon yazılmır — bir dəfəlik task ola bilər', async () => {
    const s = setup({ worker: [ESCALATE] })

    await escalatedTask(s, TEXT_TASK)

    expect(getTemplate(s.db, 'translate')).toBeUndefined()
  })

  it('İKİNCİ ilişmədən sonra başçı şablonu yazır', async () => {
    const s = setup({ worker: [ESCALATE] })

    await escalatedTask(s, TEXT_TASK)
    await escalatedTask(s, OTHER_TEXT_TASK)

    expect(getTemplate(s.db, 'translate')).toMatchObject({
      taskType: 'translate',
      authoredByModelId: 'başçı',
    })
    expect(getTemplate(s.db, 'translate')?.workerPrompt).toContain('mənbə dilini')
  })

  it('distillə icrası NƏRDİVANDAN KƏNAR pillə ilə qeyd olunur', async () => {
    // 0–7 aralığından bir nömrə seçsəydik "taskların <20%-i 7-yə çatsın"
    // hədəfi (qayda 31) bir dəfəlik investisiyanı tam başçı icrası kimi sayardı.
    const s = setup({ worker: [ESCALATE] })
    await escalatedTask(s, TEXT_TASK)

    const task = s.newTask(OTHER_TEXT_TASK)
    await s.ladder.run({ task, context: s.ctx })

    const rungs = listRunsForTask(s.db, task.id).map((r) => r.ladderRung)
    expect(rungs).toEqual([2, 7, DISTILL_RUNG])
  })

  it('başçı müqaviləyə əməl etməsə HEÇ NƏ saxlanılmır', async () => {
    // Səhv şablon bir taska deyil, BÜTÜN gələcək tasklara yapışardı.
    const s = setup({ worker: [ESCALATE], boss: answer('sadəcə cavab, başlıq yoxdur') })

    await escalatedTask(s, TEXT_TASK)
    await escalatedTask(s, OTHER_TEXT_TASK)

    expect(getTemplate(s.db, 'translate')).toBeUndefined()
  })

  it('şablon artıq varsa təkrar yazılmır — başçı bir dəfə ödənilir', async () => {
    const s = setup({ worker: [ESCALATE] })
    await escalatedTask(s, TEXT_TASK)
    await escalatedTask(s, OTHER_TEXT_TASK)
    const first = getTemplate(s.db, 'translate')

    const task = s.newTask(THIRD_TEXT_TASK)
    await s.ladder.run({ task, context: s.ctx })

    expect(getTemplate(s.db, 'translate')?.createdAt).toBe(first?.createdAt)
    expect(listRunsForTask(s.db, task.id).map((r) => r.ladderRung)).not.toContain(DISTILL_RUNG)
  })

  it('`boss-only` profilində distillə İŞƏ DÜŞMÜR — baseline ölçməsi korlanmamalıdır', async () => {
    // Qayda 25: o profil "başçı təkbaşına nə qədər xərcləyir" sualının REAL
    // cavabıdır; ora əlavə icra qatsaq proqnoz/real müqayisəsi mənasız olardı.
    const s = setup({
      worker: [ESCALATE],
      profile: 'boss-only',
      verifyCommands: [`"${process.execPath}" -e "process.exit(1)"`],
    })

    await escalatedTask(s, TEXT_TASK)
    await escalatedTask(s, OTHER_TEXT_TASK)

    expect(getTemplate(s.db, 'translate')).toBeUndefined()
  })

  it('distillə taskın YEKUN statusunu dəyişmir', async () => {
    // `RunSupervisor` hər icradan sonra taskın statusunu yazır — distillə
    // nəticədən SONRA gəldiyi üçün onu üzərinə yazardı.
    const s = setup({ worker: [ESCALATE] })
    await escalatedTask(s, TEXT_TASK)

    const task = s.newTask(OTHER_TEXT_TASK)
    const result = await s.ladder.run({ task, context: s.ctx })

    expect(result.status).toBe('succeeded')
    expect(getTask(s.db, task.id)?.status).toBe('succeeded')
  })
})

describe('Prompt distilləsi — şablonun TƏTBİQİ (0 token)', () => {
  function withTemplate(s: Setup): void {
    saveTemplate(s.db, {
      id: 'hash-1',
      taskType: 'translate',
      workerPrompt: 'ƏVVƏLCƏ DİLİ MÜƏYYƏN ET',
      rubric: 'TAM TƏRCÜMƏ',
      authoredByModelId: 'başçı',
    })
  }

  it('şablon işçinin promptuna SUFFİKS kimi əlavə olunur', async () => {
    const s = setup()
    withTemplate(s)
    const spy = vi.spyOn(s.worker, 'run')

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    const prompt = spy.mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).toContain('ƏVVƏLCƏ DİLİ MÜƏYYƏN ET')
    expect(prompt).toContain('TAM TƏRCÜMƏ')
    // Prefiks toxunulmazdır (qayda 29) — task mətni ƏN ƏVVƏLDƏ qalır.
    expect(prompt.startsWith(TEXT_TASK)).toBe(true)
  })

  it('şablon BAŞÇI olmadan da tətbiq olunur — `cheap` profilində də', async () => {
    // Şablon pillə deyil: artıq ödənilmiş mətndir və onu tətbiq etmək sıfır
    // əlavə token xərcləyir.
    const s = setup({ profile: 'cheap' })
    withTemplate(s)
    const spy = vi.spyOn(s.worker, 'run')

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(spy.mock.calls[0]?.[0].prompt ?? '').toContain('ƏVVƏLCƏ DİLİ MÜƏYYƏN ET')
  })

  it('istifadə TASK başına bir dəfə sayılır — yoxlama təkrarları şişirtmir', async () => {
    const failCmd = `"${process.execPath}" -e "console.error('xeta');process.exit(1)"`
    const s = setup({ verifyCommands: [failCmd] })
    withTemplate(s)

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(getTemplate(s.db, 'translate')?.uses).toBe(1)
  })

  it('şablon tətbiq olunduğu halda task yenə qalxırsa AYRICA sayılır', async () => {
    // `uses` və `escalationsAfter` birlikdə "şablon işləyirmi?" sualına cavab
    // verir — yalnız `uses` göstərsəydik pillə həmişə uğurlu görünərdi.
    const s = setup({ worker: [ESCALATE] })
    withTemplate(s)

    await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(getTemplate(s.db, 'translate')).toMatchObject({ uses: 1, escalationsAfter: 1 })
  })

  it('şablon KEŞ AÇARINI dəyişir — köhnə cavab yeni təlimatın nəticəsi kimi verilmir', async () => {
    const s = setup()
    const first = await s.ladder.run({ task: s.newTask(), context: s.ctx })
    expect(first.cacheKey).not.toBeNull()

    withTemplate(s)
    const second = await s.ladder.run({ task: s.newTask(), context: s.ctx })

    expect(second.cached).toBe(false)
    expect(second.cacheKey).not.toBe(first.cacheKey)
  })
})

describe('Prompt distilləsi — ölçmə', () => {
  it('distillənin xərci ORKESTRASİYA xərcidir, taskın həll xərci deyil', async () => {
    const s = setup({
      worker: [answer('{"escalate": true, "reason": "səbəb"}', { out: 5, costUsd: 0.001 })],
      boss: [...TEMPLATE_ANSWER.slice(0, 1), ...answer('', { out: 100, costUsd: 0.05 }).slice(1)],
    })
    await escalatedTask(s, TEXT_TASK)

    const task = s.newTask(OTHER_TEXT_TASK)
    await s.ladder.run({ task, context: s.ctx })
    const savings = computeTaskSavings(s.db, task.id)

    const distillCost =
      savings.byRung.find((r) => r.rung === DISTILL_RUNG)?.costUsd ?? 0
    expect(distillCost).toBeCloseTo(0.05, 6)
    // Taskın öz həll xərci: işçi (0.001) + başçının cavabı (0.05).
    expect(savings.actualCostUsd).toBeCloseTo(0.051, 6)
    expect(savings.orchestrationCostUsd).toBeCloseTo(0.05, 6)
  })

  it('distillənin tokenləri BASELINE-a girmir — qənaət şişirdilməməlidir', async () => {
    // Baseline əks-faktdır: "başçı bu taskı təkbaşına həll etsəydi". Başçı
    // orada şablon YAZMAZDI, ona görə o tokenlər müqayisəyə girməməlidir.
    const s = setup({
      worker: [answer('{"escalate": true, "reason": "səbəb"}', { out: 5, costUsd: 0.001 })],
      boss: [...TEMPLATE_ANSWER.slice(0, 1), ...answer('', { out: 100, costUsd: 0.05 }).slice(1)],
    })
    await escalatedTask(s, TEXT_TASK)

    const task = s.newTask(OTHER_TEXT_TASK)
    await s.ladder.run({ task, context: s.ctx })

    // İşçi 5 + başçının cavabı 100 = 105. Distillənin 100-ü GİRMİR.
    expect(computeTaskSavings(s.db, task.id).baselineTokens.outputTokens).toBe(105)
  })
})
