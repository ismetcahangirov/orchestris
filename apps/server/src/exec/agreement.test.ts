import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_STEPS,
  answerKey,
  majorityThreshold,
  measureAgreement,
  normalizeAnswer,
} from './agreement.js'

describe('majorityThreshold', () => {
  it('spesifikasiyadakı hədləri verir: 3→2, 5→3', () => {
    expect(majorityThreshold(3)).toBe(2)
    expect(majorityThreshold(5)).toBe(3)
  })

  it('tək nüsxədə həmişə razılaşma var', () => {
    expect(majorityThreshold(1)).toBe(1)
  })
})

describe('AGREEMENT_STEPS', () => {
  it('adaptivdir — sabit N=5 deyil', () => {
    expect(AGREEMENT_STEPS).toEqual([3, 5])
  })
})

describe('normalizeAnswer', () => {
  it('artıq boşluq və boş sətirləri atır', () => {
    expect(normalizeAnswer('  a  b \n\n\n  c ')).toBe('a b\nc')
  })

  it('CRLF ilə LF eyni sayılır', () => {
    expect(normalizeAnswer('a\r\nb')).toBe(normalizeAnswer('a\nb'))
  })

  it('kod çərçivəsi bəzəkdir — nəticəyə təsir etmir', () => {
    expect(normalizeAnswer('```js\nconst a = 1\n```')).toBe(normalizeAnswer('const a = 1'))
  })

  it('böyük/kiçik hərf QORUNUR — kodda `Foo` və `foo` fərqlidir', () => {
    expect(normalizeAnswer('Foo')).not.toBe(normalizeAnswer('foo'))
  })
})

describe('answerKey', () => {
  it('yalnız bəzəklə fərqlənən cavablar eyni açar verir', () => {
    expect(answerKey('```\nsalam\n```')).toBe(answerKey('  salam  '))
  })

  it('məzmun fərqi açarı dəyişir', () => {
    expect(answerKey('salam')).not.toBe(answerKey('sagol'))
  })
})

describe('measureAgreement', () => {
  const s = (runId: string, answer: string) => ({ runId, answer })

  it('2/3 razılaşma qəbul edilir', () => {
    const out = measureAgreement([s('r1', 'A'), s('r2', 'B'), s('r3', 'A')])
    expect(out.agreed).toBe(true)
    expect(out.votes).toBe(2)
    expect(out.threshold).toBe(2)
    expect(out.winnerRunId).toBe('r1')
  })

  it('1/3 razılaşma qəbul edilmir', () => {
    const out = measureAgreement([s('r1', 'A'), s('r2', 'B'), s('r3', 'C')])
    expect(out.agreed).toBe(false)
    expect(out.votes).toBe(1)
  })

  it('3/5 razılaşma qəbul edilir', () => {
    const out = measureAgreement([
      s('r1', 'A'),
      s('r2', 'B'),
      s('r3', 'A'),
      s('r4', 'C'),
      s('r5', 'A'),
    ])
    expect(out.agreed).toBe(true)
    expect(out.votes).toBe(3)
    expect(out.winnerRunId).toBe('r1')
  })

  it('2/5 razılaşma qəbul EDİLMİR', () => {
    const out = measureAgreement([
      s('r1', 'A'),
      s('r2', 'A'),
      s('r3', 'B'),
      s('r4', 'C'),
      s('r5', 'D'),
    ])
    expect(out.agreed).toBe(false)
    expect(out.threshold).toBe(3)
  })

  it('bəzək fərqi razılaşmanı pozmur', () => {
    const out = measureAgreement([
      s('r1', 'cavab'),
      s('r2', '```\ncavab\n```'),
      s('r3', 'başqa'),
    ])
    expect(out.agreed).toBe(true)
    expect(out.winnerRunId).toBe('r1')
  })

  it('bərabərlikdə İLK nüsxə qalib gəlir — nəticə determinist qalır', () => {
    const out = measureAgreement([s('r1', 'A'), s('r2', 'B')])
    expect(out.winnerRunId).toBe('r1')
    expect(out.agreed).toBe(false)
  })

  it('razılaşma olmasa da qalib doludur — monoton qayda üçün lazımdır', () => {
    const out = measureAgreement([s('r1', 'A'), s('r2', 'B'), s('r3', 'C')])
    expect(out.winnerRunId).toBe('r1')
    expect(out.winnerAnswer).toBe('A')
  })

  it('boş siyahı proqramçı xətasıdır', () => {
    expect(() => measureAgreement([])).toThrow()
  })
})
