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
import {
  createContext,
  createTask,
  getTask,
  listRunsForTask,
  listSubtasks,
  listVerifications,
} from '../db/repo.js'
import { getSavings } from '../db/savings-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { DECOMPOSE_RUNG } from './decompose.js'
import { Decomposer } from './decomposer.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'
import type { Worktree, WorktreeDiff, WorktreeManager } from './worktree.js'

const NODE = process.execPath
const okCmd = `"${NODE}" -e "process.exit(0)"`
const failCmd = `"${NODE}" -e "console.error('TS2345 xeta');process.exit(1)"`

/** Mətn taskı — routing onu API işçisinə yönləndirir (CLI tələb olunmur). */
const BIG_TASK = 'Bu sənədi hazırla: giriş, əsas hissə və nəticə yaz'

function answer(text: string): RunEvent[] {
  return [
    { t: 'text', delta: text },
    { t: 'done', stopReason: 'end_turn' },
  ]
}

function split(...subtasks: string[]): RunEvent[] {
  return answer(JSON.stringify({ subtasks }))
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

/** Sıfır proses spawn edən worktree — `ladder-worktree.test.ts` ilə eyni fikir. */
class FakeWorktrees implements WorktreeManager {
  created: string[] = []
  removed: string[] = []
  diff: WorktreeDiff = { diff: 'diff --git a/a.ts b/a.ts', files: 1, truncated: false }

  async create(input: { repo: string; taskId: string }): Promise<Worktree | null> {
    this.created.push(input.taskId)
    return {
      repo: input.repo,
      path: `${input.repo}/.wt/${input.taskId}`,
      branch: `orchestris/${input.taskId}`,
    }
  }
  async collect(): Promise<WorktreeDiff> {
    return this.diff
  }
  async remove(wt: Worktree): Promise<void> {
    this.removed.push(wt.path)
  }
  async apply(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}

interface SetupOptions {
  /** Başçının ÇAĞIRIŞ-BAŞINA cavabları: birincisi bölgüdür. */
  boss?: readonly (readonly RunEvent[])[]
  worker?: readonly (readonly RunEvent[])[]
  withBoss?: boolean
  verifyCommands?: string[]
  profile?: string
  cwd?: string | null
  maxParallel?: number
  worktrees?: FakeWorktrees
}

interface Setup {
  db: Db
  decomposer: Decomposer
  worker: FakeRunner
  boss: FakeRunner
  ctx: {
    id: string
    cwd: string | null
    verifyCommandsJson: string
    amplificationProfile: string
    maxParallel: number
  }
  newTask: (prompt?: string) => ReturnType<typeof createTask>
}

function setup(opts: SetupOptions = {}): Setup {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C', verifyCommands: opts.verifyCommands ?? [] })
  const ctx = {
    ...row,
    cwd: opts.cwd === undefined ? null : opts.cwd,
    amplificationProfile: opts.profile ?? 'cheap',
    maxParallel: opts.maxParallel ?? 1,
  }

  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  upsertProvider(db, { id: 'openai', displayName: 'OpenAI' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  setProviderCredentialRef(db, 'openai', 'provider:openai')
  upsertModels(db, 'anthropic', [model()])
  upsertModels(db, 'openai', [
    model({ providerId: 'openai', modelId: 'başçı', displayName: 'Başçı' }),
  ])
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)
  if (opts.withBoss !== false) setExclusiveRole(db, 'boss', modelRowId('openai', 'başçı'))

  const caps = { fileAccess: false, subscriptionBilled: false }
  const worker = new FakeRunner({
    id: 'api:anthropic',
    kind: 'api',
    capabilities: caps,
    ...(opts.worker !== undefined
      ? { eventsPerCall: opts.worker }
      : { events: answer('alt-task cavabı') }),
  })
  const boss = new FakeRunner({
    id: 'api:openai',
    kind: 'api',
    capabilities: caps,
    eventsPerCall: opts.boss ?? [split('birinci hissə', 'ikinci hissə')],
  })

  const runners = new Map<string, Runner>([
    ['api:anthropic', worker],
    ['api:openai', boss],
  ])
  const supervisor = new RunSupervisor(db)
  const router = new WorkerRouter(db, runners)
  const ladder = new Ladder(db, supervisor, router, opts.worktrees)
  const decomposer = new Decomposer(db, supervisor, ladder, router, opts.worktrees)

  return {
    db,
    decomposer,
    worker,
    boss,
    ctx,
    newTask: (prompt = BIG_TASK) => createTask(db, { contextId: ctx.id, prompt }),
  }
}

describe('Decomposer — bölgü', () => {
  it('başçının bölgüsündən alt-tasklar yaradır və SIRA ilə qaçırır', async () => {
    const { db, decomposer, ctx, newTask } = setup()
    const task = newTask()

    const result = await decomposer.run({
      task,
      context: ctx,
      requested: true,
    })

    expect(result.decomposed).toBe(true)
    expect(result.status).toBe('succeeded')

    const subtasks = listSubtasks(db, task.id)
    expect(subtasks.map((s) => s.prompt)).toEqual(['birinci hissə', 'ikinci hissə'])
    expect(subtasks.map((s) => s.subtaskIndex)).toEqual([0, 1])
    expect(subtasks.every((s) => s.parentTaskId === task.id)).toBe(true)
    // Hər alt-task ÖZ nərdivanından keçdi — yəni öz icrası var.
    expect(subtasks.every((s) => listRunsForTask(db, s.id).length > 0)).toBe(true)
  })

  it('bölgü icrası `ladder_rung: -2` ilə qeyd olunur — pillə DEYİL', () => {
    // Qayda 31/37: 0–7 aralığından nömrə seçsəydik "taskların <20%-i 7-yə
    // çatsın" hədəfi bölgünü tam başçı icrası kimi sayardı.
    expect(DECOMPOSE_RUNG).toBeLessThan(0)
  })

  it('valideyn taskda YALNIZ bölgü icrası olur — həlli alt-tasklar yazır', async () => {
    const { db, decomposer, ctx, newTask } = setup()
    const task = newTask()

    await decomposer.run({ task, context: ctx, requested: true })

    const runs = listRunsForTask(db, task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.ladderRung).toBe(DECOMPOSE_RUNG)
  })

  it('bölgünün xərci ORKESTRASİYA xərcinə yazılır, baseline-a YOX', async () => {
    // Qayda 37 ilə eyni məntiq: başçı taskı təkbaşına həll etsəydi bölgü
    // YAZMAZDI — tokenlərini baseline-a qatsaq qənaət olduğundan böyük görünərdi.
    const { db, decomposer, ctx, newTask } = setup()
    const task = newTask()

    await decomposer.run({ task, context: ctx, requested: true })

    const ledger = getSavings(db, task.id)
    expect(ledger).toBeDefined()
    expect(ledger?.tokensIn).toBe(0)
    expect(ledger?.tokensOut).toBe(0)
    expect(ledger?.orchestrationCostUsd).not.toBeNull()
  })

  it('alt-tasklar valideynin statusunu təyin edir', async () => {
    const { db, decomposer, ctx, newTask } = setup({
      // İkinci alt-task sınır: runner heç bir `done` vermir → icra uğursuzdur.
      worker: [answer('yaxşı'), [{ t: 'error', class: 'crashed', message: 'sındı' }]],
    })
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: true })

    expect(result.status).toBe('failed')
    expect(getTask(db, task.id)?.status).toBe('failed')
    // Uğurlu parça ATILMIR — nəticəsi öz alt-taskında qalır.
    expect(result.subtasks[0]?.status).toBe('succeeded')
  })
})

describe('Decomposer — geri çəkilmə', () => {
  it('başçı yararsız cavab versə bölgü baş vermir', async () => {
    const { db, decomposer, ctx, newTask } = setup({ boss: [answer('bilmirəm')] })
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: true })

    expect(result.decomposed).toBe(false)
    expect(listSubtasks(db, task.id)).toHaveLength(0)
    // Ödənilən icra GİZLƏDİLMİR (qayda 22) — çağıran adi nərdivana düşəcək.
    expect(result.decomposeRunId).not.toBeNull()
  })

  it('bir parçalı bölgü bölgü sayılmır', async () => {
    const { db, decomposer, ctx, newTask } = setup({ boss: [split('tək parça')] })
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: true })

    expect(result.decomposed).toBe(false)
    expect(listSubtasks(db, task.id)).toHaveLength(0)
  })

  it('istənilməyibsə başçı ÜMUMİYYƏTLƏ çağırılmır', async () => {
    const { db, decomposer, ctx, boss, newTask } = setup()
    const spy = vi.spyOn(boss, 'run')
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: false })

    expect(result.decomposed).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(listRunsForTask(db, task.id)).toHaveLength(0)
  })

  it('`boss-only` profilində bölgü açılmır', async () => {
    const { decomposer, ctx, boss, newTask } = setup({ profile: 'boss-only' })
    const spy = vi.spyOn(boss, 'run')

    const result = await decomposer.run({
      task: newTask(),
      context: { ...ctx, amplificationProfile: 'boss-only' },
      requested: true,
    })

    expect(result.decomposed).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('başçı təyin olunmayıbsa bölgü baş vermir', async () => {
    const { decomposer, ctx, newTask } = setup({ withBoss: false })

    const result = await decomposer.run({ task: newTask(), context: ctx, requested: true })

    expect(result.decomposed).toBe(false)
    expect(result.decomposeRunId).toBeNull()
  })
})

describe('Decomposer — yekun yoxlama', () => {
  it('yoxlama alt-tasklarda SÖNDÜRÜLÜR, sonda BİR dəfə qaçır', async () => {
    // Yarımçıq işdə `tsc` quruluş etibarı ilə sınır. Alt-tasklarda saxlasaydıq
    // hər parça 3 cəhd + başçı eskalasiyası yandırardı.
    const { db, decomposer, ctx, newTask } = setup({ verifyCommands: [okCmd] })
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: true })

    expect(result.verificationPassed).toBe(true)
    for (const sub of listSubtasks(db, task.id)) {
      for (const run of listRunsForTask(db, sub.id)) {
        expect(listVerifications(db, run.id)).toEqual([])
      }
    }
    // Yoxlama BÖLGÜ icrasına yazılır: o, hər hansı bir parçanın deyil, BÜTÖV
    // taskın yoxlamasıdır — alt-taskın icrasına yazsaydıq, həmin parça
    // başqasının səhvinə görə uğursuz görünərdi.
    const parentRun = listRunsForTask(db, task.id)[0]
    expect(listVerifications(db, parentRun?.id ?? '')).toHaveLength(1)
  })

  it('yekun yoxlama sınsa valideyn `verification_failed` olur', async () => {
    const { db, decomposer, ctx, newTask } = setup({ verifyCommands: [failCmd] })
    const task = newTask()

    const result = await decomposer.run({ task, context: ctx, requested: true })

    expect(result.verificationPassed).toBe(false)
    expect(result.status).toBe('verification_failed')
    expect(getTask(db, task.id)?.status).toBe('failed')
  })

  it('yoxlama əmri yoxdursa nəticə `null`-dır, `true` deyil', async () => {
    const { decomposer, ctx, newTask } = setup()

    const result = await decomposer.run({ task: newTask(), context: ctx, requested: true })

    expect(result.verificationPassed).toBeNull()
  })
})

describe('Decomposer — worktree izolyasiyası', () => {
  it('bütün alt-tasklar VALİDEYNİN ağacında işləyir', async () => {
    // Qayda 40: alt-task başına ağac açsaydıq, 2-ci alt-task 1-cinin yazdığı
    // faylı GÖRMƏZDİ — halbuki bölgü müqaviləsi "sonrakı əvvəlkinin üzərində
    // qurur" deyir.
    const worktrees = new FakeWorktrees()
    const { decomposer, ctx, newTask } = setup({
      worktrees,
      cwd: 'C:/repo',
      maxParallel: 4,
    })
    // Kod taskı: `shouldIsolate` yalnız `code`/`test` tiplərində açılır.
    const task = newTask('src/a.ts faylını düzəlt: əvvəlcə tipləri, sonra testləri')

    await decomposer.run({ task, context: ctx, requested: true })

    expect(worktrees.created).toEqual([task.id])
  })

  it('diff VALİDEYN taskın adına yazılır — bölgü bir iş vahididir', async () => {
    const worktrees = new FakeWorktrees()
    const { db, decomposer, ctx, newTask } = setup({
      worktrees,
      cwd: 'C:/repo',
      maxParallel: 4,
    })
    const task = newTask('src/a.ts faylını düzəlt: əvvəlcə tipləri, sonra testləri')

    await decomposer.run({ task, context: ctx, requested: true })

    const { getDiffArtifact } = await import('../db/artifact-repo.js')
    expect(getDiffArtifact(db, task.id)?.files).toBe(1)
  })

  it('ardıcıl rejimdə (`max_parallel = 1`) ağac AÇILMIR', async () => {
    const worktrees = new FakeWorktrees()
    const { decomposer, ctx, newTask } = setup({ worktrees, cwd: 'C:/repo', maxParallel: 1 })

    await decomposer.run({
      task: newTask('src/a.ts faylını düzəlt'),
      context: ctx,
      requested: true,
    })

    expect(worktrees.created).toEqual([])
  })
})

describe('Decomposer — büdcə', () => {
  it('büdcə alt-tasklar ARASINDA paylaşılır', async () => {
    // Hər alt-task limiti təzədən alsaydı, altı parçalı task büdcənin altı
    // mislini xərcləyə bilərdi. Burada BİRİNCİ alt-task limitin hamısını yeyir
    // → qalan ikisi ümumiyyətlə başlamır.
    const { db, decomposer, ctx, newTask } = setup({
      boss: [split('bir', 'iki', 'üç')],
      worker: [
        [
          { t: 'text', delta: 'cavab' },
          { t: 'usage', inputTokens: 10, outputTokens: 100, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      ],
    })
    const task = newTask()

    const result = await decomposer.run({
      task,
      context: ctx,
      requested: true,
      limits: { maxOutputTokens: 100 },
    })

    expect(result.decomposed).toBe(true)
    const executed = listSubtasks(db, task.id).filter(
      (s) => listRunsForTask(db, s.id).length > 0,
    )
    expect(executed).toHaveLength(1)
    // İcra olunmayan alt-tasklar `pending` QALMIR — UI-da "gözləyir" görünən,
    // əslində heç vaxt başlamayacaq task yalandır.
    expect(result.subtasks.slice(1).map((s) => s.status)).toEqual([
      'budget_exceeded',
      'budget_exceeded',
    ])
  })
})
