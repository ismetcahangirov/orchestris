/**
 * Faza 5B — işçinin İSTİFADƏÇİYƏ sualı.
 *
 * Eskalasiya (Pillə 6) ilə eyni sinifdəndir: hər ikisi "dayan və siqnal ver"
 * deməkdir. Fərq odur ki, eskalasiya taskı BAŞÇIYA ötürür, sual isə
 * İSTİFADƏÇİDƏN məlumat istəyir — və bu, qat-qat ucuzdur: başçının tam icrası
 * əvəzinə bir cümlə.
 */

export const QUESTION_KINDS = ['yes_no', 'single', 'multi'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/**
 * Sual mətninin həddi.
 *
 * KƏSMƏ YOX, RƏDD (qayda 39/52 prinsipi): yarımçıq kəsilmiş sual istifadəçini
 * yanıldar və o, səhv cavab verib pulu İKİ dəfə yandırar — bir dəfə səhv işə,
 * bir dəfə düzəlişə. Rədd halında isə mexanizm sadəcə geri çəkilir və cavab
 * adi mətn kimi qəbul edilir.
 */
export const QUESTION_CHAR_LIMIT = 500

/**
 * Variantların sayı.
 *
 * Checkbox siyahısı ekranda oxunaqlı qalmalıdır; 8-dən çox variant o deməkdir
 * ki, model sual vermir, siyahı sadalayır.
 */
export const MAX_QUESTION_OPTIONS = 8

export interface AskRequest {
  question: string
  kind: QuestionKind
  /** `yes_no`-da həmişə boş. */
  options: string[]
}

/** ```json ... ``` və ya ``` ... ``` çərçivəsini soyur. */
function stripCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim())
  return fence?.[1]?.trim() ?? text.trim()
}

function isKind(v: unknown): v is QuestionKind {
  return typeof v === 'string' && (QUESTION_KINDS as readonly string[]).includes(v)
}

/**
 * İşçinin cavabında sual siqnalı varmı?
 *
 * MÜQAVİLƏ QƏSDƏN SƏRTDİR: JSON obyekti cavabın BÜTÜNÜ olmalıdır (ən çoxu bir
 * kod çərçivəsi içində). "Cavabın içində belə bir JSON keçir" qaydası burada
 * eskalasiyadakından da (qayda 28) TƏHLÜKƏLİDİR: bu sistemin öz sənədini və ya
 * müqaviləsini izah edən HƏR task nümunəni sitat gətirər və biz onu sual sayıb
 * taskı ƏBƏDİ gözləmə vəziyyətinə salardıq — istifadəçi isə heç vaxt cavab
 * verməyəcəyi bir suala baxardı. Yanlış-müsbət eskalasiya bahalı icra doğurur;
 * yanlış-müsbət sual taskı DONDURUR.
 */
export function parseAsk(answer: string): AskRequest | null {
  const body = stripCodeFence(answer)
  if (!body.startsWith('{') || !body.endsWith('}')) return null

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null

  const ask = (raw as { ask?: unknown }).ask
  if (typeof ask !== 'object' || ask === null || Array.isArray(ask)) return null

  const { question, kind, options } = ask as {
    question?: unknown
    kind?: unknown
    options?: unknown
  }

  if (typeof question !== 'string' || question.trim() === '') return null
  if (question.length > QUESTION_CHAR_LIMIT) return null
  if (!isKind(kind)) return null

  const list: unknown = options === undefined ? [] : options
  if (!Array.isArray(list)) return null
  if (!list.every((o): o is string => typeof o === 'string' && o.trim() !== '')) return null
  if (list.length > MAX_QUESTION_OPTIONS) return null

  // `yes_no` variant DAŞIMIR: variant verilibsə model iki fərqli forma
  // qarışdırıb və nə istədiyi bilinmir — təxmin etmək səhv sual göstərməkdir.
  if (kind === 'yes_no' && list.length > 0) return null
  // Tək variantlı seçim seçim deyil.
  if (kind !== 'yes_no' && list.length < 2) return null

  return { question: question.trim(), kind, options: list }
}

/**
 * Cavabın sualın FORMASINA uyğunluğu.
 *
 * Zod sxemində EDİLƏ BİLMƏZ: `kind` yalnız serverdə, DB sətrində bilinir.
 * Klientdən `kind` istəsəydik o, uyğunsuz dəyər göndərə bilərdi və yoxlama
 * özü-özünü yoxlayardı.
 */
export function answerProblem(
  kind: string,
  options: readonly string[],
  answer: unknown,
): string | null {
  if (kind === 'yes_no') {
    return typeof answer === 'boolean' ? null : 'Bəli/xeyr sualı boolean cavab gözləyir'
  }
  if (kind === 'single') {
    if (typeof answer !== 'string') return 'Təkseçimli sual bir variant gözləyir'
    return options.includes(answer) ? null : `Tanınmayan variant: ${answer}`
  }
  if (kind === 'multi') {
    if (!Array.isArray(answer)) return 'Çoxseçimli sual massiv gözləyir'
    if (answer.length === 0) return 'Ən azı bir variant seçilməlidir'
    const bad = answer.find((a) => typeof a !== 'string' || !options.includes(a))
    return bad === undefined ? null : `Tanınmayan variant: ${String(bad)}`
  }
  return `Tanınmayan sual növü: ${kind}`
}
