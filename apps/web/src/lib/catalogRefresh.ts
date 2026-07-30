import type { ProvidersResponse } from './api.js'

/** `GET /api/providers` cavabındakı kataloq vəziyyəti — həqiqət mənbəyi. */
export type CatalogInfo = ProvidersResponse['catalog']

export type RefreshVerdict =
  | { kind: 'refreshed'; fetchedAt?: number }
  | { kind: 'failed'; reason: string }

export interface RefreshVerdictInput {
  /** Klientin `fetch`-i sındısa səbəb; `null` = server "oldu" dedi. */
  requestError: string | null
  /** Düyməyə basılmazdan ƏVVƏLKİ kataloq. */
  before: CatalogInfo | undefined
  /** Sorğudan SONRA yenidən oxunmuş kataloq. */
  after: CatalogInfo | undefined
}

/**
 * Xətadan istifadəçiyə göstərilə bilən səbəb çıxarır.
 *
 * `request` mətni `"502 <url>: <gövdə>"` kimi qurur, gövdə isə serverin JSON
 * cavabıdır (`{"ok":false,"error":"…"}`). Xam JSON-u ekrana yazmaq səbəbi
 * gizlətməklə eynidir — istifadəçi onu oxumur.
 */
export function refreshErrorReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const bodyStart = text.indexOf('{')
  if (bodyStart === -1) return text
  try {
    const body: unknown = JSON.parse(text.slice(bodyStart))
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const reason = (body as { error: unknown }).error
      if (typeof reason === 'string' && reason !== '') return reason
    }
  } catch {
    // JSON deyil — mətn olduğu kimi qalır.
  }
  return text
}

/** Kataloq irəlilədimi — `bundled` → `cache` keçidi də irəliləmədir. */
function advanced(before: CatalogInfo | undefined, after: CatalogInfo | undefined): boolean {
  if (after === undefined || after.source !== 'cache') return false
  if (before === undefined || before.source !== 'cache') return true
  return (after.fetchedAt ?? 0) > (before.fetchedAt ?? 0)
}

/**
 * "Kataloq yeniləndi?" sualına cavab — klientin `fetch`-inə DEYİL, serverin
 * kataloq vəziyyətinə əsasən (issue #46).
 *
 * Səbəb ölçülmüşdür: `POST /api/registry/refresh` 3 MB yükləyir və işi sona
 * çatdırır, klient tərəfdəki sorğu isə kəsilə bilir. Yalnız `mutation.isError`
 * üzərində qurulmuş mesaj həmin halda YALAN danışır — iş görülüb, istifadəçiyə
 * "sındı" deyilir və o, düyməyə bir daha basır.
 *
 * Ona görə iki müstəqil siqnal birləşdirilir:
 *  - server "oldu" dedi → yeniləndi (sual yoxdur)
 *  - server cavabı gəlməyib, AMMA kataloqun `fetchedAt`-ı irəliləyib →
 *    yeniləndi (iş görülüb, sadəcə cavabı eşitməmişik)
 *  - heç biri → uğursuz, VƏ səbəb göstərilir (əvvəl gizli qalırdı)
 */
export function catalogRefreshVerdict(input: RefreshVerdictInput): RefreshVerdict {
  if (input.requestError === null) {
    return input.after?.fetchedAt !== undefined
      ? { kind: 'refreshed', fetchedAt: input.after.fetchedAt }
      : { kind: 'refreshed' }
  }

  if (advanced(input.before, input.after)) {
    return input.after?.fetchedAt !== undefined
      ? { kind: 'refreshed', fetchedAt: input.after.fetchedAt }
      : { kind: 'refreshed' }
  }

  return { kind: 'failed', reason: input.requestError }
}
