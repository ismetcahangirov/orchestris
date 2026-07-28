import { asc, desc, eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { routingDecisions } from './schema.js'

export type RoutingDecisionRecord = typeof routingDecisions.$inferSelect

/** `routing/router.ts`-in `RoutingDecision` tipinin DB-yə yazılan hissəsi. */
export interface RecordableDecision {
  strategy: string
  runnerId: string
  modelId: string
  chosenRowId: string | null
  confidence: number
  reason: string
  ruleId?: string | undefined
  decisionTokens: number
  decisionCostUsd?: number | undefined
}

export function recordRoutingDecision(
  db: Db,
  taskId: string,
  decision: RecordableDecision,
): void {
  db.insert(routingDecisions)
    .values({
      taskId,
      strategy: decision.strategy,
      chosenModelId: decision.chosenRowId,
      runnerId: decision.runnerId,
      modelId: decision.modelId,
      confidence: decision.confidence,
      decisionTokens: decision.decisionTokens,
      // `?? null` — xərc bilinmirsə NULL. `0` "qərar pulsuz idi" deməkdir və
      // yalnız qayda routing-i üçün doğrudur (CLAUDE.md qayda 4).
      decisionCostUsd: decision.decisionCostUsd ?? null,
      ruleId: decision.ruleId ?? null,
      reason: decision.reason,
      at: Date.now(),
    })
    .run()
}

export function listRoutingDecisions(db: Db, taskId: string): RoutingDecisionRecord[] {
  return db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.taskId, taskId))
    .orderBy(asc(routingDecisions.id))
    .all()
}

export function latestRoutingDecision(
  db: Db,
  taskId: string,
): RoutingDecisionRecord | undefined {
  return db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.taskId, taskId))
    .orderBy(desc(routingDecisions.id))
    .limit(1)
    .get()
}
