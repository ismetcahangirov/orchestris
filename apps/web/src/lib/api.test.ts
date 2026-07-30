import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'

interface Call {
  url: string
  init: RequestInit | undefined
}

function captureFetch(body: unknown = { ok: true }): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return calls
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name]
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('request başlıqları (issue #50)', () => {
  it('GÖVDƏSİZ sorğuya `Content-Type: application/json` QOYMUR', async () => {
    // Ölçülmüş (Chrome, 2026-07-30): boş gövdə + bu başlıq = Fastify
    // `FST_ERR_CTP_EMPTY_JSON_BODY` → 400 və route-un kodu HEÇ VAXT çağırılmır.
    // İşlətmədiyimiz content-type-ı bildirmək məhz bu yalandır.
    const calls = captureFetch()
    await api.refreshCatalog()

    expect(calls).toHaveLength(1)
    expect(headerOf(calls[0]?.init, 'Content-Type')).toBeUndefined()
  })

  it('GÖVDƏLİ sorğuda başlıq QALIR', async () => {
    const calls = captureFetch({ taskId: 't1' })
    await api.createTask({ contextId: 'c1', prompt: 'salam' })

    expect(headerOf(calls[0]?.init, 'Content-Type')).toBe('application/json')
    expect(String(calls[0]?.init?.body)).toContain('salam')
  })

  it('gövdəsiz DELETE də başlıqsız gedir', async () => {
    // `deleteCredential` ("Açarı sil") eyni tələyə düşürdü.
    const calls = captureFetch()
    await api.deleteCredential('anthropic')

    expect(headerOf(calls[0]?.init, 'Content-Type')).toBeUndefined()
    expect(calls[0]?.init?.method).toBe('DELETE')
  })

  it('diff qəbulu da gövdəsizdir — baxış qapısı işləməli idi', async () => {
    // Qayda 42-dəki qapı: bu sorğu 400 alırsa, izolyasiya edilmiş taskın
    // nəticəsi UI-dan ÜMUMİYYƏTLƏ qəbul edilə bilmir.
    const calls = captureFetch({ ok: true, files: 2 })
    await api.acceptDiff('task-1')

    expect(headerOf(calls[0]?.init, 'Content-Type')).toBeUndefined()
  })
})
