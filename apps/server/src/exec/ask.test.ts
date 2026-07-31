import { describe, expect, it } from 'vitest'
import {
  answerProblem,
  MAX_QUESTION_OPTIONS,
  parseAsk,
  QUESTION_CHAR_LIMIT,
} from './ask.js'

const wrap = (o: unknown): string => JSON.stringify(o)

describe('parseAsk — qəbul edilən formalar', () => {
  it('yes_no sualını qəbul edir', () => {
    expect(parseAsk(wrap({ ask: { question: 'Davam edim?', kind: 'yes_no' } }))).toEqual({
      question: 'Davam edim?',
      kind: 'yes_no',
      options: [],
    })
  })

  it('single sualını variantları ilə qəbul edir', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Hansı?', kind: 'single', options: ['a', 'b'] } })),
    ).toEqual({ question: 'Hansı?', kind: 'single', options: ['a', 'b'] })
  })

  it('multi sualını qəbul edir', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Hansılar?', kind: 'multi', options: ['a', 'b'] } }))
        ?.kind,
    ).toBe('multi')
  })

  it('kod çərçivəsi soyulur', () => {
    const body = wrap({ ask: { question: 'Q', kind: 'yes_no' } })
    expect(parseAsk('```json\n' + body + '\n```')).not.toBeNull()
  })

  it('sual mətninin boşluqları kəsilir', () => {
    expect(parseAsk(wrap({ ask: { question: '  Q  ', kind: 'yes_no' } }))?.question).toBe('Q')
  })
})

describe('parseAsk — RƏDD halları', () => {
  it('cavabın İÇİNDƏ keçən JSON rədd edilir', () => {
    // Mexanizmin ƏN VACİB testi: sistemin öz sənədini izah edən task məhz belə
    // bir JSON-u nümunə kimi sitat gətirir. `includes` qaydası ilə hər belə
    // task ƏBƏDİ "cavab gözləyir" vəziyyətinə düşərdi.
    const body = wrap({ ask: { question: 'Q', kind: 'yes_no' } })
    expect(parseAsk(`Müqavilə belədir: ${body} — yəni model soruşa bilər.`)).toBeNull()
  })

  it('tanınmayan kind rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'dropdown' } }))).toBeNull()
  })

  it('single-də variant yoxdursa rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'single' } }))).toBeNull()
  })

  it('single-də TƏK variant rədd edilir — seçim deyil', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Q', kind: 'single', options: ['a'] } })),
    ).toBeNull()
  })

  it('yes_no-da variant verilibsə rədd edilir — ziddiyyət', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Q', kind: 'yes_no', options: ['a', 'b'] } })),
    ).toBeNull()
  })

  it('çox variant RƏDD edilir, KƏSİLMİR', () => {
    const options = Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, (_, i) => `v${i}`)
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'multi', options } }))).toBeNull()
  })

  it('uzun sual RƏDD edilir, KƏSİLMİR', () => {
    const question = 'a'.repeat(QUESTION_CHAR_LIMIT + 1)
    expect(parseAsk(wrap({ ask: { question, kind: 'yes_no' } }))).toBeNull()
  })

  it('boş sual rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: '   ', kind: 'yes_no' } }))).toBeNull()
  })

  it('sətir olmayan variant rədd edilir', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Q', kind: 'single', options: ['a', 5] } })),
    ).toBeNull()
  })

  it('ask massivdirsə rədd edilir', () => {
    expect(parseAsk(wrap({ ask: ['Q'] }))).toBeNull()
  })

  it('adi mətn cavabı null verir', () => {
    expect(parseAsk('Bu, adi bir cavabdır.')).toBeNull()
  })

  it('sınıq JSON null verir', () => {
    expect(parseAsk('{"ask": {')).toBeNull()
  })

  it('escalate JSON-u ask kimi oxunmur', () => {
    expect(parseAsk(wrap({ escalate: true, reason: 'r' }))).toBeNull()
  })
})

describe('answerProblem', () => {
  it('yes_no boolean tələb edir', () => {
    expect(answerProblem('yes_no', [], true)).toBeNull()
    expect(answerProblem('yes_no', [], 'bəli')).not.toBeNull()
  })

  it('single tanınan variant tələb edir', () => {
    expect(answerProblem('single', ['a', 'b'], 'a')).toBeNull()
    expect(answerProblem('single', ['a', 'b'], 'c')).toContain('Tanınmayan variant')
    expect(answerProblem('single', ['a'], ['a'])).not.toBeNull()
  })

  it('multi massiv və tanınan variantlar tələb edir', () => {
    expect(answerProblem('multi', ['a', 'b'], ['a', 'b'])).toBeNull()
    expect(answerProblem('multi', ['a'], 'a')).not.toBeNull()
    expect(answerProblem('multi', ['a'], ['a', 'z'])).toContain('Tanınmayan variant')
  })

  it('boş çoxseçimli cavab rədd edilir', () => {
    expect(answerProblem('multi', ['a'], [])).not.toBeNull()
  })

  it('tanınmayan növ rədd edilir', () => {
    expect(answerProblem('dropdown', [], 'a')).toContain('Tanınmayan sual növü')
  })
})
