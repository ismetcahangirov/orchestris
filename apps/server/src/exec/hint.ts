/**
 * Pillə 4 — İpucu (Shepherding).
 *
 * Fikir: işçi ilişəndə ona TAM cavab yox, güclü modeldən BAŞLANĞIC verilir —
 * düzgün yanaşma və həllin ilk 10–30%-i. Zəif modelin əsas problemi çox vaxt
 * "davam etdirə bilmirəm" deyil, "hardan başlayacağımı bilmirəm"dir; başlanğıc
 * veriləndə qalanını özü yığa bilir.
 *
 * NİYƏ BU, PİLLƏ 7-DƏN UCUZDUR: başçı cavabın yalnız kiçik hissəsini yazır.
 * Çıxış tokenləri giriş tokenlərindən 3–5x bahadır, ona görə "başçının qısa
 * çıxışı + işçinin tam çıxışı" adətən "başçının tam çıxışı"ndan ucuz olur.
 * Araşdırma: 42–94% qənaət, eyni dəqiqlikdə routing/cascade-dən 2.8x ucuz.
 *
 * BU PİLLƏNİN BÜTÜN QƏNAƏTİ MÜQAVİLƏDƏDİR: başçı tam həll yazsa, pillə elə
 * Pillə 7 olar — üstəlik işçinin əlavə icrası da ödənilər, yəni pillə ZƏRƏRƏ
 * işləyər. Ona görə prompt "TAM həll YAZMA"nı açıq və təkrar deyir.
 *
 * DİQQƏT — ipucunun uzunluğu BÜDCƏ İLƏ məhdudlaşdırılmır. `BudgetGuard`
 * `usage` hadisəsinə baxır, CLI runner-ləri isə `usage`-i yalnız SONDA verir
 * (CLAUDE.md qayda 3) — sərt `maxOutputTokens` uzun ipucunu kəsməzdi, sadəcə
 * icranı SONRADAN `budget_exceeded` kimi işarələyərdi və biz ödədiyimiz mətni
 * atardıq. Yəni limit qənaət etməz, pulu boşa çıxarardı. Ona görə uzunluq
 * prompt ilə istənilir və mətn burada, işçiyə verilməzdən əvvəl kəsilir.
 */

/** İşçiyə ötürülən ipucunun maksimum uzunluğu (simvol). */
export const HINT_CHAR_LIMIT = 2000

export interface HintRequest {
  task: string
  /** İşçi niyə ilişdi — başçı ipucunu məhz ora yönəltməlidir. */
  reason: string
  /** İşçinin qismən nəticəsi (Pillə 6 müqaviləsindən gəlir). */
  partial?: string
}

/**
 * Başçıya gedən prompt — "yolu göstər, yolu getmə".
 *
 * İşçinin qismən nəticəsi QƏSDƏN daxil edilir: o, artıq ödənilmiş işdir. Amma
 * "bunu düzəlt" DEYİLMİR — zəif modelin səhv cavabı güclü modeli həmin səhvə
 * bağlaya bilir (anchoring), ona görə "faydasızdırsa nəzərə alma" xəbərdarlığı
 * qalır (eyni yanaşma `escalation.ts` → `buildEscalationPrompt`).
 */
export function buildHintRequestPrompt(input: HintRequest): string {
  const lines = [
    input.task,
    '',
    '---',
    'QEYD: bu taskı daha zəif model həll edə bilmədi.',
    `Onun ilişmə səbəbi: ${input.reason}`,
    '',
    'SƏNDƏN TAM HƏLL İSTƏNMİR. Yalnız BAŞLANĞIC ipucu yaz:',
    '- düzgün yanaşmanı 1-2 cümlə ilə göstər',
    '- həllin yalnız ilk 10–30%-ni yaz: ilk addımlar, skelet, imza, açar düstur',
    '- qalanını, yəni TAM həll YAZMA — onu zəif model sənin ipucunun üzərində',
    '  tamamlayacaq',
    '- 15 sətirdən çox yazma',
  ]
  if (input.partial !== undefined && input.partial.trim() !== '') {
    lines.push(
      '',
      'Onun qismən nəticəsi aşağıdadır. Faydalıdırsa istifadə et, faydasızdırsa',
      'tamamilə nəzərə alma — səhv ola bilər.',
      '',
      input.partial.slice(0, HINT_CHAR_LIMIT),
    )
  }
  return lines.join('\n')
}

/**
 * İşçiyə gedən prompt — ipucu ilə birlikdə EYNİ task.
 *
 * Task mətni dəyişdirilmir (yalnız suffiks əlavə olunur): CLAUDE.md qayda 29 —
 * prefiksin toxunulmaz qalması prompt-keşini saxlayır.
 */
export function buildHintedPrompt(task: string, hint: string): string {
  const trimmed = hint.trim()
  const capped =
    trimmed.length > HINT_CHAR_LIMIT ? `${trimmed.slice(0, HINT_CHAR_LIMIT)}…` : trimmed

  return [
    task,
    '',
    '---',
    'İPUCU (daha güclü modeldən — həllin yalnız BAŞLANĞICI):',
    capped,
    '',
    'Bu ipucu düzgün istiqamətdir: onun üzərində qur və həlli SONA ÇATDIR.',
    'İpucunu olduğu kimi təkrar yazmaq məcburi deyil, amma ondan uzaqlaşma.',
  ].join('\n')
}
