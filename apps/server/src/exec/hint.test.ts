import { describe, expect, it } from 'vitest'
import { buildHintRequestPrompt, buildHintedPrompt, HINT_CHAR_LIMIT } from './hint.js'

const TASK = 'Bu funksiyanı yaz: fibonacci(n)'

describe('buildHintRequestPrompt — başçıdan istənən ipucu', () => {
  it('taskı və işçinin ilişdiyi səbəbi daşıyır', () => {
    const prompt = buildHintRequestPrompt({ task: TASK, reason: 'rekursiya çətindir' })

    expect(prompt).toContain(TASK)
    expect(prompt).toContain('rekursiya çətindir')
  })

  it('BAŞÇIYA TAM HƏLL YAZMAĞI QADAĞAN EDİR — pillənin bütün qənaəti buradadır', () => {
    // Başçı tam cavab yazsa Pillə 4 elə Pillə 7 olar: xərc eyni qalar, üstəlik
    // işçinin əlavə icrası da ödənilər — yəni pillə ZƏRƏRƏ işləyər.
    const prompt = buildHintRequestPrompt({ task: TASK, reason: 'səbəb' })

    expect(prompt).toContain('TAM həll YAZMA')
    expect(prompt).toContain('10–30%')
  })

  it('işçinin qismən nəticəsi varsa başçıya ötürülür — ödənilmiş iş atılmır', () => {
    const prompt = buildHintRequestPrompt({
      task: TASK,
      reason: 'səbəb',
      partial: 'function fib(n) {',
    })

    expect(prompt).toContain('function fib(n) {')
  })

  it('qismən nəticə yoxdursa boş blok yaranmır', () => {
    const prompt = buildHintRequestPrompt({ task: TASK, reason: 'səbəb' })

    expect(prompt).not.toContain('qismən nəticəsi')
  })
})

describe('buildHintedPrompt — işçiyə verilən ipuculu prompt', () => {
  it('taskı və ipucunu birlikdə daşıyır', () => {
    const prompt = buildHintedPrompt(TASK, 'Rekursiya yox, dövr işlət.')

    expect(prompt).toContain(TASK)
    expect(prompt).toContain('Rekursiya yox, dövr işlət.')
  })

  it('ipucunun DAVAMINI istəyir — təkrarını yox', () => {
    const prompt = buildHintedPrompt(TASK, 'ipucu')

    expect(prompt).toContain('SONA ÇATDIR')
  })

  it('həddindən uzun ipucu kəsilir — işçinin konteksti şişməməlidir', () => {
    const long = 'x'.repeat(HINT_CHAR_LIMIT + 500)

    const prompt = buildHintedPrompt(TASK, long)

    expect(prompt).not.toContain('x'.repeat(HINT_CHAR_LIMIT + 1))
    expect(prompt).toContain('x'.repeat(HINT_CHAR_LIMIT))
  })
})
