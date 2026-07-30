import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiProviderRow, ModelRow, ProvidersResponse } from '../lib/api.js'
import Dashboard from './Dashboard.js'

/** Seçicidə görünəcək model sətri — default: aktiv, rolsuz. */
function modelRow(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'anthropic:haiku',
    providerId: 'anthropic',
    modelId: 'haiku',
    displayName: 'Haiku',
    contextLimit: 200_000,
    outputLimit: null,
    priceIn: 1,
    priceOut: 5,
    priceCacheRead: null,
    priceCacheWrite: null,
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    source: 'models.dev',
    enabled: true,
    roleBoss: false,
    roleWorker: false,
    roleClassifier: false,
    priceKnown: true,
    taskCapable: true,
    ...over,
  }
}

/** Default model dəsti: biri CLI (abunəlik), biri API (real pul). */
const MODELS: ModelRow[] = [
  modelRow({ id: 'cli:claude:sonnet', providerId: 'cli:claude', modelId: 'sonnet-4-5' }),
  modelRow(),
]

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

function mockFetch(data: ProvidersResponse, models: ModelRow[] = MODELS): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body =
      url === '/api/providers'
        ? data
        : url === '/api/models'
          ? models
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
          : url.startsWith('/api/stats/savings')
            ? {
                period: 'month',
                summary: {
                  taskCount: 3,
                  actualCostUsd: 0.1,
                  actualSubscriptionUsd: 0,
                  baselineCostUsd: 1.5,
                  orchestrationCostUsd: 0,
                  memoryCostUsd: 0,
                  netSavingUsd: 1.4,
                  cacheHits: 0,
                  cacheSavingUsd: 0,
                  unknownCostTasks: 0,
                  subscriptionBaselineTasks: 0,
                  byTaskType: [],
                  tokensIn: 1000,
                  tokensOut: 100,
                },
                tasks: [],
              }
            : { taskId: 't1' }
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return calls
}

function renderPage(
  data: ProvidersResponse = providers(),
  models: ModelRow[] = MODELS,
): Call[] {
  const calls = mockFetch(data, models)
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

describe('Dashboard — Auto rejimi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('işçi siyahısında Auto variantı var', async () => {
    renderPage()
    await waitFor(() => {
      expect([...runnerSelect().options].map((o) => o.value)).toContain('auto')
    })
  })

  it('Auto seçiləndə model sahəsi göstərilmir', async () => {
    // Modeli router seçir — istifadəçidən model istəmək yalan olardı.
    renderPage()
    await waitFor(() => expect(runnerSelect()).toBeTruthy())
    fireEvent.change(runnerSelect(), { target: { value: 'auto' } })
    expect(screen.queryByLabelText('Model')).toBeNull()
  })

  it('Auto ilə göndərişdə runner və model GÖNDƏRİLMİR', async () => {
    const calls = renderPage()
    await waitFor(() => expect(runnerSelect().options.length).toBeGreaterThan(1))

    fireEvent.change(screen.getByLabelText('Kontekst'), { target: { value: 'ctx1' } })
    fireEvent.change(runnerSelect(), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'salam de' } })
    fireEvent.click(screen.getByRole('button', { name: 'İşə sal' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/tasks')
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post?.init?.body))
      expect(body.runner).toBeUndefined()
      expect(body.model).toBeUndefined()
    })
  })

  it('Auto seçiləndə hazır olmayan işçi xəbərdarlığı göstərilmir', async () => {
    renderPage(providers({ api: [apiProvider({ hasCredential: false, authenticated: false })] }))
    await waitFor(() => expect(runnerSelect()).toBeTruthy())
    fireEvent.change(runnerSelect(), { target: { value: 'auto' } })
    expect(screen.queryByText(/hazır deyil/i)).toBeNull()
  })
})

describe('Dashboard — qənaət paneli', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('bu ayın qənaətini göstərir', async () => {
    renderPage()
    expect(await screen.findByText(/net qənaət/i)).toBeTruthy()
  })

  it('qənaəti aylıq dövr üçün soruşur', async () => {
    const calls = renderPage()
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/stats/savings?period=month')).toBe(true)
    })
  })
})
