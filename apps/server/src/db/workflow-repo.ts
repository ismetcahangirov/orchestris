import { randomUUID } from 'node:crypto'
import { WorkflowSteps, type WorkflowStep } from '@orchestris/shared'
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm'
import { DIFF_KIND } from './artifact-repo.js'
import type { Db } from './client.js'
import { artifacts, schedules, workflowRuns, workflows, workflowStepRuns } from './schema.js'

export type WorkflowRow = typeof workflows.$inferSelect
export type WorkflowRunRow = typeof workflowRuns.$inferSelect
export type WorkflowStepRunRow = typeof workflowStepRuns.$inferSelect

function now(): number {
  return Date.now()
}

export function createWorkflow(
  db: Db,
  input: {
    contextId: string
    name: string
    description?: string | undefined
    steps: readonly WorkflowStep[]
  },
): WorkflowRow {
  const id = randomUUID()
  const at = now()
  db.insert(workflows)
    .values({
      id,
      contextId: input.contextId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      stepsJson: JSON.stringify(input.steps),
      createdAt: at,
      updatedAt: at,
    })
    .run()
  return required(db.select().from(workflows).where(eq(workflows.id, id)).get())
}

export function getWorkflow(db: Db, id: string): WorkflowRow | undefined {
  return db.select().from(workflows).where(eq(workflows.id, id)).get()
}

/** Arxivləşdirilmişlər QAYTARILMIR — onlar tarixçə üçün qalır, iş üçün yox. */
export function listWorkflows(db: Db, contextId?: string): WorkflowRow[] {
  const active = isNull(workflows.archivedAt)
  return db
    .select()
    .from(workflows)
    .where(contextId === undefined ? active : and(active, eq(workflows.contextId, contextId)))
    .orderBy(desc(workflows.createdAt))
    .all()
}

export interface WorkflowUpdate {
  name?: string | undefined
  description?: string | null | undefined
  steps?: readonly WorkflowStep[] | undefined
  archived?: boolean | undefined
}

export function updateWorkflow(db: Db, id: string, input: WorkflowUpdate): WorkflowRow {
  const values: Record<string, unknown> = { updatedAt: now() }
  if (input.name !== undefined) values['name'] = input.name
  if (input.description !== undefined) values['description'] = input.description
  if (input.steps !== undefined) values['stepsJson'] = JSON.stringify(input.steps)
  // `archived: false` = arxivdən çıxar. Sahə üç dəyərlidir (verilməyib / true /
  // false) və hər üçü fərqli mənaya gəlir.
  if (input.archived !== undefined) values['archivedAt'] = input.archived ? now() : null

  db.update(workflows).set(values).where(eq(workflows.id, id)).run()
  return required(db.select().from(workflows).where(eq(workflows.id, id)).get())
}

/**
 * Saxlanılan addımları oxuyur və YENİDƏN VALİDASİYA edir.
 *
 * Niyə yenidən: JSON sütun sxem təminatı vermir. Sətir əl ilə (və ya köhnə
 * versiya ilə) yazılıbsa, icra vaxtı `steps[i].kind` gözlənilməz ola bilər və
 * səhv icranın ORTASINDA — yəni pul yandıqdan sonra — üzə çıxardı. Burada
 * `null` qaytarmaq icranı BAŞLAMADAN dayandırır.
 */
export function parseSteps(row: { stepsJson: string }): WorkflowStep[] | null {
  try {
    const parsed = WorkflowSteps.safeParse(JSON.parse(row.stepsJson))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function createWorkflowRun(
  db: Db,
  input: {
    workflowId: string
    trigger: string
    stepsJson: string
    /** Sintetik valideyn task (issue #36). `http`-only zəncirdə verilmir. */
    rootTaskId?: string | undefined
    /** İcranı başladan cədvəl (issue #38). Əl ilə icrada verilmir. */
    scheduleId?: string | undefined
  },
): WorkflowRunRow {
  const id = randomUUID()
  db.insert(workflowRuns)
    .values({
      id,
      workflowId: input.workflowId,
      trigger: input.trigger,
      stepsJson: input.stepsJson,
      ...(input.rootTaskId !== undefined ? { rootTaskId: input.rootTaskId } : {}),
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
      startedAt: now(),
    })
    .run()
  return required(db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get())
}

export function finishWorkflowRun(
  db: Db,
  id: string,
  input: { status: string; error?: string },
): void {
  db.update(workflowRuns)
    .set({
      status: input.status,
      endedAt: now(),
      ...(input.error !== undefined ? { error: input.error } : {}),
    })
    .where(eq(workflowRuns.id, id))
    .run()
}

export function getWorkflowRun(db: Db, id: string): WorkflowRunRow | undefined {
  return db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get()
}

export function listWorkflowRuns(db: Db, workflowId: string, limit = 50): WorkflowRunRow[] {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(limit)
    .all()
}

export function startStepRun(
  db: Db,
  input: {
    workflowRunId: string
    stepId: string
    stepIndex: number
    kind: string
    attempt: number
  },
): number {
  const res = db
    .insert(workflowStepRuns)
    .values({ ...input, startedAt: now() })
    .returning({ id: workflowStepRuns.id })
    .get()
  return res.id
}

export function finishStepRun(
  db: Db,
  id: number,
  input: {
    status: string
    output?: string
    outputTruncated?: boolean
    taskId?: string
    detail?: string
  },
): void {
  db.update(workflowStepRuns)
    .set({
      status: input.status,
      endedAt: now(),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.outputTruncated !== undefined
        ? { outputTruncated: input.outputTruncated }
        : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    })
    .where(eq(workflowStepRuns.id, id))
    .run()
}

export function listStepRuns(db: Db, workflowRunId: string): WorkflowStepRunRow[] {
  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId))
    .orderBy(workflowStepRuns.id)
    .all()
}

// ── Cədvəl üzrə icra (Faza 4) ─────────────────────────────────────────────

export type ScheduleRow = typeof schedules.$inferSelect

export function createSchedule(
  db: Db,
  input: {
    workflowId: string
    intervalSeconds: number
    budgetUsdPerRun: number
    budgetUsdTotal: number
    maxRuns: number
    /** Baxılmamış diff tavanı (issue #38). Verilməsə DB defaultu. */
    maxPendingDiffs?: number | undefined
    /** İlk icranın vaxtı. Verilməsə indidən BİR İNTERVAL sonra. */
    startAt?: number | undefined
  },
): ScheduleRow {
  const id = randomUUID()
  const at = now()
  db.insert(schedules)
    .values({
      id,
      workflowId: input.workflowId,
      intervalSeconds: input.intervalSeconds,
      budgetUsdPerRun: input.budgetUsdPerRun,
      budgetUsdTotal: input.budgetUsdTotal,
      maxRuns: input.maxRuns,
      ...(input.maxPendingDiffs !== undefined
        ? { maxPendingDiffs: input.maxPendingDiffs }
        : {}),
      // Default "indi" DEYİL, "bir interval sonra": cədvəl yaradan kimi icra
      // başlasaydı, istifadəçi limitləri yoxlamağa macal tapmazdı.
      nextRunAt: input.startAt ?? at + input.intervalSeconds * 1000,
      createdAt: at,
    })
    .run()
  return required(db.select().from(schedules).where(eq(schedules.id, id)).get())
}

export function getSchedule(db: Db, id: string): ScheduleRow | undefined {
  return db.select().from(schedules).where(eq(schedules.id, id)).get()
}

export function listSchedules(db: Db, workflowId?: string): ScheduleRow[] {
  const q = db.select().from(schedules)
  return (workflowId === undefined ? q : q.where(eq(schedules.workflowId, workflowId)))
    .orderBy(schedules.nextRunAt)
    .all()
}

/** Vaxtı çatmış VƏ açıq cədvəllər. Söndürülmüşlər heç vaxt qaytarılmır. */
export function dueSchedules(db: Db, at: number): ScheduleRow[] {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, at)))
    .orderBy(schedules.nextRunAt)
    .all()
}

export function updateSchedule(
  db: Db,
  id: string,
  input: {
    enabled?: boolean | undefined
    intervalSeconds?: number | undefined
    budgetUsdPerRun?: number | undefined
    budgetUsdTotal?: number | undefined
    maxRuns?: number | undefined
    maxPendingDiffs?: number | undefined
  },
): ScheduleRow {
  const values: Record<string, unknown> = {}
  if (input.intervalSeconds !== undefined) values['intervalSeconds'] = input.intervalSeconds
  if (input.budgetUsdPerRun !== undefined) values['budgetUsdPerRun'] = input.budgetUsdPerRun
  if (input.budgetUsdTotal !== undefined) values['budgetUsdTotal'] = input.budgetUsdTotal
  if (input.maxRuns !== undefined) values['maxRuns'] = input.maxRuns
  if (input.maxPendingDiffs !== undefined) values['maxPendingDiffs'] = input.maxPendingDiffs
  if (input.enabled !== undefined) {
    values['enabled'] = input.enabled
    // Yenidən açılanda səbəb TƏMİZLƏNİR: köhnə "büdcə doldu" mətni işləyən
    // cədvəlin yanında qalsaydı, istifadəçi onu hələ də söndürülmüş sayardı.
    if (input.enabled) values['disabledReason'] = null
  }

  if (Object.keys(values).length > 0) {
    db.update(schedules).set(values).where(eq(schedules.id, id)).run()
  }
  return required(db.select().from(schedules).where(eq(schedules.id, id)).get())
}

/** İcra sayğacını artırır və növbəti vaxtı yazır — icradan ƏVVƏL çağırılır. */
export function markScheduleRun(
  db: Db,
  id: string,
  input: { nextRunAt: number; lastRunAt: number },
): void {
  db.update(schedules)
    .set({
      nextRunAt: input.nextRunAt,
      lastRunAt: input.lastRunAt,
      runs: sql`${schedules.runs} + 1`,
    })
    .where(eq(schedules.id, id))
    .run()
}

/**
 * Ölçülmüş xərci yığır.
 *
 * `sql` ifadəsi ilə ARTIRILIR, oxu-dəyiş-yaz ilə YOX: iki icra eyni anda
 * bitsəydi, JS tərəfində hesablanan cəm birini itirərdi və tavan səssizcə
 * sızardı.
 */
export function addScheduleSpend(db: Db, id: string, amountUsd: number): void {
  if (amountUsd === 0) return
  db.update(schedules)
    .set({ spentUsd: sql`${schedules.spentUsd} + ${amountUsd}` })
    .where(eq(schedules.id, id))
    .run()
}

/**
 * Cədvəlin yığdığı BAXILMAMIŞ diff sayı (issue #38).
 *
 * SAXLANILMIR, HƏR DƏFƏ HESABLANIR: istifadəçi diff-i qəbul və ya rədd edəndə
 * `artifacts.status` dəyişir və worktree silinir. Sayğac sütunu saxlasaydıq, o
 * an azalmazdı və cədvəl artıq mövcud olmayan qovluqlara görə söndürülərdi —
 * yəni tavan dolan kimi ƏBƏDİ dolu qalardı. Sorğu indeksli sütunlar üzrədir və
 * tik başına bir dəfə qaçır.
 *
 * SAY CƏDVƏL BAŞINADIR, zəncir başına yox: eyni zəncirə iki cədvəl qurmaq
 * qanunidir və biri digərinin diskinə görə söndürülməməlidir. Məhz buna görə
 * `workflow_runs.schedule_id` sütunu var — `trigger: 'schedule'` bunu ayırd edə
 * bilmir.
 *
 * `rootTaskId` üzrə birləşdirilir, çünki zəncirin diff-i həmişə SİNTETİK
 * valideyn taskın adına yazılır (issue #36) — addımların öz taskları diff
 * yazmır.
 */
export function countPendingDiffsForSchedule(db: Db, scheduleId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .innerJoin(workflowRuns, eq(workflowRuns.rootTaskId, artifacts.taskId))
    .where(
      and(
        eq(workflowRuns.scheduleId, scheduleId),
        eq(artifacts.kind, DIFF_KIND),
        eq(artifacts.status, 'pending'),
      ),
    )
    .get()
  return row?.n ?? 0
}

export function disableSchedule(db: Db, id: string, reason: string): void {
  db.update(schedules)
    .set({ enabled: false, disabledReason: reason })
    .where(eq(schedules.id, id))
    .run()
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('workflows: sətir tapılmadı')
  return row
}
