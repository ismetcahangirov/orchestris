import { describe, expect, it } from 'vitest'
import {
  buildDecomposeRequestPrompt,
  MAX_SUBTASKS,
  parseDecomposition,
  shouldDecompose,
  SUBTASK_CHAR_LIMIT,
} from './decompose.js'

function json(subtasks: unknown): string {
  return JSON.stringify({ subtasks })
}

describe('buildDecomposeRequestPrompt', () => {
  it('başçıdan həll DEYİL, bölgü istəyir', () => {
    const prompt = buildDecomposeRequestPrompt('böyük task')
    expect(prompt).toContain('HƏLL ETMƏ')
    expect(prompt).toContain('HƏLLİ YAZMA')
    expect(prompt).toContain('böyük task')
  })

  it('task mətni prefiksdə DEYİL — prompt-keşi qorunur', () => {
    // Qayda 29: `claude` CLI-nın prefiksini dəyişmək Anthropic keşini sındırır.
    // Burada task promptun İÇİNDƏDİR (öz sabit çərçivəsi ilə), ona görə bu
    // prompt tamamilə yeni bir istifadəçi mesajıdır — mövcud işçi keşlərinə
    // toxunmur.
    const prompt = buildDecomposeRequestPrompt('X')
    expect(prompt.startsWith('AŞAĞIDAKI TASKI HƏLL ETMƏ')).toBe(true)
  })
})

describe('parseDecomposition', () => {
  it('düzgün JSON-u parça siyahısına çevirir', () => {
    expect(parseDecomposition(json(['bir', 'iki']))).toEqual({ subtasks: ['bir', 'iki'] })
  })

  it('kod çərçivəsini soyur', () => {
    const fenced = ['```json', json(['bir', 'iki']), '```'].join('\n')
    expect(parseDecomposition(fenced)).toEqual({ subtasks: ['bir', 'iki'] })
  })

  it('JSON cavabın BÜTÜNÜ deyilsə rədd edir', () => {
    // Qayda 28 ilə eyni səbəb: bu sistemin öz sənədini izah edən task nümunə
    // JSON-u sitat gətirir — onu bölgü kimi oxusaydıq, izahat taskı səssizcə
    // alt-tasklara bölünərdi.
    const text = `Bölgü belə görünür: ${json(['bir', 'iki'])} — ümid edirəm aydındır.`
    expect(parseDecomposition(text)).toBeNull()
  })

  it('bir parçalı bölgünü rədd edir — bölgü deyil', () => {
    expect(parseDecomposition(json(['tək parça']))).toBeNull()
  })

  it('boş siyahını rədd edir', () => {
    expect(parseDecomposition(json([]))).toBeNull()
  })

  it('həddən çox parçanı rədd edir', () => {
    const many = Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => `parça ${i}`)
    expect(parseDecomposition(json(many))).toBeNull()
  })

  it('uzun parçanı KƏSMİR, bütöv bölgünü RƏDD edir', () => {
    // Qayda 39 ilə eyni prinsip: yarımçıq kəsilmiş göstəriş icra olunanda pul
    // iki dəfə yanar — səhv işə, sonra düzəlişə.
    const long = 'x'.repeat(SUBTASK_CHAR_LIMIT + 1)
    expect(parseDecomposition(json(['qısa', long]))).toBeNull()
  })

  it('boş və ya mətn olmayan parçanı rədd edir', () => {
    expect(parseDecomposition(json(['bir', '   ']))).toBeNull()
    expect(parseDecomposition(json(['bir', 42]))).toBeNull()
  })

  it('yararsız JSON-a `null` qaytarır', () => {
    expect(parseDecomposition('cavab yoxdur')).toBeNull()
    expect(parseDecomposition('{')).toBeNull()
    expect(parseDecomposition('["bir","iki"]')).toBeNull()
    expect(parseDecomposition('{"başqa": ["bir","iki"]}')).toBeNull()
  })
})

describe('shouldDecompose', () => {
  const base = { profile: 'balanced', requested: true, hasRouter: true }

  it('istənilibsə və başçı varsa açılır', () => {
    expect(shouldDecompose(base).decompose).toBe(true)
  })

  it('istənilməyibsə açılmır — bölgü AVTOMATİK deyil', () => {
    expect(shouldDecompose({ ...base, requested: false }).decompose).toBe(false)
  })

  it('`boss-only` profilində açılmır — baseline ölçməsi korlanmamalıdır', () => {
    // Qayda 25: o profil "başçı bu taskı təkbaşına həll etsəydi" ölçüsüdür.
    // Bir taskı N taska çevirsək ölçünün özü mənasız olardı.
    const verdict = shouldDecompose({ ...base, profile: 'boss-only' })
    expect(verdict.decompose).toBe(false)
    expect(verdict.reason).toContain('baseline')
  })

  it('router yoxdursa açılmır — bölgünü yazacaq başçı yoxdur', () => {
    expect(shouldDecompose({ ...base, hasRouter: false }).decompose).toBe(false)
  })
})
