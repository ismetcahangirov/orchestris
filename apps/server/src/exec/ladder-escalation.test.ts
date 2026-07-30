import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import {
  createContext,
  createTask,
  getCacheEntry,
  getTask,
  listRunsForTask,
  listVerifications,
} from '../db/repo.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { listRoutingDecisions } from '../db/routing-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const NODE = process.execPath
const failCmd = `"${NODE}" -e "console.error('TS2345 xeta');process.exit(1)"`
const okCmd = `"${NODE}" -e "process.exit(0)"`

/**
 * İlk 3 çağırışda sınan, 4-cüdə keçən yoxlama əmri.
 *
 * Pillə 4-ün QƏBUL yolunu yoxlamaq üçün lazımdır: 3 işçi cəhdi sınmalı, sonra
 * ipuculu cəhd keçməlidir. Sabit əmr ilə bu yol test edilə bilməz — sayğac
 * fayldadır, çünki əmr hər dəfə YENİ prosesdə qaçır.
 */
function failsUntilFourthCall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestris-verify-'))
  const script = join(dir, 'verify.cjs')
  const counter = join(dir, 'count')
  writeFileSync(
    script,
    [
      "const fs = require('node:fs')",
      `const f = ${JSON.stringify(counter)}`,
      "const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1",
      'fs.writeFileSync(f, String(n))',
      "if (n <= 3) { console.error('TS2345 xeta'); process.exit(1) }",
      'process.exit(0)',
    ].join('\n'),
  )
  return `"${NODE}" "${script}"`
}

/** Mətn taskı — routing onu API işçisinə yönləndirir və keş açarı hesablana bilir. */
const TEXT_TASK = 'Bu cümləni tərcümə et: salam'

/**
 * ÇOXADDIMLI mətn taskı — `detectMultiStep` onu tutur, ona görə Pillə 5 seçilir.
 *
 * Fayl yolu QƏSDƏN yoxdur: routing onu API işçisinə yönləndirməlidir, yoxsa
 * test CLI runner-i tələb edərdi.
 */
const MULTI_STEP_TASK = [
  'Bu mətni hazırla:',
  '1. cümlələri tərcümə et',
  '2. terminləri lüğətlə yoxla',
  '3. yekunu bir abzasda ver',
].join('\n')

function answer(text: string): RunEvent[] {
  return [
    { t: 'text', delta: text },
    { t: 'done', stopReason: 'end_turn' },
  ]
}

const ESCALATE = answer('{"escalate": true, "reason": "kontekst çatmır", "partial": "YARIMÇIQ"}')

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
  /** İşçinin ÇAĞIRIŞ-BAŞINA cavabları. Tükənəndə sonuncu təkrarlanır. */
  worker?: readonly (readonly RunEvent[])[]
  boss?: readonly RunEvent[]
  /** `false` → başçı rolu heç bir modelə verilmir (eskalasiya yeri yoxdur). */
  withBoss?: boolean
  verifyCommands?: string[]
  profile?: string
  /** Router-siz Ladder — əl ilə seçim yolu. */
  noRouter?: boolean
}

interface Setup {
  db: Db
  ladder: Ladder
  worker: FakeRunner
  boss: FakeRunner
  ctx: { id: string; cwd: string | null; verifyCommandsJson: string; amplificationProfile: string }
  newTask: (prompt?: string) => ReturnType<typeof createTask>
}

/**
 * İşçi və başçı AYRI provayderlərdədir (`anthropic` / `openai`).
 *
 * Səbəb: runner id-si provayderdən çıxarılır (`runnerIdForProvider`), ona görə
 * eyni provayderdəki iki model EYNİ runner instansiyasını işlədərdi və testdə
 * "başçı nə cavab verdi" sualını işçidən ayıra bilməzdik.
 */
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
  if (opts.withBoss !== false) {
    setExclusiveRole(db, 'boss', modelRowId('openai', 'başçı'))
  }

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
    events: opts.boss ?? answer('BAŞÇI CAVABI'),
  })

  const runners = new Map<string, Runner>([
    ['api:anthropic', worker],
    ['api:openai', boss],
  ])
  const ladder = new Ladder(
    db,
    new RunSupervisor(db),
    ...(opts.noRouter === true ? [] : [new WorkerRouter(db, runners)]),
  )

  return {
    db,
    ladder,
    worker,
    boss,
    ctx,
    newTask: (prompt = TEXT_TASK) => createTask(db, { contextId: ctx.id, prompt }),
  }
}

describe('Ladder — Pillə 6 self-escalation', () => {
  it('müqavilə işçinin promptuna əlavə olunur', async () => {
    const { ladder, ctx, worker, newTask } = setup()
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    expect(spy.mock.calls[0]?.[0].prompt).toContain('ƏMİNLİK MÜQAVİLƏSİ')
  })

  it('`cheap` profilində müqavilə GÖNDƏRİLMİR — o profil eskalasiyasızdır', async () => {
    const { ladder, ctx, worker, newTask } = setup({ profile: 'cheap' })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    expect(spy.mock.calls[0]?.[0].prompt).not.toContain('ƏMİNLİK MÜQAVİLƏSİ')
  })

  it('işçi imtina edəndə başçı işə düşür və nəticə onundur', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.finalRung).toBe(7)
    expect(result.escalation).toMatchObject({ trigger: 'self', reached: true })
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('başçının icrası 7-ci pillə və eskalasiya bağlantısı ilə qeyd olunur', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const task = newTask()

    await ladder.run({ task, context: ctx })

    const runs = listRunsForTask(db, task.id)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.ladderRung).toBe(2)
    expect(runs[1]?.ladderRung).toBe(7)
    expect(runs[1]?.escalatedFromRunId).toBe(runs[0]?.id)
    expect(runs[1]?.modelId).toBe('başçı')
  })

  it('işçinin qismən nəticəsi başçıya ötürülür — ödənilmiş iş atılmır', async () => {
    const { ladder, ctx, boss, newTask } = setup({ worker: [ESCALATE] })
    const spy = vi.spyOn(boss, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    const prompt = spy.mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).toContain('YARIMÇIQ')
    expect(prompt).toContain('kontekst çatmır')
    expect(prompt).toContain(TEXT_TASK)
  })

  it('eskalasiya qərarı routing_decisions-a yazılır — "niyə başçı?" cavabı', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const task = newTask()

    await ladder.run({ task, context: ctx })

    const decisions = listRoutingDecisions(db, task.id)
    expect(decisions.at(-1)).toMatchObject({ strategy: 'boss', modelId: 'başçı' })
    // Eskalasiya qərarı 0 token xərcləyir — qənaət hesabını şişirtmir.
    expect(decisions.at(-1)?.decisionTokens).toBe(0)
  })

  it('işçinin imtinası KEŞƏ YAZILMIR', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(result.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('başçının cavabı da işçinin keş açarı altında saxlanılmır', async () => {
    // Açar model + runner id-sini ehtiva edir. Başqa modelin cavabını ora
    // yazsaq, sonrakı `cheap` profilli icra (Pillə 7-ni QƏSDƏN söndürən)
    // səssizcə başçı cavabı alardı.
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('başçı təyin olunmayıbsa escalation_unavailable qaytarır', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE], withBoss: false })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('escalation_unavailable')
    expect(result.escalation).toMatchObject({ trigger: 'self', reached: false })
    expect(getTask(db, task.id)?.status).toBe('failed')
    // İşçinin "bacarmadım" cavabı UGURLU nəticə kimi göstərilmir.
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })

  it('başçı da sınarsa işçinin nəticəsi saxlanılır — monoton qayda', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [ESCALATE],
      boss: [{ t: 'error', class: 'overloaded', message: 'yüklü' }],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    // Nəticə işçinin nəticəsidir (imtina) — başçının xətası onu ƏVƏZ ETMİR.
    expect(result.status).toBe('escalation_unavailable')
    expect(result.escalation).toMatchObject({ reached: true })
    // Başçının icrası DB-də QALIR: xərc real gedib və gizlədilmir.
    expect(listRunsForTask(db, task.id)).toHaveLength(2)
  })

  it('əl ilə seçimdə (router yoxdur) eskalasiya edilmir', async () => {
    const { db, ladder, ctx, worker, newTask } = setup({
      worker: [ESCALATE],
      noRouter: true,
    })
    const task = newTask()

    const result = await ladder.run({
      task,
      context: ctx,
      runner: worker,
      model: 'haiku',
    })

    expect(result.status).toBe('escalation_unavailable')
    expect(result.escalation?.reached).toBe(false)
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })
})

describe('Ladder — Pillə 3 best-of-N', () => {
  it('nüsxələr razılaşırsa 3 icra ilə dayanır', async () => {
    const { db, ladder, ctx, worker, newTask } = setup({
      worker: [answer('A'), answer('A'), answer('A')],
    })
    const spy = vi.spyOn(worker, 'run')
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(spy).toHaveBeenCalledTimes(3)
    expect(result.agreement).toEqual({ n: 3, votes: 3, threshold: 2, agreed: true })
    expect(result.finalRung).toBe(3)
    expect(result.status).toBe('succeeded')
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('2/3 razılaşma kifayətdir', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('A')],
    })
    const spy = vi.spyOn(worker, 'run')

    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(spy).toHaveBeenCalledTimes(3)
    expect(result.agreement).toMatchObject({ n: 3, votes: 2, agreed: true })
  })

  it('razılaşma olmasa 5 nüsxəyə qalxır', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      worker: [
        answer('A'),
        answer('B'),
        answer('C'),
        answer('D'),
        answer('A'),
      ],
    })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    expect(spy).toHaveBeenCalledTimes(5)
  })

  it('3/5 razılaşma qəbul edilir', async () => {
    const { ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C'), answer('A'), answer('A')],
    })

    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(result.agreement).toMatchObject({ n: 5, votes: 3, threshold: 3, agreed: true })
    expect(result.finalRung).toBe(3)
  })

  it('5 nüsxədə də razılaşma yoxdursa başçıya qalxır', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C'), answer('D'), answer('E')],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.escalation).toMatchObject({ trigger: 'disagreement', reached: true })
    expect(result.finalRung).toBe(7)
    // 5 nüsxə + başçı
    expect(listRunsForTask(db, task.id)).toHaveLength(6)
  })

  it('nüsxələr 3-cü pillə kimi qeyd olunur — ilk icra 2-ci pillədə qalır', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('A'), answer('A')],
    })
    const task = newTask()

    await ladder.run({ task, context: ctx })

    const rungs = listRunsForTask(db, task.id).map((r) => r.ladderRung)
    expect(rungs).toEqual([2, 3, 3])
  })

  it('razılaşan cavab keşlənir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('A'), answer('A')],
    })
    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(getCacheEntry(db, result.cacheKey as string)?.events).toBeDefined()
  })

  it('razılaşmayan nəticə keşə YAZILMIR', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C'), answer('D'), answer('E')],
    })
    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('yoxlama əmri varsa Pillə 3 İŞƏ DÜŞMÜR — pulsuz siqnal bahalısını üstələyir', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C')],
      verifyCommands: [okCmd],
    })
    const spy = vi.spyOn(worker, 'run')

    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.verificationPassed).toBe(true)
    expect(result.agreement).toBeUndefined()
  })

  it('büdcə bitibsə nüsxə artırılmır və əldəki nəticə saxlanılır', async () => {
    const { db, ladder, ctx, worker, newTask } = setup({
      worker: [
        [
          { t: 'text', delta: 'A' },
          { t: 'usage', inputTokens: 10, outputTokens: 100, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
        answer('B'),
      ],
    })
    const spy = vi.spyOn(worker, 'run')
    const task = newTask()

    const result = await ladder.run({
      task,
      context: ctx,
      limits: { maxOutputTokens: 100 },
    })

    // İlk icra limiti tam yedi (100/100) — ikinci nüsxəni başlatmaq sərt
    // limitin mənasını pozardı.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('succeeded')
    expect(result.agreement).toBeUndefined()
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })

  it('nüsxə sınsa da ilk cavab qalır və task statusu uğurlu olur', async () => {
    // `RunSupervisor` taskın statusunu SON icraya görə yazır — burada o, sınmış
    // nüsxədir. Nərdivan isə ilk (uğurlu) cavabı qaytarır; uyğunlaşdırmasaq
    // `/tasks/:id` uğurlu cavabı "failed" kimi göstərərdi.
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), [{ t: 'error', class: 'overloaded', message: 'yüklü' }]],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.agreement).toBeUndefined()
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('razılaşma olmasa və başçı yoxdursa ən çox səs toplayan cavab qaytarılır', async () => {
    const { db, ladder, ctx, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C'), answer('D'), answer('E')],
      withBoss: false,
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    // Cavab VAR — "heç nə tapılmadı" demək istifadəçi üçün daha pisdir.
    expect(result.status).toBe('succeeded')
    expect(result.agreement?.agreed).toBe(false)
    expect(result.escalation).toMatchObject({ trigger: 'disagreement', reached: false })
    expect(getTask(db, task.id)?.status).toBe('succeeded')
    // Uğurlu nəticəyə xəta mətni bağlanmır.
    expect(result.errorMessage).toBeUndefined()
  })

  it('`cheap` profilində Pillə 3 işə düşmür', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      worker: [answer('A'), answer('B'), answer('C')],
      profile: 'cheap',
    })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('Ladder — Pillə 2 → 7 yoxlama eskalasiyası', () => {
  it('3 cəhddən sonra yoxlama sınıbsa başçıya qalxır', async () => {
    const { db, ladder, ctx, newTask } = setup({ verifyCommands: [failCmd] })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.escalation).toMatchObject({ trigger: 'verification', reached: true })
    // 3 işçi cəhdi + başçı
    expect(listRunsForTask(db, task.id)).toHaveLength(4)
    // Başçı da yoxlamadan keçmədi — nəticə dürüstdür.
    expect(result.status).toBe('verification_failed')
    expect(result.verificationPassed).toBe(false)
  })

  it('başçının icrası da yoxlamadan keçirilir — pulsuz siqnal ona da tətbiq olunur', async () => {
    const { db, ladder, ctx, newTask } = setup({ verifyCommands: [failCmd] })
    const task = newTask()

    await ladder.run({ task, context: ctx })

    const bossRun = listRunsForTask(db, task.id).at(-1)
    expect(bossRun?.ladderRung).toBe(7)
    expect(listVerifications(db, bossRun?.id ?? '')).not.toHaveLength(0)
  })

  it('başçı yoxdursa köhnə davranış qalır: verification_failed', async () => {
    const { db, ladder, ctx, newTask } = setup({
      verifyCommands: [failCmd],
      withBoss: false,
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('verification_failed')
    expect(result.verificationPassed).toBe(false)
    expect(listRunsForTask(db, task.id)).toHaveLength(3)
    expect(getTask(db, task.id)?.status).toBe('failed')
  })
})

describe('Ladder — Pillə 4 ipucu (shepherding)', () => {
  it('işçi imtina edəndə əvvəlcə İPUCU alınır, Pillə 7 yox', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('İPUCU İLƏ HƏLL ETDİM')],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.finalRung).toBe(4)
    expect(result.hint).toMatchObject({ trigger: 'self', accepted: true })
    // İşçinin imtinası, başçının ipucusu, işçinin ipuculu cəhdi — başçının
    // TAM icrası (7) YOXDUR: pillənin bütün qənaəti budur.
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 4, 4])
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('başçıdan TAM həll deyil, yalnız başlanğıc istənir', async () => {
    const { ladder, ctx, boss, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('HƏLL')],
    })
    const spy = vi.spyOn(boss, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    const prompt = spy.mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).toContain('TAM həll YAZMA')
    expect(prompt).toContain('kontekst çatmır')
    expect(prompt).toContain(TEXT_TASK)
  })

  it('başçının ipucusu işçinin növbəti promptuna qoyulur', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('HƏLL')],
    })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    const prompt = spy.mock.calls[1]?.[0].prompt ?? ''
    expect(prompt).toContain('BAŞÇI CAVABI')
    expect(prompt).toContain('İPUCU')
    expect(prompt).toContain(TEXT_TASK)
  })

  it('ipuculu işçi yenə imtina edərsə Pillə 7 işə düşür', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.finalRung).toBe(7)
    expect(result.status).toBe('succeeded')
    // İpucu boşa getdi, amma ödənildi — nəticədə GİZLƏDİLMİR.
    expect(result.hint).toMatchObject({ accepted: false })
    expect(result.escalation).toMatchObject({ trigger: 'self', reached: true })
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 4, 4, 7])
  })

  it('`balanced` profilində ipucu YOXDUR — birbaşa başçıya qalxılır', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.hint).toBeUndefined()
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 7])
  })

  it('razılaşmama halında ipucu istənmir — nüsxələr onsuz da ödənilib', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [answer('A'), answer('B'), answer('C'), answer('D'), answer('E')],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.hint).toBeUndefined()
    expect(result.finalRung).toBe(7)
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 3, 3, 3, 3, 7])
  })

  it('yoxlama sınıqlarından sonra ipuculu cəhd keçirsə nəticə onundur', async () => {
    // Əmr ilk 3 çağırışda sınır, 4-cüdə keçir: yəni yalnız İPUCULU cəhd
    // yoxlamadan keçir. Determinist siqnal ipucunun işlədiyini SIFIR token ilə
    // təsdiqləyir.
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      verifyCommands: [failsUntilFourthCall()],
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.verificationPassed).toBe(true)
    expect(result.finalRung).toBe(4)
    expect(result.hint).toMatchObject({ trigger: 'verification', accepted: true })
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 2, 2, 4, 4])
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('ipuculu cavab KEŞƏ YAZILMIR — başçının köməyi işçinin açarı altında gizlənməməlidir', async () => {
    // Keş açarı model + runner id-sidir. Ora başçı köməyi ilə alınmış cavabı
    // yazsaq, sonrakı `cheap` profilli icra (Pillə 4 və 7-ni QƏSDƏN söndürən)
    // səssizcə həmin cavabı alardı (eyni səbəb: qayda 33).
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('İPUCU İLƏ HƏLL')],
    })

    const result = await ladder.run({ task: newTask(), context: ctx })

    expect(result.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('başçı təyin olunmayıbsa ipucu da istənmir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE],
      withBoss: false,
    })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('escalation_unavailable')
    expect(result.hint).toBeUndefined()
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })

  it('büdcə bitibsə ipucu istənmir — yeni icra başlatmaq limitin mənasını pozardı', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [
        [
          { t: 'text', delta: '{"escalate": true, "reason": "bilmirəm"}' },
          { t: 'usage', inputTokens: 10, outputTokens: 100, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      ],
    })
    const task = newTask()

    const result = await ladder.run({
      task,
      context: ctx,
      limits: { maxOutputTokens: 100 },
    })

    expect(result.hint).toBeUndefined()
    expect(result.status).toBe('escalation_unavailable')
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })
})

describe('Ladder — Pillə 5 plan güclü / icra zəif', () => {
  it('çoxaddımlı taskda ipucu YERİNƏ plan istənir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('PLANI İCRA ETDİM')],
    })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.finalRung).toBe(5)
    expect(result.plan).toMatchObject({ trigger: 'self', accepted: true })
    // Pillə 4 və 5 EYNİ yerdə dayanır — ikisi birdən işə düşmür.
    expect(result.hint).toBeUndefined()
    // İşçinin imtinası, başçının planı, işçinin planlı cəhdi — başçının TAM
    // icrası (7) YOXDUR.
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 5, 5])
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })

  it('təkaddımlı taskda plan yox, ipucu seçilir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('İPUCU İLƏ HƏLL')],
    })
    const task = newTask(TEXT_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.plan).toBeUndefined()
    expect(result.hint).toMatchObject({ accepted: true })
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 4, 4])
  })

  it('başçıdan addım bölgüsü istənir, icra yox', async () => {
    const { ladder, ctx, boss, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('HƏLL')],
    })
    const spy = vi.spyOn(boss, 'run')

    await ladder.run({ task: newTask(MULTI_STEP_TASK), context: ctx })

    const prompt = spy.mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).toContain('TAM HƏLL İSTƏNMİR')
    expect(prompt).toContain('GÖVDƏLƏRİ BOŞ saxla')
    expect(prompt).toContain('kontekst çatmır')
    expect(prompt).toContain(MULTI_STEP_TASK)
  })

  it('başçının planı işçinin növbəti promptuna qoyulur', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('HƏLL')],
    })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(MULTI_STEP_TASK), context: ctx })

    const prompt = spy.mock.calls[1]?.[0].prompt ?? ''
    expect(prompt).toContain('BAŞÇI CAVABI')
    expect(prompt).toContain('PLAN')
    expect(prompt).toContain(MULTI_STEP_TASK)
  })

  it('planlı işçi yenə imtina edərsə Pillə 7 işə düşür', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE],
    })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.finalRung).toBe(7)
    expect(result.status).toBe('succeeded')
    // Plan boşa getdi, amma ödənildi — nəticədə GİZLƏDİLMİR.
    expect(result.plan).toMatchObject({ accepted: false })
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 5, 5, 7])
  })

  it('`balanced` profilində plan YOXDUR — birbaşa başçıya qalxılır', async () => {
    const { db, ladder, ctx, newTask } = setup({ worker: [ESCALATE] })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.plan).toBeUndefined()
    expect(result.hint).toBeUndefined()
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 7])
  })

  it('razılaşmama halında plan istənmir — nüsxələr onsuz da ödənilib', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [answer('A'), answer('B'), answer('C'), answer('D'), answer('E')],
    })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.plan).toBeUndefined()
    expect(result.finalRung).toBe(7)
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 3, 3, 3, 3, 7])
  })

  it('planlı cavab KEŞƏ YAZILMIR — başçının köməyi işçinin açarı altında gizlənməməlidir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('PLANLA HƏLL')],
    })

    const result = await ladder.run({ task: newTask(MULTI_STEP_TASK), context: ctx })

    expect(result.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, result.cacheKey as string)).toBeUndefined()
  })

  it('yoxlama sınıqlarından sonra planlı cəhd keçirsə nəticə onundur', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      verifyCommands: [failsUntilFourthCall()],
    })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('succeeded')
    expect(result.verificationPassed).toBe(true)
    expect(result.finalRung).toBe(5)
    expect(result.plan).toMatchObject({ trigger: 'verification', accepted: true })
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([2, 2, 2, 5, 5])
  })

  it('başçı təyin olunmayıbsa plan da istənmir', async () => {
    const { db, ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE],
      withBoss: false,
    })
    const task = newTask(MULTI_STEP_TASK)

    const result = await ladder.run({ task, context: ctx })

    expect(result.status).toBe('escalation_unavailable')
    expect(result.plan).toBeUndefined()
    expect(listRunsForTask(db, task.id)).toHaveLength(1)
  })

  it('planın uzunluğu nəticədə qeyd olunur — pillənin iqtisadiyyatı bununla ölçülür', async () => {
    const { ladder, ctx, newTask } = setup({
      profile: 'quality',
      worker: [ESCALATE, answer('HƏLL')],
      boss: answer('1. birinci addım\n2. ikinci addım'),
    })

    const result = await ladder.run({ task: newTask(MULTI_STEP_TASK), context: ctx })

    expect(result.plan?.planChars).toBe('1. birinci addım\n2. ikinci addım'.length)
  })
})

describe('Ladder — profil → pillə xəritəsi', () => {
  it('boss-only profilində tək icra 7-ci pillə kimi qeyd olunur', async () => {
    const { db, ladder, ctx, newTask } = setup({ profile: 'boss-only' })
    const task = newTask()

    const result = await ladder.run({ task, context: ctx })

    expect(result.finalRung).toBe(7)
    expect(listRunsForTask(db, task.id).map((r) => r.ladderRung)).toEqual([7])
  })

  it('naməlum profil `balanced` kimi oxunur', async () => {
    const { ladder, ctx, worker, newTask } = setup({
      profile: 'uydurma',
      worker: [answer('A'), answer('A'), answer('A')],
    })
    const spy = vi.spyOn(worker, 'run')

    await ladder.run({ task: newTask(), context: ctx })

    expect(spy).toHaveBeenCalledTimes(3)
  })
})
