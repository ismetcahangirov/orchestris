import { describe, expect, it } from 'vitest'
import {
  buildPlannedPrompt,
  buildPlanRequestPrompt,
  detectMultiStep,
  PLAN_CHAR_LIMIT,
} from './plan.js'

describe('detectMultiStep', () => {
  it('nömrələnmiş siyahını çoxaddımlı sayır', () => {
    const shape = detectMultiStep(
      ['Bunları et:', '1. sxemi dəyiş', '2. migrasiya yarat', '3. testləri yenilə'].join('\n'),
    )

    expect(shape.multiStep).toBe(true)
    expect(shape.signals).toContain('list_items:3')
  })

  it('tire ilə yazılmış siyahını da tutur', () => {
    const shape = detectMultiStep(['- birini sil', '- ikincini yaz', '- üçüncünü yoxla'].join('\n'))

    expect(shape.multiStep).toBe(true)
  })

  it('iki bənd hələ plan deyil — "a və b" cümləsidir', () => {
    const shape = detectMultiStep(['1. birini sil', '2. ikincini yaz'].join('\n'))

    expect(shape.multiStep).toBe(false)
  })

  it('sətir ORTASINDAKI nöqtəli rəqəm siyahı sayılmır', () => {
    // `v1.2` və `10 - 3` kimi mətnlər hər taskı çoxaddımlı göstərərdi.
    const shape = detectMultiStep('v1.2 ilə v2.3 arasındakı 10 - 3 fərqini izah et')

    expect(shape.multiStep).toBe(false)
  })

  it('iki fərqli sıra sözü çoxaddımlı siqnaldır', () => {
    const shape = detectMultiStep('Əvvəlcə sxemi dəyiş, sonra migrasiya yarat')

    expect(shape.multiStep).toBe(true)
    expect(shape.signals).toEqual(['seq:first', 'seq:then'])
  })

  it('tək sıra sözü kifayət etmir — təsadüf ola bilər', () => {
    const shape = detectMultiStep('Bu funksiyanı üç gün sonra silmək lazımdır, qeyd əlavə et')

    expect(shape.multiStep).toBe(false)
  })

  it('eyni sözün təkrarı yeni siqnal saymır', () => {
    const shape = detectMultiStep('sonra bunu yaz, sonra onu yaz, sonra da o birini yaz')

    expect(shape.multiStep).toBe(false)
  })

  it('şəkilçili formaları tutur — `\\b` Azərbaycan dilində işləmir (qayda 20)', () => {
    const shape = detectMultiStep('Birinci addımda faylı oxu, sonrakı addımda yaz')

    expect(shape.multiStep).toBe(true)
  })

  it('ingiliscə sıra sözlərini tutur', () => {
    const shape = detectMultiStep('First read the file, then rewrite the failing test')

    expect(shape.multiStep).toBe(true)
  })

  it('adi təkaddımlı task çoxaddımlı deyil', () => {
    expect(detectMultiStep('Bu cümləni tərcümə et: salam').multiStep).toBe(false)
  })

  it('boş prompt çoxaddımlı deyil', () => {
    expect(detectMultiStep('').multiStep).toBe(false)
  })
})

describe('buildPlanRequestPrompt', () => {
  it('başçıdan TAM həll deyil, plan və skelet istəyir', () => {
    const prompt = buildPlanRequestPrompt({ task: 'TASK', reason: 'çətindir' })

    expect(prompt).toContain('TASK')
    expect(prompt).toContain('çətindir')
    expect(prompt).toContain('TAM HƏLL İSTƏNMİR')
    expect(prompt).toContain('GÖVDƏLƏRİ BOŞ saxla')
  })

  it('qismən nəticə ötürülür, amma "bunu düzəlt" deyilmir — anchoring riski', () => {
    const prompt = buildPlanRequestPrompt({
      task: 'TASK',
      reason: 'r',
      partial: 'YARIMÇIQ',
    })

    expect(prompt).toContain('YARIMÇIQ')
    expect(prompt).toContain('faydasızdırsa')
  })

  it('boş qismən nəticə üçün bölmə əlavə edilmir', () => {
    const prompt = buildPlanRequestPrompt({ task: 'TASK', reason: 'r', partial: '   ' })

    expect(prompt).not.toContain('qismən nəticəsi')
  })

  it('uzun qismən nəticə kəsilir', () => {
    const prompt = buildPlanRequestPrompt({
      task: 'T',
      reason: 'r',
      partial: 'x'.repeat(PLAN_CHAR_LIMIT + 500),
    })

    expect(prompt).not.toContain('x'.repeat(PLAN_CHAR_LIMIT + 1))
  })
})

describe('buildPlannedPrompt', () => {
  it('task mətni DƏYİŞMİR — plan suffiks kimi gedir (qayda 29)', () => {
    const prompt = buildPlannedPrompt('TASK', '1. bunu et')

    expect(prompt.startsWith('TASK')).toBe(true)
    expect(prompt).toContain('1. bunu et')
    expect(prompt).toContain('PLAN')
  })

  it('həddindən uzun plan kəsilir — işçinin konteksti qorunur', () => {
    const prompt = buildPlannedPrompt('TASK', 'y'.repeat(PLAN_CHAR_LIMIT + 100))

    expect(prompt).toContain('…')
    expect(prompt).not.toContain('y'.repeat(PLAN_CHAR_LIMIT + 1))
  })
})
