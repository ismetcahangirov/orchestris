import { STEP_OUTPUT_CHAR_LIMIT } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import {
  capOutput,
  evaluateCondition,
  substituteVariables,
  type StepResult,
} from './workflow.js'

function step(over: Partial<StepResult> = {}): StepResult {
  return { stepId: 's', status: 'succeeded', output: 'nəticə', ...over }
}

describe('substituteVariables', () => {
  const ctx = {
    previous: 'ƏVVƏLKİ',
    byStepId: new Map([
      ['a', 'A-NIN NƏTİCƏSİ'],
      ['b', 'B-NİN NƏTİCƏSİ'],
    ]),
  }

  it('`{{previous}}` və `{{step:id}}` əvəzlənir', () => {
    expect(substituteVariables('X {{previous}} Y {{step:a}} Z', ctx)).toBe(
      'X ƏVVƏLKİ Y A-NIN NƏTİCƏSİ Z',
    )
  })

  it('boşluqlu yazılış da tutulur', () => {
    expect(substituteVariables('{{ previous }}', ctx)).toBe('ƏVVƏLKİ')
  })

  it('tanınmayan dəyişən BOŞ sətirlə əvəzlənir, olduğu kimi qalmır', () => {
    // Mətn modelə çatsaydı, model onu təlimat kimi oxuyub uydurma məzmun
    // yazardı — səhv addım id-si səssiz və yanıldıcı nəticə verərdi.
    expect(substituteVariables('[{{step:yoxdur}}]', ctx)).toBe('[]')
  })

  it('əvəzlənən mətnin içindəki dəyişən YENİDƏN emal olunmur', () => {
    // Model çıxışı `{{step:b}}` yaza bilər; ikinci keçid ona başqa addımın
    // nəticəsini oxumaq imkanı verərdi (qayda 45 — model çıxışı etibarsızdır).
    const injected = {
      previous: 'zərərli: {{step:b}}',
      byStepId: new Map([['b', 'GİZLİ']]),
    }
    expect(substituteVariables('{{previous}}', injected)).toBe('zərərli: {{step:b}}')
  })

  it('dəyişən yoxdursa mətn toxunulmaz qalır', () => {
    expect(substituteVariables('adi mətn { } {{}}', ctx)).toBe('adi mətn { } {{}}')
  })
})

describe('evaluateCondition', () => {
  const byStepId = new Map<string, StepResult>([
    ['ok', step({ stepId: 'ok', status: 'succeeded', output: 'HƏR ŞEY QAYDASINDA' })],
    ['bad', step({ stepId: 'bad', status: 'failed', output: '' })],
    ['skip', step({ stepId: 'skip', status: 'skipped', output: '' })],
  ])

  it('`succeeded` və `failed` statusu yoxlayır', () => {
    expect(evaluateCondition({ from: 'ok', test: 'succeeded' }, { previous: undefined, byStepId }).pass).toBe(true)
    expect(evaluateCondition({ from: 'bad', test: 'failed' }, { previous: undefined, byStepId }).pass).toBe(true)
  })

  it('ATLANAN addım `failed` sayılmır', () => {
    // İkisini qarışdırsaq "sınıqda təmir et" budağı heç nə olmadığı halda da
    // işə düşər və təmir taskının pulunu yandırardıq.
    expect(evaluateCondition({ from: 'skip', test: 'failed' }, { previous: undefined, byStepId }).pass).toBe(false)
  })

  it('`budget_exceeded` `failed` sayılır', () => {
    const map = new Map([['b', step({ stepId: 'b', status: 'budget_exceeded' })]])
    expect(evaluateCondition({ from: 'b', test: 'failed' }, { previous: undefined, byStepId: map }).pass).toBe(true)
  })

  it('`contains` hərf böyüklüyünə həssas deyil', () => {
    const c = { from: 'ok', test: 'contains' as const, value: 'qaydasında' }
    expect(evaluateCondition(c, { previous: undefined, byStepId }).pass).toBe(true)
  })

  it('`contains` Azərbaycan nöqtəli/nöqtəsiz `i` cütündə də işləyir', () => {
    // Sadə `toLowerCase()` burada SƏSSİZCƏ sınır: 'QAYDASINDA' → 'qaydasinda'
    // (nöqtəli i), axtarılan 'qaydasında' isə nöqtəsiz `ı` daşıyır.
    const c = { from: 'ok', test: 'contains' as const, value: 'qaydasında' }
    expect(evaluateCondition(c, { previous: undefined, byStepId }).pass).toBe(true)
  })

  it('`contains` `İ`-nin birləşən nöqtəsində də işləyir', () => {
    // 'İSTİFADƏ'.toLowerCase() → 'i' + U+0307 (birləşən nöqtə).
    const map = new Map([['x', step({ stepId: 'x', output: 'İSTİFADƏ OLUNDU' })]])
    const c = { from: 'x', test: 'contains' as const, value: 'istifadə' }
    expect(evaluateCondition(c, { previous: undefined, byStepId: map }).pass).toBe(true)
  })

  it('`contains` ingilis mətnini sındırmır', () => {
    // `toLocaleLowerCase('az')` işlətsəydik `API` → `apı` olar və bu, uyğun
    // gəlməzdi — halbuki model çıxışı çox vaxt ingilis termin daşıyır.
    const map = new Map([['x', step({ stepId: 'x', output: 'API cavab verdi' })]])
    const c = { from: 'x', test: 'contains' as const, value: 'api' }
    expect(evaluateCondition(c, { previous: undefined, byStepId: map }).pass).toBe(true)
  })

  it('`empty` boş çıxışı tutur', () => {
    expect(evaluateCondition({ from: 'bad', test: 'empty' }, { previous: undefined, byStepId }).pass).toBe(true)
    expect(evaluateCondition({ from: 'ok', test: 'empty' }, { previous: undefined, byStepId }).pass).toBe(false)
  })

  it('`negate` şərti tərsinə çevirir', () => {
    const c = { from: 'ok', test: 'succeeded' as const, negate: true }
    expect(evaluateCondition(c, { previous: undefined, byStepId }).pass).toBe(false)
  })

  it('`previous` son icra olunmuş addıma baxır', () => {
    const previous = step({ stepId: 'p', status: 'failed' })
    expect(evaluateCondition({ from: 'previous', test: 'failed' }, { previous, byStepId }).pass).toBe(true)
  })

  it('istinad olunan addım tapılmasa `false` — şərt SƏSSİZCƏ ödənmir', () => {
    // `true` saysaydıq, səhv yazılmış id budaqlanmanı tamamilə söndürərdi və
    // zəncir hər addımı qaçırardı.
    const verdict = evaluateCondition(
      { from: 'yoxdur', test: 'succeeded' },
      { previous: undefined, byStepId },
    )
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('tapılmadı')
  })

  it('`contains` dəyərsiz verilsə ödənmir', () => {
    expect(evaluateCondition({ from: 'ok', test: 'contains' }, { previous: undefined, byStepId }).pass).toBe(false)
  })
})

describe('capOutput', () => {
  it('həddə qədər mətn toxunulmaz qalır', () => {
    expect(capOutput('qısa')).toEqual({ output: 'qısa', truncated: false })
  })

  it('uzun mətn KƏSİLİR və işarələnir — rədd edilmir', () => {
    // Şablonun əksi (qayda 39): şablon GÖSTƏRİŞDİR, addım çıxışı isə MƏLUMATDIR
    // — az fayda verir, yanlış göstəriş vermir. Tam mətn taskın jurnalında qalır.
    const long = 'x'.repeat(STEP_OUTPUT_CHAR_LIMIT + 10)
    const capped = capOutput(long)
    expect(capped.truncated).toBe(true)
    expect(capped.output.length).toBe(STEP_OUTPUT_CHAR_LIMIT + 1)
  })
})
