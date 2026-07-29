import { and, asc, gte, lte, eq } from 'drizzle-orm'
import type { TaskSavings } from '../exec/savings.js'
import type { Db } from './client.js'
import { getTask } from './repo.js'
import { savingsLedger } from './schema.js'

export type SavingsRecord = typeof savingsLedger.$inferSelect

export interface RecordOptions {
  /** Test üçün — sabit vaxt. */
  at?: number
}

/**
 * Ledger sətrini yazır (task başına BİR sətir).
 *
 * Yoxlama dövrəsi taskı bir neçə dəfə icra edə bilər; `onConflictDoUpdate`
 * olmasaydı qənaət ikiqat sayılardı.
 */
export function recordSavings(
  db: Db,
  savings: TaskSavings,
  opts: RecordOptions = {},
): void {
  const values = {
    taskId: savings.taskId,
    taskType: getTask(db, savings.taskId)?.taskType ?? 'unknown',
    actualCostUsd: savings.actualCostUsd,
    actualSubscriptionUsd: savings.actualSubscriptionUsd,
    baselineCostUsd: savings.baselineCostUsd,
    baselineModelId: savings.baselineModelId,
    baselineSubscription: savings.baselineSubscription,
    orchestrationCostUsd: savings.orchestrationCostUsd,
    memoryCostUsd: savings.memoryCostUsd,
    netSavingUsd: savings.netSavingUsd,
    cachedHit: savings.cachedHit,
    tokensIn: savings.baselineTokens.inputTokens,
    tokensOut: savings.baselineTokens.outputTokens,
    at: opts.at ?? Date.now(),
  }

  db.insert(savingsLedger)
    .values(values)
    .onConflictDoUpdate({ target: savingsLedger.taskId, set: values })
    .run()
}

export function getSavings(db: Db, taskId: string): SavingsRecord | undefined {
  return db.select().from(savingsLedger).where(eq(savingsLedger.taskId, taskId)).get()
}

export interface TaskTypeSaving {
  taskType: string
  tasks: number
  netSavingUsd: number
  actualCostUsd: number
}

export interface SavingsSummary {
  taskCount: number
  /** REAL pul. */
  actualCostUsd: number
  /** Abunəlik istinad xərci — kartdan çıxmayan pul, AYRI sətir. */
  actualSubscriptionUsd: number
  baselineCostUsd: number
  /** Orkestrasiyanın öz xərci — net qənaətdən onsuz da çıxılıb, burada görünür. */
  orchestrationCostUsd: number
  memoryCostUsd: number
  netSavingUsd: number
  cacheHits: number
  /** Yalnız keşdən gələn taskların qənaəti. */
  cacheSavingUsd: number
  /** Xərci və ya qənaəti bilinməyən tasklar — cəmə GİRMİR, amma gizlədilmir. */
  unknownCostTasks: number
  /** Baseline-ı abunəlik modeli olan tasklar — bu, real pul qənaəti deyil. */
  subscriptionBaselineTasks: number
  byTaskType: TaskTypeSaving[]
  tokensIn: number
  tokensOut: number
}

export interface SummaryFilter {
  /** Unix ms — daxil olmaqla. */
  since?: number
  until?: number
}

/**
 * Yekunu SQL `SUM` ilə YOX, JS-də hesablayır.
 *
 * SƏBƏB: SQL `SUM` NULL-ları səssizcə atır. Xərci bilinməyən task cəmə `0`
 * kimi girərdi və "bu ay $X qənaət" rəqəmi olduğundan böyük görünərdi.
 * Burada naməlum sətirlər cəmdən ÇIXARILIR və ayrıca sayılır ki, UI dürüst
 * desin: "N taskın xərci bilinmir".
 */
export function summarizeSavings(db: Db, filter: SummaryFilter = {}): SavingsSummary {
  const conditions = [
    ...(filter.since !== undefined ? [gte(savingsLedger.at, filter.since)] : []),
    ...(filter.until !== undefined ? [lte(savingsLedger.at, filter.until)] : []),
  ]
  const rows =
    conditions.length === 0
      ? db.select().from(savingsLedger).orderBy(asc(savingsLedger.at)).all()
      : db
          .select()
          .from(savingsLedger)
          .where(and(...conditions))
          .orderBy(asc(savingsLedger.at))
          .all()

  const summary: SavingsSummary = {
    taskCount: rows.length,
    actualCostUsd: 0,
    actualSubscriptionUsd: 0,
    baselineCostUsd: 0,
    orchestrationCostUsd: 0,
    memoryCostUsd: 0,
    netSavingUsd: 0,
    cacheHits: 0,
    cacheSavingUsd: 0,
    unknownCostTasks: 0,
    subscriptionBaselineTasks: 0,
    byTaskType: [],
    tokensIn: 0,
    tokensOut: 0,
  }

  const byType = new Map<string, TaskTypeSaving>()

  for (const row of rows) {
    summary.tokensIn += row.tokensIn
    summary.tokensOut += row.tokensOut
    if (row.cachedHit) summary.cacheHits += 1
    if (row.baselineSubscription) summary.subscriptionBaselineTasks += 1

    if (row.actualCostUsd === null || row.netSavingUsd === null) {
      summary.unknownCostTasks += 1
      continue
    }

    summary.actualCostUsd += row.actualCostUsd
    summary.actualSubscriptionUsd += row.actualSubscriptionUsd ?? 0
    summary.baselineCostUsd += row.baselineCostUsd ?? 0
    summary.orchestrationCostUsd += row.orchestrationCostUsd ?? 0
    // Naməlum yaddaş xərci sətri onsuz da yuxarıda `unknownCostTasks`-a
    // düşür (`netSavingUsd` NULL olur), ona görə bura yalnız BİLİNƏN dəyər
    // gəlir — `?? 0` sadəcə tip qapısıdır, gizlətmə deyil.
    summary.memoryCostUsd += row.memoryCostUsd ?? 0
    summary.netSavingUsd += row.netSavingUsd
    if (row.cachedHit) summary.cacheSavingUsd += row.netSavingUsd

    const bucket = byType.get(row.taskType) ?? {
      taskType: row.taskType,
      tasks: 0,
      netSavingUsd: 0,
      actualCostUsd: 0,
    }
    bucket.tasks += 1
    bucket.netSavingUsd += row.netSavingUsd
    bucket.actualCostUsd += row.actualCostUsd
    byType.set(row.taskType, bucket)
  }

  summary.byTaskType = [...byType.values()].sort((a, b) => b.netSavingUsd - a.netSavingUsd)
  return summary
}
