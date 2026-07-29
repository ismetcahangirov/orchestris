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
/** Axın deltalarının blok indeksi üzrə yığılmış hali. */
interface StreamedBlock {
  t: 'text' | 'think'
  text: string
}

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
  /**
   * `--include-partial-messages` ilə eyni məzmun İKİ dəfə gəlir: əvvəlcə
   * `stream_event` deltaları, sonra tam `assistant` bloku. Burada deltaların
   * yığılmış hali saxlanılır ki, `assistant` bloku ona bərabər olanda ATILSIN
   * — yoxsa cavab jurnalda və UI-da iki dəfə görünərdi.
   */
  private readonly streamed = new Map<number, StreamedBlock>()

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
    if (type === 'stream_event') return this.onStreamEvent(obj)
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

  /**
   * `--include-partial-messages` bayrağının verdiyi hərf-hərf axın.
   *
   * Format Anthropic SSE hadisələrinin eynisidir (ölçülmüş: `claude` 2.1.220):
   * `message_start` → `content_block_start` → `content_block_delta`* →
   * `content_block_stop` → `message_delta` → `message_stop`.
   */
  private onStreamEvent(obj: Record<string, unknown>): RunEvent[] {
    const ev = obj['event'] as Record<string, unknown> | undefined
    if (!ev) return []
    const evType = String(ev['type'] ?? '')
    const index = typeof ev['index'] === 'number' ? ev['index'] : 0

    if (evType === 'message_start') {
      // Hər API mesajı blok indeksini 0-dan başladır. Təmizləmə olmasa
      // ikinci mesajın 0-cı bloku birincinin qalığı ilə qarışardı.
      this.streamed.clear()
      return []
    }

    if (evType === 'content_block_start') {
      const block = ev['content_block'] as { type?: string } | undefined
      const kind = block?.type
      if (kind === 'text') this.streamed.set(index, { t: 'text', text: '' })
      else if (kind === 'thinking') this.streamed.set(index, { t: 'think', text: '' })
      // `tool_use` bloku qəsdən yığılmır: onun girişi `input_json_delta` ilə
      // YARIMÇIQ JSON parçaları şəklində gəlir. Tam obyekt `assistant`
      // mesajından götürülür (aşağıda), parçalar isə atılır.
      else this.streamed.delete(index)
      return []
    }

    if (evType === 'content_block_delta') {
      const delta = ev['delta'] as Record<string, unknown> | undefined
      const deltaType = String(delta?.['type'] ?? '')

      if (deltaType === 'text_delta' && typeof delta?.['text'] === 'string') {
        const text = delta['text']
        this.append(index, 'text', text)
        return [{ t: 'text', delta: text }]
      }
      if (deltaType === 'thinking_delta' && typeof delta?.['thinking'] === 'string') {
        const text = delta['thinking']
        this.append(index, 'think', text)
        return [{ t: 'think', delta: text }]
      }
      // `signature_delta` — düşünmə imzası. UI-a və DB-yə getməməlidir.
      // `input_json_delta` — alət girişinin yarımçıq JSON parçası.
      return []
    }

    // `message_delta` KUMULYATİV `usage` daşıyır — emit ETMİRİK, yoxsa
    // tokenlər həm burada, həm `result` sətrində sayılardı (qayda 3).
    // `content_block_stop` / `message_stop` — struktur siqnalları, məzmun yox.
    return []
  }

  private append(index: number, t: 'text' | 'think', text: string): void {
    const entry = this.streamed.get(index)
    if (entry === undefined) this.streamed.set(index, { t, text })
    else if (entry.t === t) entry.text += text
    else this.streamed.set(index, { t, text })
  }

  /**
   * Blok artıq delta kimi axıdılıbsa `true` qaytarır və qeydi silir.
   *
   * Müqayisə MƏZMUN üzrədir, indeks üzrə yox: `assistant` mesajı blokun
   * indeksini daşımır. Axıdılmamış blok (məs. bayraq sönülü icra) tapılmır və
   * normal yolla emit olunur — parser hər iki rejimdə işləyir.
   */
  private consumeStreamed(t: 'text' | 'think', text: string): boolean {
    for (const [index, entry] of this.streamed) {
      if (entry.t === t && entry.text === text) {
        this.streamed.delete(index)
        return true
      }
    }
    return false
  }

  private onAssistant(obj: Record<string, unknown>): RunEvent[] {
    const message = obj['message'] as { content?: ContentBlock[] } | undefined
    const blocks = message?.content ?? []
    const out: RunEvent[] = []

    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        // Axınla artıq verilibsə təkrar emit etmirik (bax `consumeStreamed`).
        if (this.consumeStreamed('text', b.text)) continue
        out.push({ t: 'text', delta: b.text })
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        // `signature` qəsdən buraxılır — UI-a və DB-yə getməməlidir.
        if (this.consumeStreamed('think', b.thinking)) continue
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
