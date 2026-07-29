import { describe, expect, it, vi } from 'vitest'
import { ClaudeMemProvider, isAtLeast } from './claude-mem.js'

/** Şəbəkəyə ÇIXMIR — bütün cavablar saxtadır (CLAUDE.md qayda 11). */
function fakeFetch(
  routes: Record<string, { status?: number; body: unknown }>,
): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname
    const route = routes[path]
    if (route === undefined) return new Response('yoxdur', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const MIN = '4.2.0'

describe('isAtLeast', () => {
  it('rəqəmlə müqayisə edir, sətirlə yox', () => {
    // `'10' < '9'` sətir müqayisəsində doğrudur — versiyada yalandır.
    expect(isAtLeast('4.10.0', '4.9.0')).toBe(true)
    expect(isAtLeast('4.9.0', '4.10.0')).toBe(false)
  })

  it('bərabər versiya qəbul olunur', () => {
    expect(isAtLeast('4.2.0', '4.2.0')).toBe(true)
  })

  it('ön buraxılış (pre-release) minimumu ÖDƏMİR', () => {
    expect(isAtLeast('4.2.0-beta', '4.2.0')).toBe(false)
  })

  it('`v` prefiksi qəbul olunur', () => {
    expect(isAtLeast('v5.0.0', '4.2.0')).toBe(true)
  })
})

describe('ClaudeMemProvider.health', () => {
  it('minimum versiya TƏYİN OLUNMAYIBSA işə düşmür', async () => {
    // Zəiflikli versiyanı (issue #354) səssizcə qəbul etməkdənsə, cavabı
    // istifadəçidən tələb edirik — uydurma rəqəm yazmırıq.
    const p = new ClaudeMemProvider({ fetchImpl: fakeFetch({ '/health': { body: {} } }) })
    const health = await p.health()

    expect(health.ok).toBe(false)
    expect(health.detail).toContain('ORCHESTRIS_CLAUDE_MEM_MIN_VERSION')
  })

  it('köhnə versiya RƏDD olunur', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({ '/health': { body: { version: '4.1.9' } } }),
    })

    expect(await p.health()).toMatchObject({ ok: false })
  })

  it('kifayət edən versiya qəbul olunur', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({ '/health': { body: { version: '4.2.0' } } }),
    })

    expect(await p.health()).toMatchObject({ ok: true })
  })

  it('worker əlçatmazdırsa ATMIR, `ok: false` qaytarır', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED 127.0.0.1:37777')
      }) as unknown as typeof fetch,
    })

    expect(await p.health()).toMatchObject({ ok: false })
  })
})

describe('ClaudeMemProvider.recall', () => {
  it('qeydləri qaytarır və lokal axtarışı PULSUZ sayır', async () => {
    // Lokal FTS5/Chroma axtarışında model çağırışı yoxdur — `0` "bilinmir"
    // deyil, ölçülə bilən sıfırdır (qayda 4-dəki fərq).
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({
        '/recall': { body: { items: [{ id: 'm1', text: 'qeyd', score: 0.5 }] } },
      }),
    })

    const result = await p.recall('sual', 'scope', 100)
    expect(result.items).toEqual([{ id: 'm1', text: 'qeyd', score: 0.5 }])
    expect(result.costUsd).toBe(0)
  })

  it('HTTP xətasında atır — `MemorySession` onu tutur', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({ '/recall': { status: 500, body: { error: 'sındı' } } }),
    })

    await expect(p.recall('sual', 'scope', 100)).rejects.toThrow('HTTP 500')
  })
})

describe('ClaudeMemProvider.remember', () => {
  it('cavabdakı xərci götürür', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({ '/remember': { body: { costUsd: 0.0004 } } }),
    })

    expect(await p.remember('scope', [{ id: 'a', text: 'x' }])).toEqual({ costUsd: 0.0004 })
  })

  it('xərc bildirilməyibsə NULL — sıxma model çağırışıdır, "pulsuz" deyil', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN },
      fetchImpl: fakeFetch({ '/remember': { body: {} } }),
    })

    expect(await p.remember('scope', [{ id: 'a', text: 'x' }])).toEqual({ costUsd: null })
  })

  it('istifadəçi pulsuz model BƏYAN edibsə həmin qiymət işlədilir', async () => {
    const p = new ClaudeMemProvider({
      config: { minVersion: MIN, declaredWriteCostUsd: 0 },
      fetchImpl: fakeFetch({ '/remember': { body: {} } }),
    })

    expect(await p.remember('scope', [{ id: 'a', text: 'x' }])).toEqual({ costUsd: 0 })
  })
})
