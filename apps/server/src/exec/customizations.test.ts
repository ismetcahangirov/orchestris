import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { McpServer } from '../db/customization-repo.js'
import {
  buildMcpConfig,
  resolveCustomizations,
  writeMcpConfig,
} from './customizations.js'

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    id: 'id-1',
    name: 'probe',
    transport: 'stdio',
    command: 'node',
    argsJson: '["server.js"]',
    envJson: '{}',
    secretEnvJson: '[]',
    url: null,
    enabled: true,
    createdAt: 1,
    ...over,
  }
}

const noSecrets = (): undefined => undefined

describe('buildMcpConfig', () => {
  it('stdio serverini command/args ilə qurur', () => {
    const { config } = buildMcpConfig([server()], noSecrets)
    expect(config).toEqual({
      mcpServers: { probe: { command: 'node', args: ['server.js'] } },
    })
  })

  it('env sirsiz dəyərləri daşıyır', () => {
    const { config } = buildMcpConfig(
      [server({ envJson: '{"MODE":"fast"}' })],
      noSecrets,
    )
    expect(config?.mcpServers['probe']?.env).toEqual({ MODE: 'fast' })
  })

  it('http serverini url ilə qurur', () => {
    const { config } = buildMcpConfig(
      [server({ transport: 'http', command: null, url: 'https://x/mcp' })],
      noSecrets,
    )
    expect(config?.mcpServers['probe']).toEqual({ type: 'http', url: 'https://x/mcp' })
  })

  it('sirlər keychain-dən oxunub içəri qoyulur', () => {
    const { config } = buildMcpConfig([server({ secretEnvJson: '["TOKEN"]' })], () => 'gizli')
    expect(config?.mcpServers['probe']?.env).toEqual({ TOKEN: 'gizli' })
  })

  it('sirr tapılmasa server ATILIR — yarımçıq env təhlükəlidir', () => {
    const { config, skipped } = buildMcpConfig(
      [server({ secretEnvJson: '["TOKEN"]' })],
      noSecrets,
    )
    expect(config).toBeNull()
    expect(skipped).toEqual(['probe'])
  })

  it('söndürülmüş server konfiqurasiyaya girmir', () => {
    expect(buildMcpConfig([server({ enabled: false })], noSecrets).config).toBeNull()
  })

  it('stdio-da command yoxdursa atılır', () => {
    const { config, skipped } = buildMcpConfig([server({ command: null })], noSecrets)
    expect(config).toBeNull()
    expect(skipped).toEqual(['probe'])
  })

  it('http-də url yoxdursa atılır', () => {
    const { skipped } = buildMcpConfig(
      [server({ transport: 'http', command: null, url: null })],
      noSecrets,
    )
    expect(skipped).toEqual(['probe'])
  })

  it('server yoxdursa null qaytarır — BOŞ fayl yazmaq ödəniş verib heç nə almazdı', () => {
    expect(buildMcpConfig([], noSecrets).config).toBeNull()
  })

  it('sınıq JSON sütunları icranı sındırmır', () => {
    const { config } = buildMcpConfig(
      [server({ argsJson: '{{{', envJson: '{{{', secretEnvJson: '{{{' })],
      noSecrets,
    )
    expect(config?.mcpServers['probe']).toEqual({ command: 'node', args: [] })
  })
})

describe('resolveCustomizations', () => {
  it('heç nə seçilməyibsə undefined — SABİT dəst işlədilir', () => {
    // Bu, fazanın ƏSAS təminatıdır: seçim etməyən kontekstin əmr sətri
    // bayt-bayt köhnə qalır və mövcud keşlər sınmır.
    expect(
      resolveCustomizations({
        mcpConfigPath: undefined,
        pluginDirs: [],
        builtinSkills: false,
      }),
    ).toBeUndefined()
  })

  it('yalnız daxili skill-lər seçilibsə də deskriptor qaytarır', () => {
    const got = resolveCustomizations({
      mcpConfigPath: undefined,
      pluginDirs: [],
      builtinSkills: true,
    })
    expect(got).toEqual({ pluginDirs: [], builtinSkills: true })
  })

  it('pluginDirs DETERMİNİST sıralanır', () => {
    const got = resolveCustomizations({
      mcpConfigPath: undefined,
      pluginDirs: ['/z', '/a'],
      builtinSkills: false,
    })
    expect(got?.pluginDirs).toEqual(['/a', '/z'])
  })

  it('təkrarlanan qovluq bir dəfə verilir', () => {
    const got = resolveCustomizations({
      mcpConfigPath: undefined,
      pluginDirs: ['/a', '/a'],
      builtinSkills: false,
    })
    expect(got?.pluginDirs).toEqual(['/a'])
  })
})

describe('writeMcpConfig', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-mcp-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('faylı yazır və yolunu qaytarır', () => {
    const path = writeMcpConfig(dir, 'ctx-1', { mcpServers: { a: { command: 'x' } } })
    expect(path).toBe(join(dir, 'ctx-1.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { a: { command: 'x' } },
    })
  })

  it('ÜZƏRİNƏ yazır — köhnə seçim səssizcə işlədilməməlidir', () => {
    writeMcpConfig(dir, 'ctx-2', { mcpServers: { a: { command: 'x' } } })
    const path = writeMcpConfig(dir, 'ctx-2', { mcpServers: { b: { command: 'y' } } })
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['b'])
  })
})
