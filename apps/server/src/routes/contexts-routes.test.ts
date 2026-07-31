import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from '@orchestris/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import { createContext } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orchestris-ctx-'))
  writeFileSync(join(root, 'fayl.txt'), 'x')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const db = openDb(':memory:')
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, app }
}

describe('POST /api/contexts — cwd yoxlanması', () => {
  it('mövcud qovluq qəbul edilir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: root },
    })
    expect(res.statusCode).toBe(201)
  })

  it('mövcud olmayan yol 400 verir', async () => {
    // Yoxlamasaq, səhv yol yalnız İLK TASK İCRASINDA üzə çıxardı — istifadəçi
    // artıq gözləyir və pul ödəyib.
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: join(root, 'yoxdur') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('fayl yolu 400 verir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: join(root, 'fayl.txt') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cwd verilməsə yoxlama işə düşmür', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('fayl icazəsi yaratmada saxlanılır', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: root, fileAccess: 'read-only' },
    })
    expect(res.json().fileAccess).toBe('read-only')
  })
})

describe('PATCH /api/contexts/:id — cwd və icazə', () => {
  it('cwd dəyişdirilə bilir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { cwd: root },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cwd).toBe(root)
  })

  it('cwd null ilə silinir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a', cwd: root })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { cwd: null },
    })
    expect(res.json().cwd).toBeNull()
  })

  it('mövcud olmayan əlavə qovluq 400 verir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { fileAccess: 'extended', extraDirs: [join(root, 'yoxdur')] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('mövcud əlavə qovluq qəbul edilir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { fileAccess: 'extended', extraDirs: [root] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.json().extraDirsJson)).toEqual([root])
  })

  it('tanınmayan səviyyə 400 verir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { fileAccess: 'zibil' },
    })
    expect(res.statusCode).toBe(400)
  })
})
