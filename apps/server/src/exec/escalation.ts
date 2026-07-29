import type { RunEvent } from '@orchestris/shared'

/**
 * Pillə 6 — self-escalation.
 *
 * Zəif modelin ən bahalı davranışı "bilmirəm, amma cəhd edirəm"dir: o, minlərlə
 * token yandırır və sonunda səhv cavab verir — həm pul gedir, həm nəticə yoxdur,
 * həm də üstündən başçı yenidən işləməli olur. Müqavilə bu davranışı DAYANDIRIR:
 * model əmin deyilsə cəhd etməyi kəsir və bir sətirlik JSON qaytarır.
 *
 * Bu, Pillə 3-dən (best-of-N) UCUZDUR və ondan ƏVVƏL yoxlanılır: N nüsxə
 * qaçırmaq üçün ən azı N icra lazımdır, eskalasiya isə bir neçə onluq token.
 */

/**
 * İşçinin promptuna əlavə olunan müqavilə.
 *
 * DİQQƏT: bu mətn İSTİFADƏÇİ MESAJINA əlavə olunur, sistem promptuna YOX.
 * CLAUDE.md qayda 1-də ölçülüb: `claude` CLI-nın sistem prompt prefiksini
 * dəyişmək Anthropic prompt-cache-ini sındırır və eyni task 5x bahalaşır.
 * Müqavilə mesajın SONUNA düşür — prefiks toxunulmaz qalır.
 */
export const ESCALATION_CONTRACT = [
  '---',
  'ƏMİNLİK MÜQAVİLƏSİ (məcburi):',
  'Əgər bu taskı əminliklə həll edə bilmirsənsə, cəhd etməyi DAYANDIR və',
  'cavab olaraq YALNIZ bu JSON-u qaytar (başqa heç nə yazma):',
  '{"escalate": true, "reason": "niyə əmin deyilsən", "partial": "əldə etdiyin qismən nəticə (ola bilər boş)"}',
  'Səhv cavab verməkdənsə eskalasiya etmək daha yaxşıdır — task avtomatik',
  'daha güclü modelə ötürüləcək. Həll edə bilirsənsə bu JSON-u YAZMA, sadəcə',
  'taskı normal şəkildə həll et.',
].join('\n')

export interface Escalation {
  reason: string
  /** İşçinin əldə etdiyi qismən nəticə — başçıya ipucu kimi ötürülür. */
  partial?: string
}

/** `text` deltalarını birləşdirir — modelin YAZDIĞI cavab budur. */
export function collectAnswerText(events: readonly RunEvent[]): string {
  let out = ''
  for (const e of events) if (e.t === 'text') out += e.delta
  return out
}

/** ```json ... ``` və ya ``` ... ``` çərçivəsini soyur. */
function stripCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim())
  return fence?.[1]?.trim() ?? text.trim()
}

/**
 * İşçinin cavabında eskalasiya siqnalı varmı?
 *
 * MÜQAVİLƏ QƏSDƏN SƏRTDİR: JSON obyekti cavabın BÜTÜNÜ olmalıdır (ən çoxu bir
 * kod çərçivəsi içində). "Cavabın içində belə bir JSON keçir" qaydası
 * TƏHLÜKƏLİDİR — bu sistemin öz sənədini, testlərini və ya müqavilənin özünü
 * izah edən taskda model həmin JSON-u nümunə kimi sitat gətirir və biz onu
 * "bacarmadım" kimi oxuyub taskı BOŞ YERƏ başçıya (Pillə 7) göndərərdik.
 * Yanlış-müsbət eskalasiya bu layihənin bütün məqsədinin əksidir: nəticə
 * onsuz da hazır idi, üstündən ən bahalı model işlədilir.
 *
 * `escalate` sahəsi MƏHZ `true` olmalıdır: `"true"` mətni və ya `1` qəbul
 * edilmir — model uydurma JSON yazanda bu sahələr təsadüfən doğru dəyər ala
 * bilər.
 */
export function parseEscalation(answer: string): Escalation | null {
  const body = stripCodeFence(answer)
  if (!body.startsWith('{') || !body.endsWith('}')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj['escalate'] !== true) return null

  const reason = typeof obj['reason'] === 'string' ? obj['reason'].trim() : ''
  const partial = typeof obj['partial'] === 'string' ? obj['partial'].trim() : ''

  return {
    // Səbəb yazılmasa da eskalasiya ETİBARLIDIR — `escalate: true` özü siqnaldır.
    // Boş səbəbi "siqnal yoxdur" saysaq, model səhv cavab verməyə məcbur olardı.
    reason: reason === '' ? 'işçi səbəb göstərmədi' : reason,
    ...(partial === '' ? {} : { partial }),
  }
}

/** Modelə geri ötürülən çıxışın limiti — qismən nəticə kontekst şişirtməməlidir. */
const PARTIAL_LIMIT = 4000

/**
 * Başçıya ötürülən prompt.
 *
 * İşçinin qismən nəticəsi QƏSDƏN daxil edilir: o, artıq ödənilmiş işdir və
 * atmaq həmin tokenləri ikinci dəfə — bu dəfə başçının qiymətləri ilə —
 * ödəmək deməkdir. Amma "bu cavabı düzəlt" DEYİLMİR: araşdırma göstərir ki,
 * zəif modelin səhv cavabı güclü modeli həmin səhvə bağlaya bilir (anchoring).
 */
export function buildEscalationPrompt(task: string, escalation: Escalation): string {
  const lines = [
    task,
    '',
    '---',
    'QEYD: bu task əvvəlcə daha zəif modelə verildi və o, həll edə bilmədiyini bildirdi.',
    `Onun göstərdiyi səbəb: ${escalation.reason}`,
  ]
  if (escalation.partial !== undefined) {
    lines.push(
      '',
      'Onun qismən nəticəsi aşağıdadır. Faydalıdırsa istifadə et, faydasızdırsa',
      'tamamilə nəzərə alma — səhv ola bilər.',
      '',
      escalation.partial.slice(0, PARTIAL_LIMIT),
    )
  }
  return lines.join('\n')
}
