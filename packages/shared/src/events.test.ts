import { describe, expect, it } from 'vitest'
import { RunEventSchema } from './events.js'

describe('RunEventSchema — əsas variantlar', () => {
  it('mətn deltasını qəbul edir', () => {
    expect(RunEventSchema.parse({ t: 'text', delta: 'SALAM' })).toEqual({
      t: 'text',
      delta: 'SALAM',
    })
  })

  it('start hadisəsini qəbul edir', () => {
    expect(
      RunEventSchema.parse({ t: 'start', sessionId: 's-1', model: 'haiku' }),
    ).toEqual({ t: 'start', sessionId: 's-1', model: 'haiku' })
  })

  it('done hadisəsini qəbul edir', () => {
    expect(
      RunEventSchema.parse({ t: 'done', stopReason: 'end_turn' }),
    ).toMatchObject({ t: 'done', stopReason: 'end_turn' })
  })

  it('tanınmayan `t` dəyərini rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'nonsense' })).toThrow()
  })

  it('mətn deltasında `delta` sahəsi olmadan rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'text' })).toThrow()
  })
})

describe('RunEventSchema — vendor sahələrini kəsir', () => {
  // Bu paketin MƏRKƏZİ invariantı: heç bir vendor sahəsi bu sərhəddən keçmir.
  it('artıq sahələri çıxarır', () => {
    expect(
      RunEventSchema.parse({
        t: 'text',
        delta: 'x',
        vendorRaw: { a: 1 },
        signature: 'gizli',
      }),
    ).toEqual({ t: 'text', delta: 'x' })
  })
})

describe('RunEventSchema — tool variantı', () => {
  it('input açarı MƏCBURİDİR', () => {
    // B3 blocker qoruması: `z.unknown()` açarı opsional edirdi və UI
    // `JSON.stringify(undefined).slice()` ilə çökürdü.
    expect(() =>
      RunEventSchema.parse({ t: 'tool', id: '1', name: 'Read' }),
    ).toThrow()
  })

  it('obyekt input-u qəbul edir və JSON.stringify təhlükəsizdir', () => {
    const e = RunEventSchema.parse({
      t: 'tool',
      id: '1',
      name: 'Read',
      input: { file_path: '/a.ts' },
    })
    if (e.t !== 'tool') throw new Error('gözlənilməz variant')
    expect(() => JSON.stringify(e.input).slice(0, 5)).not.toThrow()
  })

  it('boş obyekt input-u qəbul edir', () => {
    expect(
      RunEventSchema.parse({ t: 'tool', id: '1', name: 'x', input: {} }),
    ).toEqual({ t: 'tool', id: '1', name: 'x', input: {} })
  })
})

describe('RunEventSchema — result variantı', () => {
  it('output opsionaldır', () => {
    expect(
      RunEventSchema.parse({ t: 'result', id: '1', ok: true }),
    ).toEqual({ t: 'result', id: '1', ok: true })
  })

  it('ok sahəsi məcburidir', () => {
    expect(() => RunEventSchema.parse({ t: 'result', id: '1' })).toThrow()
  })
})

describe('RunEventSchema — usage variantı', () => {
  it('bütün sahələrlə qəbul edir', () => {
    const parsed = RunEventSchema.parse({
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
      billed: 'subscription',
    })
    expect(parsed.t).toBe('usage')
  })

  it('keş və costUsd sahələri opsionaldır', () => {
    expect(
      RunEventSchema.parse({
        t: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        billed: 'real',
      }),
    ).toEqual({ t: 'usage', inputTokens: 1, outputTokens: 2, billed: 'real' })
  })

  it('billed sahəsi MƏCBURİDİR — UI abunəlik xərcini real kimi göstərməsin', () => {
    expect(() =>
      RunEventSchema.parse({ t: 'usage', inputTokens: 1, outputTokens: 2 }),
    ).toThrow()
  })

  it('tanınmayan billed dəyərini rədd edir', () => {
    expect(() =>
      RunEventSchema.parse({
        t: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        billed: 'free',
      }),
    ).toThrow()
  })

  it('mənfi costUsd-i rədd edir', () => {
    expect(() =>
      RunEventSchema.parse({
        t: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: -1,
        billed: 'real',
      }),
    ).toThrow()
  })

  it('kəsr token sayını rədd edir', () => {
    expect(() =>
      RunEventSchema.parse({
        t: 'usage',
        inputTokens: 1.5,
        outputTokens: 2,
        billed: 'real',
      }),
    ).toThrow()
  })
})

describe('RunEventSchema — rate_limit variantı', () => {
  it('blocked sahəsi ilə qəbul edir', () => {
    expect(
      RunEventSchema.parse({
        t: 'rate_limit',
        status: 'allowed',
        blocked: false,
        limitType: 'five_hour',
        resetsAtUnixSec: 1785097800,
      }),
    ).toEqual({
      t: 'rate_limit',
      status: 'allowed',
      blocked: false,
      limitType: 'five_hour',
      resetsAtUnixSec: 1785097800,
    })
  })

  it('blocked sahəsi MƏCBURİDİR — sağlam icrada gözləməyə düşməmək üçün', () => {
    expect(() =>
      RunEventSchema.parse({
        t: 'rate_limit',
        status: 'allowed',
        limitType: 'five_hour',
      }),
    ).toThrow()
  })

  it('naməlum status dəyərini qəbul edir — CLI yeni dəyər əlavə edə bilər', () => {
    const e = RunEventSchema.parse({
      t: 'rate_limit',
      status: 'throttled_soon',
      blocked: false,
      limitType: 'weekly',
    })
    expect(e.t).toBe('rate_limit')
  })
})

describe('RunEventSchema — error variantı', () => {
  it('etibarlı sinfi qəbul edir', () => {
    expect(
      RunEventSchema.parse({ t: 'error', class: 'auth', message: 'm' }),
    ).toEqual({ t: 'error', class: 'auth', message: 'm' })
  })

  it('sessionId-i qəbul edir — uğursuz icranı davam etdirmək üçün', () => {
    expect(
      RunEventSchema.parse({
        t: 'error',
        class: 'crashed',
        message: 'm',
        sessionId: 's-9',
      }),
    ).toMatchObject({ sessionId: 's-9' })
  })

  it('uydurma sinfi RƏDD edir', () => {
    // B2 blocker qoruması: `z.string()` `'rateLimit'` və `''` qəbul edirdi.
    expect(() =>
      RunEventSchema.parse({ t: 'error', class: 'rateLimit', message: 'm' }),
    ).toThrow()
    expect(() =>
      RunEventSchema.parse({ t: 'error', class: '', message: 'm' }),
    ).toThrow()
  })

  it('retryable sahəsini saxlamır — o, class-dan törəyir', () => {
    const e = RunEventSchema.parse({
      t: 'error',
      class: 'auth',
      message: 'm',
      retryable: true,
    })
    expect('retryable' in e).toBe(false)
  })
})
