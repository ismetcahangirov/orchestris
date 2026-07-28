import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiProviderRow, ProvidersResponse } from '../lib/api.js'
import Dashboard from './Dashboard.js'

function apiProvider(over: Partial<ApiProviderRow> = {}): ApiProviderRow {
  return {
    id: 'anthropic',
    displayName: 'Anthropic',
    hasCredential: true,
    enabled: true,
    modelCount: 3,
    lastDiscoveryAt: null,
    lastDiscoveryError: null,
    envVars: [],
    runnerId: 'api:anthropic',
    authenticated: true,
    ...over,
  }
}

function providers(over: Partial<ProvidersResponse> = {}): ProvidersResponse {
  return {
    cli: [
      { id: 'cli:claude', kind: 'cli', installed: true, authenticated: true, detail: 'Hazır' },
    ],
    api: [apiProvider()],
    keychain: { ok: true, detail: 'işləyir' },
    catalog: { source: 'bundled', providerCount: 3 },
    ...over,
  }
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function mockFetch(data: ProvidersResponse): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body =
      url === '/api/providers'
        ? data
        : url === '/api/contexts'
          ? [
              {
                id: 'ctx1',
                name: 'Layihə',
                cwd: null,
                amplificationProfile: 'balanced',
                workerMode: 'manual',
                autoSubmode: 'cheap',
                verifyCommandsJson: '[]',
                maxParallel: 1,
                createdAt: 0,
              },
            ]
          : { taskId: 't1' }
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return calls
}

function renderPage(data: ProvidersResponse = providers()): Call[] {
  const calls = mockFetch(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

function runnerSelect(): HTMLSelectElement {
  return screen.getByLabelText('İşçi') as HTMLSelectElement
}

describe('Dashboard — işçi seçimi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('API provayderini işçi siyahısına əlavə edir', async () => {
    renderPage()
    await waitFor(() => {
      expect(
        [...runnerSelect().options].map((o) => o.value),
      ).toContain('api:anthropic')
    })
  })

  it('runner-i olmayan API provayderini siyahıya salmır', async () => {
    // `runnerId: null` = server üçün belə runner qeydiyyatdan keçməyib.
    // Onu seçilə bilən göstərmək istifadəçiyə işləməyən düymə vermək olardı.
    renderPage(providers({ api: [apiProvider({ runnerId: null })] }))
    await waitFor(() => expect(runnerSelect().options.length).toBeGreaterThan(0))
    expect([...runnerSelect().options].map((o) => o.value)).not.toContain('api:anthropic')
  })

  it('CLI runner-lərini serverdən gələn siyahıdan götürür', async () => {
    renderPage()
    await waitFor(() => {
      expect([...runnerSelect().options].map((o) => o.value)).toContain('cli:claude')
    })
  })
})

describe('Dashboard — hazır olmayan işçi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('açarı olmayan API provayderi seçiləndə xəbərdarlıq göstərir', async () => {
    renderPage(
      providers({
        api: [apiProvider({ hasCredential: false, authenticated: false })],
      }),
    )
    // Seçim variantı GƏLƏNƏ QƏDƏR gözlə: mövcud olmayan dəyərə `change`
    // göndərmək səssizcə heç nə etmir və test yalançı yaşıl olardı.
    await waitFor(() =>
      expect([...runnerSelect().options].map((o) => o.value)).toContain('api:anthropic'),
    )
    fireEvent.change(runnerSelect(), { target: { value: 'api:anthropic' } })

    expect(await screen.findByText(/açarı təyin olunmayıb/i)).toBeTruthy()
  })

  it('hazır olmayan işçi ilə task göndərməyə qoymur', async () => {
    renderPage(
      providers({
        api: [apiProvider({ hasCredential: false, authenticated: false })],
      }),
    )
    await waitFor(() =>
      expect([...runnerSelect().options].map((o) => o.value)).toContain('api:anthropic'),
    )
    // Kontekst və prompt DOLDURULUR ki, düymənin sönük qalmasının YEGANƏ
    // səbəbi işçinin hazır olmaması olsun.
    fireEvent.change(screen.getByLabelText('Kontekst'), { target: { value: 'ctx1' } })
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'salam de' } })
    fireEvent.change(runnerSelect(), { target: { value: 'api:anthropic' } })

    const button = screen.getByRole('button', { name: 'İşə sal' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    // Hazır işçiyə keçəndə düymə açılmalıdır — yoxsa yuxarıdakı yoxlama
    // başqa səbəbdən yaşıl ola bilərdi.
    fireEvent.change(runnerSelect(), { target: { value: 'cli:claude' } })
    expect(
      (screen.getByRole('button', { name: 'İşə sal' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('Dashboard — task göndərişi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('seçilmiş runner id-sini POST /api/tasks-a göndərir', async () => {
    const calls = renderPage()
    await waitFor(() => expect(runnerSelect().options.length).toBeGreaterThan(1))

    fireEvent.change(screen.getByLabelText('Kontekst'), { target: { value: 'ctx1' } })
    fireEvent.change(runnerSelect(), { target: { value: 'api:anthropic' } })
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'salam de' } })
    fireEvent.click(screen.getByRole('button', { name: 'İşə sal' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/tasks')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post?.init?.body))).toMatchObject({ runner: 'api:anthropic' })
    })
  })
})
