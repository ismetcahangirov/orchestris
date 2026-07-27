import type { ErrorClass, RunEvent } from '@orchestris/shared'

export interface BudgetLimits {
  maxOutputTokens?: number
  maxCostUsd?: number
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
}

export interface BudgetViolation {
  class: ErrorClass
  message: string
  retryable: false
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
      )
    }

    return null
  }

  /** Vaxt yoxlaması — hadisədən asılı deyil, dövri çağırılır. */
  checkClock(): BudgetViolation | null {
    const { maxSeconds } = this.limits
    if (maxSeconds === undefined) return null
    const elapsed = (Date.now() - this.startedAt) / 1000
    if (elapsed > maxSeconds) {
      return this.violation(
        `Vaxt limiti aşıldı: ${elapsed.toFixed(1)}s > ${maxSeconds}s`,
      )
    }
    return null
  }

  private violation(message: string): BudgetViolation {
    return { class: 'budget_exceeded', message, retryable: false }
  }
}
