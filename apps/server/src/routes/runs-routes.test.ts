import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import { createContext, createRun, createTask, finishRun } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'orchestris' })
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, ctx, app }
}

describe('GET /api/runs/active', () => {
  it('icra yoxdursa boş siyahı verir', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ runs: [] })
  })

  it('işləyən icra görünür, bitmiş icra görünmür', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'auth bug' })
    const live = createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm1' })
    const done = createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm2' })
    finishRun(db, done.id, { status: 'succeeded' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    const rows = res.json().runs as { runId: string }[]
    expect(rows.map((r) => r.runId)).toEqual([live.id])
  })

  it('kontekst adı və prompt parçası cavabdadır', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'auth bug-ı düzəlt' })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.json().runs[0]).toMatchObject({
      contextName: 'orchestris',
      promptExcerpt: 'auth bug-ı düzəlt',
    })
  })

  it('uzun prompt kəsilir və çoxnöqtə alır', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'a'.repeat(80) })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    const got = res.json().runs[0].promptExcerpt as string
    expect(got).toHaveLength(61)
    expect(got.endsWith('…')).toBe(true)
  })

  it('çoxsətirli prompt bir sətrə yığılır', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'bir\n\niki   üç' })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.json().runs[0].promptExcerpt).toBe('bir iki üç')
  })

  it('mənfi pillələr (distillə/bölgü) də görünür', async () => {
    // Onlar da pul yandırır və "niyə hələ gözləyirəm?" sualının cavabı çox
    // vaxt məhz onlardır — gizlətsək istifadəçi sistemi donmuş sayardı.
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm', ladderRung: -1 })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.json().runs[0].ladderRung).toBe(-1)
  })
})
