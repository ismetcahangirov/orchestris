import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import { RunEventSchema } from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { ClaudeStreamParser } from './parse-claude.js'

function parseFixture(name: string): { events: RunEvent[]; parser: ClaudeStreamParser } {
  const parser = new ClaudeStreamParser()
  const events: RunEvent[] = []
  const text = readFileSync(fixturePath(name), 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    events.push(...parser.push(line))
  }
  return { events, parser }
}

describe('ClaudeStreamParser — safe-mode fixture', () => {
  it('hər emit olunan hadisə RunEvent sxemini keçir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    for (const e of events) {
      expect(() => RunEventSchema.parse(e)).not.toThrow()
    }
  })

  it('mətn blokunu text hadisəsi kimi verir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const texts = events.filter((e) => e.t === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toEqual({ t: 'text', delta: 'SALAM' })
  })

  it('thinking blokunu think hadisəsi kimi verir, signature-ı sızdırmır', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const thinks = events.filter((e) => e.t === 'think')
    expect(thinks).toHaveLength(1)
    expect(JSON.stringify(thinks[0])).not.toContain('signature')
  })

  it('usage hadisəsini YALNIZ bir dəfə verir — kumulyativ toplama yoxdur', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const usages = events.filter((e) => e.t === 'usage')
    expect(usages).toHaveLength(1)
    expect(usages[0]).toEqual({
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.008450099999999999,
      billed: 'subscription',
    })
  })

  it('rate_limit hadisəsini çıxarır', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const rl = events.filter((e) => e.t === 'rate_limit')
    expect(rl).toHaveLength(1)
    expect(rl[0]).toEqual({
      t: 'rate_limit',
      status: 'allowed',
      blocked: false,
      limitType: 'five_hour',
      resetsAtUnixSec: 1785097800,
    })
  })

  it('done hadisəsini sessionId və stopReason ilə verir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const done = events.filter((e) => e.t === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toEqual({
      t: 'done',
      sessionId: '00000000-0000-4000-8000-000000000001',
      stopReason: 'end_turn',
    })
  })

  it('sessionId-i init hadisəsindən dərhal tutur', () => {
    const parser = new ClaudeStreamParser()
    parser.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
        model: 'claude-haiku-4-5-20251001',
      }),
    )
    expect(parser.sessionId).toBe('abc-123')
  })

  it('telemetriya hadisələrini atır', () => {
    const parser = new ClaudeStreamParser()
    const noise = [
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
      { type: 'system', subtype: 'hook_started', hook_name: 'x' },
      { type: 'system', subtype: 'hook_response', hook_name: 'x' },
    ]
    for (const n of noise) {
      expect(parser.push(JSON.stringify(n))).toEqual([])
    }
  })
})

describe('ClaudeStreamParser — tool istifadəsi', () => {
  it('tool_use blokunu tool hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    )
    expect(events).toEqual([
      { t: 'tool', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
    ])
  })

  it('user tool_result blokunu result hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' },
          ],
        },
      }),
    )
    expect(events).toEqual([{ t: 'result', id: 'toolu_1', ok: true, output: 'ok' }])
  })

  it('xətalı tool_result-u ok:false kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'ENOENT' },
          ],
        },
      }),
    )
    expect(events).toEqual([
      { t: 'result', id: 'toolu_2', ok: false, output: 'ENOENT' },
    ])
  })
})

describe('ClaudeStreamParser — xəta halları', () => {
  it('is_error:true olan result-u error hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: 'stop_sequence',
        session_id: 's1',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        result: 'Invalid API key',
      }),
    )
    const err = events.find((e) => e.t === 'error')
    expect(err).toEqual({
      t: 'error',
      class: 'auth',
      message: 'Invalid API key',
      sessionId: 's1',
    })
  })

  it('pozuq JSON sətrini parse_error kimi verir, çökmür', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push('{ bu json deyil')
    expect(events).toEqual([
      {
        t: 'error',
        class: 'parse_error',
        message: 'JSON parse alınmadı: { bu json deyil',
      },
    ])
  })

  it('boş sətri sakitcə atır', () => {
    const parser = new ClaudeStreamParser()
    expect(parser.push('   ')).toEqual([])
  })
})

describe('ClaudeStreamParser — tam fərdiləşdirmə fixture-i', () => {
  it('hook səs-küyü ilə dolu axını da düzgün parse edir', () => {
    const { events } = parseFixture('claude-full-customizations.jsonl')
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'error')).toHaveLength(0)
  })

  it('tam rejimin daha bahalı olduğunu ölçür — safe-mode-un dəyərini sübut edir', () => {
    const full = parseFixture('claude-full-customizations.jsonl')
    const safe = parseFixture('claude-safe-mode.jsonl')
    // `costUsd` artıq opsionaldır (`0` ≠ "bilinmir"). Yoxluğu 0-a çevirmək
    // müqayisəni səssizcə zəiflədərdi, ona görə açıq şəkildə sınırıq.
    const cost = (r: ReturnType<typeof parseFixture>): number => {
      const u = r.events.find((e) => e.t === 'usage')
      if (u?.t !== 'usage' || u.costUsd === undefined) {
        throw new Error('fixture-də costUsd yoxdur')
      }
      return u.costUsd
    }
    expect(cost(full)).toBeGreaterThan(cost(safe) * 2)
  })
})

describe('ClaudeStreamParser — start hadisəsi', () => {
  it('init-dən start hadisəsi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's-1',
        model: 'claude-haiku-4-5-20251001',
        apiKeySource: 'none',
      }),
    )
    expect(events).toEqual([
      { t: 'start', sessionId: 's-1', model: 'claude-haiku-4-5-20251001' },
    ])
  })

  it('apiKeySource "none" olduqda abunəlik kimi işarələyir', () => {
    const parser = new ClaudeStreamParser()
    parser.push(
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }),
    )
    expect(parser.billed).toBe('subscription')
  })

  it('apiKeySource API açarı göstərdikdə real ödəniş kimi işarələyir', () => {
    const parser = new ClaudeStreamParser()
    parser.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        apiKeySource: 'ANTHROPIC_API_KEY',
      }),
    )
    expect(parser.billed).toBe('real')
  })

  it('safe-mode fixture-i start hadisəsi ilə başlayır', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    expect(events[0]?.t).toBe('start')
    expect(events.filter((e) => e.t === 'start')).toHaveLength(1)
  })
})

describe('ClaudeStreamParser — costUsd yoxluğu', () => {
  it('total_cost_usd yoxdursa costUsd sahəsini BURAXIR', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    )
    const u = events.find((e) => e.t === 'usage')
    expect(u && 'costUsd' in u).toBe(false)
  })
})

describe('ClaudeStreamParser — --include-partial-messages fixture', () => {
  it('hər emit olunan hadisə RunEvent sxemini keçir', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    for (const e of events) {
      expect(() => RunEventSchema.parse(e)).not.toThrow()
    }
  })

  it('mətni parça-parça axın kimi verir və TƏKRARLAMIR', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    const texts = events.filter((e) => e.t === 'text')
    // Axın olduğunu sübut edir: heç olmasa bir delta var və birləşməsi
    // yekun cavabın ÖZÜDÜR — `assistant` bloku ayrıca emit olunsaydı
    // "SALAMSALAM" alınardı.
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.map((e) => (e.t === 'text' ? e.delta : '')).join('')).toBe('SALAM')
  })

  it('thinking-i axınla verir və tam bloku təkrar emit etmir', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    const thinks = events.filter((e) => e.t === 'think')
    // Fixture-də 4 `thinking_delta` var; tam blok da emit olunsaydı 5 olardı.
    expect(thinks).toHaveLength(4)
    const joined = thinks.map((e) => (e.t === 'think' ? e.delta : '')).join('')
    // Fixture-də thinking uzunluq qoruyan maska ilə əvəzlənib; parçaların
    // birləşməsi blokun uzunluğuna BƏRABƏRDİR (dublikat olsaydı 2x = 430).
    expect(joined.length).toBe(215)
  })

  it('signature-ı heç bir hadisəyə sızdırmır', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    expect(JSON.stringify(events)).not.toContain('signature')
  })

  it('usage-i yalnız bir dəfə, result sətrindən verir', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    const usages = events.filter((e) => e.t === 'usage')
    // `stream_event/message_delta` də kumulyativ `usage` daşıyır — onu da
    // emit etsək tokenlər iki dəfə sayılardı (CLAUDE.md qayda 3).
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ inputTokens: 10, outputTokens: 67 })
  })

  it('start və done hadisələri dəyişmir', () => {
    const { events } = parseFixture('claude-partial-messages.jsonl')
    expect(events.filter((e) => e.t === 'start')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
  })
})

describe('ClaudeStreamParser — partial axında alət istifadəsi', () => {
  it('alət girişini TAM obyekt kimi verir, input_json_delta parçalarını yox', () => {
    const { events } = parseFixture('claude-partial-tool.jsonl')
    const tools = events.filter((e) => e.t === 'tool')
    expect(tools).toHaveLength(1)
    const tool = tools[0]
    if (tool?.t !== 'tool') throw new Error('tool hadisəsi yoxdur')
    expect(tool.name).toBe('Read')
    // `input_json_delta` parçaları yarımçıq JSON-dur — onları emit etsək
    // UI-da sınıq mətn, DB-də isə parse olunmayan giriş qalardı.
    expect(tool.input['file_path']).toContain('qeyd.txt')
    expect(JSON.stringify(events)).not.toContain('partial_json')
  })

  it('iki mesajlı axında indeks sıfırlanması dublikat yaratmır', () => {
    const { events } = parseFixture('claude-partial-tool.jsonl')
    const texts = events.filter((e) => e.t === 'text')
    // Hər blok bir neçə deltadan ibarətdir: axın yoxdursa 2 hadisə olardı
    // (mesaj başına bir tam blok), axın varsa 4.
    expect(texts).toHaveLength(4)
    const joined = texts.map((e) => (e.t === 'text' ? e.delta : '')).join('')
    // İkinci mesaj `content_block` indeksini 0-dan başladır — akkumulyator
    // sıfırlanmasaydı birinci mesajın mətni ilə qarışardı.
    expect(joined).toBe('Mən qeyd.txt faylını oxuyacağam.Faylda olan söz: **salam**')
  })

  it('alət nəticəsini result hadisəsi kimi verir', () => {
    const { events } = parseFixture('claude-partial-tool.jsonl')
    const results = events.filter((e) => e.t === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true })
  })
})
