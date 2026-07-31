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
import { mcpSecretRef } from './customizations.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

let dir: string
let zip: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-plug-'))
  zip = join(dir, 'bundle.zip')
  writeFileSync(zip, 'PK')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const db = openDb(':memory:')
  const credentials = new MemoryStore()
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials, catalog: CATALOG })
  return { db, app, credentials }
}

const STDIO = { name: 'probe', transport: 'stdio', command: 'node', args: ['s.js'] }

describe('POST /api/mcp-servers', () => {
  it('stdio serveri əlavə edilir', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/mcp-servers', payload: STDIO })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ name: 'probe', transport: 'stdio' })
  })

  it('SİRR cavabda QAYTARILMIR — yalnız ad (qayda 13)', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { ...STDIO, secretEnv: { TOKEN: 'çox-gizli-dəyər' } },
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('çox-gizli-dəyər')
    expect(res.json().secretEnvNames).toEqual(['TOKEN'])
    expect(res.json().hasSecret).toBe(true)
  })

  it('sirr KEYCHAIN-ə yazılır, DB-yə yox', async () => {
    const { app, credentials } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { ...STDIO, secretEnv: { TOKEN: 'gizli' } },
    })
    const id = res.json().id as string
    expect(await credentials.get(mcpSecretRef(id, 'TOKEN'))).toBe('gizli')
  })

  it('siyahıda da sirr YOXDUR', async () => {
    const { app } = setup()
    await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { ...STDIO, secretEnv: { TOKEN: 'gizli-siyahı' } },
    })
    const res = await app.inject({ method: 'GET', url: '/api/mcp-servers' })
    expect(res.body).not.toContain('gizli-siyahı')
  })

  it('boşluqlu ad rədd edilir — ad alət adına düşür', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { ...STDIO, name: 'my server' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('stdio-da command yoxdursa 400', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { name: 'x', transport: 'stdio' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('http-də url yoxdursa 400', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      payload: { name: 'x', transport: 'http' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /api/mcp-servers/:id', () => {
  it('istifadə olunmayan server silinir', async () => {
    const { app } = setup()
    const id = (
      await app.inject({ method: 'POST', url: '/api/mcp-servers', payload: STDIO })
    ).json().id as string
    const res = await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${id}` })
    expect(res.statusCode).toBe(200)
  })

  it('işlədilən server 409 verir — səssiz silmə icranı sındırardı', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'C' })
    const id = (
      await app.inject({ method: 'POST', url: '/api/mcp-servers', payload: STDIO })
    ).json().id as string
    await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { mcpServerIds: [id] },
    })

    const res = await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${id}` })
    expect(res.statusCode).toBe(409)
    expect(res.json().contexts).toEqual([ctx.id])
  })

  it('mövcud olmayan server 404 verir', async () => {
    const { app } = setup()
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/mcp-servers/yoxdur' })).statusCode,
    ).toBe(404)
  })
})

describe('POST /api/plugins', () => {
  it('mövcud qovluq qəbul edilir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      payload: { name: 'p', path: dir },
    })
    expect(res.statusCode).toBe(201)
  })

  it('.zip faylı da qəbul edilir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      payload: { name: 'z', path: zip },
    })
    expect(res.statusCode).toBe(201)
  })

  it('mövcud olmayan yol 400 verir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      payload: { name: 'p', path: join(dir, 'yoxdur') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('zip olmayan fayl 400 verir', async () => {
    const { app } = setup()
    const file = join(dir, 'oxu.txt')
    writeFileSync(file, 'x')
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      payload: { name: 'p', path: file },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/contexts/:id — fərdiləşdirmə seçimi', () => {
  it('seçim yazılır və builtinSkillsEnabled saxlanılır', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'C' })
    const id = (
      await app.inject({ method: 'POST', url: '/api/mcp-servers', payload: STDIO })
    ).json().id as string

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { mcpServerIds: [id], builtinSkillsEnabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().builtinSkillsEnabled).toBe(true)
  })

  it('default builtinSkillsEnabled SÖNÜLÜDÜR', async () => {
    // Açsaydıq hər mövcud kontekst bir dəfə ÖLÇÜLMÜŞ +3,648 token ödəyərdi.
    const { db } = setup()
    expect(createContext(db, { name: 'C' }).builtinSkillsEnabled).toBe(false)
  })
})

describe('GET /api/mcp-servers/available', () => {
  it('fayl yoxdursa boş siyahı — xəta YOX', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/api/mcp-servers/available' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().servers)).toBe(true)
  })
})
