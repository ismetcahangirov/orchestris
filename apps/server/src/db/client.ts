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
`

export function openDb(file = dbPath()): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  // WAL: oxuma yazmanı bloklamır — UI icra zamanı hadisələri oxuyur.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}
