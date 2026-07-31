import { describe, expect, it } from 'vitest'
import { openDb } from './client.js'
import {
  contextsUsingMcpServer,
  contextsUsingPlugin,
  createMcpServer,
  createPluginSource,
  deleteMcpServer,
  listContextMcpServers,
  listContextPlugins,
  listMcpServers,
  setContextMcpServers,
  setContextPlugins,
} from './customization-repo.js'
import { createContext } from './repo.js'

function seed() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  return { db, ctx }
}

describe('mcp_servers', () => {
  it('stdio serveri yaradılır', () => {
    const { db } = seed()
    const s = createMcpServer(db, {
      name: 'context7',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'context7'],
    })
    expect(s.transport).toBe('stdio')
    expect(JSON.parse(s.argsJson)).toEqual(['-y', 'context7'])
    expect(s.enabled).toBe(true)
  })

  it('secretEnv yalnız ADLARI saxlayır — DƏYƏR YOX (qayda 13)', () => {
    const { db } = seed()
    const s = createMcpServer(db, {
      name: 'sentry',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      secretEnv: ['SENTRY_TOKEN'],
    })
    expect(JSON.parse(s.secretEnvJson)).toEqual(['SENTRY_TOKEN'])
    // Sətrin heç bir yerində dəyər olmamalıdır — sütun yalnız ad daşıyır.
    expect(JSON.stringify(s)).not.toContain('secret-value')
  })

  it('eyni ad İKİ dəfə yazıla bilmir', () => {
    const { db } = seed()
    createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    expect(() => createMcpServer(db, { name: 'a', transport: 'stdio', command: 'y' })).toThrow()
  })

  it('siyahı ADA görə sıralanır — determinizm keş üçün vacibdir', () => {
    const { db } = seed()
    createMcpServer(db, { name: 'zeta', transport: 'stdio', command: 'x' })
    createMcpServer(db, { name: 'alfa', transport: 'stdio', command: 'x' })
    expect(listMcpServers(db).map((s) => s.name)).toEqual(['alfa', 'zeta'])
  })
})

describe('kontekst seçimi', () => {
  it('seçim TAM ƏVƏZ olunur', () => {
    const { db, ctx } = seed()
    const a = createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    const b = createMcpServer(db, { name: 'b', transport: 'stdio', command: 'x' })

    setContextMcpServers(db, ctx.id, [a.id, b.id])
    expect(listContextMcpServers(db, ctx.id)).toHaveLength(2)

    setContextMcpServers(db, ctx.id, [b.id])
    expect(listContextMcpServers(db, ctx.id).map((s) => s.name)).toEqual(['b'])
  })

  it('təkrarlanan id bir dəfə yazılır', () => {
    const { db, ctx } = seed()
    const a = createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    setContextMcpServers(db, ctx.id, [a.id, a.id])
    expect(listContextMcpServers(db, ctx.id)).toHaveLength(1)
  })

  it('kontekstin serverləri ADA görə sıralanır', () => {
    const { db, ctx } = seed()
    const z = createMcpServer(db, { name: 'zeta', transport: 'stdio', command: 'x' })
    const a = createMcpServer(db, { name: 'alfa', transport: 'stdio', command: 'x' })
    setContextMcpServers(db, ctx.id, [z.id, a.id])
    expect(listContextMcpServers(db, ctx.id).map((s) => s.name)).toEqual(['alfa', 'zeta'])
  })

  it('plugin seçimi işləyir', () => {
    const { db, ctx } = seed()
    const p = createPluginSource(db, { name: 'superpowers', path: '/plug' })
    setContextPlugins(db, ctx.id, [p.id])
    expect(listContextPlugins(db, ctx.id).map((x) => x.path)).toEqual(['/plug'])
  })
})

describe('silmə qapısı', () => {
  it('işlədən konteksti tapır — səssiz silmə icranı sındırardı', () => {
    const { db, ctx } = seed()
    const a = createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    setContextMcpServers(db, ctx.id, [a.id])
    expect(contextsUsingMcpServer(db, a.id)).toEqual([ctx.id])
  })

  it('istifadə olunmayan server boş siyahı verir', () => {
    const { db } = seed()
    const a = createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    expect(contextsUsingMcpServer(db, a.id)).toEqual([])
  })

  it('plugin üçün də işləyir', () => {
    const { db, ctx } = seed()
    const p = createPluginSource(db, { name: 'p', path: '/plug' })
    setContextPlugins(db, ctx.id, [p.id])
    expect(contextsUsingPlugin(db, p.id)).toEqual([ctx.id])
  })

  it('server silinəndə bağlantı sətri də silinir (cascade)', () => {
    const { db, ctx } = seed()
    const a = createMcpServer(db, { name: 'a', transport: 'stdio', command: 'x' })
    setContextMcpServers(db, ctx.id, [a.id])
    deleteMcpServer(db, a.id)
    expect(listContextMcpServers(db, ctx.id)).toEqual([])
  })
})
