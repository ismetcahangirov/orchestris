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
export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  events: many(runEvents),
}))
