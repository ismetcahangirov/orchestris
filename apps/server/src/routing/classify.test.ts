import { describe, expect, it } from 'vitest'
import { classifyTask } from './classify.js'

describe('classifyTask — fayl və kod siqnalları', () => {
  it('fayl yolu göründükdə fayl girişi tələb edir', () => {
    const f = classifyTask({ prompt: 'apps/server/src/app.ts faylını düzəlt' })
    expect(f.needsFileAccess).toBe(true)
    expect(f.taskType).toBe('code')
  })

  it('repoya istinad edildikdə də fayl girişi tələb edir', () => {
    const f = classifyTask({ prompt: 'bu layihədə köhnə importları təmizlə' })
    expect(f.needsFileAccess).toBe(true)
  })

  it('yapışdırılmış kod bloku fayl girişi TƏLƏB ETMİR', () => {
    // İstifadəçi kodu birbaşa verib — modelin fayl oxumasına ehtiyac yoxdur.
    // Bunu qarışdırsaq hər kod sualı bahalı CLI-a düşərdi (~21.7k döşəmə).
    const f = classifyTask({
      prompt: 'Bu funksiyada səhv haradadır?\n```ts\nconst a = 1\n```',
    })
    expect(f.needsFileAccess).toBe(false)
  })

  it('fayl girişi lazım olanda alət də lazımdır', () => {
    const f = classifyTask({ prompt: 'src/main.ts-i yenilə' })
    expect(f.needsToolUse).toBe(true)
  })

  it('cwd-nin mövcudluğu TƏK BAŞINA fayl işi demək deyil', () => {
    // Kontekstin iş qovluğu var deyə "salam" sualını CLI-a göndərmək
    // mənasızdır — siqnal promptdan gəlməlidir.
    const f = classifyTask({ prompt: 'salam, necəsən?', cwd: 'C:/repo' })
    expect(f.needsFileAccess).toBe(false)
  })
})

describe('classifyTask — task tipi', () => {
  it('test yazma tapşırığını test kimi tanıyır', () => {
    expect(classifyTask({ prompt: 'src/parse.ts üçün unit test yaz' }).taskType).toBe('test')
  })

  it('izah tapşırığını explain kimi tanıyır', () => {
    const f = classifyTask({ prompt: 'Event loop necə işləyir, izah et' })
    expect(f.taskType).toBe('explain')
    expect(f.needsFileAccess).toBe(false)
  })

  it('tərcüməni translate kimi tanıyır', () => {
    expect(
      classifyTask({ prompt: 'Bu cümləni ingilis dilinə tərcümə et: salam dünya' }).taskType,
    ).toBe('translate')
  })

  it('xülasəni summarize kimi tanıyır', () => {
    expect(classifyTask({ prompt: 'Aşağıdakı mətni xülasə et: ...' }).taskType).toBe('summarize')
  })

  it('ingiliscə felləri də tanıyır', () => {
    expect(classifyTask({ prompt: 'explain how the parser works' }).taskType).toBe('explain')
    expect(classifyTask({ prompt: 'write tests for utils/date.ts' }).taskType).toBe('test')
  })

  it('qısa ümumi sualı chat sayır', () => {
    expect(classifyTask({ prompt: 'Bakıda hava necədir?' }).taskType).toBe('chat')
  })

  it('heç bir siqnal yoxdursa unknown qaytarır', () => {
    const f = classifyTask({ prompt: 'x'.repeat(600) })
    expect(f.taskType).toBe('unknown')
  })
})

describe('classifyTask — inamlılıq', () => {
  it('güclü siqnalda yüksək inamlılıq verir', () => {
    const f = classifyTask({ prompt: 'apps/web/src/App.tsx faylına yeni route əlavə et' })
    expect(f.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('siqnalsız promptda AŞAĞI inamlılıq verir', () => {
    // Aşağı inamlılıq router-i klassifikatora/default-a yönləndirir —
    // uydurma qərar verməkdənsə "bilmirəm" demək ucuzdur.
    const f = classifyTask({ prompt: 'x'.repeat(600) })
    expect(f.confidence).toBeLessThan(0.5)
  })

  it('inamlılıq həmişə 0..1 aralığındadır', () => {
    const prompts = [
      '',
      'salam',
      'src/a.ts src/b.ts src/c.ts fayllarını düzəlt və test yaz və izah et',
      '```ts\nconst a = 1\n```',
    ]
    for (const prompt of prompts) {
      const f = classifyTask({ prompt })
      expect(f.confidence).toBeGreaterThanOrEqual(0)
      expect(f.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('işlədilən siqnalları sadalayır — UI qərarın səbəbini göstərir', () => {
    const f = classifyTask({ prompt: 'src/a.ts faylını düzəlt' })
    expect(f.signals).toContain('file_path')
    expect(f.signals).toContain('write_verb')
  })
})

describe('classifyTask — sıfır token', () => {
  it('saf funksiyadır: eyni giriş → eyni nəticə', () => {
    const input = { prompt: 'src/a.ts üçün test yaz' }
    expect(classifyTask(input)).toEqual(classifyTask(input))
  })

  it('strukturlaşmış çıxış tələbini JSON sözündən tanıyır', () => {
    const f = classifyTask({ prompt: 'Nəticəni JSON sxemi ilə qaytar' })
    expect(f.needsStructuredOutput).toBe(true)
  })
})
