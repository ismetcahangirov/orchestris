import { classifyErrorText, type RunEvent } from '@orchestris/shared'

/** Atılan `system` subtype-ları — bunlar model çıxışı deyil, telemetriyadır. */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'hook_started',
  'hook_response',
])

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

function blockText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'string'
          ? v
          : typeof (v as { text?: unknown })?.text === 'string'
            ? (v as { text: string }).text
            : '',
      )
      .join('')
  }
  return ''
}

/**
 * `claude -p --output-format stream-json --verbose` çıxışını `RunEvent`
 * axınına çevirir.
 *
 * Vəziyyət saxlayır: `sessionId` (init-dən) və `sawResult` (ikiqat `usage`
 * emissiyasının qarşısını almaq üçün).
 */
export class ClaudeStreamParser {
  sessionId: string | undefined
  model: string | undefined
  /**
   * `init` hadisəsindəki `apiKeySource` sahəsindən oxunur: `'none'` →
   * abunəlik (OAuth), başqa dəyər → API açarı ilə real ödəniş. Default
   * `'subscription'`, çünki `--safe-mode` ilə işləyən CLI abunəlikdən gedir.
   */
  billed: 'real' | 'subscription' = 'subscription'
  private sawResult = false

  push(rawLine: string): RunEvent[] {
    const line = rawLine.trim()
    if (!line) return []

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return [
        {
          t: 'error',
          class: 'parse_error',
          message: `JSON parse alınmadı: ${line.slice(0, 200)}`,
        },
      ]
    }

    const type = typeof obj['type'] === 'string' ? (obj['type'] as string) : ''

    if (type === 'system') return this.onSystem(obj)
    if (type === 'assistant') return this.onAssistant(obj)
    if (type === 'user') return this.onUser(obj)
    if (type === 'rate_limit_event') return this.onRateLimit(obj)
    if (type === 'result') return this.onResult(obj)

    // Tanınmayan hadisə tipi — səssizcə atılır. CLI yeni tiplər əlavə edə
    // bilər; bu, parser-i sındırmamalıdır.
    return []
  }

  private onSystem(obj: Record<string, unknown>): RunEvent[] {
    const subtype = String(obj['subtype'] ?? '')
    if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return []
    if (subtype !== 'init') return []

    if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']
    if (typeof obj['model'] === 'string') this.model = obj['model']

    const keySource = obj['apiKeySource']
    if (typeof keySource === 'string' && keySource !== 'none') {
      this.billed = 'real'
    }

    // `start` hadisəsi burada emit olunur, `done`-da gözlənilmir: icra xəta
    // ilə bitsə sessionId heç vaxt çıxmazdı və `--resume` mümkün olmazdı.
    return [
      {
        t: 'start',
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        ...(this.model !== undefined ? { model: this.model } : {}),
      },
    ]
  }

  private onAssistant(obj: Record<string, unknown>): RunEvent[] {
    const message = obj['message'] as { content?: ContentBlock[] } | undefined
    const blocks = message?.content ?? []
    const out: RunEvent[] = []

    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ t: 'text', delta: b.text })
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        // `signature` qəsdən buraxılır — UI-a və DB-yə getməməlidir.
        out.push({ t: 'think', delta: b.thinking })
      } else if (b.type === 'tool_use') {
        // `input` sxemdə MƏCBURİ obyektdir — obyekt olmayan dəyər gəlsə boş
        // obyektə çevrilir, yoxsa UI-da `JSON.stringify(undefined)` çökür.
        const input =
          typeof b.input === 'object' && b.input !== null && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : {}
        out.push({
          t: 'tool',
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          input,
        })
      }
    }

    // DİQQƏT: `message.usage` kumulyativdir. Burada emit ETMİRİK — yoxsa hər
    // assistant hadisəsi eyni tokenləri yenidən sayardı. `usage` yalnız
    // `result` sətrindən gəlir.
    return out
  }

  private onUser(obj: Record<string, unknown>): RunEvent[] {
    const message = obj['message'] as { content?: ContentBlock[] } | undefined
    const out: RunEvent[] = []
    for (const b of message?.content ?? []) {
      if (b.type !== 'tool_result') continue
      out.push({
        t: 'result',
        id: String(b.tool_use_id ?? ''),
        ok: b.is_error !== true,
        output: blockText(b.content),
      })
    }
    return out
  }

  private onRateLimit(obj: Record<string, unknown>): RunEvent[] {
    const info = obj['rate_limit_info'] as Record<string, unknown> | undefined
    if (!info) return []
    const status = String(info['status'] ?? 'unknown')
    return [
      {
        t: 'rate_limit',
        status,
        // Bu hadisə sağlam icrada da `'allowed'` ilə gəlir. Yalnız rədd
        // olunma bloklayıcıdır — bunu qarışdırsaq hər icrada saatlarla
        // gözləyərdik.
        blocked: status === 'rejected',
        limitType: String(info['rateLimitType'] ?? 'unknown'),
        ...(typeof info['resetsAt'] === 'number'
          ? { resetsAtUnixSec: info['resetsAt'] }
          : {}),
      },
    ]
  }

  private onResult(obj: Record<string, unknown>): RunEvent[] {
    if (this.sawResult) return []
    this.sawResult = true

    if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']

    const out: RunEvent[] = []
    const usage = (obj['usage'] ?? {}) as Record<string, unknown>
    const num = (k: string): number =>
      typeof usage[k] === 'number' ? (usage[k] as number) : 0
    const cacheRead = num('cache_read_input_tokens')
    const cacheWrite = num('cache_creation_input_tokens')

    out.push({
      t: 'usage',
      inputTokens: num('input_tokens'),
      outputTokens: num('output_tokens'),
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      // `total_cost_usd` yoxdursa sahə BURAXILIR — `0` yazmaq "pulsuz" kimi
      // oxunar və büdcə mühafizəsini yan keçər.
      ...(typeof obj['total_cost_usd'] === 'number'
        ? { costUsd: obj['total_cost_usd'] }
        : {}),
      billed: this.billed,
    })

    if (obj['is_error'] === true) {
      const text =
        typeof obj['result'] === 'string' && obj['result']
          ? (obj['result'] as string)
          : String(obj['subtype'] ?? 'bilinməyən xəta')
      out.push({
        t: 'error',
        class: classifyErrorText(text),
        message: text,
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      })
      return out
    }

    out.push({
      t: 'done',
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      stopReason: String(obj['stop_reason'] ?? 'unknown'),
    })
    return out
  }
}
