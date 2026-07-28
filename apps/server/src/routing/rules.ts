import type { TaskFeatures } from './classify.js'

/**
 * Pillə 1 qaydaları — SIFIR token.
 *
 * "Ən ucuz qərar qaydadır." Hər qayda ölçülmüş fakta əsaslanır, zövqə yox:
 *
 * | Ölçülmüş (Faza 1A) | Nəticə |
 * |---|---|
 * | `claude` CLI çağırışı ~21.7k token döşəməsi daşıyır | qısa mətn üçün baha |
 * | API çağırışının döşəməsi ~0-dır | fayl aləti yoxdur |
 *
 * Buradan iki istiqamət çıxır: **alət lazımdırsa CLI**, **lazım deyilsə API**.
 * Döşəmə uzun fayl sessiyasında amortizasiya olunur; bir cümlə tərcüməsində yox.
 */
export interface RoutingRule {
  id: string
  /** UI-da göstərilir — istifadəçi qərarın niyəsini görməlidir. */
  description: string
  /** Uyğun gəldikdə hansı runner növü üstün tutulur. */
  prefer: 'cli' | 'api'
  matches(f: TaskFeatures): boolean
}

/** Bundan uzun mətn taskı artıq "qısa" deyil — döşəmə nisbətən kiçilir. */
const SHORT_TEXT_MAX_CHARS = 8000

const TEXT_TYPES = new Set(['explain', 'translate', 'summarize', 'chat'])

/**
 * SIRA ƏHƏMİYYƏTLİDİR — ilk uyğun gələn qayda qazanır. Fayl qaydası birincidir,
 * çünki o, seçim deyil MƏCBURİYYƏTdir: alətsiz runner fayl taskını edə bilmir.
 */
export const BUILTIN_RULES: readonly RoutingRule[] = [
  {
    id: 'file-work-to-cli',
    description:
      'Fayl yolu və ya repo istinadı var → CLI (alət lazımdır; ~21.7k token döşəməsi uzun sessiyada amortizasiya olunur)',
    prefer: 'cli',
    matches: (f) => f.needsFileAccess,
  },
  {
    id: 'pasted-code-to-api',
    description:
      'Kod promptun İÇİNDƏDİR, fayl lazım deyil → API (alət lazım deyil, döşəmə ödəmək mənasızdır)',
    prefer: 'api',
    matches: (f) =>
      !f.needsFileAccess &&
      (f.taskType === 'code' || f.taskType === 'test') &&
      f.signals.includes('code_fence'),
  },
  {
    id: 'short-text-to-api',
    description:
      'Qısa mətn/analiz taskı (izah, tərcümə, xülasə, söhbət) → API (~21.7k döşəmə ödəmək mənasızdır)',
    prefer: 'api',
    matches: (f) =>
      !f.needsFileAccess &&
      TEXT_TYPES.has(f.taskType) &&
      f.promptChars <= SHORT_TEXT_MAX_CHARS,
  },
]

/** İlk uyğun gələn qayda. Heç biri uyğun gəlmirsə `undefined` — bu, dürüst "bilmirəm"dir. */
export function matchRule(
  features: TaskFeatures,
  rules: readonly RoutingRule[] = BUILTIN_RULES,
): RoutingRule | undefined {
  return rules.find((r) => r.matches(features))
}
