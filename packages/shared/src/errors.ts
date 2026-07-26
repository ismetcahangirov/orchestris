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

export function isRetryable(cls: ErrorClass): boolean {
  return !NON_RETRYABLE.has(cls)
}

/**
 * Xam CLI xəta mətnini sinfə çevirir. Sıra vacibdir — daha xüsusi
 * naxışlar əvvəl yoxlanılır.
 */
export function classifyErrorText(text: string): ErrorClass {
  const s = text.toLowerCase()
  if (s.includes('401') || s.includes('unauthorized')) return 'auth'
  if (s.includes('not logged in')) return 'auth'
  if (s.includes('403') || s.includes('forbidden')) return 'auth'
  if (s.includes('429') || s.includes('rate limit') || s.includes('rate_limit')) {
    return 'rate_limit'
  }
  if (s.includes('overloaded') || s.includes('529')) return 'overloaded'
  if (s.includes('timed out') || s.includes('timeout')) return 'timeout'
  if (s.includes('permission denied') || s.includes('tool denied')) {
    return 'tool_denied'
  }
  return 'crashed'
}
