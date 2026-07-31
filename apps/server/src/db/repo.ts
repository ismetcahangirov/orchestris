import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { ActiveRun, ErrorClass, RunEvent } from '@orchestris/shared'
import type { Db } from './client.js'
import { cacheEntries, contexts, runEvents, runs, tasks, verificationRuns } from './schema.js'

type Context = typeof contexts.$inferSelect
type Task = typeof tasks.$inferSelect
type Run = typeof runs.$inferSelect

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'budget_exceeded'])

const now = (): number => Date.now()

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} tapılmadı`)
  return row
}

export function createContext(
  db: Db,
  input: {
    name: string
    cwd?: string
    verifyCommands?: readonly string[]
    fileAccess?: string
    extraDirs?: readonly string[]
  },
): Context {
  const id = randomUUID()
  db.insert(contexts)
    .values({
      id,
      name: input.name,
      cwd: input.cwd ?? null,
      verifyCommandsJson: JSON.stringify(input.verifyCommands ?? []),
      ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
      ...(input.extraDirs !== undefined
        ? { extraDirsJson: JSON.stringify(input.extraDirs) }
        : {}),
      createdAt: now(),
    })
    .run()
  return required(db.select().from(contexts).where(eq(contexts.id, id)).get(), 'contexts')
}

export function listContexts(db: Db): Context[] {
  return db.select().from(contexts).orderBy(asc(contexts.createdAt)).all()
}

export function getContext(db: Db, id: string): Context | undefined {
  return db.select().from(contexts).where(eq(contexts.id, id)).get()
}

/**
 * Sahələr açıq şəkildə `| undefined` daşıyır: `exactOptionalPropertyTypes`
 * altında "sahə yoxdur" ilə "sahə undefined-dır" fərqli tiplərdir və zod-un
 * `.optional()` nəticəsi ikincisidir.
 */
export interface ContextUpdate {
  amplificationProfile?: string | undefined
  workerMode?: string | undefined
  defaultWorkerModelId?: string | null | undefined
  verifyCommands?: readonly string[] | undefined
  /** `0` = avtomatik (`resolveMaxParallel`). */
  maxParallel?: number | undefined
  /** `null` = avtomatik (kontekstin öz `id`-si — `memory/session.ts`). */
  memoryScope?: string | null | undefined
  memoryEnabled?: boolean | undefined
  budgetTokens?: number | null | undefined
  budgetUsd?: number | null | undefined
  budgetSeconds?: number | null | undefined
  /**
   * İş qovluğu. `null` = sil.
   *
   * Əvvəl bu sahə YOX İDİ — `cwd` yalnız kontekst yaradılanda verilirdi və
   * səhv yazılmış yolu düzəltmək üçün kontekst yenidən yaradılmalı idi.
   */
  cwd?: string | null | undefined
  fileAccess?: string | undefined
  /** YALNIZ `'extended'` səviyyəsində tətbiq olunur (`exec/file-access.ts`). */
  extraDirs?: readonly string[] | undefined
}

/**
 * Yalnız VERİLƏN sahələri yeniləyir.
 *
 * `undefined` ilə `null` fərqi burada vacibdir: `undefined` "toxunma",
 * `null` isə "təyinatı sil" deməkdir. Hamısını bir yerdə yazsaydıq,
 * profil dəyişikliyi büdcəni səssizcə silərdi.
 */
export function updateContext(db: Db, id: string, input: ContextUpdate): Context {
  const values = {
    ...(input.amplificationProfile !== undefined
      ? { amplificationProfile: input.amplificationProfile }
      : {}),
    ...(input.workerMode !== undefined ? { workerMode: input.workerMode } : {}),
    ...(input.defaultWorkerModelId !== undefined
      ? { defaultWorkerModelId: input.defaultWorkerModelId }
      : {}),
    ...(input.verifyCommands !== undefined
      ? { verifyCommandsJson: JSON.stringify(input.verifyCommands) }
      : {}),
    ...(input.maxParallel !== undefined ? { maxParallel: input.maxParallel } : {}),
    ...(input.memoryScope !== undefined ? { memoryScope: input.memoryScope } : {}),
    ...(input.memoryEnabled !== undefined ? { memoryEnabled: input.memoryEnabled } : {}),
    ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.budgetSeconds !== undefined ? { budgetSeconds: input.budgetSeconds } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
    ...(input.extraDirs !== undefined
      ? { extraDirsJson: JSON.stringify(input.extraDirs) }
      : {}),
  }

  if (Object.keys(values).length > 0) {
    db.update(contexts).set(values).where(eq(contexts.id, id)).run()
  }
  return required(getContext(db, id), 'contexts')
}

export function createTask(
  db: Db,
  input: {
    contextId: string
    prompt: string
    taskType?: string
    /** Dekompozisiya (Faza 4) — bu task hansı taskın parçasıdır. */
    parentTaskId?: string
    /** Alt-taskın sırası, 0-dan. Valideyn tasklarda verilmir. */
    subtaskIndex?: number
  },
): Task {
  const id = randomUUID()
  db.insert(tasks)
    .values({
      id,
      contextId: input.contextId,
      prompt: input.prompt,
      taskType: input.taskType ?? 'unknown',
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.subtaskIndex !== undefined ? { subtaskIndex: input.subtaskIndex } : {}),
      createdAt: now(),
    })
    .run()
  return required(db.select().from(tasks).where(eq(tasks.id, id)).get(), 'tasks')
}

/**
 * Bölünmüş taskın alt-taskları — SIRA İLƏ.
 *
 * Sıralama `subtask_index` üzrədir, `created_at` üzrə YOX: alt-tasklar eyni
 * millisaniyədə yaradılır və vaxta görə sıralama müqavilənin ("sonrakı
 * əvvəlkinin üzərində qurur") pozulduğunu göstərməzdi — sadəcə səssizcə səhv
 * sıra verərdi.
 */
export function listSubtasks(db: Db, parentTaskId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(tasks.subtaskIndex)
    .all()
}

export function getTask(db: Db, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get()
}

/** Routing-in determinist təsnifatı — ledger bölgüsü buna görə qurulur. */
export function setTaskType(db: Db, id: string, taskType: string): void {
  db.update(tasks).set({ taskType }).where(eq(tasks.id, id)).run()
}

export function setTaskStatus(db: Db, id: string, status: string): void {
  db.update(tasks)
    .set({
      status,
      ...(TERMINAL_TASK_STATUSES.has(status) ? { completedAt: now() } : {}),
    })
    .where(eq(tasks.id, id))
    .run()
}

export function createRun(
  db: Db,
  input: {
    taskId: string
    runnerId: string
    modelId: string
    ladderRung?: number
    attempt?: number
    cachedHit?: boolean
    subscriptionBilled?: boolean
    worktreePath?: string
    /**
     * Bu icra hansı icradan sonra, PİLLƏ QALXARAQ başladı (Pillə 6/3 → 7).
     * `attempt`-dən FƏRQLİDİR: o, eyni pillədə təkrar cəhddir.
     */
    escalatedFromRunId?: string
  },
): Run {
  const id = randomUUID()
  db.insert(runs)
    .values({
      id,
      taskId: input.taskId,
      runnerId: input.runnerId,
      modelId: input.modelId,
      ladderRung: input.ladderRung ?? 7,
      attempt: input.attempt ?? 1,
      cachedHit: input.cachedHit ?? false,
      subscriptionBilled: input.subscriptionBilled ?? false,
      worktreePath: input.worktreePath ?? null,
      escalatedFromRunId: input.escalatedFromRunId ?? null,
      startedAt: now(),
    })
    .run()
  return required(db.select().from(runs).where(eq(runs.id, id)).get(), 'runs')
}

export function listRunsForTask(db: Db, taskId: string): Run[] {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.startedAt)).all()
}

export function getRunTaskId(db: Db, runId: string): string | undefined {
  return db.select({ taskId: runs.taskId }).from(runs).where(eq(runs.id, runId)).get()?.taskId
}

export function getRun(db: Db, runId: string): Run | undefined {
  return db.select().from(runs).where(eq(runs.id, runId)).get()
}

/**
 * `usage` hadisəsini run sətrinə yazır.
 *
 * DİQQƏT: dəyərlər KUMULYATİVDİR — `+=` deyil, `=` istifadə olunur. Toplama
 * eyni tokenləri bir neçə dəfə sayardı.
 *
 * `costUsd` yoxdursa NULL qalır: "bilinmir" ilə "pulsuz" fərqli şeylərdir.
 */
export function applyUsageToRun(
  db: Db,
  runId: string,
  event: Extract<RunEvent, { t: 'usage' }>,
): void {
  db.update(runs)
    .set({
      tokensIn: event.inputTokens,
      tokensOut: event.outputTokens,
      tokensCacheRead: event.cacheReadTokens ?? 0,
      tokensCacheWrite: event.cacheWriteTokens ?? 0,
      costUsd: event.costUsd ?? null,
      subscriptionBilled: event.billed === 'subscription',
    })
    .where(eq(runs.id, runId))
    .run()
}

export function finishRun(
  db: Db,
  runId: string,
  input: {
    status: 'succeeded' | 'failed' | 'interrupted' | 'budget_exceeded'
    sessionId?: string
    errorClass?: ErrorClass
    errorMessage?: string
  },
): Run {
  db.update(runs)
    .set({
      status: input.status,
      endedAt: now(),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.errorClass !== undefined ? { errorClass: input.errorClass } : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: input.errorMessage.slice(0, 2000) }
        : {}),
    })
    .where(eq(runs.id, runId))
    .run()
  return required(db.select().from(runs).where(eq(runs.id, runId)).get(), 'runs')
}

export interface StoredEvent {
  seq: number
  at: number
  event: RunEvent
}

export function appendEvent(db: Db, runId: string, event: RunEvent): StoredEvent {
  const maxSeq =
    db
      .select({ v: sql<number>`COALESCE(MAX(${runEvents.seq}), 0)` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get()?.v ?? 0
  const seq = maxSeq + 1
  const at = now()
  db.insert(runEvents)
    .values({ runId, seq, type: event.t, payloadJson: JSON.stringify(event), at })
    .run()
  return { seq, at, event }
}

export function listEvents(
  db: Db,
  runId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): StoredEvent[] {
  const where =
    opts.afterSeq !== undefined
      ? and(eq(runEvents.runId, runId), gt(runEvents.seq, opts.afterSeq))
      : eq(runEvents.runId, runId)

  let q = db.select().from(runEvents).where(where).orderBy(asc(runEvents.seq)).$dynamic()
  if (opts.limit !== undefined) q = q.limit(opts.limit)

  return q.all().map((r) => ({
    seq: r.seq,
    at: r.at,
    event: JSON.parse(r.payloadJson) as RunEvent,
  }))
}

/**
 * Server çökdükdən sonra qalan `running` icraları `interrupted` işarələyir.
 * Hadisə jurnalına TOXUNMUR — spesifikasiya onun itməməsini tələb edir.
 */
export function markOrphanedRunsInterrupted(db: Db): number {
  const orphans = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, ['running', 'pending']))
    .all()
  if (orphans.length === 0) return 0

  db.update(runs)
    .set({ status: 'interrupted', endedAt: now() })
    .where(inArray(runs.status, ['running', 'pending']))
    .run()
  return orphans.length
}

type CacheEntry = typeof cacheEntries.$inferSelect
type VerificationRun = typeof verificationRuns.$inferSelect

/** Yoxlama çıxışının maksimum saxlanılan uzunluğu. Modelə geri ötürülür. */
const VERIFY_EXCERPT_LIMIT = 4000

export interface CachedResult {
  hash: string
  modelId: string
  runnerId: string
  events: RunEvent[]
  hits: number
  lastHitAt: number | null
}

export function getCacheEntry(db: Db, hash: string): CachedResult | undefined {
  const row: CacheEntry | undefined = db
    .select()
    .from(cacheEntries)
    .where(eq(cacheEntries.hash, hash))
    .get()
  if (row === undefined) return undefined
  return {
    hash: row.hash,
    modelId: row.modelId,
    runnerId: row.runnerId,
    events: JSON.parse(row.eventsJson) as RunEvent[],
    hits: row.hits,
    lastHitAt: row.lastHitAt,
  }
}

export function putCacheEntry(
  db: Db,
  input: {
    hash: string
    modelId: string
    runnerId: string
    events: readonly RunEvent[]
  },
): void {
  db.insert(cacheEntries)
    .values({
      hash: input.hash,
      modelId: input.modelId,
      runnerId: input.runnerId,
      eventsJson: JSON.stringify(input.events),
      createdAt: now(),
    })
    .onConflictDoUpdate({
      target: cacheEntries.hash,
      set: {
        eventsJson: JSON.stringify(input.events),
        modelId: input.modelId,
        runnerId: input.runnerId,
      },
    })
    .run()
}

export function recordCacheHit(db: Db, hash: string): void {
  db.update(cacheEntries)
    .set({ hits: sql`${cacheEntries.hits} + 1`, lastHitAt: now() })
    .where(eq(cacheEntries.hash, hash))
    .run()
}

export function appendVerification(
  db: Db,
  runId: string,
  input: {
    command: string
    exitCode: number | null
    passed: boolean
    outputExcerpt: string
    durationMs: number
  },
): void {
  db.insert(verificationRuns)
    .values({
      runId,
      command: input.command,
      exitCode: input.exitCode,
      passed: input.passed,
      outputExcerpt: input.outputExcerpt.slice(0, VERIFY_EXCERPT_LIMIT),
      durationMs: input.durationMs,
      at: now(),
    })
    .run()
}

export function listVerifications(db: Db, runId: string): VerificationRun[] {
  return db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.runId, runId))
    .orderBy(asc(verificationRuns.id))
    .all()
}

/** Zolaqda göstərilən prompt parçasının uzunluğu. */
const PROMPT_EXCERPT_CHARS = 60

function excerpt(prompt: string): string {
  // Sətir sonları BİRLƏŞDİRİLİR: zolaq bir sətirlikdir və xam `\n` orada
  // sadəcə boşluq kimi görünərdi, amma uzunluq hesabını korlayardı.
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > PROMPT_EXCERPT_CHARS
    ? `${oneLine.slice(0, PROMPT_EXCERPT_CHARS)}…`
    : oneLine
}

/**
 * Hazırda işləyən icralar — canlı zolaq üçün (Faza 5A).
 *
 * `status = 'running'` filtri kifayətdir: `finishRun` hər terminal halda
 * statusu dəyişir, server çökməsindən sonra qalanları isə başlanğıcdakı
 * `markOrphanedRunsInterrupted` təmizləyir.
 *
 * Mənfi pillələr (distillə -1, bölgü -2) SÜZÜLMÜR: onlar da pul yandırır və
 * "niyə hələ gözləyirəm?" sualının cavabı çox vaxt məhz onlardır. Gizlətsək
 * istifadəçi boş zolağa baxıb sistemi donmuş sayardı.
 */
export function listActiveRuns(db: Db): ActiveRun[] {
  const rows = db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      contextId: tasks.contextId,
      contextName: contexts.name,
      prompt: tasks.prompt,
      modelId: runs.modelId,
      runnerId: runs.runnerId,
      ladderRung: runs.ladderRung,
      attempt: runs.attempt,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(contexts, eq(tasks.contextId, contexts.id))
    .where(eq(runs.status, 'running'))
    .orderBy(asc(runs.startedAt))
    .all()

  return rows.map(({ prompt, ...r }) => ({ ...r, promptExcerpt: excerpt(prompt) }))
}

/** Tək icra — `activity` yayımında `'started'` yükü üçün. */
export function getActiveRun(db: Db, runId: string): ActiveRun | undefined {
  return listActiveRuns(db).find((r) => r.runId === runId)
}

/**
 * Keş sətrini SİLİR — review yazılanda (Faza 5B).
 *
 * İstifadəçi rəy yazırsa, deməli cavab səhv idi; amma o cavab Pillə 0 keşinə
 * ARTIQ düşüb və eyni prompt bir daha göndəriləndə qaytarılardı. Silməsəydik,
 * istifadəçi düzəltdiyini sandığı səhvi bir daha alardı və səbəbini heç yerdə
 * görməzdi.
 */
export function deleteCacheEntry(db: Db, hash: string): void {
  db.delete(cacheEntries).where(eq(cacheEntries.hash, hash)).run()
}

/** `storeInCache` yazdığı açarı icra sətrinə də yazır — bax `runs.cache_key`. */
export function setRunCacheKey(db: Db, runId: string, cacheKey: string): void {
  db.update(runs).set({ cacheKey }).where(eq(runs.id, runId)).run()
}
