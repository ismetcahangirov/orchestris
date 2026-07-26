import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RunEventSchema, type RunEvent } from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { CodexStreamParser } from './parse-codex.js'

function parseFixture(name: string): { events: RunEvent[]; parser: CodexStreamParser } {
  const parser = new CodexStreamParser()
  const events: RunEvent[] = []
  for (const line of readFileSync(fixturePath(name), 'utf8').split('\n')) {
    if (!line.trim()) continue
    events.push(...parser.push(line))
  }
  return { events, parser }
}

describe('CodexStreamParser — auth xətası fixture-i', () => {
  it('hər emit olunan hadisə RunEvent sxemini keçir', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    for (const e of events) expect(() => RunEventSchema.parse(e)).not.toThrow()
  })

  it('JSON olmayan stderr sətirlərini atır, parse_error yaratmır', () => {
    // Fixture-də 8 JSON-olmayan sətir var (stdin qeydi + Rust ERROR logları).
    // Onları xəta saymaq hər log sətrini uydurma xətaya çevirərdi.
    const { events } = parseFixture('codex-auth-error.jsonl')
    expect(
      events.filter((e) => e.t === 'error' && e.class === 'parse_error'),
    ).toHaveLength(0)
  })

  it('thread.started-dan start hadisəsi verir və sessionId tutur', () => {
    const { events, parser } = parseFixture('codex-auth-error.jsonl')
    expect(parser.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    const starts = events.filter((e) => e.t === 'start')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toEqual({
      t: 'start',
      sessionId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('401 mesajını auth xətası kimi təsnif edir', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    const authErrors = events.filter((e) => e.t === 'error' && e.class === 'auth')
    expect(authErrors.length).toBeGreaterThan(0)
  })

  it('xəta hadisələrinə sessionId əlavə edir — uğursuz icranı davam etdirmək üçün', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    const errs = events.filter((e) => e.t === 'error')
    expect(errs.length).toBeGreaterThan(0)
    for (const e of errs) {
      if (e.t === 'error') {
        expect(e.sessionId).toBe('00000000-0000-4000-8000-000000000001')
      }
    }
  })

  it('turn.failed-dən sonra done vermir', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    expect(events.filter((e) => e.t === 'done')).toHaveLength(0)
  })

  it('heç bir usage hadisəsi vermir — turn tamamlanmadı', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(0)
  })
})

describe('CodexStreamParser — hadisə tipləri', () => {
  it('agent_message item-ini text hadisəsi kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'SALAM' },
      }),
    )
    expect(events).toEqual([{ t: 'text', delta: 'SALAM' }])
  })

  it('reasoning item-ini think hadisəsi kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_2', type: 'reasoning', text: 'düşünürəm' },
      }),
    )
    expect(events).toEqual([{ t: 'think', delta: 'düşünürəm' }])
  })

  it('command_execution item-ini tool + result kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'command_execution',
          command: 'ls -la',
          exit_code: 0,
          aggregated_output: 'total 0',
        },
      }),
    )
    expect(events).toEqual([
      { t: 'tool', id: 'item_3', name: 'command_execution', input: { command: 'ls -la' } },
      { t: 'result', id: 'item_3', ok: true, output: 'total 0' },
    ])
  })

  it('sıfırdan fərqli exit_code-u ok:false kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i4', type: 'command_execution', command: 'false', exit_code: 1 },
      }),
    )
    const res = events.find((e) => e.t === 'result')
    expect(res).toEqual({ t: 'result', id: 'i4', ok: false, output: '' })
  })

  it('turn.completed hadisəsini usage + done kimi verir', () => {
    const parser = new CodexStreamParser()
    parser.push(JSON.stringify({ type: 'thread.started', thread_id: 'th_9' }))
    const events = parser.push(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30 },
      }),
    )
    expect(events).toEqual([
      {
        t: 'usage',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 100,
        billed: 'subscription',
      },
      { t: 'done', sessionId: 'th_9', stopReason: 'end_turn' },
    ])
  })

  it('costUsd sahəsini HEÇ VAXT yazmır — codex xərc bildirmir', () => {
    // `costUsd: 0` yazmaq "həqiqətən pulsuz" kimi oxunar və büdcə
    // mühafizəsini səssizcə yan keçər.
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    )
    const u = events.find((e) => e.t === 'usage')
    expect(u && 'costUsd' in u).toBe(false)
  })

  it('turn.completed iki dəfə gəlsə usage yalnız bir dəfə verilir', () => {
    const parser = new CodexStreamParser()
    const first = parser.push(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    )
    const second = parser.push(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 9 } }),
    )
    expect(first.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(second).toEqual([])
  })

  it('keş tokeni sıfırdırsa cacheReadTokens sahəsini buraxır', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0 },
      }),
    )
    const u = events.find((e) => e.t === 'usage')
    expect(u && 'cacheReadTokens' in u).toBe(false)
  })

  it('turn.started və tanınmayan tipləri sakitcə atır', () => {
    const parser = new CodexStreamParser()
    expect(parser.push(JSON.stringify({ type: 'turn.started' }))).toEqual([])
    expect(parser.push(JSON.stringify({ type: 'some.future.event' }))).toEqual([])
  })

  it('JSON olmayan sətri atır', () => {
    const parser = new CodexStreamParser()
    expect(parser.push('Reading additional input from stdin...')).toEqual([])
    expect(
      parser.push('2026-07-26T20:17:01Z ERROR codex_api::endpoint: failed'),
    ).toEqual([])
  })

  it('boş sətri atır', () => {
    const parser = new CodexStreamParser()
    expect(parser.push('   ')).toEqual([])
  })

  it('pozuq JSON obyekt sətrini parse_error kimi verir', () => {
    const parser = new CodexStreamParser()
    expect(parser.push('{"type": "broken"')).toEqual([
      {
        t: 'error',
        class: 'parse_error',
        message: 'JSON parse alınmadı: {"type": "broken"',
      },
    ])
  })

  it('error hadisəsində retryable sahəsi YOXDUR', () => {
    // Sahə qəsdən silindi — `isRetryable(class)`-dan törəyir və sahə kimi
    // saxlanılsa iki istehlakçı fərqli qərar verə bilər.
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({ type: 'error', message: 'Not logged in' }),
    )
    expect(events).toHaveLength(1)
    expect(events[0] && 'retryable' in events[0]).toBe(false)
  })
})
