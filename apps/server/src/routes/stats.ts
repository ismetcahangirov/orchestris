import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { summarizeSavings } from '../db/savings-repo.js'
import { savingsLedger, tasks } from '../db/schema.js'

/** Dashboard-ın "bu gün / bu həftə / bu ay" seçicisi. */
export const STATS_PERIODS = ['day', 'week', 'month', 'all'] as const
export type StatsPeriod = (typeof STATS_PERIODS)[number]

const DAY_MS = 24 * 60 * 60 * 1000
const PERIOD_MS: Record<Exclude<StatsPeriod, 'all'>, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
}

/** `/history` səhifəsində göstərilən son task sayı. */
const RECENT_LIMIT = 100

export function registerStatsRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { period?: string } }>('/api/stats/savings', async (req, reply) => {
    const period = (req.query.period ?? 'month') as StatsPeriod
    if (!STATS_PERIODS.includes(period)) {
      return reply.code(400).send({
        error: `Naməlum dövr: ${req.query.period ?? ''}`,
        available: STATS_PERIODS,
      })
    }

    const since = period === 'all' ? undefined : Date.now() - PERIOD_MS[period]
    const summary = summarizeSavings(db, since !== undefined ? { since } : {})

    // Sətirlər `/history` səhifəsi üçün: hansı task nə qədər qənaət etdi.
    // Prompt task cədvəlindən gəlir — ledger promptu təkrarlamır.
    const rows = db
      .select({
        taskId: savingsLedger.taskId,
        taskType: savingsLedger.taskType,
        actualCostUsd: savingsLedger.actualCostUsd,
        actualSubscriptionUsd: savingsLedger.actualSubscriptionUsd,
        baselineCostUsd: savingsLedger.baselineCostUsd,
        baselineModelId: savingsLedger.baselineModelId,
        baselineSubscription: savingsLedger.baselineSubscription,
        orchestrationCostUsd: savingsLedger.orchestrationCostUsd,
        netSavingUsd: savingsLedger.netSavingUsd,
        cachedHit: savingsLedger.cachedHit,
        tokensIn: savingsLedger.tokensIn,
        tokensOut: savingsLedger.tokensOut,
        at: savingsLedger.at,
        prompt: tasks.prompt,
        status: tasks.status,
      })
      .from(savingsLedger)
      .innerJoin(tasks, eq(savingsLedger.taskId, tasks.id))
      .orderBy(desc(savingsLedger.at))
      .limit(RECENT_LIMIT)
      .all()

    return {
      period,
      ...(since !== undefined ? { since } : {}),
      summary,
      tasks: since === undefined ? rows : rows.filter((r) => r.at >= since),
    }
  })
}
