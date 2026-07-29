import { describe, expect, it } from 'vitest'
import { CHARS_PER_TOKEN, estimateTokens, trimToBudget } from './budget.js'
import type { MemoryItem } from './provider.js'

function item(id: string, text: string, score?: number): MemoryItem {
  return { id, text, ...(score !== undefined ? { score } : {}) }
}

describe('estimateTokens', () => {
  it('təxmini YUXARI qiymətləndirir — səhvin ucuz istiqaməti', () => {
    // `4` işlətsəydik büdcə səssizcə aşılardı: Azərbaycan mətni tokenləşdiricidə
    // pis sıxılır. `3` daha çox token göstərir, yəni daha az yaddaş qoşulur.
    expect(CHARS_PER_TOKEN).toBe(3)
    expect(estimateTokens('a'.repeat(30))).toBe(10)
  })

  it('boş mətn də ən azı bir token sayılır', () => {
    expect(estimateTokens('')).toBe(1)
  })
})

describe('trimToBudget', () => {
  it('büdcəyə sığmayan qeydi atır', () => {
    const kept = trimToBudget([item('a', 'x'.repeat(300))], 10)
    expect(kept).toEqual([])
  })

  it('kəsim RELEVANTLIĞA görədir, sıraya görə yox', () => {
    // Provayderin qaytardığı sıra təsadüfi ola bilər; büdcənin kimə çatacağını
    // `score` həll etməlidir.
    const kept = trimToBudget(
      [item('az-uyğun', 'x'.repeat(30), 0.1), item('çox-uyğun', 'y'.repeat(30), 0.9)],
      10,
    )
    expect(kept.map((i) => i.id)).toEqual(['çox-uyğun'])
  })

  it('sığmayan qeyddən SONRA gələn kiçik qeyd hələ də qəbul olunur', () => {
    // Dayansaydıq, bir uzun qeyd qalan bütün büdcəni israf edərdi.
    const kept = trimToBudget(
      [item('uzun', 'x'.repeat(300), 0.9), item('qısa', 'y'.repeat(15), 0.5)],
      10,
    )
    expect(kept.map((i) => i.id)).toEqual(['qısa'])
  })

  it('mətnin özünü KƏSMİR — yarımçıq qeyd yanıldıcıdır', () => {
    const kept = trimToBudget([item('a', 'x'.repeat(15))], 10)
    expect(kept[0]?.text).toHaveLength(15)
  })

  it('büdcə sıfır və ya mənfi olsa heç nə qaytarmır', () => {
    expect(trimToBudget([item('a', 'salam')], 0)).toEqual([])
    expect(trimToBudget([item('a', 'salam')], -5)).toEqual([])
  })

  it('cəm HEÇ VAXT büdcəni aşmır', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, 'x'.repeat(30), i / 20))
    const kept = trimToBudget(items, 50)
    const used = kept.reduce((sum, i) => sum + estimateTokens(i.text), 0)
    expect(used).toBeLessThanOrEqual(50)
    expect(kept.length).toBeGreaterThan(0)
  })
})
