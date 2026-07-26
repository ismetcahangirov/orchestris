import { describe, expect, it } from 'vitest'
import { RunEventSchema } from './events.js'

describe('RunEventSchema', () => {
  it('mətn deltasını qəbul edir', () => {
    const parsed = RunEventSchema.parse({ t: 'text', delta: 'SALAM' })
    expect(parsed).toEqual({ t: 'text', delta: 'SALAM' })
  })

  it('usage hadisəsini bütün keş sahələri ilə qəbul edir', () => {
    const parsed = RunEventSchema.parse({
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
    })
    expect(parsed.t).toBe('usage')
  })

  it('usage hadisəsində keş sahələri opsionaldır', () => {
    const parsed = RunEventSchema.parse({
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0,
    })
    expect(parsed).toMatchObject({ t: 'usage', inputTokens: 1 })
  })

  it('rate_limit hadisəsini qəbul edir', () => {
    const parsed = RunEventSchema.parse({
      t: 'rate_limit',
      status: 'allowed',
      limitType: 'five_hour',
      resetsAt: 1785097800,
    })
    expect(parsed.t).toBe('rate_limit')
  })

  it('tanınmayan `t` dəyərini rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'nonsense' })).toThrow()
  })

  it('mətn deltasında `delta` sahəsi olmadan rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'text' })).toThrow()
  })
})
