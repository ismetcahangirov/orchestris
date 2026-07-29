import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Ladder from './Ladder.js'

const RULES = {
  rules: [
    {
      id: 'file-work-to-cli',
      description: 'Fayl yolu və ya repo istinadı var → CLI (alət lazımdır)',
      prefer: 'cli',
    },
    {
      id: 'short-text-to-api',
      description: 'Qısa mətn taskı → API (~21.7k döşəmə ödəmək mənasızdır)',
      prefer: 'api',
    },
  ],
  profiles: ['cheap', 'balanced', 'quality', 'boss-only'],
  profileRungs: {
    cheap: [0, 1, 2],
    balanced: [0, 1, 2, 3, 6, 7],
    quality: [0, 1, 2, 3, 4, 5, 6, 7],
    'boss-only': [7],
  },
}

const CONTEXTS = [
  {
    id: 'ctx1',
    name: 'Layihə',
    cwd: null,
    amplificationProfile: 'balanced',
    workerMode: 'auto',
    autoSubmode: 'cheap',
    verifyCommandsJson: '["pnpm test"]',
    maxParallel: 1,
    memoryScope: null,
    memoryEnabled: true,
    createdAt: 0,
  },
]

const MEMORY = {
  provider: 'claude-mem',
  active: true,
  tokenBudget: 600,
  health: { ok: false, detail: 'worker əlçatmazdır' },
}

const TEMPLATES = {
  templates: [
    {
      id: 'hash-1',
      taskType: 'translate',
      workerPrompt: 'ƏVVƏLCƏ DİLİ MÜƏYYƏN ET',
      rubric: 'TAM TƏRCÜMƏ',
      authoredByModelId: 'başçı',
      authoringCostUsd: 0.0123,
      uses: 12,
      escalationsAfter: 2,
      createdAt: 0,
      lastUsedAt: null,
    },
  ],
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function mockFetch(templates: unknown = TEMPLATES): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body =
      url === '/api/routing/rules'
        ? RULES
        : url === '/api/templates'
          ? templates
          : url === '/api/memory'
            ? MEMORY
            : url === '/api/contexts'
              ? CONTEXTS
              : url.startsWith('/api/models')
                ? []
                : { ...CONTEXTS[0], amplificationProfile: 'boss-only' }
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return calls
}

function renderPage(templates?: unknown): Call[] {
  const calls = mockFetch(templates)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Ladder />
    </QueryClientProvider>,
  )
  return calls
}

describe('Ladder səhifəsi — qaydalar', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('quraşdırılmış qaydaları izahı ilə göstərir', async () => {
    renderPage()
    expect(await screen.findByText('file-work-to-cli')).toBeTruthy()
    expect(screen.getByText(/21.7k döşəmə/)).toBeTruthy()
  })

  it('qaydaların hazırda redaktə olunmadığını AÇIQ deyir', async () => {
    // İstifadəçini "burada dəyişə bilərəm" gözləntisi ilə qoymamaq üçün.
    renderPage()
    expect(await screen.findByText(/redaktə/i)).toBeTruthy()
  })
})

describe('Ladder səhifəsi — profillər', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('kontekstin cari profilini göstərir', async () => {
    renderPage()
    const select = (await screen.findByLabelText('Amplifikasiya profili')) as HTMLSelectElement
    // Variantlar gələnə qədər gözlə: boş `select`-in dəyəri həmişə '' olur və
    // test yalançı qırmızı verərdi.
    await waitFor(() => expect(select.options.length).toBeGreaterThan(0))
    expect(select.value).toBe('balanced')
  })

  it('profil dəyişikliyini PATCH ilə göndərir', async () => {
    const calls = renderPage()
    const select = (await screen.findByLabelText('Amplifikasiya profili')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBeGreaterThan(0))
    fireEvent.change(select, { target: { value: 'boss-only' } })

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH')
      expect(patch?.url).toBe('/api/contexts/ctx1')
      expect(JSON.parse(String(patch?.init?.body))).toEqual({
        amplificationProfile: 'boss-only',
      })
    })
  })

  it('boss-only profilinin baseline üçün olduğunu izah edir', async () => {
    renderPage()
    expect(await screen.findByText(/baseline/i)).toBeTruthy()
  })

  it('Pillə 4 artıq "Faza 2" deyil — vəziyyəti "işləyir" göstərilir', async () => {
    renderPage()

    const row = (await screen.findByText(/İpucu \(shepherding\)/)).closest('tr')
    expect(row?.textContent).toContain('işləyir')
  })

  it('Pillə 5 artıq "Faza 2" deyil — vəziyyəti "işləyir" göstərilir', async () => {
    renderPage()

    const row = (await screen.findByText(/Plan güclü/)).closest('tr')
    expect(row?.textContent).toContain('işləyir')
    expect(row?.textContent).not.toContain('Faza 2')
  })

  it('şablonun İSTİFADƏSİNİ və sonrakı ESKALASİYALARINI birlikdə göstərir', async () => {
    // Yalnız istifadə sayı göstərilsəydi mexanizm həmişə uğurlu görünərdi —
    // halbuki şablon tətbiq olunub, task yenə başçıya qalxa bilər.
    renderPage()

    const row = (await screen.findByText('translate')).closest('tr')
    expect(row?.textContent).toContain('12')
    expect(row?.textContent).toContain('2')
    expect(row?.textContent).toContain('$0.0123')
  })

  it('şablon yoxdursa SƏBƏBİNİ izah edir — boş cədvəl "sınıqdır" kimi oxunmasın', async () => {
    renderPage({ templates: [] })

    expect(await screen.findByText(/Hələ şablon yoxdur/)).toBeTruthy()
  })

  it('cari profildə hansı pillələrin aktiv olduğunu serverin verdiyi dəstdən göstərir', async () => {
    // Kontekst `balanced`-dir → 4 və 5 aktiv DEYİL, qalan altısı aktivdir.
    // Siyahını UI-da təkrar yazsaydıq, server dəyişəndə bu test yaşıl qalar,
    // səhifə isə yalan danışardı.
    renderPage()
    await waitFor(() => expect(screen.getAllByText('aktiv')).toHaveLength(6))
  })
})

describe('Ladder səhifəsi — yaddaş', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('provayderi və SINIQ vəziyyəti səbəbi ilə göstərir', async () => {
    // "Qoşulub" ilə "işləyir" fərqlidir: worker əlçatmazdırsa istifadəçi bunu
    // görməlidir, yoxsa yaddaşın sınıq olduğunu heç vaxt bilməz.
    renderPage()

    expect(await screen.findByText('claude-mem')).toBeTruthy()
    expect(screen.getByText('sınıq')).toBeTruthy()
    expect(screen.getByText(/əlçatmazdır/)).toBeTruthy()
  })

  it('token büdcəsini SERVERDƏN göstərir — səhifə öz rəqəmini uydurmur', async () => {
    renderPage()
    expect(await screen.findByText('600')).toBeTruthy()
  })

  it('sahə verilməyibsə "avtomatik" olduğunu açıq deyir', async () => {
    renderPage()
    expect(await screen.findByText(/ctx1 \(avtomatik\)/)).toBeTruthy()
  })

  it('kontekst səviyyəsindəki opt-out PATCH ilə göndərilir', async () => {
    const calls = renderPage()
    const box = await screen.findByLabelText(/yaddaş işə düşsün/i)
    fireEvent.click(box)

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH')
      expect(JSON.parse(String(patch?.init?.body))).toEqual({ memoryEnabled: false })
    })
  })
})
