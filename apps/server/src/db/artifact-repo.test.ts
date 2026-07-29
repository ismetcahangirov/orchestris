import { describe, expect, it } from 'vitest'
import {
  getDiffArtifact,
  listArtifacts,
  listPendingArtifacts,
  resolveArtifact,
  saveDiffArtifact,
} from './artifact-repo.js'
import { openDb } from './client.js'
import { createContext, createTask } from './repo.js'

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  const save = (over: Partial<Parameters<typeof saveDiffArtifact>[1]> = {}) =>
    saveDiffArtifact(db, {
      taskId: task.id,
      worktreePath: 'C:/wt/1',
      branch: 'orchestris/1',
      repoPath: 'C:/repo',
      content: 'diff --git a/a b/a',
      files: 1,
      truncated: false,
      ...over,
    })
  return { db, task, save }
}

describe('artifact-repo', () => {
  it('diff yazılır və `pending` başlayır', () => {
    const { db, task, save } = setup()
    const row = save()

    expect(row.status).toBe('pending')
    expect(getDiffArtifact(db, task.id)?.content).toContain('diff --git')
    expect(listArtifacts(db, task.id)).toHaveLength(1)
  })

  it('təkrar yazılış sətri ƏVƏZ EDİR — task başına bir diff', () => {
    const { db, task, save } = setup()
    save()
    save({ content: 'yeni diff', files: 3 })

    const rows = listArtifacts(db, task.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('yeni diff')
    expect(rows[0]?.files).toBe(3)
  })

  it('məzmun dəyişəndə köhnə qərar SIFIRLANIR', () => {
    const { db, task, save } = setup()
    const row = save()
    resolveArtifact(db, row.id, 'rejected')
    expect(getDiffArtifact(db, task.id)?.status).toBe('rejected')

    // Nərdivan eyni taskı yenidən qaçırdı və worktree-də yeni iş var.
    // İstifadəçinin KÖHNƏ məzmuna verdiyi "rədd" qərarı artıq keçərli deyil.
    save({ content: 'yeni iş' })
    const after = getDiffArtifact(db, task.id)
    expect(after?.status).toBe('pending')
    expect(after?.resolvedAt).toBeNull()
  })

  it('yalnız `pending` sətirlər yetim təmizləyicisindən qorunur', () => {
    const { db, save } = setup()
    const row = save()
    expect(listPendingArtifacts(db).map((a) => a.id)).toEqual([row.id])

    resolveArtifact(db, row.id, 'accepted')
    expect(listPendingArtifacts(db)).toEqual([])
  })

  it('task silinəndə artefakt da gedir (kaskad)', () => {
    const { db, task, save } = setup()
    save()
    db.$client.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    expect(getDiffArtifact(db, task.id)).toBeUndefined()
  })
})
