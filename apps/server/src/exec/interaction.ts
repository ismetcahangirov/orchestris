import type { QuestionKind } from './ask.js'

export interface AskInput {
  taskId: string
  runId: string
  contextId: string
  /** Hovuz limiti — slot buraxılıb yenidən alınarkən lazımdır. */
  maxParallel: number
  question: string
  kind: QuestionKind
  options: readonly string[]
}

/** Cavab: `yes_no` → boolean, `single` → string, `multi` → string[]. */
export type QuestionAnswer = boolean | string | string[]

export interface QuestionGate {
  /**
   * Sualı yazır və cavabı GÖZLƏYİR.
   *
   * `null` = cavab gəlmədi (ləğv və ya server bağlanır). Nərdivan bu halda
   * DAYANMIR — nəticə olduğu kimi qaytarılır (qayda 32: monoton, bir
   * orkestrasiya qərarının uğursuzluğu istifadəçinin nəticəsini məhv
   * etməməlidir).
   */
  ask(input: AskInput): Promise<QuestionAnswer | null>
}

export interface ReviewQueue {
  /** Tətbiq olunmamış rəyləri götürür və dərhal "tətbiq olunub" işarələyir. */
  drain(taskId: string): string[]
}

/** İstifadəçinin cavabını işçiyə çatdıran prompt. */
export function buildAnswerPrompt(question: string, answer: QuestionAnswer): string {
  const rendered = Array.isArray(answer)
    ? answer.join(', ')
    : typeof answer === 'boolean'
      ? answer
        ? 'bəli'
        : 'xeyr'
      : answer
  return [
    'İSTİFADƏÇİNİN CAVABI:',
    `Sual: ${question}`,
    `Cavab: ${rendered}`,
    'İndi taskı bu cavaba əsasən həll et.',
  ].join('\n')
}

/**
 * Rəyləri işçiyə çatdıran blok.
 *
 * Yaddaşdan (qayda 45) fərqli olaraq ETİBARSIZ çərçivəyə salınmır: bu mətni
 * istifadəçi ÖZÜ yazıb, yəni o, taskın özü qədər etibarlıdır.
 */
export function buildReviewPrompt(reviews: readonly string[]): string {
  if (reviews.length === 0) return ''
  return [
    'İSTİFADƏÇİNİN RƏYİ (məcburi nəzərə al):',
    ...reviews.map((r) => `- ${r}`),
  ].join('\n')
}
