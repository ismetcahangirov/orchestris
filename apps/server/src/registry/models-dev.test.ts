import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_PROVIDER_IDS,
  CATALOG_TTL_MS,
  loadCatalog,
  normalizeCatalog,
  refreshCatalog,
} from './models-dev.js'

function tmpFile(name = 'models-cache.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'orch-cat-')), name)
}

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch
}

const MINIMAL = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-x': {
        id: 'claude-x',
        name: 'Claude X',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 64000 },
        tool_call: true,
        structured_output: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
}

describe('normalizeCatalog', () => {
  it('provayder və modelləri normallaşdırır', () => {
    const [p] = normalizeCatalog(MINIMAL)
    expect(p?.id).toBe('anthropic')
    expect(p?.envVars).toEqual(['ANTHROPIC_API_KEY'])
    const m = p?.models[0]
    expect(m?.modelId).toBe('claude-x')
    expect(m?.displayName).toBe('Claude X')
    expect(m?.price).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(m?.contextLimit).toBe(200000)
    expect(m?.toolCall).toBe(true)
    expect(m?.inputModalities).toEqual(['text', 'image'])
  })

  it('qiyməti olmayan model üçün price BOŞ obyektdir — 0 yazılmır', () => {
    const [p] = normalizeCatalog({
      x: { id: 'x', models: { m: { id: 'm' } } },
    })
    expect(p?.models[0]?.price).toEqual({})
    expect(p?.models[0]?.price.input).toBeUndefined()
  })

  it('natamam qiymət sahələri buraxılır, sıfırlanmır', () => {
    const [p] = normalizeCatalog({
      x: { id: 'x', models: { m: { id: 'm', cost: { input: 1, output: 2 } } } },
    })
    expect(p?.models[0]?.price).toEqual({ input: 1, output: 2 })
    expect('cacheRead' in (p?.models[0]?.price ?? {})).toBe(false)
  })

  it('POZUQ model atılır, qalanları qalır — bütöv kataloq sınmır', () => {
    const [p] = normalizeCatalog({
      x: {
        id: 'x',
        models: {
          yaxsi: { id: 'yaxsi' },
          pozuq: { id: 123 }, // `id` string deyil
          basqa: { id: 'basqa' },
        },
      },
    })
    expect(p?.models.map((m) => m.modelId)).toEqual(['basqa', 'yaxsi'])
  })

  it('POZUQ provayder atılır, qalanları qalır', () => {
    const providers = normalizeCatalog({
      yaxsi: { id: 'yaxsi', models: {} },
      pozuq: { models: {} }, // `id` yoxdur
    })
    expect(providers.map((p) => p.id)).toEqual(['yaxsi'])
  })

  it('naməlum yeni sahələr sxemi sındırmır', () => {
    const [p] = normalizeCatalog({
      x: {
        id: 'x',
        gelecek_sahe: 'nese',
        models: { m: { id: 'm', gelecek_model_sahesi: { derin: true } } },
      },
    })
    expect(p?.models).toHaveLength(1)
  })

  it('massiv və ya null kimi tamamilə yanlış girişdə boş qaytarır', () => {
    expect(normalizeCatalog(null)).toEqual([])
    expect(normalizeCatalog('salam')).toEqual([])
  })
})

describe('loadCatalog', () => {
  it('keş yoxdursa repodakı snapshot-dan yüklənir (offline işləyir)', () => {
    const cat = loadCatalog({ cacheFile: tmpFile('yoxdur.json') })
    expect(cat.source).toBe('bundled')
    expect(cat.providers.length).toBeGreaterThan(0)
    expect(cat.providers.map((p) => p.id)).toContain('anthropic')
  })

  it('təzə keş varsa ondan oxuyur', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ fetchedAt: 1_000_000, data: MINIMAL }))
    const cat = loadCatalog({ cacheFile: file, now: 1_000_000 + 60_000 })
    expect(cat.source).toBe('cache')
    expect(cat.fetchedAt).toBe(1_000_000)
    expect(cat.providers).toHaveLength(1)
  })

  it('köhnəlmiş keş (TTL keçib) snapshot-a düşür', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ fetchedAt: 1_000_000, data: MINIMAL }))
    const cat = loadCatalog({ cacheFile: file, now: 1_000_000 + CATALOG_TTL_MS + 1 })
    expect(cat.source).toBe('bundled')
  })

  it('pozuq keş faylı snapshot-a düşür, ATMIR', () => {
    const file = tmpFile()
    writeFileSync(file, '{ bu json deyil')
    expect(loadCatalog({ cacheFile: file }).source).toBe('bundled')
  })

  it('boş kataloq verən keş snapshot-a düşür', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ fetchedAt: 1_000_000, data: {} }))
    expect(loadCatalog({ cacheFile: file, now: 1_000_000 }).source).toBe('bundled')
  })

  it('bundled snapshot-da real qiymətlər var', () => {
    const cat = loadCatalog({ cacheFile: tmpFile('yoxdur.json') })
    const anthropic = cat.providers.find((p) => p.id === 'anthropic')
    expect(anthropic?.envVars).toContain('ANTHROPIC_API_KEY')
    const priced = anthropic?.models.filter((m) => m.price.input !== undefined) ?? []
    expect(priced.length).toBeGreaterThan(0)
  })
})

describe('refreshCatalog', () => {
  it('yüklənən datanı keşə yazır və kataloq qaytarır', async () => {
    const file = tmpFile()
    const cat = await refreshCatalog({
      cacheFile: file,
      now: 5_000,
      fetchImpl: fakeFetch(MINIMAL),
    })
    expect(cat.source).toBe('cache')
    expect(cat.fetchedAt).toBe(5_000)

    // Yazılan keş sonrakı `loadCatalog` tərəfindən oxunur.
    const reloaded = loadCatalog({ cacheFile: file, now: 5_000 })
    expect(reloaded.source).toBe('cache')
    expect(reloaded.providers).toHaveLength(1)
  })

  it('HTTP xətasında ATIR — səssizcə köhnə datanı qaytarmır', async () => {
    await expect(
      refreshCatalog({
        cacheFile: tmpFile(),
        fetchImpl: fakeFetch({}, false, 503),
      }),
    ).rejects.toThrow(/503/)
  })

  it('boş/mənasız cavabda ATIR və keşi KORLAMIR', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ fetchedAt: 1_000, data: MINIMAL }))
    await expect(
      refreshCatalog({ cacheFile: file, fetchImpl: fakeFetch({ zibil: true }) }),
    ).rejects.toThrow(/provayder/)
    // Köhnə keş yerindədir.
    expect(loadCatalog({ cacheFile: file, now: 1_000 }).providers).toHaveLength(1)
  })
})

describe('BUNDLED_PROVIDER_IDS', () => {
  it('üç dəstəklənən provayderi sadalayır', () => {
    expect([...BUNDLED_PROVIDER_IDS].sort()).toEqual(['anthropic', 'google', 'openai'])
  })
})
