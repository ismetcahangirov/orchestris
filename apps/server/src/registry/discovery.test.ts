import { describe, expect, it } from 'vitest'
import {
  adapterFor,
  anthropicAdapter,
  discoverModels,
  googleAdapter,
  mergeWithCatalog,
  openAiAdapter,
  openAiCompatibleAdapter,
  providerSupport,
} from './discovery.js'
import type { CatalogProvider } from './models-dev.js'

const KEY = 'sk-ant-api03-CoxGizliAcar1234567890'

interface Captured {
  url: string
  headers: Record<string, string>
}

/** Şəbəkəyə ÇIXMIR — sorğunu tutub hazır cavab qaytarır. */
function fakeFetch(
  body: unknown,
  captured: Captured[] = [],
  init: { ok?: boolean; status?: number; text?: string } = {},
): typeof fetch {
  return (async (url: string, opts?: RequestInit) => {
    captured.push({
      url,
      headers: (opts?.headers ?? {}) as Record<string, string>,
    })
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => init.text ?? '',
    } as Response
  }) as unknown as typeof fetch
}

const CATALOG: CatalogProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  envVars: ['ANTHROPIC_API_KEY'],
  models: [
    {
      providerId: 'anthropic',
      modelId: 'claude-tanınan',
      displayName: 'Claude Tanınan',
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextLimit: 200000,
      toolCall: true,
      structuredOutput: true,
      reasoning: true,
      inputModalities: ['text', 'image'],
    },
  ],
}

describe('anthropicAdapter', () => {
  it('açarı x-api-key başlığında və versiya başlığı ilə göndərir', async () => {
    const captured: Captured[] = []
    await anthropicAdapter.listModels(
      KEY,
      fakeFetch({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }, captured),
    )
    expect(captured[0]?.headers['x-api-key']).toBe(KEY)
    expect(captured[0]?.headers['anthropic-version']).toBe('2023-06-01')
    // Açar URL-ə DÜŞMÜR.
    expect(captured[0]?.url).not.toContain(KEY)
  })

  it('display_name-i götürür', async () => {
    const out = await anthropicAdapter.listModels(
      KEY,
      fakeFetch({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }),
    )
    expect(out).toEqual([{ modelId: 'claude-x', displayName: 'Claude X' }])
  })
})

describe('openAiAdapter', () => {
  it('Bearer başlığı ilə göndərir, açar URL-də yoxdur', async () => {
    const captured: Captured[] = []
    await openAiAdapter.listModels(KEY, fakeFetch({ data: [{ id: 'gpt-x' }] }, captured))
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${KEY}`)
    expect(captured[0]?.url).not.toContain(KEY)
  })
})

describe('googleAdapter', () => {
  it('açarı URL sorğu parametrində DEYİL, başlıqda göndərir', async () => {
    const captured: Captured[] = []
    await googleAdapter.listModels(
      KEY,
      fakeFetch({ models: [{ name: 'models/gemini-x' }] }, captured),
    )
    expect(captured[0]?.headers['x-goog-api-key']).toBe(KEY)
    expect(captured[0]?.url).not.toContain(KEY)
    expect(captured[0]?.url).not.toContain('key=')
  })

  it('`models/` prefiksini kəsir', async () => {
    const out = await googleAdapter.listModels(
      KEY,
      fakeFetch({ models: [{ name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash' }] }),
    )
    expect(out).toEqual([{ modelId: 'gemini-3-flash', displayName: 'Gemini 3 Flash' }])
  })

  it('generateContent dəstəkləməyən modelləri süzür', async () => {
    const out = await googleAdapter.listModels(
      KEY,
      fakeFetch({
        models: [
          { name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed-x', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    )
    expect(out.map((m) => m.modelId)).toEqual(['gemini-x'])
  })

  it('supportedGenerationMethods yoxdursa modeli SAXLAYIR', async () => {
    const out = await googleAdapter.listModels(KEY, fakeFetch({ models: [{ name: 'models/x' }] }))
    expect(out).toHaveLength(1)
  })
})

describe('xəta yolu — açar sızması', () => {
  it('HTTP xətasında açar cavab mətnindən KƏSİLİR', async () => {
    const err = await anthropicAdapter
      .listModels(KEY, fakeFetch({}, [], { ok: false, status: 401, text: `invalid key: ${KEY}` }))
      .catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(KEY)
    expect((err as Error).message).toContain('401')
  })

  it('discoverModels şəbəkə xətasından da açarı kəsir', async () => {
    const throwing = (async () => {
      throw new Error(`connect failed for key ${KEY}`)
    }) as unknown as typeof fetch

    const err = await discoverModels({
      providerId: 'anthropic',
      apiKey: KEY,
      catalogProvider: CATALOG,
      fetchImpl: throwing,
    }).catch((e: unknown) => e as Error)

    expect((err as Error).message).not.toContain(KEY)
  })

  it('dəstəklənməyən provayder üçün aydın xəta', async () => {
    await expect(
      discoverModels({ providerId: 'yoxdur', apiKey: KEY, catalogProvider: undefined }),
    ).rejects.toThrow(/dəstəklənmir/)
  })
})

describe('mergeWithCatalog', () => {
  it('models.dev-də tanınan model qiymətini alır', () => {
    const [m] = mergeWithCatalog('anthropic', [{ modelId: 'claude-tanınan' }], CATALOG)
    expect(m?.source).toBe('models.dev')
    expect(m?.price).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(m?.contextLimit).toBe(200000)
    expect(m?.toolCall).toBe(true)
  })

  it('models.dev-də OLMAYAN model qalır, amma qiyməti BOŞ olur — 0 yox', () => {
    const [m] = mergeWithCatalog('anthropic', [{ modelId: 'yeni-model' }], CATALOG)
    expect(m?.source).toBe('api')
    expect(m?.price).toEqual({})
    expect(m?.modelId).toBe('yeni-model')
  })

  it('kataloq ümumiyyətlə yoxdursa hamısı `api` mənbəli olur', () => {
    const out = mergeWithCatalog('anthropic', [{ modelId: 'a' }, { modelId: 'b' }], undefined)
    expect(out.every((m) => m.source === 'api')).toBe(true)
    expect(out).toHaveLength(2)
  })

  it('models.dev-də olub açarın icazə vermədiyi model siyahıya DÜŞMÜR', () => {
    // Kəsişmə: kataloqda `claude-tanınan` var, amma endpoint onu qaytarmadı.
    const out = mergeWithCatalog('anthropic', [{ modelId: 'basqa' }], CATALOG)
    expect(out.map((m) => m.modelId)).toEqual(['basqa'])
  })

  it('provayderin verdiyi ad models.dev adını üstələyir', () => {
    const [m] = mergeWithCatalog(
      'anthropic',
      [{ modelId: 'claude-tanınan', displayName: 'Provayder Adı' }],
      CATALOG,
    )
    expect(m?.displayName).toBe('Provayder Adı')
  })
})

describe('adapterFor', () => {
  it('üç provayder üçün adapter var', () => {
    expect(adapterFor('anthropic')).toBeDefined()
    expect(adapterFor('openai')).toBeDefined()
    expect(adapterFor('google')).toBeDefined()
  })

  it('naməlum provayder üçün undefined', () => {
    expect(adapterFor('yoxdur')).toBeUndefined()
  })
})

describe('providerSupport (issue #44)', () => {
  const base = { id: 'x', name: 'X', envVars: [], models: [] }

  it('öz adapteri olan provayder `native`-dir', () => {
    // Bu üçü OpenAI protokolunu danışmır (`anthropic` → `x-api-key` +
    // `anthropic-version`, `google` → tamam başqa format), ona görə
    // `openai-compatible` yolu onlara TƏTBİQ EDİLMƏMƏLİDİR.
    expect(providerSupport({ ...base, id: 'anthropic' })).toBe('native')
    expect(providerSupport({ ...base, id: 'openai' })).toBe('native')
  })

  it('`npm` + `baseUrl` varsa `openai-compatible`', () => {
    expect(
      providerSupport({
        ...base,
        id: 'deepseek',
        npm: '@ai-sdk/openai-compatible',
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toBe('openai-compatible')
  })

  it('ÜNVAN yoxdursa dəstəklənmir — runner qurula bilməz', () => {
    expect(
      providerSupport({ ...base, id: 'x', npm: '@ai-sdk/openai-compatible' }),
    ).toBeNull()
  })

  it('başqa SDK paketi dəstəklənmir', () => {
    // `@ai-sdk/groq` və s. öz paketini tələb edir; onu `openai-compatible`
    // saysaydıq, işləməyən provayderi seçilə bilən göstərərdik.
    expect(
      providerSupport({ ...base, npm: '@ai-sdk/groq', baseUrl: 'https://api.groq.com' }),
    ).toBeNull()
  })

  it('`npm` ümumiyyətlə yoxdursa dəstəklənmir', () => {
    expect(providerSupport({ ...base, baseUrl: 'https://x.com' })).toBeNull()
  })
})

describe('openAiCompatibleAdapter (issue #44)', () => {
  it('`{baseUrl}/models` ünvanına AÇARI BAŞLIQDA göndərir', async () => {
    // Qayda 14: açar URL-ə qoyulmur — URL server log-larına, proxy
    // jurnallarına və `fetch failed` xəta mətnlərinə düşür.
    let seenUrl = ''
    let seenAuth: string | undefined
    const fake = (async (url: string, init?: RequestInit) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
        text: async () => '',
      } as Response
    }) as unknown as typeof fetch

    const adapter = openAiCompatibleAdapter('deepseek', 'https://api.deepseek.com')
    const out = await adapter.listModels(KEY, fake)

    expect(seenUrl).toBe('https://api.deepseek.com/models')
    expect(seenUrl).not.toContain(KEY)
    expect(seenAuth).toBe(`Bearer ${KEY}`)
    expect(out).toEqual([{ modelId: 'deepseek-chat' }])
  })

  it('sondakı `/` kəsilir — `//models` bəzi serverlərdə 404 verir', async () => {
    let seenUrl = ''
    const fake = (async (url: string) => {
      seenUrl = url
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as Response
    }) as unknown as typeof fetch

    await openAiCompatibleAdapter('x', 'http://127.0.0.1:1234/v1/').listModels(KEY, fake)
    expect(seenUrl).toBe('http://127.0.0.1:1234/v1/models')
  })

  it('xəta mətnindən AÇAR KƏSİLİR', async () => {
    // Provayder cavabları göndərilən açarı əks etdirə bilir; o mətn DB-yə
    // (`providers.last_discovery_error`) və oradan UI-a gedir (qayda 18).
    const fake = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => `Incorrect API key provided: ${KEY}`,
      }) as Response) as unknown as typeof fetch

    await expect(
      openAiCompatibleAdapter('deepseek', 'https://api.deepseek.com').listModels(KEY, fake),
    ).rejects.toThrow(/deepseek: HTTP 401/)

    const err = await openAiCompatibleAdapter('deepseek', 'https://api.deepseek.com')
      .listModels(KEY, fake)
      .catch((e: Error) => e.message)
    expect(err).not.toContain(KEY)
  })
})

describe('discoverModels — openai-compatible yolu (issue #44)', () => {
  const deepseek: CatalogProvider = {
    id: 'deepseek',
    name: 'DeepSeek',
    envVars: [],
    npm: '@ai-sdk/openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    models: [],
  }

  it('öz adapteri olmayan provayder üçün kataloqdan ünvan götürür', async () => {
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
        text: async () => '',
      }) as Response) as unknown as typeof fetch

    const out = await discoverModels({
      providerId: 'deepseek',
      apiKey: KEY,
      catalogProvider: deepseek,
      fetchImpl: fake,
    })
    expect(out.map((m) => m.modelId)).toEqual(['deepseek-chat'])
  })

  it('kataloq məlumatı yoxdursa kəşf DƏSTƏKLƏNMİR', async () => {
    // Ünvanı haradan götürəcəyimiz bilinmir — təxmin etmək yanlış hosta açar
    // göndərmək olardı.
    await expect(
      discoverModels({ providerId: 'deepseek', apiKey: KEY, catalogProvider: undefined }),
    ).rejects.toThrow(/dəstəklənmir/)
  })
})
