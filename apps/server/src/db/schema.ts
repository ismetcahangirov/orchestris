import { relations } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** İş sahəsi — istifadəçinin "yeni kontekst başlat" dediyi şey. */
export const contexts = sqliteTable('contexts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cwd: text('cwd'),
  amplificationProfile: text('amplification_profile').notNull().default('balanced'),
  workerMode: text('worker_mode').notNull().default('auto'),
  autoSubmode: text('auto_submode').notNull().default('cheap'),
  defaultWorkerModelId: text('default_worker_model_id'),
  /** JSON massiv: yoxlama əmrləri, məs. ["pnpm typecheck","pnpm test"] */
  verifyCommandsJson: text('verify_commands_json').notNull().default('[]'),
  budgetTokens: integer('budget_tokens'),
  budgetUsd: real('budget_usd'),
  budgetSeconds: integer('budget_seconds'),
  maxParallel: integer('max_parallel').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
})

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    parentTaskId: text('parent_task_id'),
    prompt: text('prompt').notNull(),
    taskType: text('task_type').notNull().default('unknown'),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [index('tasks_context_idx').on(t.contextId, t.createdAt)],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runnerId: text('runner_id').notNull(),
    modelId: text('model_id').notNull(),
    ladderRung: integer('ladder_rung').notNull().default(7),
    /**
     * Yoxlama dövrəsində neçənci cəhddir. 1-dən başlayır. Eyni task üçün
     * bir neçə run olur: hər uğursuz yoxlamadan sonra yenisi yaradılır.
     * `escalatedFromRunId` bundan FƏRQLİDİR — o, pillələr arası keçid üçündür.
     */
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull().default('running'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    /** NULL = xərc BİLİNMİR (codex xərc bildirmir). 0 = həqiqətən pulsuz. */
    costUsd: real('cost_usd'),
    /** true → abunəlikdən getdi, real pul çıxmadı */
    subscriptionBilled: integer('subscription_billed', { mode: 'boolean' })
      .notNull()
      .default(false),
    cachedHit: integer('cached_hit', { mode: 'boolean' }).notNull().default(false),
    escalatedFromRunId: text('escalated_from_run_id'),
    sessionId: text('session_id'),
    worktreePath: text('worktree_path'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
  },
  (t) => [index('runs_task_idx').on(t.taskId, t.startedAt)],
)

/** Append-only hadisə jurnalı — "modellərin gördüyü işi görə bilək" budur. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('run_events_seq_idx').on(t.runId, t.seq)],
)

export const contextsRelations = relations(contexts, ({ many }) => ({
  tasks: many(tasks),
}))
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  context: one(contexts, { fields: [tasks.contextId], references: [contexts.id] }),
  runs: many(runs),
}))
/**
 * Pillə 0 — hazır nəticə keşi.
 *
 * `hash` açarı `cache-key.ts`-də hesablanır və iş qovluğunun git vəziyyətini
 * də əhatə edir: eyni prompt fərqli kod üzərində fərqli cavab tələb edir.
 */
export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    hash: text('hash').primaryKey(),
    modelId: text('model_id').notNull(),
    runnerId: text('runner_id').notNull(),
    /** Saxlanılan `RunEvent[]` — JSON massiv. */
    eventsJson: text('events_json').notNull(),
    hits: integer('hits').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    lastHitAt: integer('last_hit_at'),
  },
  (t) => [index('cache_model_idx').on(t.modelId)],
)

/** Pillə 2 — hər determinist yoxlama əmrinin nəticəsi. */
export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    exitCode: integer('exit_code'),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    /** Çıxışın ilk hissəsi — modelə geri ötürülən budur. */
    outputExcerpt: text('output_excerpt').notNull(),
    durationMs: integer('duration_ms').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('verification_run_idx').on(t.runId)],
)

export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  events: many(runEvents),
  verifications: many(verificationRuns),
}))
