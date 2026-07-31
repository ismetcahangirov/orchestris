import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import {
  buildEscalationPrompt,
  buildSignalContract,
  collectAnswerText,
  parseEscalation,
} from './escalation.js'

describe('collectAnswerText', () => {
  it('yalnız `text` deltalarını birləşdirir', () => {
    const events: RunEvent[] = [
      { t: 'start' },
      { t: 'think', delta: 'düşünürəm' },
      { t: 'text', delta: 'SA' },
      { t: 'text', delta: 'LAM' },
      { t: 'done', stopReason: 'end_turn' },
    ]
    expect(collectAnswerText(events)).toBe('SALAM')
  })

  it('mətn yoxdursa boş sətir', () => {
    expect(collectAnswerText([{ t: 'done', stopReason: 'end_turn' }])).toBe('')
  })
})

describe('parseEscalation', () => {
  it('təmiz JSON eskalasiyanı tanıyır', () => {
    const e = parseEscalation('{"escalate": true, "reason": "kontekst çatmır"}')
    expect(e).toEqual({ reason: 'kontekst çatmır' })
  })

  it('qismən nəticəni saxlayır', () => {
    const e = parseEscalation(
      '{"escalate":true,"reason":"r","partial":"function f() {}"}',
    )
    expect(e?.partial).toBe('function f() {}')
  })

  it('kod çərçivəsi içindəki JSON-u da tanıyır', () => {
    const e = parseEscalation('```json\n{"escalate": true, "reason": "r"}\n```')
    expect(e?.reason).toBe('r')
  })

  it('ətrafdakı boşluqlar əhəmiyyətsizdir', () => {
    expect(parseEscalation('\n\n  {"escalate":true}  \n')?.reason).toBe(
      'işçi səbəb göstərmədi',
    )
  })

  it('normal cavab eskalasiya DEYİL', () => {
    expect(parseEscalation('Cavab: 42')).toBeNull()
  })

  it('`escalate` sahəsi olmayan JSON eskalasiya deyil', () => {
    expect(parseEscalation('{"answer": 42}')).toBeNull()
  })

  it('`escalate: false` eskalasiya deyil', () => {
    expect(parseEscalation('{"escalate": false, "reason": "r"}')).toBeNull()
  })

  it('`escalate` mətn və ya rəqəm olarsa qəbul edilmir', () => {
    expect(parseEscalation('{"escalate": "true"}')).toBeNull()
    expect(parseEscalation('{"escalate": 1}')).toBeNull()
  })

  // Bu, modulun ƏSAS müdafiəsidir: yanlış-müsbət eskalasiya hazır nəticəni
  // atıb taskı ən bahalı modelə göndərir — layihənin məqsədinin tam əksi.
  it('cavabın İÇİNDƏ sitat gətirilən JSON eskalasiya DEYİL', () => {
    const answer = [
      'Self-escalation belə işləyir: model bacarmadıqda',
      '{"escalate": true, "reason": "..."} qaytarır.',
      'Beləliklə boş yerə token yanmır.',
    ].join('\n')
    expect(parseEscalation(answer)).toBeNull()
  })

  it('müqavilənin öz mətnini təkrarlayan cavab eskalasiya deyil', () => {
    expect(parseEscalation(buildSignalContract({ escalate: true, ask: true }))).toBeNull()
  })

  it('yarımçıq JSON eskalasiya deyil', () => {
    expect(parseEscalation('{"escalate": true, "reason":')).toBeNull()
  })

  it('massiv eskalasiya deyil', () => {
    expect(parseEscalation('[{"escalate": true}]')).toBeNull()
  })
})

describe('buildEscalationPrompt', () => {
  it('orijinal taskı və səbəbi daşıyır', () => {
    const p = buildEscalationPrompt('X et', { reason: 'çətindir' })
    expect(p).toContain('X et')
    expect(p).toContain('çətindir')
  })

  it('qismən nəticə varsa daxil edilir — ödənilmiş iş atılmır', () => {
    const p = buildEscalationPrompt('X et', { reason: 'r', partial: 'YARIMÇIQ' })
    expect(p).toContain('YARIMÇIQ')
  })

  it('qismən nəticə yoxdursa bölmə ümumiyyətlə görünmür', () => {
    const p = buildEscalationPrompt('X et', { reason: 'r' })
    expect(p).not.toContain('qismən nəticəsi')
  })

  it('çox uzun qismən nəticə kəsilir', () => {
    const p = buildEscalationPrompt('X', { reason: 'r', partial: 'a'.repeat(10_000) })
    expect(p.length).toBeLessThan(5000)
  })
})

describe('buildSignalContract (Faza 5B)', () => {
  it('heç bir siqnal aktiv deyilsə boş sətir verir', () => {
    expect(buildSignalContract({ escalate: false, ask: false })).toBe('')
  })

  it('yalnız eskalasiya', () => {
    const c = buildSignalContract({ escalate: true, ask: false })
    expect(c).toContain('"escalate"')
    expect(c).not.toContain('"ask"')
  })

  it('yalnız sual', () => {
    const c = buildSignalContract({ escalate: false, ask: true })
    expect(c).toContain('"ask"')
    expect(c).not.toContain('"escalate"')
  })

  it('hər ikisi BİR blokda verilir', () => {
    const c = buildSignalContract({ escalate: true, ask: true })
    expect(c).toContain('"escalate"')
    expect(c).toContain('"ask"')
    // İki ayrı başlıq YOX — ortaq mətn bir dəfə yazılır (qiymət və aydınlıq).
    expect(c.match(/SİQNAL MÜQAVİLƏSİ/g)).toHaveLength(1)
  })

  it('hər iki siqnalla belə 900 simvoldan qısadır', () => {
    // Müqavilə HƏR işçi icrasında ödənilir — uzunluğu daimi vergidir.
    expect(buildSignalContract({ escalate: true, ask: true }).length).toBeLessThan(900)
  })

  it('cavabın TAMI olma şərtini daşıyır — qayda 28/69', () => {
    expect(buildSignalContract({ escalate: true, ask: true })).toContain('cavabın TAMI')
  })
})
