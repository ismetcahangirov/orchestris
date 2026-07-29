import { and, countDistinct, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from './client.js'
import { runs, taskTemplates, tasks } from './schema.js'

export type TaskTemplate = typeof taskTemplates.$inferSelect

export interface SaveTemplateInput {
  id: string
  taskType: string
  workerPrompt: string
  rubric: string
  authoredByModelId: string
  authoringRunId?: string
  /** `undefined` = xərc BİLİNMİR (qayda 4) — `0` yazmaq "pulsuz" yalanı olardı. */
  authoringCostUsd?: number
  at?: number
}

/**
 * Prompt distilləsinin anbarı — task TİPİ başına bir şablon.
 *
 * Şablon `runs`/`tasks`-dan ASILI DEYİL: onu ödəyən task silinsə də qalır,
 * çünki bütün fayda gələcək tasklardadır.
 */
export function getTemplate(db: Db, taskType: string): TaskTemplate | undefined {
  return db.select().from(taskTemplates).where(eq(taskTemplates.taskType, taskType)).get()
}

export function listTemplates(db: Db): TaskTemplate[] {
  return db.select().from(taskTemplates).orderBy(desc(taskTemplates.createdAt)).all()
}

/**
 * Şablonu yazır və ya YENİDƏN yazır.
 *
 * Yenidən yazılışda `uses`/`escalations_after` SIFIRLANIR: onlar "bu mətn nə
 * qədər işlədildi və nə qədər tutmadı" sualının cavabıdır. Köhnə mətnin
 * sayğacını yeni mətnin üstünə daşısaq, "şablon işləyirmi?" ölçməsi iki fərqli
 * promptun qarışığını göstərərdi.
 */
export function saveTemplate(db: Db, input: SaveTemplateInput): TaskTemplate {
  const values = {
    id: input.id,
    taskType: input.taskType,
    workerPrompt: input.workerPrompt,
    rubric: input.rubric,
    authoredByModelId: input.authoredByModelId,
    authoringRunId: input.authoringRunId ?? null,
    authoringCostUsd: input.authoringCostUsd ?? null,
    uses: 0,
    escalationsAfter: 0,
    createdAt: input.at ?? Date.now(),
    lastUsedAt: null,
  }

  db.insert(taskTemplates)
    .values(values)
    .onConflictDoUpdate({ target: taskTemplates.taskType, set: values })
    .run()

  const saved = getTemplate(db, input.taskType)
  if (saved === undefined) throw new Error('Şablon yazıldı, amma geri oxunmadı')
  return saved
}

/** Şablon bir taskda tətbiq olundu. Task başına BİR dəfə çağırılır. */
export function recordTemplateUse(db: Db, taskType: string, at = Date.now()): void {
  db.update(taskTemplates)
    .set({ uses: sql`${taskTemplates.uses} + 1`, lastUsedAt: at })
    .where(eq(taskTemplates.taskType, taskType))
    .run()
}

/**
 * Şablon tətbiq olundu, amma task YENƏ yuxarı pilləyə qalxdı.
 *
 * Bu rəqəm `uses` ilə yanaşı göstərilir: distillə "işlədi" iddiası yalnız
 * ikisinin nisbəti ilə yoxlana bilər.
 */
export function recordTemplateEscalation(db: Db, taskType: string): void {
  db.update(taskTemplates)
    .set({ escalationsAfter: sql`${taskTemplates.escalationsAfter} + 1` })
    .where(eq(taskTemplates.taskType, taskType))
    .run()
}

/**
 * Bu tipdə NEÇƏ task başçının köməyini tələb etdi — distillə qapısı.
 *
 * İki şərt birlikdə vacibdir:
 *  - `escalated_from_run_id IS NOT NULL` — icra bir şey SINDIQDAN sonra doğdu.
 *    Bunsuz `boss-only` profilinin adi tək icrası da "eskalasiya" sayılardı və
 *    baseline ölçməsi (qayda 25) distilləni yalandan işə salardı.
 *  - `ladder_rung` başçının qarışdığı pillələrdən biridir (4, 5, 7). Sırf işçi
 *    təkrarları (rung 2) sayılsaydı, qapı zəif modelin adi retry-larından açılardı.
 *
 * TASK sayılır, icra yox: Pillə 4/5 bir taskda İKİ sətir yazır (başçının qısa
 * mətni + işçinin köməkli cəhdi) — icra saysaydıq bir task qapını təkbaşına açardı.
 */
export function countBossAssistedTasks(
  db: Db,
  taskType: string,
  assistRungs: readonly number[],
): number {
  const row = db
    .select({ n: countDistinct(runs.taskId) })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(tasks.taskType, taskType),
        isNotNull(runs.escalatedFromRunId),
        inArray(runs.ladderRung, [...assistRungs]),
      ),
    )
    .get()
  return row?.n ?? 0
}
