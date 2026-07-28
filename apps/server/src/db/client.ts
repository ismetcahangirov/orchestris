import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dbPath } from '../paths.js'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

/** Cədvəlləri yaradan DDL. drizzle-kit migrasiyaları sonrakı fazada. */
const DDL = `
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT,
  amplification_profile TEXT NOT NULL DEFAULT 'balanced',
  worker_mode TEXT NOT NULL DEFAULT 'auto',
  auto_submode TEXT NOT NULL DEFAULT 'cheap',
  default_worker_model_id TEXT,
  verify_commands_json TEXT NOT NULL DEFAULT '[]',
  budget_tokens INTEGER,
  budget_usd REAL,
  budget_seconds INTEGER,
  max_parallel INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  parent_task_id TEXT,
  prompt TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_context_idx ON tasks(context_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ladder_rung INTEGER NOT NULL DEFAULT 7,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  subscription_billed INTEGER NOT NULL DEFAULT 0,
  cached_hit INTEGER NOT NULL DEFAULT 0,
  escalated_from_run_id TEXT,
  session_id TEXT,
  worktree_path TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_class TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, started_at);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_events_seq_idx ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS cache_entries (
  hash TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  events_json TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER
);
CREATE INDEX IF NOT EXISTS cache_model_idx ON cache_entries(model_id);
CREATE TABLE IF NOT EXISTS verification_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  exit_code INTEGER,
  passed INTEGER NOT NULL,
  output_excerpt TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_run_idx ON verification_runs(run_id);
CREATE TABLE IF NOT EXISTS routing_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  chosen_model_id TEXT,
  runner_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  decision_tokens INTEGER NOT NULL DEFAULT 0,
  decision_cost_usd REAL,
  rule_id TEXT,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routing_task_idx ON routing_decisions(task_id, at);
CREATE TABLE IF NOT EXISTS savings_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL DEFAULT 'unknown',
  actual_cost_usd REAL,
  actual_subscription_usd REAL,
  baseline_cost_usd REAL,
  baseline_model_id TEXT,
  baseline_subscription INTEGER NOT NULL DEFAULT 0,
  orchestration_cost_usd REAL,
  memory_cost_usd REAL NOT NULL DEFAULT 0,
  net_saving_usd REAL,
  cached_hit INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS savings_task_idx ON savings_ledger(task_id);
CREATE INDEX IF NOT EXISTS savings_at_idx ON savings_ledger(at);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'api',
  display_name TEXT NOT NULL,
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_discovery_at INTEGER,
  last_discovery_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_limit INTEGER,
  output_limit INTEGER,
  price_in REAL,
  price_out REAL,
  price_cache_read REAL,
  price_cache_write REAL,
  tool_call INTEGER NOT NULL DEFAULT 0,
  structured_output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'models.dev',
  enabled INTEGER NOT NULL DEFAULT 1,
  role_boss INTEGER NOT NULL DEFAULT 0,
  role_worker INTEGER NOT NULL DEFAULT 0,
  role_classifier INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS models_provider_idx ON models(provider_id);
-- Başçı və klassifikator YALNIZ BİR model ola bilər. Qismən (partial) unikal
-- indeks: yalnız 1 olan sətirlərə tətbiq olunur, 0-lar sərbəst təkrarlanır.
-- Bu, "iki başçı" vəziyyətini tətbiq qatında yox, BAZADA qeyri-mümkün edir.
CREATE UNIQUE INDEX IF NOT EXISTS models_single_boss_idx
  ON models(role_boss) WHERE role_boss = 1;
CREATE UNIQUE INDEX IF NOT EXISTS models_single_classifier_idx
  ON models(role_classifier) WHERE role_classifier = 1;
`

export function openDb(file = dbPath()): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  // WAL: oxuma yazmanı bloklamır — UI icra zamanı hadisələri oxuyur.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  // `CREATE TABLE IF NOT EXISTS` mövcud cədvələ yeni SÜTUN əlavə etmir.
  // Faza 1A-dan qalan bazalar üçün `attempt` sütununu idempotent əlavə edirik.
  // (drizzle-kit migrasiyaları sonrakı fazada; indi bu kifayətdir.)
  const addColumn = (table: string, column: string, ddl: string): void => {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
  }
  addColumn('runs', 'attempt', 'attempt INTEGER NOT NULL DEFAULT 1')
  // Faza 1C: CLI runner-ləri də `providers` cədvəlində saxlanılır ki, Auto
  // rejimi onların modellərini namizəd kimi görsün.
  addColumn('providers', 'kind', `kind TEXT NOT NULL DEFAULT 'api'`)
  return drizzle(sqlite, { schema })
}
