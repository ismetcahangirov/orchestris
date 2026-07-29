import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { getDiffArtifact } from '../db/artifact-repo.js'
import { openDb } from '../db/client.js'
import { createContext, createTask, listRunsForTask } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'
import type { Worktree, WorktreeDiff, WorktreeManager } from './worktree.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

/** Kod taskı: fayl yolu + yazma feli → `classify.ts` bunu `code` sayır. */
const CODE_PROMPT = 'src/a.ts faylındaki funksiyanı düzəlt'

/**
 * Sıfır proses spawn edən worktree — nərdivanın İZOLYASİYA MƏNTİQİNİ yoxlayır.
 *
 * Real git yolu `worktree.test.ts`-də müvəqqəti repo üzərində ayrıca test
 * olunur. Burada saxta işlətmək qəsdəndir: nərdivanın hər pilləsində git
 * çağırsaydıq, testlər onlarla saniyə çəkər və sınmanın səbəbi "git-mi,
 * nərdivan-mı?" sualı ilə qarışardı.
 */
class FakeWorktrees implements WorktreeManager {
  created: string[] = []
  removed: string[] = []
  applied: { repo: string; diff: string }[] = []
  /** `create` bunu qaytarır; `null` = worktree açıla bilmədi. */
  failCreate = false
  diff: WorktreeDiff = { diff: 'diff --git a/a.ts b/a.ts', files: 1, truncated: false }

  async create(input: { repo: string; taskId: string }): Promise<Worktree | null> {
    if (this.failCreate) return null
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

  async apply(input: { repo: string; diff: string }): Promise<{ ok: boolean }> {
    this.applied.push(input)
    return { ok: true }
  }
}

function setup(over: { maxParallel?: number; cwd?: string | null } = {}) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: over.cwd === undefined ? 'C:/repo' : over.cwd,
    maxParallel: over.maxParallel ?? 4,
    // `cheap` — yoxlama əmri və eskalasiya olmadan tək işçi icrası. İzolyasiya
    // pillələrdən asılı deyil, ona görə ən sadə profil seçilir.
    amplificationProfile: 'cheap',
  }
  const worktrees = new FakeWorktrees()
  const ladder = new Ladder(db, new RunSupervisor(db), undefined, worktrees)
  const runner: Runner = new FakeRunner({ events: DONE, capabilities: { fileAccess: true } })
  const run = async (prompt = CODE_PROMPT) => {
    const task = createTask(db, { contextId: ctx.id, prompt })
    const result = await ladder.run({ task, context: ctx, runner, model: 'm' })
    return { result, taskId: task.id }
  }
  return { db, ctx, worktrees, ladder, run }
}

describe('Ladder — worktree izolyasiyası', () => {
  it('paralel kod taskı ayrıca worktree-də icra olunur və yol qeyd olunur', async () => {
    const { db, worktrees, run } = setup()
    const { taskId } = await run()

    expect(worktrees.created).toEqual([taskId])
    // `runs.worktree_path` "bu icra hansı ağacda işlədi?" sualının cavabıdır —
    // worktree silindikdən sonra da qalır.
    expect(listRunsForTask(db, taskId)[0]?.worktreePath).toContain(taskId)
  })

  it('dəyişiklik varsa diff artefakt kimi saxlanılır və worktree QALIR', async () => {
    const { db, worktrees, run } = setup()
    const { taskId } = await run()

    const artifact = getDiffArtifact(db, taskId)
    expect(artifact?.status).toBe('pending')
    expect(artifact?.files).toBe(1)
    expect(artifact?.content).toContain('diff --git')
    // Qəbul/rədd istifadəçinin qərarıdır — nərdivan silmir.
    expect(worktrees.removed).toEqual([])
  })

  it('dəyişiklik yoxdursa worktree DƏRHAL silinir və artefakt yazılmır', async () => {
    const { db, worktrees, run } = setup()
    worktrees.diff = { diff: '', files: 0, truncated: false }
    const { taskId } = await run()

    expect(getDiffArtifact(db, taskId)).toBeUndefined()
    expect(worktrees.removed).toHaveLength(1)
  })

  it('ardıcıl rejimdə (max_parallel = 1) worktree açılmır', async () => {
    const { worktrees, run } = setup({ maxParallel: 1 })
    await run()
    expect(worktrees.created).toEqual([])
  })

  it('mətn taskı üçün worktree açılmır', async () => {
    const { worktrees, run } = setup()
    await run('bu layihəni izah et')
    expect(worktrees.created).toEqual([])
  })

  it('cwd yoxdursa worktree açılmır', async () => {
    const { worktrees, run } = setup({ cwd: null })
    await run()
    expect(worktrees.created).toEqual([])
  })

  it('worktree açıla bilməsə task NORMAL davam edir', async () => {
    const { db, worktrees, run } = setup()
    worktrees.failCreate = true
    const { result, taskId } = await run()

    expect(result.status).toBe('succeeded')
    expect(listRunsForTask(db, taskId)[0]?.worktreePath).toBeNull()
  })
})
