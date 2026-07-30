import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProvidersResponse } from '../lib/api.js'
import Providers from './Providers.js'

const PROVIDERS: ProvidersResponse = {
  cli: [
    {
      id: 'cli:claude',
      kind: 'cli',
      installed: true,
      authenticated: true,
      detail: 'Hazır',
      version: '2.0.0',
    },
  ],
  api: [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      hasCredential: false,
      enabled: true,
      modelCount: 0,
      lastDiscoveryAt: null,
      lastDiscoveryError: null,
      envVars: ['ANTHROPIC_API_KEY'],
      runnerId: 'api:anthropic',
      authenticated: false,
    },
  ],
  keychain: { ok: true, detail: 'OS açar anbarı işləyir' },
  catalog: { source: 'bundled', providerCount: 3 },
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Providers />
    </QueryClientProvider>,
  )
}

/** `fetch`-i tutur — testlər şəbəkəyə çıxmır. */
function mockFetch(overrides: Partial<ProvidersResponse> = {}) {
  // `init` açıq şəkildə `| undefined` — `exactOptionalPropertyTypes` altında
  // "sahə yoxdur" ilə "sahə undefined-dır" fərqli tiplərdir.
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body =
      url === '/api/providers'
        ? { ...PROVIDERS, ...overrides }
        : url.startsWith('/api/models')
          ? []
          : { ok: true, modelCount: 2 }
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  })
  globalThis.fetch = impl as unknown as typeof fetch
  return calls
}

describe('Providers səhifəsi', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mockFetch()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('CLI və API provayderlərini göstərir', async () => {
    renderPage()
    expect(await screen.findByText('cli:claude')).toBeInTheDocument()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
  })

  it('açar sahəsi type="password"-dur — çiyin üstündən oxunmasın', async () => {
    renderPage()
    const input = await screen.findByLabelText('Anthropic API açarı')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
  })

  it('açar 8 simvoldan qısa olduqda düymə sönükdür', async () => {
    renderPage()
    const input = await screen.findByLabelText('Anthropic API açarı')
    const button = screen.getByRole('button', { name: 'Yadda saxla' })

    expect(button).toBeDisabled()
    fireEvent.change(input, { target: { value: 'qisa' } })
    expect(button).toBeDisabled()
    fireEvent.change(input, { target: { value: 'kifayet-qeder-uzun-acar' } })
    expect(button).toBeEnabled()
  })

  it('açar göndərildikdən sonra sahədən SİLİNİR', async () => {
    const calls = mockFetch()
    renderPage()
    const input = (await screen.findByLabelText('Anthropic API açarı')) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'sk-ant-test-acar-12345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Yadda saxla' }))

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/providers/anthropic/credential')).toBe(true)
    })
    // Açar brauzerin yaddaşında qalmır.
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('açar YALNIZ POST body-də gedir — URL-ə düşmür', async () => {
    const calls = mockFetch()
    renderPage()
    const input = await screen.findByLabelText('Anthropic API açarı')

    fireEvent.change(input, { target: { value: 'sk-ant-test-acar-12345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Yadda saxla' }))

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST')
      expect(post).toBeDefined()
      expect(post?.url).not.toContain('sk-ant-test-acar-12345')
      expect(String(post?.init?.body)).toContain('sk-ant-test-acar-12345')
    })
  })

  it('keychain sınıqdırsa xəbərdarlıq göstərir', async () => {
    mockFetch({ keychain: { ok: false, detail: 'OS açar anbarı əlçatan deyil: D-Bus yoxdur' } })
    renderPage()
    expect(await screen.findByText(/D-Bus yoxdur/)).toBeInTheDocument()
  })

  it('açar təyin olunubsa forma əvəzinə idarə düymələri görünür', async () => {
    mockFetch({
      api: [{ ...PROVIDERS.api[0]!, hasCredential: true, modelCount: 5 }],
    })
    renderPage()

    expect(await screen.findByText('açar təyin olunub')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Açarı sil' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Anthropic API açarı')).not.toBeInTheDocument()
  })

  it('son kəşf xətasını göstərir', async () => {
    mockFetch({
      api: [
        {
          ...PROVIDERS.api[0]!,
          hasCredential: true,
          lastDiscoveryError: 'anthropic: HTTP 401 [API-ACARI-KESILDI]',
        },
      ],
    })
    renderPage()
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument()
  })

  it('offline snapshot mənbəyini dürüst göstərir', async () => {
    renderPage()
    expect(await screen.findByText(/repodakı snapshot \(offline\)/)).toBeInTheDocument()
  })
})

/**
 * Kataloq yeniləməsinin NƏTİCƏSİ (issue #46).
 *
 * `refreshMock` iki şeyi ayrıca idarə edir: `POST /api/registry/refresh`-in
 * uğuru və ondan SONRAKI `/api/providers` cavabındakı kataloq. Məhz bu ikisinin
 * fərqli ola bilməsi issue #46-nın səbəbidir — server işi bitirir, klientin
 * sorğusu isə kəsilir.
 */
function refreshMock(opts: {
  refreshFails?: string
  catalogAfter: ProvidersResponse['catalog']
}): void {
  let refreshed = false
  const impl = vi.fn(async (url: string) => {
    if (url === '/api/providers') {
      const catalog = refreshed ? opts.catalogAfter : PROVIDERS.catalog
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...PROVIDERS, catalog }),
        text: async () => '',
      } as Response
    }
    if (url === '/api/registry/refresh') {
      refreshed = true
      if (opts.refreshFails !== undefined) {
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
          text: async () => opts.refreshFails as string,
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, providerCount: 175 }),
        text: async () => '',
      } as Response
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' } as Response
  })
  globalThis.fetch = impl as unknown as typeof fetch
}

describe('Providers — kataloq yeniləməsinin nəticəsi (issue #46)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sorğu sınsa DA kataloq yenilənibsə "yenilənmədi" DEMİR', async () => {
    // İssue #46-nın mahiyyəti: server 3 MB-lıq yükləməni sona çatdırır, klient
    // tərəfdəki sorğu isə kəsilir. Köhnə UI `isError` üzərində qurulduğu üçün
    // görülmüş işi "sındı" kimi göstərirdi.
    refreshMock({
      refreshFails: 'sorğu kəsildi',
      catalogAfter: { source: 'cache', fetchedAt: 5000, providerCount: 175 },
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Kataloqu yenilə' }))

    expect(await screen.findByText(/Kataloq yeniləndi/)).toBeInTheDocument()
    expect(screen.queryByText(/Kataloq yenilənmədi/)).not.toBeInTheDocument()
  })

  it('yeni yeniləmə gedərkən KÖHNƏ nəticə göstərilmir', async () => {
    // "Yenilənir…" düyməsinin yanında qalan "Kataloq yeniləndi." keçmişdən
    // danışır, istifadəçi isə onu HAZIRKI sorğunun nəticəsi kimi oxuyur.
    let hold: (() => void) | null = null
    const impl = vi.fn(async (url: string) => {
      // İKİNCİ yeniləmə qəsdən yarımçıq saxlanılır — birincinin nəticəsi
      // ekranda qalırsa məhz burada görünür.
      if (url === '/api/registry/refresh' && hold !== null) {
        await new Promise<void>((resolve) => {
          const release = hold as () => void
          hold = () => {
            release()
            resolve()
          }
        })
      }
      const body = url === '/api/providers' ? PROVIDERS : { ok: true }
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
    })
    globalThis.fetch = impl as unknown as typeof fetch
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Kataloqu yenilə' }))
    expect(await screen.findByText(/Kataloq yeniləndi/)).toBeInTheDocument()

    hold = () => {}
    fireEvent.click(screen.getByRole('button', { name: 'Kataloqu yenilə' }))

    await waitFor(() => expect(screen.getByText('Yenilənir…')).toBeInTheDocument())
    expect(screen.queryByText(/Kataloq yeniləndi/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Kataloq yenilənmədi/)).not.toBeInTheDocument()
    hold()
  })

  it('həqiqətən sındıqda SƏBƏBİ göstərir', async () => {
    // Köhnə mesaj yalnız "yenilənmədi" deyirdi — istifadəçi səbəbi HEÇ YERDƏ
    // görə bilmirdi, halbuki 502 cavabı onu daşıyır.
    refreshMock({
      refreshFails: 'models.dev → HTTP 503',
      catalogAfter: PROVIDERS.catalog,
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Kataloqu yenilə' }))

    expect(await screen.findByText(/Kataloq yenilənmədi/)).toBeInTheDocument()
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument()
  })
})

describe('Providers — CLI modellərinə rol vermək', () => {
  it('CLI kartında model siyahısını açmaq mümkündür', async () => {
    // Auto rejimi yalnız "işçi" işarəli modellər arasından seçir. CLI
    // modellərinə rol verə bilməsək, "fayl işi → CLI" qaydası heç vaxt işə
    // düşməzdi (issue #7).
    const calls = mockFetch()
    renderPage()

    const toggle = await screen.findByRole('button', { name: /modellər/i })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/models?provider=cli:claude')).toBe(true)
    })
  })
})
