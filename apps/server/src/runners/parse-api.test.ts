import { describe, expect, it } from 'vitest'
import { RunEventSchema, type RunEvent } from '@orchestris/shared'
import { ApiStreamParser, type ApiStreamPart } from './parse-api.js'

function collect(
  parts: readonly ApiStreamPart[],
  parser = new ApiStreamParser(),
): RunEvent[] {
  const out: RunEvent[] = []
  for (const p of parts) out.push(...parser.push(p))
  return out
}

/** AI SDK `LanguageModelUsage` — v7 formatı (`ai@7.0.37` dist/index.d.ts). */
function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputTokens: 100,
    inputTokenDetails: {
      noCacheTokens: 100,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 20,
    outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
    totalTokens: 120,
    ...over,
  }
}

describe('ApiStreamParser — mətn və düşüncə', () => {
  it('text-delta hissəsini text hadisəsinə çevirir', () => {
    expect(collect([{ type: 'text-delta', id: '1', text: 'Salam' }])).toEqual([
      { t: 'text', delta: 'Salam' },
    ])
  })

  it('reasoning-delta hissəsini think hadisəsinə çevirir', () => {
    expect(collect([{ type: 'reasoning-delta', id: '1', text: 'düşünürəm' }])).toEqual([
      { t: 'think', delta: 'düşünürəm' },
    ])
  })

  it('boş delta üçün hadisə yaratmır', () => {
    expect(collect([{ type: 'text-delta', id: '1', text: '' }])).toEqual([])
  })

  it('tanınmayan hissə tipini səssizcə atır', () => {
    // AI SDK yeni hissə tipləri əlavə edir (`raw`, `source`, `custom`, ...).
    // Onları xəta saymaq hər yeni SDK versiyasında uydurma xəta yaradardı.
    expect(collect([{ type: 'raw', rawValue: { anything: true } }])).toEqual([])
    expect(collect([{ type: 'text-start', id: '1' }])).toEqual([])
  })
})

describe('ApiStreamParser — alət çağırışları', () => {
  it('tool-call hissəsini tool hadisəsinə çevirir', () => {
    expect(
      collect([
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { city: 'Baku' },
        },
      ]),
    ).toEqual([{ t: 'tool', id: 'call_1', name: 'get_weather', input: { city: 'Baku' } }])
  })

  it('obyekt olmayan tool input-u boş obyektə çevirir', () => {
    // `input` sxemdə MƏCBURİ obyektdir. Sətir/massiv gəlsə UI-da
    // `JSON.stringify(input)` üzərində qurulan kod çökərdi.
    const events = collect([
      { type: 'tool-call', toolCallId: 'c', toolName: 'n', input: 'sətir' },
    ])
    expect(events).toEqual([{ t: 'tool', id: 'c', name: 'n', input: {} }])
  })

  it('tool-result hissəsini uğurlu result hadisəsinə çevirir', () => {
    expect(
      collect([
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: {},
          output: { tempC: 31 },
        },
      ]),
    ).toEqual([{ t: 'result', id: 'call_1', ok: true, output: '{"tempC":31}' }])
  })

  it('tool-error hissəsini uğursuz result hadisəsinə çevirir', () => {
    expect(
      collect([
        {
          type: 'tool-error',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: {},
          error: new Error('şəbəkə sınıb'),
        },
      ]),
    ).toEqual([{ t: 'result', id: 'call_1', ok: false, output: 'şəbəkə sınıb' }])
  })
})

describe('ApiStreamParser — usage (CLAUDE.md qayda 3)', () => {
  it('usage-i YALNIZ finish hissəsindən, bir dəfə emit edir', () => {
    const events = collect([
      { type: 'finish-step', response: { modelId: 'm' }, usage: usage(), finishReason: 'stop' },
      { type: 'text-delta', id: '1', text: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        totalUsage: usage(),
      },
    ])
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
  })

  it('finish-step usage-i emit etmir — o, addım-addımdır', () => {
    // Addım-addım emit etmək BudgetGuard-ı (son-dəyər-qalib) yan keçərdi:
    // mühafizə yalnız son kiçik addımı görər və heç vaxt işə düşməzdi.
    const events = collect([
      { type: 'finish-step', response: { modelId: 'm' }, usage: usage(), finishReason: 'stop' },
    ])
    expect(events).toEqual([])
  })

  it('inputTokens üçün noCacheTokens işlədir, total-ı YOX', () => {
    // ÖLÇÜLMÜŞ (@ai-sdk/anthropic@4.0.21 dist/index.js):
    //   inputTokens.total = noCache + cacheRead + cacheWrite
    // `total`-ı işlətsək və üstünə cacheRead/cacheWrite də versək, keş
    // tokenləri İKİ DƏFƏ qiymətləndirilər — xərc şişər, ledger yalan danışar.
    const events = collect([
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        totalUsage: usage({
          inputTokens: 21_700,
          inputTokenDetails: {
            noCacheTokens: 200,
            cacheReadTokens: 21_000,
            cacheWriteTokens: 500,
          },
        }),
      },
    ])
    const u = events.find((e) => e.t === 'usage')
    expect(u).toMatchObject({
      inputTokens: 200,
      cacheReadTokens: 21_000,
      cacheWriteTokens: 500,
    })
  })

  it('billed həmişə real-dır — API abunəlikdən getmir', () => {
    const events = collect([
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
    ])
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ billed: 'real' })
  })

  it('naməlum token sayını 0 sayır, sahəni atmır', () => {
    const events = collect([
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        totalUsage: { inputTokens: undefined, outputTokens: undefined },
      },
    ])
    expect(events.find((e) => e.t === 'usage')).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})

describe('ApiStreamParser — xərc (CLAUDE.md qayda 4, 15)', () => {
  it('qiymət verilibsə costUsd hesablayır', () => {
    const parser = new ApiStreamParser({
      // models.dev vahidi: 1 MİLYON token üçün USD.
      resolvePrice: () => ({ input: 3, output: 15 }),
    })
    const events = collect(
      [
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
          totalUsage: usage({
            inputTokens: 1000,
            inputTokenDetails: { noCacheTokens: 1000 },
            outputTokens: 1000,
          }),
        },
      ],
      parser,
    )
    // 1000/1e6*3 + 1000/1e6*15 = 0.018
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ costUsd: 0.018 })
  })

  it('qiymət bilinmirsə costUsd sahəsini BURAXIR, 0 yazmır', () => {
    const parser = new ApiStreamParser({ resolvePrice: () => undefined })
    const events = collect(
      [
        { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
      ],
      parser,
    )
    const u = events.find((e) => e.t === 'usage')
    expect(u).not.toHaveProperty('costUsd')
  })

  it('qiyməti provayderin bildirdiyi FAKTİKİ model üçün soruşur', () => {
    // Anthropic `claude-sonnet-4-5` istəyinə tarixli snapshot id-si ilə cavab
    // verir. Qiymət istənilən modelin deyil, işlədilənin qiymətidir.
    const asked: (string | undefined)[] = []
    const parser = new ApiStreamParser({
      resolvePrice: (id) => {
        asked.push(id)
        return { input: 1, output: 1 }
      },
    })
    collect(
      [
        {
          type: 'finish-step',
          response: { modelId: 'claude-sonnet-4-5-20250929' },
          usage: usage(),
          finishReason: 'stop',
        },
        { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
      ],
      parser,
    )
    expect(asked).toEqual(['claude-sonnet-4-5-20250929'])
  })
})

describe('ApiStreamParser — bitmə və xəta', () => {
  it('finish hissəsindən done verir və xam stop səbəbini saxlayır', () => {
    const events = collect([
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
    ])
    expect(events.at(-1)).toEqual({ t: 'done', stopReason: 'end_turn' })
  })

  it('rawFinishReason yoxdursa SDK-nın normallaşdırdığı səbəbi işlədir', () => {
    const events = collect([
      { type: 'finish', finishReason: 'length', rawFinishReason: undefined, totalUsage: usage() },
    ])
    expect(events.at(-1)).toEqual({ t: 'done', stopReason: 'length' })
  })

  it('usage done-dan ƏVVƏL gəlir', () => {
    const events = collect([
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
    ])
    expect(events.map((e) => e.t)).toEqual(['usage', 'done'])
  })

  it('error hissəsini təsnif edilmiş error hadisəsinə çevirir', () => {
    const events = collect([
      { type: 'error', error: new Error('429 Too Many Requests') },
    ])
    expect(events).toEqual([
      { t: 'error', class: 'rate_limit', message: '429 Too Many Requests' },
    ])
  })

  it('Error olmayan xəta dəyərini də mətnə çevirir', () => {
    const events = collect([{ type: 'error', error: { statusCode: 401 } }])
    expect(events[0]).toMatchObject({ t: 'error', class: 'auth' })
  })

  it('abort hissəsi üçün done vermir', () => {
    // Kəsilmiş icra BİTMİŞ deyil. `done` versək supervisor onu `succeeded`
    // sayardı və UI istifadəçiyə yalan danışardı.
    expect(collect([{ type: 'abort', reason: 'user' }])).toEqual([])
  })

  it('ikinci finish hissəsi ikiqat usage/done yaratmır', () => {
    const parts: ApiStreamPart[] = [
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
    ]
    expect(collect(parts).map((e) => e.t)).toEqual(['usage', 'done'])
  })
})

describe('ApiStreamParser — sxem uyğunluğu', () => {
  it('emit etdiyi hər hadisə RunEvent sxemini keçir', () => {
    const parser = new ApiStreamParser({ resolvePrice: () => ({ input: 3, output: 15 }) })
    const events = collect(
      [
        { type: 'start' },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', text: 'nəticə' },
        { type: 'reasoning-delta', id: '2', text: 'düşüncə' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } },
        { type: 'tool-result', toolCallId: 'c1', toolName: 'read', input: {}, output: 'məzmun' },
        {
          type: 'finish-step',
          response: { modelId: 'claude-haiku-4-5' },
          usage: usage(),
          finishReason: 'stop',
        },
        { type: 'finish', finishReason: 'stop', rawFinishReason: 'end_turn', totalUsage: usage() },
      ],
      parser,
    )
    for (const e of events) expect(() => RunEventSchema.parse(e)).not.toThrow()
  })
})
