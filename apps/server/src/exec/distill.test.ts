import { describe, expect, it } from 'vitest'
import {
  buildDistillRequestPrompt,
  buildTemplatedPrompt,
  DISTILL_MIN_ASSISTED_TASKS,
  DISTILL_RUNG,
  parseTemplate,
  shouldDistill,
  TEMPLATE_CHAR_LIMIT,
  templateId,
} from './distill.js'

const TEMPLATE = {
  workerPrompt: '- əvvəlcə tipləri oxu\n- sonra funksiyanı yaz',
  rubric: '- kod kompilyasiya olunur\n- testlər keçir',
}

/** Başçının müqaviləyə əməl edən cavabı. */
function bossAnswer(worker = 'ADDIMLAR', rubric = 'ŞƏRTLƏR'): string {
  return `### İŞÇİ PROMPTU\n${worker}\n\n### RUBRİKA\n${rubric}\n`
}

describe('buildDistillRequestPrompt — başçıdan istənən şablon', () => {
  it('nümunə taskı daşıyır, amma HƏLLİNİ istəmir', () => {
    const prompt = buildDistillRequestPrompt({
      taskType: 'code',
      examplePrompt: 'src/a.ts-dəki xətanı düzəlt',
      reason: 'kontekst çatmadı',
    })

    expect(prompt).toContain('src/a.ts-dəki xətanı düzəlt')
    expect(prompt).toContain('HƏLL ETMƏ')
    expect(prompt).toContain('HƏLLİ İSTƏNMİR')
  })

  it('nümunəyə XAS heç nə yazılmamasını tələb edir', () => {
    // Şablon bir taska yox, TİPƏ aiddir: nümunənin fayl adı ora düşsə, növbəti
    // 500 taskda yanıldıcı olardı.
    const prompt = buildDistillRequestPrompt({
      taskType: 'code',
      examplePrompt: 'task',
      reason: 'səbəb',
    })

    expect(prompt).toContain('bu nümunəyə xas heç nə yazma')
  })

  it('hər iki başlığı adı ilə istəyir — parse məhz onlara baxır', () => {
    const prompt = buildDistillRequestPrompt({
      taskType: 'test',
      examplePrompt: 'task',
      reason: 'səbəb',
    })

    expect(prompt).toContain('### İŞÇİ PROMPTU')
    expect(prompt).toContain('### RUBRİKA')
  })
})

describe('parseTemplate — başçının cavabı şablona çevrilir', () => {
  it('iki bölməni ayırır', () => {
    expect(parseTemplate(bossAnswer('A', 'B'))).toEqual({
      workerPrompt: 'A',
      rubric: 'B',
    })
  })

  it('kod çərçivəsi içindəki cavabı da qəbul edir', () => {
    const answer = '```\n' + bossAnswer('A', 'B') + '```'

    expect(parseTemplate(answer)).toEqual({ workerPrompt: 'A', rubric: 'B' })
  })

  it('başlıq çatışmırsa HEÇ NƏ saxlanılmır', () => {
    // Sərt parse qəsdəndir: səhv şablon bir taska deyil, BÜTÜN gələcək
    // tasklara yapışardı.
    expect(parseTemplate('sadəcə mətn')).toBeNull()
    expect(parseTemplate('### İŞÇİ PROMPTU\nA')).toBeNull()
    expect(parseTemplate('### RUBRİKA\nB')).toBeNull()
  })

  it('bölmələr TƏRS sırada gəlibsə rədd edilir', () => {
    expect(parseTemplate('### RUBRİKA\nB\n### İŞÇİ PROMPTU\nA')).toBeNull()
  })

  it('boş bölmə rədd edilir', () => {
    expect(parseTemplate('### İŞÇİ PROMPTU\n\n### RUBRİKA\nB')).toBeNull()
  })

  it('HƏDDƏN UZUN şablon KƏSİLMİR, RƏDD edilir', () => {
    // Şablon hər gələcək icrada giriş tokeni kimi ödənilir — yəni bir dəfəlik
    // xərci DAİMİ vergiyə çevirir. Yarımçıq kəsilmiş təlimat isə yanıldıcıdır
    // və o da sonsuz dəfə oxunardı.
    const long = 'x'.repeat(TEMPLATE_CHAR_LIMIT + 1)

    expect(parseTemplate(bossAnswer(long, 'B'))).toBeNull()
  })
})

describe('templateId — məzmun hash-i', () => {
  it('eyni məzmun eyni id verir', () => {
    expect(templateId(TEMPLATE)).toBe(templateId({ ...TEMPLATE }))
  })

  it('mətn dəyişəndə id DƏYİŞİR — keş açarı bundan asılıdır', () => {
    expect(templateId(TEMPLATE)).not.toBe(
      templateId({ ...TEMPLATE, rubric: 'başqa rubrika' }),
    )
  })
})

describe('buildTemplatedPrompt — işçiyə verilən şablonlu prompt', () => {
  it('task mətnini ƏVVƏLDƏ saxlayır — prefiks toxunulmazdır', () => {
    // CLAUDE.md qayda 29: prefiksin dəyişməsi Anthropic prompt-keşini sındırır
    // və eyni taskı 5x bahalaşdırır.
    const prompt = buildTemplatedPrompt('TASK MƏTNİ', TEMPLATE)

    expect(prompt.startsWith('TASK MƏTNİ')).toBe(true)
  })

  it('həm iş üsulunu, həm rubrikanı daşıyır', () => {
    const prompt = buildTemplatedPrompt('TASK', TEMPLATE)

    expect(prompt).toContain('əvvəlcə tipləri oxu')
    expect(prompt).toContain('testlər keçir')
  })
})

describe('shouldDistill — qapı (0 token)', () => {
  const gate = {
    profile: 'balanced',
    taskType: 'code',
    hasTemplate: false,
    assistedTasks: DISTILL_MIN_ASSISTED_TASKS,
  }

  it('təkrarlanan tipdə şablon yazılır', () => {
    expect(shouldDistill(gate).distill).toBe(true)
  })

  it('tip BİR dəfə ilişibsə yazılmır — bir dəfəlik task ola bilər', () => {
    expect(shouldDistill({ ...gate, assistedTasks: 1 }).distill).toBe(false)
  })

  it('şablon artıq varsa təkrar yazılmır', () => {
    expect(shouldDistill({ ...gate, hasTemplate: true }).distill).toBe(false)
  })

  it('`unknown` tipə şablon yazılmır — hər taska yapışardı', () => {
    expect(shouldDistill({ ...gate, taskType: 'unknown' }).distill).toBe(false)
  })

  it('`boss-only` profilində yazılmır — baseline ölçməsi korlanmamalıdır', () => {
    // Qayda 25: o profil "başçı təkbaşına nə qədər xərcləyir" sualının REAL
    // cavabıdır. Ora əlavə icra qatsaq proqnoz/real müqayisəsi mənasız olar.
    expect(shouldDistill({ ...gate, profile: 'boss-only' }).distill).toBe(false)
  })

  it('hər rədd cavabı SƏBƏB daşıyır', () => {
    expect(shouldDistill({ ...gate, assistedTasks: 0 }).reason).toContain('0')
  })
})

describe('DISTILL_RUNG', () => {
  it('nərdivandan KƏNARDIR (mənfi) — 7 sayılsaydı iki ölçmə yalan danışardı', () => {
    // "Taskların <20%-i 7-yə çatsın" hədəfi (qayda 31) distillə icralarını tam
    // başçı icrası kimi sayardı; `byRung` isə investisiyanı taskın həll
    // xərcinin içində gizlədərdi.
    expect(DISTILL_RUNG).toBeLessThan(0)
  })
})
