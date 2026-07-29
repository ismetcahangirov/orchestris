import type { RunEvent, Runner, WorkflowStep } from '@orchestris/shared'
import { DEFAULT_MAX_PENDING_DIFFS } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { getDiffArtifact, resolveArtifact } from '../db/artifact-repo.js'
import { openDb, type Db } from '../db/client.js'
import {
  modelRowId,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { createContext, updateContext } from '../db/repo.js'
import {
  countPendingDiffsForSchedule,
  createSchedule,
  createWorkflow,
  getSchedule,
  listWorkflowRuns,
  updateSchedule,
} from '../db/workflow-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { Scheduler } from './scheduler.js'
import { RunSupervisor } from './supervisor.js'
import { WorkflowEngine } from './workflow-engine.js'
import type { Worktree, WorktreeDiff, WorktreeManager } from './worktree.js'

/**
 * Cədvəl üzrə icranın DİSK tavanı (issue #38).
 *
 * Bu fayl `scheduler.test.ts`-dən AYRIDIR, çünki burada zəncir HƏQİQƏTƏN diff
 * yaratmalıdır — yəni izolyasiya işə düşməli, saxta `WorktreeManager` qurulmalı
 * və kontekstdə `cwd` + `maxParallel > 1` olmalıdır. Xərc tavanlarının testləri
 * bunların heç birinə ehtiyac duymur və eyni setup-a qatsaydıq, hər USD testi
 * səbəbsiz yerə worktree məntiqindən keçərdi.
 *
 * YOXLANAN ƏSAS İDDİA: xərc tavanları (USD, icra sayı) diskə KORDUR. Repoya
 * yazan zəncirin hər avtomatik icrası yeni `pending` diff — yəni reponun yeni
 * nüsxəsini — yaradır, yetim təmizləyicisi isə onlara qəsdən toxunmur
 * (qayda 44). Burada `maxRuns` və büdcə hər testdə QƏSDƏN GENİŞ saxlanılır:
 * cədvəli dayandıran yeganə şey diff tavanı olmalıdır.
 */

/** Fayl yolu + yazma feli → `classify.ts` bunu `code` sayır, yəni izolyasiya açılır. */
const CODE_PROMPT = 'src/a.ts faylındaki funksiyanı düzəlt'

const T0 = 1_800_000_000_000

const ANSWER: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0.001, billed: 'real' },
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
    source: 'models.dev',
  }
}

/**
 * Saxta ağac idarəçisi — HƏR icrada dəyişiklik "tapır".
 *
 * `worktree.test.ts` real `git` ilə yoxlanılır; burada MƏNTİQ yoxlanılır: neçə
 * `pending` diff yığıldı və cədvəl nə vaxt dayandı.
 */
class FakeWorktrees implements WorktreeManager {
  removed: string[] = []
  diff: WorktreeDiff = { diff: 'diff --git a/a.ts b/a.ts', files: 1, truncated: false }

  async create(input: { repo: string; taskId: string }): Promise<Worktree | null> {
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

const STEPS: WorkflowStep[] = [{ kind: 'task', id: 'a', prompt: CODE_PROMPT }]

function setup(opts: { steps?: WorkflowStep[] } = {}) {
  const db: Db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C', cwd: 'C:/repo' })
  // İzolyasiya ÜÇ şərti birlikdə tələb edir (qayda 40) — `maxParallel > 1`
  // onlardan biridir.
  updateContext(db, ctx.id, { maxParallel: 4, amplificationProfile: 'cheap' })

  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')
  upsertModels(db, 'anthropic', [model()])
  setWorkerRole(db, modelRowId('anthropic', 'haiku'), true)

  const runner = new FakeRunner({
    id: 'api:anthropic',
    kind: 'api',
    capabilities: { fileAccess: false, subscriptionBilled: false },
    events: ANSWER,
  })
  const runners = new Map<string, Runner>([['api:anthropic', runner]])
  const worktrees = new FakeWorktrees()
  const ladder = new Ladder(db, new RunSupervisor(db), new WorkerRouter(db, runners))
  const engine = new WorkflowEngine({ db, ladder, worktrees })
  const scheduler = new Scheduler(db, engine)

  const workflow = createWorkflow(db, {
    contextId: ctx.id,
    name: 'W',
    steps: opts.steps ?? STEPS,
  })

  /** Tavanlardan YALNIZ diff tavanı dar; qalanları qəsdən çox geniş. */
  const schedule = (over: Partial<Parameters<typeof createSchedule>[1]> = {}) =>
    createSchedule(db, {
      workflowId: workflow.id,
      intervalSeconds: 60,
      budgetUsdPerRun: 100,
      budgetUsdTotal: 1000,
      maxRuns: 500,
      maxPendingDiffs: 1,
      startAt: T0,
      ...over,
    })

  return { db, scheduler, workflow, schedule, worktrees, ctx }
}

/** Zəncirin sintetik valideyn taskı — diff məhz onun adına yazılır (issue #36). */
function rootTaskOf(db: Db, workflowId: string, index = 0): string {
  const run = listWorkflowRuns(db, workflowId)[index]
  if (run?.rootTaskId === null || run?.rootTaskId === undefined) {
    throw new Error('sintetik valideyn task yaradılmayıb')
  }
  return run.rootTaskId
}

describe('Scheduler — disk tavanı (issue #38)', () => {
  it('avtomatik icra HƏQİQƏTƏN baxılmamış diff yığır', async () => {
    // Problemin özü: xərc tavanları buna kordur. Bu test onu göstərir, sonrakılar
    // isə yeni tavanın onu dayandırdığını.
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule({ maxPendingDiffs: 500 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)

    expect(countPendingDiffsForSchedule(db, s.id)).toBe(2)
    expect(getDiffArtifact(db, rootTaskOf(db, workflow.id))?.status).toBe('pending')
    // Xərc tavanı buna toxunmur — icra ucuzdur, sayğac isə hələ çox uzaqdır.
    expect(getSchedule(db, s.id)?.enabled).toBe(true)
  })

  it('hədd dolanda cədvəl SÖNDÜRÜLÜR — üstəlik ELƏ HƏMİN tikdə', async () => {
    // Yalnız icradan ƏVVƏL yoxlasaydıq, gündəlik cədvəldə söndürülmə bir GÜN
    // gecikər və istifadəçi səbəbi yalnız sabah görərdi.
    const { db, scheduler, schedule } = setup()
    const s = schedule({ maxPendingDiffs: 1 })

    const result = await scheduler.tick(T0)

    expect(result.started).toHaveLength(1)
    expect(result.disabled[0]?.reason).toContain('baxılmamış diff')
    expect(getSchedule(db, s.id)?.enabled).toBe(false)
    expect(getSchedule(db, s.id)?.disabledReason).toContain('1/1')
  })

  it('söndürülmüş cədvəl daha diff yığmır', async () => {
    const { db, scheduler, schedule } = setup()
    const s = schedule({ maxPendingDiffs: 1 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)
    await scheduler.tick(T0 + 120_000)

    expect(countPendingDiffsForSchedule(db, s.id)).toBe(1)
    expect(getSchedule(db, s.id)?.runs).toBe(1)
  })

  it('tavan `>=` ilə yoxlanılır — bir vahid sızmır', async () => {
    // `maxPendingDiffs = 2` "ən çox iki baxılmamış diff" deməkdir, üçüncüsü
    // YARANMAMALIDIR (digər üç tavanla eyni qayda).
    const { db, scheduler, schedule } = setup()
    const s = schedule({ maxPendingDiffs: 2 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)
    await scheduler.tick(T0 + 120_000)

    expect(countPendingDiffsForSchedule(db, s.id)).toBe(2)
    expect(getSchedule(db, s.id)?.enabled).toBe(false)
  })

  it('diff-ə BAXILANDA yer boşalır və cədvəl yenidən işləyir', async () => {
    // Say sütunda SAXLANILSAYDI bu mümkün olmazdı: tavan dolan kimi ƏBƏDİ dolu
    // qalar və "baxdım, davam et" işləməzdi.
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule({ maxPendingDiffs: 1 })

    await scheduler.tick(T0)
    expect(getSchedule(db, s.id)?.enabled).toBe(false)

    const artifact = getDiffArtifact(db, rootTaskOf(db, workflow.id))
    resolveArtifact(db, artifact?.id as number, 'accepted')
    expect(countPendingDiffsForSchedule(db, s.id)).toBe(0)

    // Yenidən açmaq İSTİFADƏÇİNİN qərarıdır — söndürülmə səbəbi də təmizlənir.
    updateSchedule(db, s.id, { enabled: true })
    const next = await scheduler.tick(T0 + 60_000)

    expect(next.started).toHaveLength(1)
    expect(getSchedule(db, s.id)?.runs).toBe(2)
  })

  it('say CƏDVƏL başınadır — eyni zəncirin ikinci cədvəli təsirlənmir', async () => {
    // `workflow_id` üzrə saysaydıq (və ya sadəcə `trigger: "schedule"` üzrə),
    // eyni zəncirə qurulmuş iki cədvəldən biri digərinin diskinə görə
    // söndürülərdi. Məhz buna görə `workflow_runs.schedule_id` sütunu var.
    const { db, scheduler, schedule } = setup()
    const a = schedule({ maxPendingDiffs: 1 })
    const b = schedule({ maxPendingDiffs: 1, startAt: T0 + 30_000 })

    await scheduler.tick(T0)
    expect(getSchedule(db, a.id)?.enabled).toBe(false)
    expect(countPendingDiffsForSchedule(db, b.id)).toBe(0)

    const second = await scheduler.tick(T0 + 30_000)

    expect(second.started).toHaveLength(1)
    expect(countPendingDiffsForSchedule(db, b.id)).toBe(1)
  })

  it('ƏL İLƏ icranın diff-i cədvələ yazılmır', async () => {
    // Baxış qapısı əl ilə icrada da işləyir (issue #36), amma o diff-lər
    // istifadəçinin ÖZ qərarı ilə yaranıb — avtomatik icranın tavanını
    // doldurmamalıdır.
    const { db, scheduler, schedule, workflow } = setup()
    const s = schedule({ maxPendingDiffs: 5 })
    const { getContext } = await import('../db/repo.js')
    const ctxRow = getContext(db, workflow.contextId)

    const engine = new WorkflowEngine({
      db,
      ladder: new Ladder(
        db,
        new RunSupervisor(db),
        new WorkerRouter(
          db,
          new Map<string, Runner>([
            [
              'api:anthropic',
              new FakeRunner({
                id: 'api:anthropic',
                kind: 'api',
                capabilities: { fileAccess: false, subscriptionBilled: false },
                events: ANSWER,
              }),
            ],
          ]),
        ),
      ),
      worktrees: new FakeWorktrees(),
    })
    await engine.run({
      workflowId: workflow.id,
      steps: STEPS,
      trigger: 'manual',
      context: {
        id: ctxRow?.id as string,
        cwd: 'C:/repo',
        verifyCommandsJson: '[]',
        amplificationProfile: 'cheap',
        defaultWorkerModelId: null,
        maxParallel: 4,
        memoryScope: null,
        memoryEnabled: false,
      },
    })

    expect(countPendingDiffsForSchedule(db, s.id)).toBe(0)
    await scheduler.tick(T0)
    expect(countPendingDiffsForSchedule(db, s.id)).toBe(1)
  })

  it('diff YARATMAYAN zəncir tavanı doldurmur', async () => {
    // Problem yalnız repoya HƏQİQƏTƏN yazan zəncirlərdə var: dəyişiklik
    // olmayanda `finalizeWorktree` qovluğu DƏRHAL silir.
    const { db, scheduler, schedule, worktrees } = setup()
    worktrees.diff = { diff: '', files: 0, truncated: false }
    const s = schedule({ maxPendingDiffs: 1 })

    await scheduler.tick(T0)
    await scheduler.tick(T0 + 60_000)

    expect(countPendingDiffsForSchedule(db, s.id)).toBe(0)
    expect(worktrees.removed).toHaveLength(2)
    expect(getSchedule(db, s.id)?.enabled).toBe(true)
  })
})

describe('Baxılmamış diff tavanı — sxem defaultu', () => {
  it('DB defaultu shared sabitinə BƏRABƏRDİR', () => {
    // İki mənbə var, çünki `drizzle-kit generate` `schema.ts`-i CJS kimi yükləyir
    // və `@orchestris/shared` importunu həll edə bilmir (səbəb `schema.ts`-də
    // yazılıb). Ayrılmalarını yalnız bu test tutur.
    const db: Db = openDb(':memory:')
    const ctx = createContext(db, { name: 'C' })
    const workflow = createWorkflow(db, {
      contextId: ctx.id,
      name: 'W',
      steps: STEPS,
    })

    const s = createSchedule(db, {
      workflowId: workflow.id,
      intervalSeconds: 60,
      budgetUsdPerRun: 1,
      budgetUsdTotal: 10,
      maxRuns: 5,
    })

    expect(s.maxPendingDiffs).toBe(DEFAULT_MAX_PENDING_DIFFS)
  })
})
