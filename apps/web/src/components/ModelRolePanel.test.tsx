import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ModelRolePanel from './ModelRolePanel.js'
import { selectableModels } from '../lib/selectableModels.js'
import { api, type ApiProviderRow, type ModelRow, type ProvidersResponse } from '../lib/api.js'

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

const CLI_MODEL = modelRow({
  id: 'cli:claude:sonnet',
  providerId: 'cli:claude',
  modelId: 'sonnet-4-5',
})

function show(models: ModelRow[], data: ProvidersResponse = providers()): void {
  vi.spyOn(api, 'listModels').mockResolvedValue(models)
  vi.spyOn(api, 'listProviders').mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ModelRolePanel />
    </QueryClientProvider>,
  )
}

function select(name: 'Başçı model' | 'İşçi model'): HTMLSelectElement {
  return screen.getByLabelText(new RegExp(name)) as HTMLSelectElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('selectableModels', () => {
  it('ABUNƏLİK və API modellərini BİR siyahıda verir', () => {
    // Layihənin əsas seçimi məhz bu ikisi arasındadır (qayda 5): abunəlikdə
    // kartdan pul çıxmır, API-da çıxır. Biri siyahıdan düşsəydi, istifadəçi
    // ucuz yolu ümumiyyətlə görməzdi.
    const out = selectableModels([CLI_MODEL, modelRow()], providers())

    expect(out.map((o) => o.runnerId)).toEqual(['cli:claude', 'api:anthropic'])
    expect(out.map((o) => o.subscription)).toEqual([true, false])
  })

  it('task icra EDƏ BİLMƏYƏN modeli siyahıya salmır (issue #47)', () => {
    // Embedding/şəkil/audio modeli başçı və ya işçi OLA BİLMƏZ — seçilsə task
    // icra anında sınardı. Siqnal serverdə kataloqun modalitlərindən
    // hesablanır (`registry/capability.ts`); süzgəc yalnız SEÇİCİDƏDİR,
    // `/providers` siyahısına toxunmur.
    const out = selectableModels(
      [
        modelRow(),
        modelRow({
          id: 'anthropic:embed',
          modelId: 'text-embedding-3-small',
          taskCapable: false,
        }),
      ],
      providers(),
    )
    expect(out.map((o) => o.model.modelId)).toEqual(['haiku'])
  })

  it('söndürülmüş modeli siyahıya salmır', () => {
    // "Seç" deyib sonra işlətməmək olardı.
    expect(selectableModels([modelRow({ enabled: false })], providers())).toEqual([])
  })

  it('runner-i qeydiyyatdan keçməmiş provayderin modelini salmır', () => {
    // `runnerId: null` = server belə runner qurmayıb; seçim heç vaxt icra
    // olunmazdı.
    const out = selectableModels([modelRow()], providers({ api: [apiProvider({ runnerId: null })] }))
    expect(out).toEqual([])
  })

  it('hazır olmayan runner-in modeli QALIR, amma işarələnir', () => {
    // Silsəydik, "niyə yoxdur?" sualının cavabı heç yerdə görünməzdi.
    const out = selectableModels(
      [modelRow()],
      providers({ api: [apiProvider({ authenticated: false })] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.ready).toBe(false)
  })

  it('provayderlər hələ yüklənməyibsə boş qaytarır', () => {
    expect(selectableModels([modelRow()], undefined)).toEqual([])
  })
})

describe('ModelRolePanel', () => {
  it('başçı seçimi EKSKLÜZİV yazılır', async () => {
    const setRole = vi.spyOn(api, 'setModelRole').mockResolvedValue(modelRow())
    show([CLI_MODEL, modelRow()])

    await waitFor(() => expect(select('Başçı model').options.length).toBeGreaterThan(1))
    fireEvent.change(select('Başçı model'), { target: { value: 'cli:claude:sonnet' } })

    // `exclusive` GÖNDƏRİLMİR: `boss` onsuz da eksklüzivdir (bazada qismən
    // unikal indeks var) — bayraq yalnız `worker` üçün mənalıdır.
    await waitFor(() =>
      expect(setRole).toHaveBeenCalledWith('cli:claude:sonnet', 'boss', true, false),
    )
  })

  it('işçi seçimi TƏK işçi kimi yazılır', async () => {
    // Dropdown tək seçim deməkdir. `exclusive` olmasaydı, seçim köhnə işçilərin
    // üstünə əlavə olunar və "işçi budur" sözü yalan olardı.
    const setRole = vi.spyOn(api, 'setModelRole').mockResolvedValue(modelRow())
    show([CLI_MODEL, modelRow()])

    await waitFor(() => expect(select('İşçi model').options.length).toBeGreaterThan(1))
    fireEvent.change(select('İşçi model'), { target: { value: 'anthropic:haiku' } })

    await waitFor(() =>
      expect(setRole).toHaveBeenCalledWith('anthropic:haiku', 'worker', true, true),
    )
  })

  it('mövcud rollar seçili göstərilir', async () => {
    show([
      modelRow({ id: 'cli:claude:sonnet', providerId: 'cli:claude', roleBoss: true }),
      modelRow({ roleWorker: true }),
    ])

    await waitFor(() => expect(select('Başçı model').value).toBe('cli:claude:sonnet'))
    expect(select('İşçi model').value).toBe('anthropic:haiku')
  })

  it('ÇOXLU işçi varsa xəbərdarlıq göstərilir', async () => {
    // Buradan seçmək qalanlarını söndürür — bunu gizlətmək istifadəçinin
    // `/providers`-də qurduğu konfiqurasiyanı səssizcə dağıtmaq olardı.
    show([
      modelRow({ id: 'cli:claude:sonnet', providerId: 'cli:claude', roleWorker: true }),
      modelRow({ roleWorker: true }),
    ])

    expect(await screen.findByText(/2 işçi model seçilib/)).toBeTruthy()
  })

  it('tək işçidə xəbərdarlıq YOXDUR', async () => {
    show([CLI_MODEL, modelRow({ roleWorker: true })])

    await waitFor(() => expect(select('İşçi model').value).toBe('anthropic:haiku'))
    expect(screen.queryByText(/işçi model seçilib/)).toBeNull()
  })

  it('hazır olmayan runner seçilibsə səbəb yazılır', async () => {
    show([modelRow({ roleBoss: true })], providers({ api: [apiProvider({ authenticated: false })] }))

    expect(await screen.findByText(/api:anthropic hazır deyil/)).toBeTruthy()
  })

  it('seçiləcək model yoxdursa yol göstərilir', async () => {
    show([])
    expect(await screen.findByText(/Seçilə bilən model yoxdur/)).toBeTruthy()
  })
})
