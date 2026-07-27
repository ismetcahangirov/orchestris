import { classifyErrorText, type RunEvent } from '@orchestris/shared'

interface CodexItem {
  id?: string
  type?: string
  text?: string
  message?: string
  command?: string
  exit_code?: number
  aggregated_output?: string
}

/**
 * `codex exec --json` çıxışını `RunEvent` axınına çevirir.
 *
 * Codex-ə xas üç davranış (hər biri real eksperimentlə təsdiqlənib):
 *  1. stderr Rust logları stdout axınına qarışır və JSON DEYİL. Onlar
 *     səssizcə atılır — `parse_error` yaratmaq hər log sətrini uydurma
 *     xətaya çevirərdi.
 *  2. `codex exec` stdin bağlanmasa "Reading additional input from stdin..."
 *     deyib donur; o sətir də JSON deyil və atılır.
 *  3. Hadisə adları nöqtəlidir: `thread.started`, `turn.completed`, ...
 *
 * Xərc: codex `total_cost_usd` kimi bir şey vermir. `costUsd` sahəsi
 * BURAXILIR — `0` yazmaq "həqiqətən pulsuz" kimi oxunar və büdcə
 * mühafizəsini səssizcə yan keçər.
 */
export class CodexStreamParser {
  sessionId: string | undefined
  private sawTerminal = false

  push(rawLine: string): RunEvent[] {
    const line = rawLine.trim()
    if (!line) return []

    // JSON olmayan sətirlər (Rust logları, stdin qeydi) — sakitcə atılır.
    if (!line.startsWith('{')) return []

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

    switch (obj['type']) {
      case 'thread.started': {
        if (typeof obj['thread_id'] === 'string') this.sessionId = obj['thread_id']
        // `start` hadisəsi burada verilir: icra xəta ilə bitsə `done` gəlməz
        // və sessionId heç vaxt çıxmazdı — halbuki `codex exec resume` məhz
        // o halda lazımdır.
        return [
          {
            t: 'start',
            ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
          },
        ]
      }
      case 'turn.started':
        return []
      case 'item.completed':
        return this.onItem(obj['item'] as CodexItem | undefined)
      case 'error':
        return this.errorEvent(String(obj['message'] ?? 'bilinməyən xəta'))
      case 'turn.failed': {
        this.sawTerminal = true
        const err = obj['error'] as { message?: string } | undefined
        return this.errorEvent(String(err?.message ?? 'turn uğursuz oldu'))
      }
      case 'turn.completed':
        return this.onTurnCompleted(obj)
      default:
        // Tanınmayan tip — səssizcə atılır. Codex yeni hadisə tipləri əlavə
        // edə bilər; bu, parser-i sındırmamalıdır.
        return []
    }
  }

  private errorEvent(message: string): RunEvent[] {
    return [
      {
        t: 'error',
        class: classifyErrorText(message),
        message,
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      },
    ]
  }

  private onItem(item: CodexItem | undefined): RunEvent[] {
    if (!item) return []
    const id = String(item.id ?? '')

    switch (item.type) {
      case 'agent_message':
        return item.text ? [{ t: 'text', delta: item.text }] : []
      case 'reasoning':
        return item.text ? [{ t: 'think', delta: item.text }] : []
      case 'error':
        return this.errorEvent(String(item.message ?? 'bilinməyən xəta'))
      case 'command_execution':
        return [
          {
            t: 'tool',
            id,
            name: 'command_execution',
            input: { command: String(item.command ?? '') },
          },
          {
            t: 'result',
            id,
            ok: (item.exit_code ?? 0) === 0,
            output: item.aggregated_output ?? '',
          },
        ]
      default:
        return []
    }
  }

  private onTurnCompleted(obj: Record<string, unknown>): RunEvent[] {
    if (this.sawTerminal) return []
    this.sawTerminal = true

    const usage = (obj['usage'] ?? {}) as Record<string, unknown>
    const num = (k: string): number =>
      typeof usage[k] === 'number' ? (usage[k] as number) : 0
    const cached = num('cached_input_tokens')

    return [
      {
        t: 'usage',
        inputTokens: num('input_tokens'),
        outputTokens: num('output_tokens'),
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        // `costUsd` QƏSDƏN yoxdur — yuxarıdaki sinif şərhinə bax.
        billed: 'subscription',
      },
      {
        t: 'done',
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        stopReason: 'end_turn',
      },
    ]
  }
}
