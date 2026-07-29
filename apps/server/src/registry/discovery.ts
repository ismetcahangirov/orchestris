import { z } from 'zod'
import type { ModelUpsert } from '../db/registry-repo.js'
import { redactAll } from '../secrets/redact.js'
import type { CatalogProvider } from './models-dev.js'

/**
 * Model kəşfi — açarın REAL icazə verdiyi modelləri provayderin öz
 * endpoint-indən alıb models.dev metadatası ilə birləşdirir.
 *
 * Niyə kəsişmə: models.dev bütün mövcud modelləri sadalayır, amma konkret
 * açar onların hamısına icazəli olmaya bilər (tier məhdudiyyəti, preview
 * modelləri, təşkilat siyasəti). Yalnız models.dev-ə baxsaydıq, istifadəçi
 * işlətdiyi anda 404/403 alan modelləri siyahıda görərdi.
 */

const OpenAiModels = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
})

const AnthropicModels = z.object({
  data: z.array(
    z.object({ id: z.string().min(1), display_name: z.string().optional() }),
  ),
})

const GoogleModels = z.object({
  models: z.array(
    z
      .object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
  ),
})

export interface DiscoveredModel {
  modelId: string
  displayName?: string
}

export interface DiscoveryAdapter {
  readonly providerId: string
  listModels(apiKey: string, doFetch: typeof fetch): Promise<DiscoveredModel[]>
}

/**
 * Cavabın uğurlu olduğunu yoxlayır və xəta halında AÇARI KƏSİLMİŞ mətn atır.
 *
 * Provayder xətaları çox vaxt göndərilən açarı əks etdirir
 * (`Incorrect API key provided: sk-proj-...`). O mətn DB-yə
 * (`providers.last_discovery_error`) və oradan UI-a gedir — kəsmə burada,
 * mənbədə edilir.
 */
async function readOk(res: Response, apiKey: string, providerId: string): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      redactAll(`${providerId}: HTTP ${res.status} ${body.slice(0, 300)}`.trim(), apiKey),
    )
  }
  return res.json()
}

export const openAiAdapter: DiscoveryAdapter = {
  providerId: 'openai',
  async listModels(apiKey, doFetch) {
    const res = await doFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const parsed = OpenAiModels.safeParse(await readOk(res, apiKey, 'openai'))
    if (!parsed.success) throw new Error('openai: model siyahısı gözlənilən formatda deyil')
    return parsed.data.data.map((m) => ({ modelId: m.id }))
  },
}

export const anthropicAdapter: DiscoveryAdapter = {
  providerId: 'anthropic',
  async listModels(apiKey, doFetch) {
    const res = await doFetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: {
        'x-api-key': apiKey,
        // Bu başlıq MƏCBURİDİR — olmadan Anthropic API 400 qaytarır.
        'anthropic-version': '2023-06-01',
      },
    })
    const parsed = AnthropicModels.safeParse(await readOk(res, apiKey, 'anthropic'))
    if (!parsed.success) throw new Error('anthropic: model siyahısı gözlənilən formatda deyil')
    return parsed.data.data.map((m) => ({
      modelId: m.id,
      ...(m.display_name !== undefined ? { displayName: m.display_name } : {}),
    }))
  },
}

export const googleAdapter: DiscoveryAdapter = {
  providerId: 'google',
  async listModels(apiKey, doFetch) {
    // Açar `?key=` sorğu parametri ilə DEYİL, başlıqla göndərilir. Google hər
    // ikisini qəbul edir, amma URL-lər log-a, xəta mətnlərinə və proxy
    // jurnallarına düşür — açarı ora qoymaq lazımsız risqdir.
    const res = await doFetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { headers: { 'x-goog-api-key': apiKey } },
    )
    const parsed = GoogleModels.safeParse(await readOk(res, apiKey, 'google'))
    if (!parsed.success) throw new Error('google: model siyahısı gözlənilən formatda deyil')

    return (
      parsed.data.models
        // `generateContent` dəstəkləməyənlər (embedding, TTS) mətn taskı üçün
        // yararsızdır. Sahə yoxdursa modeli SAXLAYIRIQ — Google onu
        // buraxsa, biz yararlı modeli itirməməliyik.
        .filter(
          (m) =>
            m.supportedGenerationMethods === undefined ||
            m.supportedGenerationMethods.includes('generateContent'),
        )
        .map((m) => ({
          // Google `models/gemini-3-flash` formatında qaytarır; models.dev və
          // AI SDK isə prefikssiz `gemini-3-flash` işlədir.
          modelId: m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name,
          ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        }))
    )
  },
}

export const DISCOVERY_ADAPTERS: readonly DiscoveryAdapter[] = [
  anthropicAdapter,
  openAiAdapter,
  googleAdapter,
]

export function adapterFor(providerId: string): DiscoveryAdapter | undefined {
  return DISCOVERY_ADAPTERS.find((a) => a.providerId === providerId)
}

/**
 * models.dev-in "bu provayder OpenAI protokolunu danışır" işarəsi (issue #44).
 *
 * ÖLÇÜLMÜŞ (models.dev, 2026-07-29, 174 provayder): 138-i məhz bu paketi
 * göstərir və HAMISININ `api` (baseURL) sahəsi var. Yəni provayderin əlavə
 * edilib-edilməyəcəyi sualına models.dev-in ÖZÜ cavab verir.
 *
 * NİYƏ AD ÜZRƏ AĞ SİYAHI DEYİL: `['deepseek', 'groq', …]` yazsaydıq, siyahı
 * models.dev hər yeni provayder əlavə edəndə köhnələrdi və istifadəçi bunu
 * "niyə yoxdur?" sualı ilə bizdən soruşardı. Paket adı isə provayderin
 * PROTOKOLUNU bildirir — bizə lazım olan da elə budur.
 */
export const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible'

/**
 * Provayder əlavə edilə bilərmi — və hansı yolla.
 *
 * İki yol var və qarışdırılmamalıdır: `native` = öz kəşf adapteri olan üç
 * provayder (auth başlıqları fərqlidir), `openai-compatible` = qalan hamısı.
 */
export function providerSupport(
  provider: CatalogProvider,
): 'native' | 'openai-compatible' | null {
  if (adapterFor(provider.id) !== undefined) return 'native'
  if (provider.npm === OPENAI_COMPATIBLE_NPM && provider.baseUrl !== undefined) {
    return 'openai-compatible'
  }
  return null
}

/**
 * OpenAI-uyğun provayder üçün kəşf adapteri (issue #44).
 *
 * `openAiAdapter`-dən yeganə fərqi ÜNVANDIR — protokol eynidir (`GET
 * {baseUrl}/models` → `{ data: [{ id }] }`). Ona görə adapter FABRİKDİR:
 * provayderin öz `baseUrl`-i ilə qurulur.
 *
 * SONDAKI `/` KƏSİLİR: models.dev bəzi provayderlərdə ünvanı `…/v1`, bəzisində
 * `…/v1/` şəklində verir; birləşdirəndə `//models` alınardı və bəzi serverlər
 * (xüsusən lokal olanlar) onu 404 qaytarır.
 */
export function openAiCompatibleAdapter(
  providerId: string,
  baseUrl: string,
): DiscoveryAdapter {
  return {
    providerId,
    async listModels(apiKey, doFetch) {
      const root = baseUrl.replace(/\/+$/, '')
      const res = await doFetch(`${root}/models`, {
        // Açar BAŞLIQDA gedir, URL-də yox (qayda 14): URL server log-larına,
        // proxy jurnallarına və `fetch failed` xəta mətnlərinə düşür.
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const body = await readOk(res, apiKey, providerId)
      return OpenAiModels.parse(body).data.map((m) => ({ modelId: m.id }))
    },
  }
}

/** Kəşf edilmiş modelləri models.dev metadatası ilə birləşdirir. */
export function mergeWithCatalog(
  providerId: string,
  discovered: readonly DiscoveredModel[],
  catalogProvider: CatalogProvider | undefined,
): ModelUpsert[] {
  const byId = new Map(catalogProvider?.models.map((m) => [m.modelId, m]) ?? [])

  return discovered.map((d) => {
    const meta = byId.get(d.modelId)
    if (meta !== undefined) {
      return {
        ...meta,
        // Provayderin verdiyi ad daha dəqiqdir (açarın gördüyü variant).
        displayName: d.displayName ?? meta.displayName,
        source: 'models.dev' as const,
      }
    }

    // models.dev-də yoxdur → model İŞLƏDİLƏ BİLƏR, amma qiyməti bilinmir.
    // `price: {}` qəsdəndir: `0` yazmaq onu pulsuz göstərərdi (qayda 4).
    return {
      providerId,
      modelId: d.modelId,
      displayName: d.displayName ?? d.modelId,
      price: {},
      toolCall: false,
      structuredOutput: false,
      reasoning: false,
      inputModalities: [],
      source: 'api' as const,
    }
  })
}

export interface DiscoverInput {
  providerId: string
  apiKey: string
  catalogProvider: CatalogProvider | undefined
  fetchImpl?: typeof fetch
}

/**
 * Provayderin endpoint-ini çağırıb DB-yə yazılmağa hazır model siyahısı verir.
 * Uğursuzluqda AÇARI KƏSİLMİŞ xəta atır.
 */
export async function discoverModels(input: DiscoverInput): Promise<ModelUpsert[]> {
  // Öz adapteri VARSA o qazanır: `anthropic` OpenAI protokolunu danışmır
  // (`x-api-key` + `anthropic-version` başlıqları), `google` isə ümumiyyətlə
  // başqa formatdadır. `openai-compatible` yalnız qalanlar üçündür.
  const adapter =
    adapterFor(input.providerId) ??
    (input.catalogProvider !== undefined &&
    providerSupport(input.catalogProvider) === 'openai-compatible'
      ? openAiCompatibleAdapter(
          input.providerId,
          input.catalogProvider.baseUrl as string,
        )
      : undefined)

  if (adapter === undefined) {
    throw new Error(`Model kəşfi dəstəklənmir: ${input.providerId}`)
  }

  let discovered: DiscoveredModel[]
  try {
    discovered = await adapter.listModels(input.apiKey, input.fetchImpl ?? fetch)
  } catch (err) {
    // Şəbəkə səviyyəsindəki xətalar da açarı daşıya bilər (məs. URL-i əks
    // etdirən `TypeError: fetch failed` səbəbləri) — burada da kəsilir.
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(redactAll(message, input.apiKey))
  }

  return mergeWithCatalog(input.providerId, discovered, input.catalogProvider)
}
