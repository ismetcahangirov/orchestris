import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  classifyErrorText,
  type Capabilities,
  type DetectResult,
  type RunEvent,
  type RunOptions,
  type RunRequest,
  type Runner,
} from '@orchestris/shared'
import { streamText, type LanguageModel } from 'ai'
import type { ModelPrice } from '../registry/pricing.js'
import { redactAll } from '../secrets/redact.js'
import { ApiStreamParser, type ApiStreamPart } from './parse-api.js'

/**
 * ÖZ SDK-sı olan provayderlər — `createProviderModel` bunları birbaşa tanıyır.
 *
 * Qalan hamısı `openai-compatible` yolu ilə gedir (issue #44) və `baseUrl`
 * TƏLƏB EDİR; ona görə onlar burada SADALANMIR — siyahı models.dev-dən gəlir.
 */
export const API_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const
export type ApiProviderId = (typeof API_PROVIDER_IDS)[number]

/**
 * Açardan model obyekti qurur. ŞƏBƏKƏYƏ ÇIXMIR — yalnız konfiqurasiya
 * obyekti yaradır, ilk sorğu `streamText` çağırışında gedir.
 *
 * `baseUrl` VERİLİBSƏ `openai-compatible` yolu seçilir (issue #44): models.dev-in
 * 174 provayderindən 138-i məhz bu protokoldadır. Öz SDK-sı olan üç provayder
 * ÜSTÜN tutulur — `anthropic` OpenAI protokolunu danışmır (`x-api-key` +
 * `anthropic-version`), `google` isə ümumiyyətlə başqa formatdadır.
 */
export function createProviderModel(
  providerId: string,
  apiKey: string,
  modelId: string,
  baseUrl?: string,
): LanguageModel {
  switch (providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
    default:
      if (baseUrl === undefined) {
        throw new Error(`API runner dəstəklənmir: ${providerId}`)
      }
      // `name` SDK-nın daxili etiketidir; provayder id-sini veririk ki, xəta
      // mətnlərində hansı provayderdən danışıldığı görünsün.
      return createOpenAICompatible({
        name: providerId,
        baseURL: baseUrl.replace(/\/+$/, ''),
        apiKey,
      })(modelId)
  }
}

/**
 * `streamText`-in bizə lazım olan hissəsi. SDK-nın öz tipi generic alət dəsti
 * üzərində qurulub və testdə saxta axın yaratmağı çətinləşdirir — burada
 * yalnız istifadə etdiyimiz sahələr var.
 */
export interface ApiStreamCall {
  model: unknown
  prompt: string
  abortSignal?: AbortSignal
  maxOutputTokens?: number
}

export type StreamTextFn = (call: ApiStreamCall) => {
  fullStream: AsyncIterable<ApiStreamPart>
}

const defaultStreamText: StreamTextFn = (call) => {
  const result = streamText({
    model: call.model as LanguageModel,
    prompt: call.prompt,
    ...(call.abortSignal !== undefined ? { abortSignal: call.abortSignal } : {}),
    ...(call.maxOutputTokens !== undefined ? { maxOutputTokens: call.maxOutputTokens } : {}),
  })
  return { fullStream: result.fullStream as AsyncIterable<ApiStreamPart> }
}

export interface ApiRunnerDeps {
  providerId: string
  /**
   * Açarı OS anbarından oxuyur. Hər icrada YENİDƏN oxunur — istifadəçi açarı
   * silsə və ya dəyişsə, köhnə açarla işləməyə davam etmək olmaz.
   * `null` = açar yoxdur.
   */
  getApiKey: () => Promise<string | null>
  /**
   * OpenAI-uyğun provayderin kök ünvanı (issue #44). Öz SDK-sı olan üç
   * provayderdə VERİLMİR.
   *
   * FUNKSİYADIR, sabit dəyər deyil: provayder DB-dən silinib yenidən başqa
   * ünvanla əlavə oluna bilər və runner prosesin ömrü boyu yaşayır. Sabit
   * saxlasaydıq, köhnə ünvan qalar və istifadəçi bunu yalnız sorğu sınanda
   * görərdi (eyni mühakimə: `getApiKey` da hər icrada yenidən oxunur).
   */
  getBaseUrl?: () => string | undefined
  /** Faktiki modelin qiyməti. `undefined` = qiymət bilinmir (qayda 4). */
  resolvePrice?: (providerId: string, modelId: string) => ModelPrice | undefined
  /** Test üçün — real SDK provayderini əvəz edir. */
  createModel?: (apiKey: string, modelId: string) => unknown
  /** Test üçün — real API çağırışını əvəz edir (sıfır token, qayda 11). */
  streamText?: StreamTextFn
}

/**
 * Birbaşa API modelləri üçün runner.
 *
 * NİYƏ LAZIMDIR (Faza 1A-da ölçülüb): `claude` CLI hər çağırışda ~21.7k token
 * döşəməsi daşıyır (baza sistem promptu + daxili alətlər). API çağırışının
 * döşəməsi ~0-dır. Qısa mətn tasklarında o döşəməni ödəmək mənasızdır — bu
 * runner routing-i (issue #7) MÜMKÜN edir.
 *
 * Fərqlər CLI runner-lərdən:
 *  - `fileAccess: false` — alət yoxdur, fayl oxunmur
 *  - `sessions: false` — `--resume` ekvivalenti yoxdur
 *  - `subscriptionBilled: false` — REAL pul çıxır, dollar limiti tətbiq olunur
 */
export class ApiRunner implements Runner {
  readonly id: string
  readonly kind = 'api' as const
  readonly capabilities: Capabilities = {
    fileAccess: false,
    toolUse: true,
    sessions: false,
    structuredOutput: true,
    // Abunəlik DEYİL — kartdan real pul çıxır. `BudgetGuard` bunu görüb
    // dollar limitini tətbiq edir (CLAUDE.md qayda 5).
    subscriptionBilled: false,
  }

  private readonly deps: ApiRunnerDeps
  private readonly streamText: StreamTextFn
  private readonly createModel: (apiKey: string, modelId: string) => unknown

  constructor(deps: ApiRunnerDeps) {
    this.deps = deps
    this.id = `api:${deps.providerId}`
    this.streamText = deps.streamText ?? defaultStreamText
    this.createModel =
      deps.createModel ??
      ((apiKey, modelId) =>
        createProviderModel(deps.providerId, apiKey, modelId, deps.getBaseUrl?.()))
  }

  /**
   * Açarın mövcudluğunu yoxlayır. Provayderin endpoint-inə SORĞU GETMİR —
   * `/api/providers` səhifəsi hər açılışda bütün provayderləri yoxlayır və
   * bu, hər dəfə pullu (və ya rate-limit yeyən) sorğu olardı. Açarın həqiqətən
   * işlədiyi model kəşfində (`POST /api/providers/:id/discover`) təsdiqlənir.
   */
  async detect(): Promise<DetectResult> {
    const key = await this.deps.getApiKey()
    if (key === null || key === '') {
      return {
        installed: true,
        authenticated: false,
        detail: `${this.deps.providerId}: API açarı təyin olunmayıb`,
      }
    }
    return {
      installed: true,
      authenticated: true,
      detail: `${this.deps.providerId}: açar OS anbarında var (icrada təsdiqlənir)`,
    }
  }

  async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    const apiKey = await this.deps.getApiKey()
    if (apiKey === null || apiKey === '') {
      yield {
        t: 'error',
        class: 'auth',
        message: `${this.deps.providerId}: API açarı yoxdur — /providers səhifəsindən əlavə et`,
      }
      return
    }

    // `start` axın başlamazdan ƏVVƏL verilir: sorğu ilk baytdan əvvəl sınsa
    // belə UI hansı modelin sınadığını göstərməlidir. Provayder daha dəqiq
    // (tarixli) model id-si bildirsə, parser onu tutur və qiymət ONA görə
    // hesablanır — amma `start` sxem üzrə yalnız BİR DƏFƏ ola bilər.
    yield { t: 'start', model: req.model }

    const parser = new ApiStreamParser({
      resolvePrice: (actualModelId) =>
        this.deps.resolvePrice?.(this.deps.providerId, actualModelId ?? req.model),
    })

    try {
      const { fullStream } = this.streamText({
        model: this.createModel(apiKey, req.model),
        prompt: req.prompt,
        ...(opts?.signal !== undefined ? { abortSignal: opts.signal } : {}),
        // Sərt çıxış limiti provayder tərəfində tətbiq olunur — `BudgetGuard`
        // yalnız artıq ödənilmiş tokenləri görəndən sonra kəsə bilər.
        ...(opts?.maxOutputTokens !== undefined
          ? { maxOutputTokens: opts.maxOutputTokens }
          : {}),
      })

      for await (const part of fullStream) {
        for (const event of parser.push(part)) yield event
        if (opts?.signal?.aborted === true) break
      }
    } catch (err) {
      // Kəsilmə xəta DEYİL. Supervisor abort-u görüb icranı `interrupted`
      // sayır; burada `error` versək istifadəçi öz ləğvini xəta kimi görərdi.
      if (opts?.signal?.aborted === true) return

      // Provayder xətaları göndərilən açarı əks etdirə bilir
      // (`Incorrect API key provided: sk-...`). Bu mətn `run_events`-ə və
      // oradan brauzerə gedir — kəsmə hadisə YARANMAZDAN ƏVVƏL edilir.
      const message = redactAll(err instanceof Error ? err.message : String(err), apiKey)
      yield { t: 'error', class: classifyErrorText(message), message }
    }
  }
}
