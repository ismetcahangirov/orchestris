import type { RunEvent, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { getDiffArtifact, saveDiffArtifact } from '../db/artifact-repo.js'
import { openDb } from '../db/client.js'
import { createContext, createTask } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'
import type { ApplyResult, Worktree, WorktreeDiff, WorktreeManager } from '../exec/worktree.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]
const CATALOG: Catalog = { source: 'bundled', providers: [] }

class FakeWorktrees implements WorktreeManager {
  removed: string[] = []
  applied: { repo: string; diff: string }[] = []
  applyResult: ApplyResult = { ok: true }

  async create(): Promise<Worktree | null> {
    return null
  }

  async collect(): Promise<WorktreeDiff> {
    return { diff: '', files: 0, truncated: false }
  }

  async remove(wt: Worktree): Promise<void> {
    this.removed.push(wt.path)
  }

  async apply(input: { repo: string; diff: string }): Promise<ApplyResult> {
    this.applied.push(input)
    return this.applyResult
  }
}

function setup(over: { truncated?: boolean; withWorktrees?: boolean } = {}) {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  const worktrees = new FakeWorktrees()
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: DONE })]])
  const app = buildApp({
    db,
    runners,
    credentials: new MemoryStore(),
    catalog: CATALOG,
    ...(over.withWorktrees === false ? {} : { worktrees }),
  })

  const artifact = saveDiffArtifact(db, {
    taskId: task.id,
    worktreePath: 'C:/wt/1',
    branch: 'orchestris/1',
    repoPath: 'C:/repo',
    content: 'diff --git a/a b/a',
    files: 2,
    truncated: over.truncated ?? false,
  })

  return { db, app, task, artifact, worktrees, ctx }
}

describe('diff qəbulu / rəddi', () => {
  it('qəbul diff-i əsas repoya tətbiq edir və worktree-ni silir', async () => {
    const { db, app, task, worktrees } = setup()
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/accept` })

    expect(res.statusCode).toBe(200)
    expect(worktrees.applied).toEqual([{ repo: 'C:/repo', diff: 'diff --git a/a b/a' }])
    expect(worktrees.removed).toEqual(['C:/wt/1'])
    expect(getDiffArtifact(db, task.id)?.status).toBe('accepted')
  })

  it('tətbiq alınmasa sətir `pending` QALIR — istifadəçi yenidən cəhd edə bilər', async () => {
    const { db, app, task, worktrees } = setup()
    worktrees.applyResult = { ok: false, error: 'patch does not apply' }

    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/accept` })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('patch does not apply')
    // Worktree SİLİNMİR: dəyişikliyin yeganə nüsxəsi hələ oradadır.
    expect(worktrees.removed).toEqual([])
    expect(getDiffArtifact(db, task.id)?.status).toBe('pending')
  })

  it('kəsilmiş diff qəbul edilmir — yarımçıq patch tətbiq olunmamalıdır', async () => {
    const { app, task, worktrees } = setup({ truncated: true })
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/accept` })

    expect(res.statusCode).toBe(409)
    expect(res.json().worktreePath).toBe('C:/wt/1')
    expect(worktrees.applied).toEqual([])
  })

  it('rədd əsas repoya heç nə yazmır, worktree-ni silir', async () => {
    const { db, app, task, worktrees } = setup()
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/reject` })

    expect(res.statusCode).toBe(200)
    expect(worktrees.applied).toEqual([])
    expect(worktrees.removed).toEqual(['C:/wt/1'])
    // Sətir qalır: "bu task nə etmişdi?" sualının cavabı diff mətnindədir.
    expect(getDiffArtifact(db, task.id)?.status).toBe('rejected')
  })

  it('iki dəfə həll edilə bilməz', async () => {
    const { app, task } = setup()
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/reject` })
    const again = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/accept` })

    expect(again.statusCode).toBe(409)
    expect(again.json().error).toContain('rejected')
  })

  it('diff yoxdursa 404', async () => {
    const { db, app, ctx } = setup()
    const other = createTask(db, { contextId: ctx.id, prompt: 'başqa' })
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${other.id}/diff/accept` })
    expect(res.statusCode).toBe(404)
  })

  it('worktree dəstəyi qurulmayıbsa 503 — səssiz uğur qaytarılmır', async () => {
    const { app, task } = setup({ withWorktrees: false })
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/diff/accept` })
    expect(res.statusCode).toBe(503)
  })

  it('GET /api/tasks/:id artefaktları qaytarır', async () => {
    const { app, task } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` })
    expect(res.json().artifacts).toHaveLength(1)
    expect(res.json().artifacts[0].status).toBe('pending')
  })
})

describe('max_parallel ayarı', () => {
  it('default 0-dır (avtomatik) və PATCH ilə dəyişir', async () => {
    const { app, ctx } = setup()
    expect(ctx.maxParallel).toBe(0)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { maxParallel: 3 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().maxParallel).toBe(3)
  })

  it('mənfi dəyər qəbul edilmir', async () => {
    const { app, ctx } = setup()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { maxParallel: -1 },
    })
    expect(res.statusCode).toBe(400)
  })
})
