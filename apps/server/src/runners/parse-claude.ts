import { classifyErrorText, isRetryable, type RunEvent } from '@orchestris/shared'

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
          retryable: false,
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
    if (subtype === 'init') {
      if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']
      if (typeof obj['model'] === 'string') this.model = obj['model']
    }
    return []
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
        out.push({
          t: 'tool',
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          input: b.input,
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
    const event: RunEvent = {
      t: 'rate_limit',
      status: String(info['status'] ?? 'unknown'),
      limitType: String(info['rateLimitType'] ?? 'unknown'),
      ...(typeof info['resetsAt'] === 'number'
        ? { resetsAt: info['resetsAt'] }
        : {}),
    }
    return [event]
  }

  private onResult(obj: Record<string, unknown>): RunEvent[] {
    if (this.sawResult) return []
    this.sawResult = true

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
      costUsd:
        typeof obj['total_cost_usd'] === 'number'
          ? (obj['total_cost_usd'] as number)
          : 0,
    })

    if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']

    if (obj['is_error'] === true) {
      const text =
        typeof obj['result'] === 'string' && obj['result']
          ? (obj['result'] as string)
          : String(obj['subtype'] ?? 'bilinməyən xəta')
      const cls = classifyErrorText(text)
      out.push({
        t: 'error',
        class: cls,
        message: text,
        retryable: isRetryable(cls),
      })
      return out
    }

    out.push({
      t: 'done',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      stopReason: String(obj['stop_reason'] ?? 'unknown'),
    })
    return out
  }
}
