import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './client.js'
import { migrationsFolder } from './migrate.js'

const tmpDirs: string[] = []
const opened: Db[] = []

function tmpDb(name = 'legacy.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestris-migrate-'))
  tmpDirs.push(dir)
  return join(dir, name)
}

/** Windows açıq fayl deskriptoru olan faylı silməyə qoymur — bağlamaq şərtdir. */
function open(file: string): Db {
  const db = openDb(file)
  opened.push(db)
  return db
}

afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function objects(file: string): { name: string; type: string; sql: string | null }[] {
  const sqlite = new Database(file, { readonly: true })
  const rows = sqlite
    .prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
       ORDER BY name`,
    )
    .all() as { name: string; type: string; sql: string | null }[]
  sqlite.close()
  return rows
}

function columns(file: string, table: string): string[] {
  const sqlite = new Database(file, { readonly: true })
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  sqlite.close()
  return rows.map((r) => r.name)
}

function migrationRows(file: string): { hash: string; created_at: number }[] {
  const sqlite = new Database(file, { readonly: true })
  const rows = sqlite
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as { hash: string; created_at: number }[]
  sqlite.close()
  return rows
}

/**
 * Faza 1A-nın (commit b7bd21f) əl ilə yazılmış DDL-i — məhz bu şəkildə
 * yaradılmış bazalar istifadəçinin diskindədir. `runs.attempt` sütunu,
 * `providers`/`models`/`savings_ledger` cədvəlləri hələ yox idi.
 */
const FAZA_1A_DDL = `
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

/** Faza 1A bazası yaradır və içinə real məlumat qoyur. */
function seedFaza1aDb(): string {
  const file = tmpDb()
  const sqlite = new Database(file)
  sqlite.exec(FAZA_1A_DDL)
  sqlite
    .prepare('INSERT INTO contexts (id, name, created_at) VALUES (?, ?, ?)')
    .run('ctx1', 'Köhnə kontekst', 1000)
  sqlite
    .prepare('INSERT INTO tasks (id, context_id, prompt, created_at) VALUES (?, ?, ?, ?)')
    .run('task1', 'ctx1', 'köhnə task', 1001)
  sqlite
    .prepare(
      'INSERT INTO runs (id, task_id, runner_id, model_id, started_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('run1', 'task1', 'claude', 'claude-haiku-4-5', 1002)
  sqlite.close()
  return file
}

describe('migrationsFolder', () => {
  it('drizzle qovluğunu cwd-dən asılı olmadan tapır', () => {
    const folder = migrationsFolder()
    expect(folder.endsWith('drizzle')).toBe(true)
  })
})

describe('təmiz baza', () => {
  it('migrasiyalarla bütün cədvəlləri yaradır', () => {
    const file = tmpDb('fresh.db')
    open(file)
    const names = objects(file).map((o) => o.name)
    for (const t of [
      'contexts',
      'tasks',
      'runs',
      'run_events',
      'cache_entries',
      'routing_decisions',
      'verification_runs',
      'providers',
      'models',
      'savings_ledger',
    ]) {
      expect(names).toContain(t)
    }
  })

  it('qismən unikal indeksləri də yaradır — iki başçı mümkün deyil', () => {
    const sqlite = openDb(':memory:').$client
    sqlite
      .prepare(
        'INSERT INTO providers (id, display_name, created_at) VALUES (?, ?, ?)',
      )
      .run('anthropic', 'Anthropic', 1)
    const insertModel = sqlite.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, role_boss, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertModel.run('a:1', 'anthropic', '1', 'Bir', 1, 1)
    expect(() => insertModel.run('a:2', 'anthropic', '2', 'İki', 1, 1)).toThrow(/UNIQUE/)
    // 0 olanlar sərbəst təkrarlanır
    insertModel.run('a:3', 'anthropic', '3', 'Üç', 0, 1)
    insertModel.run('a:4', 'anthropic', '4', 'Dörd', 0, 1)
  })

  it('tətbiq olunan migrasiyaları qeyd edir', () => {
    const file = tmpDb('fresh2.db')
    open(file)
    expect(migrationRows(file).length).toBeGreaterThan(0)
  })
})

describe('köhnə (Faza 1A) baza', () => {
  it('məlumatı itirmədən çatışmayan cədvəl və sütunları əlavə edir', () => {
    const file = seedFaza1aDb()
    const sqlite = open(file).$client
    const ctx = sqlite.prepare('SELECT name FROM contexts WHERE id = ?').get('ctx1') as {
      name: string
    }
    expect(ctx.name).toBe('Köhnə kontekst')
    sqlite.close()

    expect(columns(file, 'runs')).toContain('attempt')
    expect(columns(file, 'providers')).toContain('kind')
    expect(objects(file).map((o) => o.name)).toContain('savings_ledger')
  })

  it('mövcud cədvəlləri yenidən yaratmağa cəhd etmir və baseline-ı möhürləyir', () => {
    const file = seedFaza1aDb()
    open(file) // `CREATE TABLE contexts` təkrar icra olunsaydı burada sınardı

    // Sabit rəqəm YAZILMIR: hər yeni migrasiya bu testi səbəbsiz sındırardı və
    // sındığı üçün "yeniləyək" deyib əslindəki invariantı gözdən qaçırardıq.
    // İnvariant budur: möhürlənmiş köhnə baza TƏMİZ baza ilə eyni sayda
    // migrasiya qeydi ilə bitir — nə az (0000 tətbiq olunmuş sayılmayıb), nə çox.
    const fresh = tmpDb('fresh-baseline.db')
    open(fresh)
    expect(migrationRows(file)).toHaveLength(migrationRows(fresh).length)
  })

  it('təkrar açılışda heç nə etmir', () => {
    const file = seedFaza1aDb()
    open(file)
    const before = migrationRows(file)
    open(file)
    expect(migrationRows(file)).toEqual(before)
  })

  it('köhnə bazanı təmiz baza ilə eyni sxemə gətirir', () => {
    const legacy = seedFaza1aDb()
    open(legacy)
    const fresh = tmpDb('fresh3.db')
    open(fresh)

    const names = (file: string) => objects(file).map((o) => `${o.type}:${o.name}`)
    expect(names(legacy)).toEqual(names(fresh))

    // Sütunlar da üst-üstə düşməlidir. `attempt` köhnə bazaya ALTER ilə
    // əlavə olunur və sona düşür, təmiz bazada isə ortadadır — ona görə
    // müqayisə SIRALI deyil, DƏST üzrədir.
    for (const table of ['runs', 'providers', 'models', 'savings_ledger']) {
      expect([...columns(legacy, table)].sort()).toEqual([...columns(fresh, table)].sort())
    }
  })
})
