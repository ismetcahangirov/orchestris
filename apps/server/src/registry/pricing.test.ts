import { describe, expect, it } from 'vitest'
import { computeCostUsd, hasBasePrice, type ModelPrice } from './pricing.js'

const FULL: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

describe('computeCostUsd', () => {
  it('tam qiymətlə düzgün hesablayır', () => {
    // 1M giriş × $3 + 1M çıxış × $15 = $18
    expect(computeCostUsd(FULL, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
  })

  it('keş tokenlərini də daxil edir', () => {
    const cost = computeCostUsd(FULL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.3 + 3.75, 10)
  })

  it('kiçik icranı düzgün miqyaslayır', () => {
    // Faza 1A-da ölçülən real rəqəm: 25,076 giriş + 59 çıxış
    const cost = computeCostUsd(FULL, { inputTokens: 25_076, outputTokens: 59 })
    expect(cost).toBeCloseTo((25_076 * 3 + 59 * 15) / 1e6, 10)
  })

  it('qiymət tamamilə yoxdursa undefined qaytarır — 0 YOX', () => {
    const cost = computeCostUsd({}, { inputTokens: 100, outputTokens: 50 })
    expect(cost).toBeUndefined()
    expect(cost).not.toBe(0)
  })

  it('yalnız çıxış qiyməti yoxdursa undefined qaytarır', () => {
    expect(computeCostUsd({ input: 3 }, { inputTokens: 100, outputTokens: 50 })).toBeUndefined()
  })

  it('işlədilməmiş token növünün qiyməti bilinməsə də xərc BİLİNİR', () => {
    // cache_read qiyməti yoxdur, amma keşdən heç nə oxunmayıb → xərc dəqiqdir.
    // models.dev-də belə model 30 ədəddir; onları "bilinmir" saymaq büdcə
    // mühafizəsini lazımsız yere kor edərdi.
    const cost = computeCostUsd(
      { input: 3, output: 15 },
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
    )
    expect(cost).toBe(3)
  })

  it('işlədilmiş token növünün qiyməti bilinmirsə xərc BİLİNMİR', () => {
    const cost = computeCostUsd(
      { input: 3, output: 15 },
      { inputTokens: 1_000_000, outputTokens: 10, cacheReadTokens: 20_000 },
    )
    expect(cost).toBeUndefined()
  })

  it('həqiqətən pulsuz model üçün 0 qaytarır (undefined YOX)', () => {
    const cost = computeCostUsd(
      { input: 0, output: 0 },
      { inputTokens: 5_000, outputTokens: 1_000 },
    )
    expect(cost).toBe(0)
    expect(cost).not.toBeUndefined()
  })

  it('heç bir token işlədilməyibsə qiymət bilinməsə də 0-dır', () => {
    expect(computeCostUsd({}, { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })
})

describe('hasBasePrice', () => {
  it('giriş və çıxış qiyməti varsa true', () => {
    expect(hasBasePrice({ input: 3, output: 15 })).toBe(true)
  })

  it('pulsuz model (0 qiymət) də true — 0 bilinən qiymətdir', () => {
    expect(hasBasePrice({ input: 0, output: 0 })).toBe(true)
  })

  it('yalnız keş qiyməti varsa false', () => {
    expect(hasBasePrice({ cacheRead: 0.3 })).toBe(false)
  })

  it('boş qiymət false', () => {
    expect(hasBasePrice({})).toBe(false)
  })
})
