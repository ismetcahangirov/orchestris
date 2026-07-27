/**
 * Qiymətlər models.dev-in vahidindədir: **1 MİLYON token üçün USD**.
 * `undefined` = qiymət BİLİNMİR. `0` = həqiqətən pulsuz. İkisi eyni şey
 * deyil (CLAUDE.md qayda 4).
 */
export interface ModelPrice {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** `PER_MILLION` bölənindən istifadə: models.dev qiymətləri 1e6 token üçündür. */
const PER_MILLION = 1_000_000

/**
 * İcranın xərcini hesablayır. Qiymət bilinmirsə `undefined` qaytarır —
 * **heç vaxt `0` yox**.
 *
 * Əsas incəlik: qiymətin natamam olması yalnız O TOKEN NÖVÜ İŞLƏDİLİBSƏ
 * problemdir. Ölçülmüş fakt (models.dev, 2026-07-28): bundle etdiyimiz 103
 * modeldən 9-unun qiyməti ümumiyyətlə yoxdur, 30-unun isə `cache_read`
 * qiyməti yoxdur. Əgər `cache_read` qiyməti bilinmirsə, amma icra heç bir
 * keş oxumayıbsa (`cacheReadTokens: 0`), xərc TAM bilinir — o modeli
 * "qiyməti bilinmir" saymaq lazımsız yere büdcə mühafizəsini kor edərdi.
 *
 * Əksinə, keşdən 20k token oxunubsa və `cache_read` qiyməti yoxdursa, yekun
 * rəqəm həqiqətən bilinmir — orada `undefined` qaytarılır ki, UI "xərc
 * bilinmir" desin və `BudgetGuard` yalan rəqəmə güvənməsin.
 */
export function computeCostUsd(
  price: ModelPrice,
  tokens: TokenCounts,
): number | undefined {
  const parts: [number, number | undefined][] = [
    [tokens.inputTokens, price.input],
    [tokens.outputTokens, price.output],
    [tokens.cacheReadTokens ?? 0, price.cacheRead],
    [tokens.cacheWriteTokens ?? 0, price.cacheWrite],
  ]

  let total = 0
  for (const [count, unitPrice] of parts) {
    if (count === 0) continue // qiymət bilinməsə də bu komponent xərcə təsir etmir
    if (unitPrice === undefined) return undefined
    total += (count * unitPrice) / PER_MILLION
  }
  return total
}

/**
 * Modelin xərcinin ÜMUMİYYƏTLƏ hesablana biləcəyini bildirir — UI-da
 * "qiymət bilinmir" nişanı üçün. Konkret icranın xərci üçün
 * `computeCostUsd` işlədilir: orada işlədilməyən token növü əhəmiyyətsizdir.
 */
export function hasBasePrice(price: ModelPrice): boolean {
  return price.input !== undefined && price.output !== undefined
}
