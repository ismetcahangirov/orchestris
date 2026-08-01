import type { BudgetEnforcement, ErrorClass, RunEvent } from '@orchestris/shared'

export interface BudgetLimits {
  maxOutputTokens?: number
  maxCostUsd?: number
  /**
   * İCRA BAŞINA vaxt limiti — task başına YOX.
   *
   * Əvvəl bu, bütün taskın ümumi vaxtı idi və `RemainingBudget` ondan keçən
   * vaxtı çıxırdı. Nəticə: altı parçalı task ikinci parçanın ortasında ölürdü
   * və qalan dördü heç vaxt başlamırdı. Halbuki uzun task NORMALDIR; anormal
   * olan uzun İCRADIR (ilişmiş proses — qayda 6).
   */
  maxSeconds?: number
  /**
   * Abunəlikdən ödənilən icralar (CLI) üçün DOLLAR limiti tətbiq edilmir —
   * `costUsd` orada istinad qiymətidir, real pul çıxmır. Token və vaxt
   * limitləri isə hər halda tətbiq edilir.
   *
   * Hadisənin özündəki `billed: 'subscription'` də eyni təsiri verir; runner
   * öz billing rejimini konfiqurasiyadan daha yaxşı bilir.
   */
  subscriptionBilled?: boolean
  /**
   * Limit aşılanda KƏSİLSİNMİ. Verilməsə `'stop'` — yəni mövcud hər çağırış
   * (cədvəl, zəncir, testlər) davranışını BAYT-BAYT saxlayır.
   *
   * Səbəb `@orchestris/shared` → `BUDGET_ENFORCEMENTS` şərhindədir: `usage`
   * hər runner-də İŞİN SONUNDA gəlir, ona görə token/xərc limitinə görə
   * öldürmək pul qazandırmır, yalnız ödənilmiş nəticəni məhv edir.
   */
  enforcement?: BudgetEnforcement
}

export interface BudgetViolation {
  class: ErrorClass
  message: string
  retryable: false
  /**
   * İcra KƏSİLSİNMİ.
   *
   * `false` → pozuntu yalnız QEYD olunur: xərc onsuz da çəkilib, kəsmək
   * ödənilmiş nəticəni atmaqdan başqa heç nə etməzdi. Vaxt pozuntusunda bu
   * HƏMİŞƏ `true`-dur — orada iş hələ GEDİR və kəsmək real qənaətdir.
   */
  enforce: boolean
}

/**
 * Bölünmüş taskın ÜMUMİ tavanı — parça sayına görə miqyaslanır.
 *
 * Əvvəl limit bölünmüş taskda BÜTÖV idi: altı parça 30k tokeni öz aralarında
 * bölürdü, yəni task nə qədər çox parçaya bölünsəydi hər parçaya bir o qədər
 * AZ büdcə qalırdı. Bu, mexanizmin öz məqsədinə ziddir — task məhz böyük
 * olduğu üçün bölünür.
 *
 * İndi hər alt-task TAM limiti alır (`capLimits`), valideyn isə bu miqyaslanmış
 * tavana tabedir: qaçmış bölgü (məs. başçı 6 parça əvəzinə 6 nəhəng parça
 * yazsa) yenə də sonsuz xərcləyə bilmir.
 *
 * `maxSeconds` MİQYASLANMIR — o, icra başına limitdir, cəmlənən resurs deyil.
 */
export function scaleLimits(
  limits: BudgetLimits | undefined,
  factor: number,
): BudgetLimits | undefined {
  if (limits === undefined) return undefined
  return {
    ...limits,
    ...(limits.maxOutputTokens !== undefined
      ? { maxOutputTokens: limits.maxOutputTokens * factor }
      : {}),
    ...(limits.maxCostUsd !== undefined
      ? { maxCostUsd: limits.maxCostUsd * factor }
      : {}),
  }
}

/**
 * İki limitin daha DARI — alt-taskın öz limiti ilə valideynin qalan tavanı.
 *
 * Alt-task tam limiti alır, AMMA tavandan çox ala bilməz: son parçaya çatanda
 * tavan onsuz da tükənmiş ola bilər.
 */
export function capLimits(
  limits: BudgetLimits | undefined,
  ceiling: BudgetLimits | undefined,
): BudgetLimits | undefined {
  if (limits === undefined) return ceiling
  if (ceiling === undefined) return limits
  const tokens = smaller(limits.maxOutputTokens, ceiling.maxOutputTokens)
  const cost = smaller(limits.maxCostUsd, ceiling.maxCostUsd)
  return {
    ...limits,
    ...(tokens !== undefined ? { maxOutputTokens: tokens } : {}),
    ...(cost !== undefined ? { maxCostUsd: cost } : {}),
  }
}

/** `undefined` = "limit yoxdur", yəni daha DAR olan həmişə digəridir. */
function smaller(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/**
 * Sərt büdcə mühafizəsi.
 *
 * SƏBƏB: kaskad orkestrasiyada orchestrator hər task üçün əlavə çağırışlar
 * edir. Sənaye hesabatları göstərir ki, testdə $0.50 olan axın 100K icrada
 * $50,000/ay-a çıxa bilər. Bu sinif o riski kəsir — pozuntu halında proses
 * AĞACI öldürülür.
 */
export class BudgetGuard {
  private readonly startedAt: number

  constructor(private readonly limits: BudgetLimits) {
    this.startedAt = Date.now()
  }

  /**
   * Hadisə əsasında yoxlama. `usage` hadisələri KUMULYATİVDİR — burada
   * toplama aparılmır, hər dəfə mütləq dəyər müqayisə olunur.
   */
  check(event: RunEvent): BudgetViolation | null {
    if (event.t !== 'usage') return null

    const { maxOutputTokens, maxCostUsd } = this.limits

    if (maxOutputTokens !== undefined && event.outputTokens > maxOutputTokens) {
      return this.violation(
        `Output token limiti aşıldı: ${event.outputTokens} > ${maxOutputTokens}`,
        this.enforced(),
      )
    }

    // Abunəlik: ya konfiqurasiya, ya hadisənin özü belə deyir.
    const onSubscription =
      this.limits.subscriptionBilled === true || event.billed === 'subscription'

    // `costUsd` yoxluğu "BİLİNMİR" deməkdir — `0` kimi oxumaq limiti heç vaxt
    // işə salmaz, sonsuz kimi oxumaq isə hər icranı kəsər. Doğrusu: yoxlamamaq.
    if (
      maxCostUsd !== undefined &&
      !onSubscription &&
      event.costUsd !== undefined &&
      event.costUsd > maxCostUsd
    ) {
      return this.violation(
        `Xərc limiti aşıldı: $${event.costUsd.toFixed(6)} > $${maxCostUsd.toFixed(6)}`,
        this.enforced(),
      )
    }

    return null
  }

  /**
   * Vaxt yoxlaması — hadisədən asılı deyil, dövri çağırılır.
   *
   * `enforce` HƏMİŞƏ `true`: token/xərc limitindən fərqli olaraq bu yoxlama
   * iş GEDƏRKƏN işə düşür, yəni kəsmək həqiqətən qalan xərcin qarşısını alır.
   * İlişmiş prosesi dayandıran YEGANƏ mexanizm budur (qayda 6) — onu
   * `'report'` rejimində də söndürsək, cavab verməyən bir `claude` prosesi
   * əbədi token yandırardı.
   */
  checkClock(): BudgetViolation | null {
    const { maxSeconds } = this.limits
    if (maxSeconds === undefined) return null
    const elapsed = (Date.now() - this.startedAt) / 1000
    if (elapsed > maxSeconds) {
      return this.violation(
        `Vaxt limiti aşıldı: ${elapsed.toFixed(1)}s > ${maxSeconds}s`,
        true,
      )
    }
    return null
  }

  /** Verilməyən rejim `'stop'`-dur — mövcud çağırışların davranışı dəyişmir. */
  private enforced(): boolean {
    return this.limits.enforcement !== 'report'
  }

  private violation(message: string, enforce: boolean): BudgetViolation {
    return { class: 'budget_exceeded', message, retryable: false, enforce }
  }
}
