import { classifyErrorText, type RunEvent } from '@orchestris/shared'
import { computeCostUsd, type ModelPrice } from '../registry/pricing.js'

/**
 * AI SDK `fullStream` hissəsinin BİZƏ LAZIM OLAN hissəsi.
 *
 * SDK-nın öz `TextStreamPart<TOOLS>` tipini götürmürük: o, generic alət
 * dəsti üzərində qurulub və 25 variantı var. Bizim istehlak etdiyimiz sahələr
 * struktur olaraq sabitdir, ona görə burada yalnız onlar təsvir olunur —
 * testlər də SDK-nı işə salmadan saxta hissə düzəldə bilir.
 */
export interface ApiStreamPart {
  type: string
  [key: string]: unknown
}

/** AI SDK `LanguageModelUsage` (v7) — sahələr `undefined` ola bilər. */
interface SdkUsage {
  inputTokens?: number | undefined
  inputTokenDetails?:
    | {
        noCacheTokens?: number | undefined
        cacheReadTokens?: number | undefined
        cacheWriteTokens?: number | undefined
      }
    | undefined
  outputTokens?: number | undefined
}

export interface ApiStreamParserOptions {
  /**
   * Faktiki işlədilən model üçün qiymət. `undefined` qaytarmaq "qiymət
   * bilinmir" deməkdir — o halda `costUsd` sahəsi BURAXILIR (qayda 4).
   */
  resolvePrice?: (modelId: string | undefined) => ModelPrice | undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * AI SDK `streamText().fullStream` axınını `RunEvent` axınına çevirir.
 *
 * Vəziyyət saxlayır: faktiki `model` (provayderin bildirdiyi) və `sawFinish`
 * (ikiqat `usage`/`done` emissiyasının qarşısını almaq üçün).
 */
export class ApiStreamParser {
  /**
   * Provayderin bildirdiyi FAKTİKİ model id-si (`finish-step` →
   * `response.modelId`). İstənilən modeldən fərqli ola bilər: Anthropic
   * `claude-sonnet-4-5` istəyinə tarixli snapshot id-si ilə cavab verir və
   * qiymət məhz onun qiymətidir.
   */
  model: string | undefined
  private sawFinish = false
  private readonly resolvePrice: (modelId: string | undefined) => ModelPrice | undefined

  constructor(opts: ApiStreamParserOptions = {}) {
    this.resolvePrice = opts.resolvePrice ?? (() => undefined)
  }

  push(part: ApiStreamPart): RunEvent[] {
    switch (part.type) {
      case 'text-delta':
        return this.delta('text', part['text'])
      case 'reasoning-delta':
        return this.delta('think', part['text'])
      case 'tool-call':
        return this.onToolCall(part)
      case 'tool-result':
        return this.onToolResult(part, true)
      case 'tool-error':
        return this.onToolResult(part, false)
      case 'finish-step':
        return this.onFinishStep(part)
      case 'finish':
        return this.onFinish(part)
      case 'error':
        return this.onError(part)
      default:
        // Tanınmayan hissə səssizcə atılır. AI SDK yeni hissə tipləri əlavə
        // edir (`raw`, `source`, `custom`, `tool-input-delta`, ...) — onları
        // xəta saymaq hər SDK yeniləməsində uydurma xəta yaradardı.
        return []
    }
  }

  private delta(t: 'text' | 'think', value: unknown): RunEvent[] {
    const text = typeof value === 'string' ? value : ''
    if (text === '') return []
    return [{ t, delta: text }]
  }

  private onToolCall(part: ApiStreamPart): RunEvent[] {
    const raw = part['input']
    // `input` sxemdə MƏCBURİ obyektdir (bax events.ts). Obyekt olmayan dəyər
    // gəlsə boş obyektə çevrilir, yoxsa UI-da `JSON.stringify(input)` üzərində
    // qurulan kod çökür.
    const input =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    return [
      {
        t: 'tool',
        id: String(part['toolCallId'] ?? ''),
        name: String(part['toolName'] ?? ''),
        input,
      },
    ]
  }

  private onToolResult(part: ApiStreamPart, ok: boolean): RunEvent[] {
    return [
      {
        t: 'result',
        id: String(part['toolCallId'] ?? ''),
        ok,
        output: ok ? outputText(part['output']) : errorText(part['error']),
      },
    ]
  }

  private onFinishStep(part: ApiStreamPart): RunEvent[] {
    const response = part['response']
    if (typeof response === 'object' && response !== null) {
      const modelId = (response as { modelId?: unknown }).modelId
      if (typeof modelId === 'string' && modelId !== '') this.model = modelId
    }
    // `finish-step`-in `usage`-i ADDIM-ADDIMDIR — emit ETMİRİK. Addım-addım
    // emissiya `BudgetGuard`-ı (son-dəyər-qalib) səssizcə yan keçərdi:
    // mühafizə yalnız son kiçik addımı görər və heç vaxt işə düşməzdi
    // (CLAUDE.md qayda 3).
    return []
  }

  private onFinish(part: ApiStreamPart): RunEvent[] {
    if (this.sawFinish) return []
    this.sawFinish = true

    const usage = (part['totalUsage'] ?? {}) as SdkUsage
    const details = usage.inputTokenDetails
    const cacheRead = num(details?.cacheReadTokens) ?? 0
    const cacheWrite = num(details?.cacheWriteTokens) ?? 0
    // ÖLÇÜLMÜŞ (@ai-sdk/anthropic@4.0.21 dist/index.js):
    //   inputTokens = noCache + cacheRead + cacheWrite
    // Yəni SDK-nın `inputTokens`-i KEŞ TOKENLƏRİNİ DƏ EHTİVA EDİR. Onu
    // `cacheReadTokens`/`cacheWriteTokens` ilə birlikdə versək, keş tokenləri
    // iki dəfə qiymətləndirilər. Bizim sxemdə (və claude CLI parser-ində)
    // `inputTokens` keşsiz hissədir — ona görə `noCacheTokens` işlədilir.
    const inputTokens = num(details?.noCacheTokens) ?? num(usage.inputTokens) ?? 0
    const outputTokens = num(usage.outputTokens) ?? 0

    const tokens = {
      inputTokens,
      outputTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    }

    const price = this.resolvePrice(this.model)
    const costUsd = price === undefined ? undefined : computeCostUsd(price, tokens)

    const stopReason =
      typeof part['rawFinishReason'] === 'string' && part['rawFinishReason'] !== ''
        ? (part['rawFinishReason'] as string)
        : String(part['finishReason'] ?? 'unknown')

    return [
      {
        t: 'usage',
        ...tokens,
        // Qiymət bilinmirsə sahə BURAXILIR — `0` "həqiqətən pulsuz" kimi
        // oxunar və büdcə mühafizəsini heç vaxt işə salmazdı (qayda 4).
        ...(costUsd !== undefined ? { costUsd } : {}),
        // API çağırışı abunəlikdən GETMİR — kartdan real pul çıxır.
        billed: 'real',
      },
      { t: 'done', stopReason },
    ]
  }

  private onError(part: ApiStreamPart): RunEvent[] {
    const message = errorText(part['error'])
    return [{ t: 'error', class: classifyErrorText(message), message }]
  }
}
