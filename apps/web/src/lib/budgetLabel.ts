import type { ContextRow } from './api.js'

export interface BudgetSummary {
  /** İnsana göstərilən sətir. */
  text: string
  /** Heç bir limit yoxdursa `true` — UI onu fərqli rəngləyir. */
  unlimited: boolean
}

/**
 * Kontekstin büdcəsini bir sətirlə yazır.
 *
 * NİYƏ LAZIMDIR: əvvəl limit web klientində SABİT KODLANMIŞDI (30,000 token /
 * 600 s) və istifadəçi onu nə görürdü, nə dəyişə bilirdi. Task limitə dəyəndə
 * ekranda yalnız `failed` görünürdü — səbəb heç yerdə yazılmırdı. Limit qərar
 * verməzdən ƏVVƏL görünməlidir, sonra deyil.
 *
 * Vaxt AYRICA işarələnir ("icra başına"): o, taskın ümumi vaxtı deyil, bir
 * icranın ilişmə həddidir və ikisini eyni cür yazsaq istifadəçi altı parçalı
 * taskın bir saatda bitəcəyini zənn edərdi.
 */
export function summarizeBudget(ctx: ContextRow | undefined): BudgetSummary {
  if (ctx === undefined) return { text: '', unlimited: false }

  // `typeof === 'number'` yoxlanılır, `!== null` YOX: sahə köhnə serverdən
  // ÜMUMİYYƏTLƏ gəlməyə bilər və `undefined.toLocaleString()` bütün səhifəni
  // ağ ekrana çevirərdi. Limit göstərmək taskı göndərməkdən az vacibdir.
  const parts: string[] = []
  if (typeof ctx.budgetTokens === 'number') {
    parts.push(`${ctx.budgetTokens.toLocaleString('az-AZ')} çıxış tokeni`)
  }
  if (typeof ctx.budgetUsd === 'number') parts.push(`$${ctx.budgetUsd}`)
  if (typeof ctx.budgetSeconds === 'number') {
    parts.push(`icra başına ${formatDuration(ctx.budgetSeconds)}`)
  }

  if (parts.length === 0) return { text: 'limitsiz', unlimited: true }
  return { text: parts.join(' · '), unlimited: false }
}

/** Formadakı XAM mətn — istifadəçi yazarkən rəqəm olmaya bilər. */
export interface BudgetFormValues {
  tokens: string
  usd: string
  /** DƏQİQƏ ilə. Saniyə istəsəydik istifadəçi `3600` yazmalı olardı. */
  minutes: string
}

export interface BudgetPatch {
  budgetTokens: number | null
  budgetUsd: number | null
  budgetSeconds: number | null
}

/**
 * Forma dəyərlərini PATCH gövdəsinə çevirir.
 *
 * Boş sahə `null`-dır, `0` YOX: sxem müsbət ədəd tələb edir və `0` "limitsiz"
 * demək olsaydı, "sıfır token" ilə "limit yoxdur" eyni dəyərlə ifadə olunardı —
 * biri hər icranı kəsər, digəri heç birini.
 *
 * Yoxlama BURADA edilir, serverin 400-ünü gözləmədən: səhv rəqəm yazan
 * istifadəçi səbəbi dərhal görməlidir, sorğu getdikdən sonra yox.
 */
export function parseBudgetForm(
  v: BudgetFormValues,
): { patch: BudgetPatch } | { error: string } {
  const tokens = parseField(v.tokens, { integer: true, label: 'Token limiti' })
  if ('error' in tokens) return tokens
  const usd = parseField(v.usd, { integer: false, label: 'Xərc limiti' })
  if ('error' in usd) return usd
  const minutes = parseField(v.minutes, { integer: false, label: 'Vaxt limiti' })
  if ('error' in minutes) return minutes

  return {
    patch: {
      budgetTokens: tokens.value,
      budgetUsd: usd.value,
      budgetSeconds: minutes.value === null ? null : Math.round(minutes.value * 60),
    },
  }
}

function parseField(
  raw: string,
  opts: { integer: boolean; label: string },
): { value: number | null } | { error: string } {
  const text = raw.trim()
  if (text === '') return { value: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `${opts.label} müsbət ədəd olmalıdır (boş = limitsiz)` }
  }
  if (opts.integer && !Number.isInteger(n)) {
    return { error: `${opts.label} tam ədəd olmalıdır` }
  }
  return { value: n }
}

/**
 * Saniyəni oxunaqlı vahidə çevirir.
 *
 * Xam saniyə yazsaydıq `3600` rəqəmi "çoxdur, yoxsa azdır?" sualını
 * cavablandırmazdı — limitin bütün mənası isə məhz o sualdır.
 */
function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} saat`
  if (seconds % 60 === 0) return `${seconds / 60} dəq`
  return `${seconds} s`
}
