import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerFsRoutes } from './fs.js'

let root: string
let app: FastifyInstance

const url = (route: string, path: string): string =>
  `${route}?path=${encodeURIComponent(path)}`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orchestris-fs-'))
  mkdirSync(join(root, 'repo-qovluq'))
  // `.git` QOVLUQ kimi — adi repo
  mkdirSync(join(root, 'repo-qovluq', '.git'))
  mkdirSync(join(root, 'worktree-repo'))
  // `.git` FAYL kimi — git worktree (CLAUDE.md qayda 44)
  writeFileSync(join(root, 'worktree-repo', '.git'), 'gitdir: /başqa/yer\n')
  mkdirSync(join(root, 'adi-qovluq'))
  mkdirSync(join(root, '.gizli'))
  writeFileSync(join(root, 'fayl.txt'), 'mən qovluq deyiləm')

  app = Fastify()
  registerFsRoutes(app)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

async function entries(path: string): Promise<{ name: string; isRepo: boolean; hidden: boolean }[]> {
  const res = await app.inject({ method: 'GET', url: url('/api/fs/list', path) })
  return res.json().entries
}

describe('GET /api/fs/list', () => {
  it('yalnız qovluqlar qaytarılır, fayllar yox', async () => {
    const names = (await entries(root)).map((e) => e.name)
    expect(names).not.toContain('fayl.txt')
    expect(names).toContain('adi-qovluq')
  })

  it('.git QOVLUQ olan qovluq repo sayılır', async () => {
    expect((await entries(root)).find((e) => e.name === 'repo-qovluq')?.isRepo).toBe(true)
  })

  it('.git FAYL olan qovluq da repo sayılır — worktree halı', async () => {
    // Yalnız qovluğu yoxlasaydıq, sistemin ÖZ yaratdığı worktree-lər "repo
    // deyil" görünərdi (qayda 44: worktree-də `.git` bir FAYLDIR).
    expect((await entries(root)).find((e) => e.name === 'worktree-repo')?.isRepo).toBe(
      true,
    )
  })

  it('adi qovluq repo sayılmır', async () => {
    expect((await entries(root)).find((e) => e.name === 'adi-qovluq')?.isRepo).toBe(false)
  })

  it('nöqtə ilə başlayan qovluq hidden işarələnir — SİLİNMİR', async () => {
    const e = (await entries(root)).find((x) => x.name === '.gizli')
    expect(e?.hidden).toBe(true)
  })

  it('siyahı ad üzrə sıralanır', async () => {
    const names = (await entries(root)).map((e) => e.name)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })

  it('nisbi yol 400 verir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=nisbi/yol' })
    expect(res.statusCode).toBe(400)
  })

  it('mövcud olmayan yol 404 verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/list', join(root, 'yoxdur')),
    })
    expect(res.statusCode).toBe(404)
  })

  it('fayl yolu 400 verir — qovluq gözlənilir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/list', join(root, 'fayl.txt')),
    })
    expect(res.statusCode).toBe(400)
  })

  it('parent bir səviyyə yuxarını verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/list', join(root, 'adi-qovluq')),
    })
    expect(res.json().parent).toBe(root)
  })

  it('drives boş deyil', async () => {
    const res = await app.inject({ method: 'GET', url: url('/api/fs/list', root) })
    expect(res.json().drives.length).toBeGreaterThan(0)
  })

  it('path verilməsə ev qovluğundan başlayır', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().path).toBe('string')
  })
})

describe('GET /api/fs/check', () => {
  it('yazıla bilən qovluq üçün writable true', async () => {
    const res = await app.inject({ method: 'GET', url: url('/api/fs/check', root) })
    expect(res.json()).toMatchObject({ exists: true, isDirectory: true, writable: true })
  })

  it('repo qovluğu isRepo true verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/check', join(root, 'repo-qovluq')),
    })
    expect(res.json().isRepo).toBe(true)
  })

  it('mövcud olmayan yol üçün exists false — 404 DEYİL', async () => {
    // Seçici hələ yazılmaqda olan yolu yoxlaya bilər; 404 UI-da xəta kimi
    // görünərdi, halbuki cavab sadəcə "hələ yoxdur"dur.
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/check', join(root, 'yoxdur')),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().exists).toBe(false)
  })

  it('fayl üçün isDirectory false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/api/fs/check', join(root, 'fayl.txt')),
    })
    expect(res.json()).toMatchObject({ exists: true, isDirectory: false })
  })

  it('prob faylı QALMIR', async () => {
    await app.inject({ method: 'GET', url: url('/api/fs/check', root) })
    const names = (await entries(root)).map((e) => e.name)
    expect(names.some((n) => n.startsWith('.orchestris-write-test'))).toBe(false)
  })

  it('path verilməsə 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/check' })
    expect(res.statusCode).toBe(400)
  })
})
