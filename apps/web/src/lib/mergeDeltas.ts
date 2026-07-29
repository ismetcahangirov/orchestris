import type { StoredEventRow } from './api.js'

/**
 * Ardıcıl `text`/`think` deltalarını bir sətirdə birləşdirir.
 *
 * `--include-partial-messages` ilə cavab onlarla parça hadisə şəklində gəlir
 * (ölçülmüş: bir cümlə = 2 delta). Hər parçaya bir sətir versək, tək cavab
 * ekranı doldurar və oxunmaz olardı. Birləşdirmə YALNIZ göstərişdədir —
 * jurnal hadisələri olduğu kimi qalır.
 *
 * `seq` kimi qrupun BİRİNCİ hadisəsininki saxlanılır: sıralama və React
 * açarı sabit qalsın.
 */
export function mergeDeltas(rows: readonly StoredEventRow[]): StoredEventRow[] {
  const out: StoredEventRow[] = []
  for (const row of rows) {
    const cur = row.event
    const last = out[out.length - 1]
    const prev = last?.event
    if (
      last !== undefined &&
      (cur.t === 'text' || cur.t === 'think') &&
      (prev?.t === 'text' || prev?.t === 'think') &&
      prev.t === cur.t
    ) {
      out[out.length - 1] = {
        ...last,
        event: { t: cur.t, delta: prev.delta + cur.delta },
      }
      continue
    }
    out.push(row)
  }
  return out
}
