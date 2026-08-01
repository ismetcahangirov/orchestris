import { describe, expect, it } from 'vitest'
import type { ContextRow } from './api.js'
import { parseBudgetForm, summarizeBudget } from './budgetLabel.js'

const ctx = (over: Partial<ContextRow>): ContextRow =>
  ({
    id: 'c1',
    name: 'C',
    cwd: null,
    amplificationProfile: 'balanced',
    workerMode: 'auto',
    autoSubmode: 'cheap',
    verifyCommandsJson: '[]',
    maxParallel: 0,
    budgetTokens: null,
    budgetUsd: null,
    budgetSeconds: null,
    memoryScope: null,
    memoryEnabled: true,
    questionsEnabled: true,
    builtinSkillsEnabled: true,
    fileAccess: 'workspace',
    extraDirsJson: '[]',
    createdAt: 0,
    ...over,
  }) as ContextRow

describe('summarizeBudget', () => {
  it('heç bir limit yoxdursa "limitsiz" deyir', () => {
    const s = summarizeBudget(ctx({}))
    expect(s.unlimited).toBe(true)
    expect(s.text).toBe('limitsiz')
  })

  it('vaxtı "icra başına" kimi işarələyir', () => {
    // Task başına saysaydıq, istifadəçi altı parçalı taskın bir saatda
    // bitəcəyini zənn edərdi — halbuki limit hər icraya AYRICA tətbiq olunur.
    const s = summarizeBudget(ctx({ budgetTokens: 200_000, budgetSeconds: 3600 }))
    expect(s.text).toContain('icra başına 1 saat')
    expect(s.unlimited).toBe(false)
  })

  it('dəqiqə və saniyə də oxunaqlı yazılır', () => {
    expect(summarizeBudget(ctx({ budgetSeconds: 600 })).text).toContain('10 dəq')
    expect(summarizeBudget(ctx({ budgetSeconds: 90 })).text).toContain('90 s')
  })

  it('sahə ÜMUMİYYƏTLƏ gəlməsə çökmür', () => {
    // Köhnə server (və ya köhnə keşlənmiş cavab) bu sahələri göndərməyə bilər.
    // `undefined.toLocaleString()` bütün səhifəni ağ ekrana çevirərdi.
    const partial = { id: 'c1', name: 'C' } as unknown as ContextRow
    expect(summarizeBudget(partial).unlimited).toBe(true)
  })
})

describe('parseBudgetForm', () => {
  it('boş sahə `null`-dır — "limitsiz"', () => {
    const r = parseBudgetForm({ tokens: '', usd: '  ', minutes: '' })
    expect(r).toEqual({
      patch: { budgetTokens: null, budgetUsd: null, budgetSeconds: null },
    })
  })

  it('dəqiqəni saniyəyə çevirir', () => {
    const r = parseBudgetForm({ tokens: '200000', usd: '', minutes: '60' })
    expect('patch' in r && r.patch.budgetSeconds).toBe(3600)
  })

  it('`0` və mənfi rədd edilir', () => {
    // `0` "limitsiz" demək olsaydı, "sıfır token" ilə "limit yoxdur" eyni
    // dəyərlə ifadə olunardı — biri hər icranı kəsər, digəri heç birini.
    expect('error' in parseBudgetForm({ tokens: '0', usd: '', minutes: '' })).toBe(true)
    expect('error' in parseBudgetForm({ tokens: '-5', usd: '', minutes: '' })).toBe(true)
  })

  it('token limiti kəsr ola bilməz', () => {
    expect('error' in parseBudgetForm({ tokens: '1.5', usd: '', minutes: '' })).toBe(true)
  })

  it('rəqəm olmayan mətn səbəbi ilə rədd edilir', () => {
    const r = parseBudgetForm({ tokens: 'çox', usd: '', minutes: '' })
    expect('error' in r && r.error).toContain('müsbət ədəd')
  })
})
