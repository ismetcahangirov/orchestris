import type { RunEvent, Runner, WorkflowStep } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { getDiffArtifact } from '../db/artifact-repo.js'
import { openDb, type Db } from '../db/client.js'
import { createContext, getTask, listSubtasks } from '../db/repo.js'
import {
  modelRowId,
  setExclusiveRole,
  setProviderCredentialRef,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { getSavings } from '../db/savings-repo.js'
import { createWorkflow, getWorkflowRun } from '../db/workflow-repo.js'
import { WorkerRouter } from '../routing/decide.js'
import { FakeRunner } from '../runners/fake.js'
import { Decomposer } from './decomposer.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'
import { WorkflowEngine } from './workflow-engine.js'
import type { Worktree, WorktreeDiff, WorktreeManager } from './worktree.js'

/**
 * Zəncirin ORTAQ ağacı (issue #36).
 *
 * Testlər saxta `WorktreeManager` işlədir — `ladder-worktree.test.ts` ilə eyni
 * səbəb: real git yolu `worktree.test.ts`-də ayrıca yoxlanılır, burada isə
 * MƏNTİQ yoxlanılır (kim ağac açır, diff kimin adına yazılır, kim bağlayır).
 */

/** Kod taskı: fayl yolu + yazma feli → `classify.ts` bunu `code` sayır. */
const CODE_PROMPT = 'src/a.ts faylındaki funksiyanı düzəlt'
const TEXT_PROMPT = 'bu mətni xülasə et'

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
    source: 'models.dev',
    ...over,
  }
}

function taskStep(id: string, prompt: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { kind: 'task', id, prompt, ...over } as WorkflowStep
}

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
  worker?: readonly (readonly RunEvent[])[]
  boss?: readonly (readonly RunEvent[])[]
  maxParallel?: number
  cwd?: string | null
  /** Verilməsə saxta manager qurulur; `false` → motora ümumiyyətlə verilmir. */
  worktrees?: false
}

function setup(opts: SetupOptions = {}) {
  const db: Db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    // `cheap` — eskalasiyasız tək işçi icrası. İzolyasiya pillələrdən asılı deyil.
    amplificationProfile: 'cheap',
    cwd: opts.cwd === undefined ? 'C:/repo' : opts.cwd,
    maxParallel: opts.maxParallel ?? 4,
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
  setExclusiveRole(db, 'boss', modelRowId('openai', 'başçı'))

  const caps = { fileAccess: true, subscriptionBilled: false }
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
  const worktrees = new FakeWorktrees()
  const ladder = new Ladder(db, supervisor, router, worktrees)
  const decomposer = new Decomposer(db, supervisor, ladder, router, worktrees)
  const engine = new WorkflowEngine({
    db,
    ladder,
    decomposer,
    allow: { hosts: [] },
    ...(opts.worktrees === false ? {} : { worktrees }),
  })

  const run = async (steps: WorkflowStep[]) => {
    const wf = createWorkflow(db, { contextId: ctx.id, name: 'W', steps })
    return engine.run({ workflowId: wf.id, steps, context: ctx, trigger: 'manual' })
  }

  return { db, ctx, worktrees, engine, run }
}

describe('WorkflowEngine — ortaq worktree (issue #36)', () => {
  it('bütün kod addımları BİR ortaq ağacda qaçır — valideyn taskın adına', async () => {
    const { worktrees, run } = setup()
    const result = await run([
      taskStep('a', CODE_PROMPT),
      taskStep('b', `${CODE_PROMPT} — davamı`),
    ])

    expect(result.rootTaskId).toBeDefined()
    // BİR ağac, addım başına bir dənə YOX: 2-ci addım 1-cinin işini görməlidir.
    expect(worktrees.created).toEqual([result.rootTaskId])
  })

  it('diff VALİDEYN taskın adına `pending` yazılır və ağac QALIR', async () => {
    const { db, worktrees, run } = setup()
    const result = await run([taskStep('a', CODE_PROMPT)])

    const artifact = getDiffArtifact(db, result.rootTaskId ?? '')
    expect(artifact?.status).toBe('pending')
    expect(artifact?.content).toContain('diff --git')
    // Qəbul/rədd istifadəçinin qərarıdır (qayda 42) — motor silmir.
    expect(worktrees.removed).toEqual([])
  })

  it('dəyişiklik yoxdursa ağac dərhal silinir və artefakt yazılmır', async () => {
    const { db, worktrees, run } = setup()
    worktrees.diff = { diff: '', files: 0, truncated: false }
    const result = await run([taskStep('a', CODE_PROMPT)])

    expect(getDiffArtifact(db, result.rootTaskId ?? '')).toBeUndefined()
    expect(worktrees.removed).toHaveLength(1)
  })

  it('addımların taskları valideynin ALT-TASKLARIDIR — sıra ilə', async () => {
    const { db, run } = setup({ worker: [answer('BİR'), answer('İKİ')] })
    const result = await run([taskStep('a', CODE_PROMPT), taskStep('b', TEXT_PROMPT)])

    const subtasks = listSubtasks(db, result.rootTaskId ?? '')
    expect(subtasks).toHaveLength(2)
    expect(subtasks.map((t) => t.subtaskIndex)).toEqual([0, 1])
  })

  it('təkrar cəhdləri FƏRQLİ sıra nömrəsi alır — indeks yox, icra sayğacı', async () => {
    const { db, run } = setup({ worker: [answer(''), answer('NƏTİCƏ')] })
    const result = await run([
      taskStep('a', CODE_PROMPT, {
        repeat: { max: 2, until: { from: 'previous', test: 'empty', negate: true } },
      } as Partial<WorkflowStep>),
    ])

    const subtasks = listSubtasks(db, result.rootTaskId ?? '')
    expect(subtasks).toHaveLength(2)
    expect(subtasks.map((t) => t.subtaskIndex)).toEqual([0, 1])
  })

  it('valideyn taskın statusu zəncirin yekununa uyğunlaşdırılır', async () => {
    const { db, run } = setup()
    const ok = await run([taskStep('a', CODE_PROMPT)])
    expect(getTask(db, ok.rootTaskId ?? '')?.status).toBe('succeeded')

    const { db: db2, run: run2 } = setup({
      worker: [[{ t: 'error', class: 'crashed', message: 'sındı' }]],
    })
    const bad = await run2([taskStep('a', CODE_PROMPT)])
    expect(bad.status).toBe('failed')
    expect(getTask(db2, bad.rootTaskId ?? '')?.status).toBe('failed')
  })

  it('valideyn task LEDGER sətri yaratmır — öz icrası yoxdur (qayda 24)', async () => {
    const { db, run } = setup()
    const result = await run([taskStep('a', CODE_PROMPT)])

    expect(getSavings(db, result.rootTaskId ?? '')).toBeUndefined()
    // Addımın öz taskı isə ölçülür — xərc gizlədilmir.
    const [step] = listSubtasks(db, result.rootTaskId ?? '')
    expect(getSavings(db, step?.id ?? '')).toBeDefined()
  })

  it('yalnız HTTP addımlarından ibarət zəncirdə valideyn task YARADILMIR', async () => {
    const { db, worktrees, run } = setup()
    const result = await run([
      { kind: 'http', id: 'h', method: 'GET', url: 'https://example.com' } as WorkflowStep,
    ])

    expect(result.rootTaskId).toBeUndefined()
    expect(getWorkflowRun(db, result.workflowRunId)?.rootTaskId).toBeNull()
    expect(worktrees.created).toEqual([])
  })

  it('mətn zəncirində ağac AÇILMIR, amma valideyn task qalır (alt-task ağacı)', async () => {
    const { db, worktrees, run } = setup()
    const result = await run([taskStep('a', TEXT_PROMPT)])

    expect(worktrees.created).toEqual([])
    expect(result.rootTaskId).toBeDefined()
    expect(listSubtasks(db, result.rootTaskId ?? '')).toHaveLength(1)
  })

  it('ardıcıl rejimdə (max_parallel = 1) ağac açılmır', async () => {
    const { worktrees, run } = setup({ maxParallel: 1 })
    await run([taskStep('a', CODE_PROMPT)])
    expect(worktrees.created).toEqual([])
  })

  it('`cwd` yoxdursa ağac açılmır — git ümumiyyətlə yoxdur', async () => {
    const { worktrees, run } = setup({ cwd: null })
    await run([taskStep('a', CODE_PROMPT)])
    expect(worktrees.created).toEqual([])
  })

  it('manager verilməyibsə davranış dəyişmir — izolyasiyasız icra', async () => {
    const { db, worktrees, run } = setup({ worktrees: false })
    const result = await run([taskStep('a', CODE_PROMPT)])

    expect(worktrees.created).toEqual([])
    expect(result.status).toBe('succeeded')
    expect(getDiffArtifact(db, result.rootTaskId ?? '')).toBeUndefined()
  })

  it('bölünən addım da ORTAQ ağacda qaçır — ikinci ağac açılmır', async () => {
    const { db, worktrees, run } = setup({
      boss: [answer('{"subtasks": ["src/a.ts düzəlt", "src/b.ts düzəlt"]}')],
      worker: [answer('BİR'), answer('İKİ')],
    })
    const result = await run([
      taskStep('a', CODE_PROMPT, { decompose: true } as Partial<WorkflowStep>),
    ])

    // Bölgü HƏQİQƏTƏN baş verdi: addımın taskının öz alt-taskları var.
    const [step] = listSubtasks(db, result.rootTaskId ?? '')
    expect(listSubtasks(db, step?.id ?? '')).toHaveLength(2)
    expect(worktrees.created).toEqual([result.rootTaskId])
    // Ağacın sahibi zəncirdir: bölgü onu BAĞLAMAMALIDIR, yoxsa diff addımın
    // taskına yazılar və zəncirin növbəti addımı boş qovluqda işləyərdi.
    expect(worktrees.removed).toEqual([])
  })
})
