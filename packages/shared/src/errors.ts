export const ERROR_CLASSES = [
  'auth',
  'rate_limit',
  'overloaded',
  'budget_exceeded',
  'timeout',
  'tool_denied',
  'crashed',
  'parse_error',
] as const

export type ErrorClass = (typeof ERROR_CLASSES)[number]

/**
 * Təkrar edilə BİLMƏYƏN siniflər. `auth` insan müdaxiləsi tələb edir;
 * `budget_exceeded` sərt kəsimdir və təkrar cəhd onun mənasını pozardı;
 * `tool_denied` istifadəçi qərarıdır; `parse_error` deterministdir.
 */
const NON_RETRYABLE = new Set<ErrorClass>([
  'auth',
  'budget_exceeded',
  'tool_denied',
  'parse_error',
])

/**
 * "Təkrar cəhd KÖMƏK EDƏ BİLƏRmi" sualına cavab verir — "indi təkrar et"
 * demir. Cəhdlərin sayını bu funksiya məhdudlaşdırmır; onu çağıran
 * (RunSupervisor) məhdudlaşdırmalıdır. `crashed` təkrarlanabiləndir, çünki
 * proses ölümü keçici ola bilər — amma sonsuz dövrə düşməmək çağıranın
 * məsuliyyətidir.
 */
export function isRetryable(cls: ErrorClass): boolean {
  return !NON_RETRYABLE.has(cls)
}

/**
 * Xam CLI xəta mətnini sinfə çevirir.
 *
 * SIRA VACİBDİR və status kodları SÖZ SƏRHƏDİ (`\b`) ilə yoxlanılır.
 *
 * SƏBƏB (real mesajla təsdiqlənib): CLI xətaları `cf-ray: a2140175bd9ce8ee`
 * kimi hex ID-lər və UUID request-id-lər daşıyır. Onların içində təsadüfən
 * "401" ardıcıllığı olur — `includes('401')` işlətsək, təkrarlanabilən
 * rate-limit xətası təkrarsız `auth` kimi təsnif olunur və istifadəçiyə
 * səhvən "yenidən login ol" deyilir.
 *
 * Həmçinin rate-limit və overload yoxlamaları auth-dan ƏVVƏL gəlir: mesajda
 * həm real 429, həm də hex içində təsadüfi "401" varsa, 429 həqiqi siqnaldır.
 */
export function classifyErrorText(text: string): ErrorClass {
  const s = text.toLowerCase()

  if (
    /\b429\b/.test(s) ||
    s.includes('rate limit') ||
    s.includes('rate_limit') ||
    s.includes('too many requests') ||
    s.includes('usage limit')
  ) {
    return 'rate_limit'
  }

  if (/\b529\b/.test(s) || s.includes('overloaded')) return 'overloaded'

  // Spesifik auth mesajları status kodundan əvvəl — daha etibarlı siqnaldır.
  if (
    s.includes('not logged in') ||
    s.includes('invalid api key') ||
    s.includes('authentication') ||
    s.includes('unauthorized') ||
    s.includes('forbidden')
  ) {
    return 'auth'
  }

  if (s.includes('timed out') || s.includes('timeout')) return 'timeout'
  if (s.includes('permission denied') || s.includes('tool denied')) {
    return 'tool_denied'
  }

  // Çılpaq status kodu ƏN SONDA — söz sərhədi hex ID-ləri kəssə də, adi
  // rəqəmləri kəsmir: `'Request timed out after 401 seconds'` mesajında
  // `\b401\b` UYĞUN GƏLİR (müddətdir, status kodu deyil). Ona görə bütün
  // spesifik mətn siqnalları — o cümlədən timeout — bundan əvvəl yoxlanılır.
  if (/\b401\b/.test(s) || /\b403\b/.test(s)) return 'auth'

  return 'crashed'
}
