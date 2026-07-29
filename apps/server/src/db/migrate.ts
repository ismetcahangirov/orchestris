import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { Db } from './client.js'

type Sqlite = Database.Database

/**
 * `drizzle/` qovluğunu MODULUN ÖZ yerindən tapır.
 *
 * `process.cwd()` işlətmək OLMAZ: vitest `apps/server`-i ayrı proyekt kimi
 * qaçırır, dev server repo kökündən başladılır, `dist/`-dən qaçanda isə cwd
 * tamamilə başqa yer ola bilər. Yuxarı qalxmaq həm `src/db/`, həm də
 * `dist/db/` üçün eyni nəticəni verir — hər ikisindən `apps/server/drizzle`-a
 * çıxılır.
 */
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'drizzle')
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Migrasiya qovluğu tapılmadı (drizzle/meta/_journal.json axtarıldı)')
}

/** drizzle-in öz migrasiya cədvəli — adı `sqlite-core/dialect.ts`-dən gəlir. */
const MIGRATIONS_TABLE = '__drizzle_migrations'

/**
 * Faza 1A–1C-də sxem əl ilə yazılmış DDL ilə yaradılırdı. O bazalarda cədvəllər
 * VAR, amma `__drizzle_migrations` YOXDUR — migrator onları yeni baza sayıb
 * `CREATE TABLE contexts` icra edər və "table already exists" ilə sınardı.
 *
 * Ona görə belə bazalar bir dəfə "möhürlənir": 0000 migrasiyasının yalnız
 * ÇATIŞMAYAN obyektləri yaradılır, sonra migrasiya artıq tətbiq olunmuş kimi
 * qeyd edilir. Bundan sonra 0001+ normal yolla gedir.
 */
function baselineLegacyDb(sqlite: Sqlite, folder: string): void {
  const existing = objectNames(sqlite)
  if (existing.has(MIGRATIONS_TABLE)) return // artıq migrasiya idarəsindədir
  if (!existing.has('contexts')) return // tamamilə yeni baza — normal yol

  const baseline = readMigrationFiles({ migrationsFolder: folder })[0]
  if (!baseline) throw new Error('Migrasiya faylı tapılmadı — baseline möhürlənə bilməz')

  for (const stmt of baseline.sql) {
    const name = createdObjectName(stmt)
    if (name === null) {
      // 0000 yalnız CREATE-lərdən ibarətdir. Bu dəyişsə, "mövcuddursa keç"
      // məntiqi səssizcə yanlış olardı — səssiz yerinə bərk sınmaq lazımdır.
      throw new Error(`Baseline yalnız CREATE ifadələrini dəstəkləyir: ${stmt.slice(0, 60)}`)
    }
    if (!existing.has(name)) sqlite.exec(stmt)
  }

  // `CREATE TABLE` mövcud cədvələ yeni SÜTUN əlavə etmir — 1A/1B bazalarında
  // bu iki sütun sonradan gəlmişdi və yuxarıdakı döngə onları görmür.
  addColumnIfMissing(sqlite, 'runs', 'attempt', 'attempt INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(sqlite, 'providers', 'kind', `kind TEXT NOT NULL DEFAULT 'api'`)

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`,
  )
  sqlite
    .prepare(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`)
    .run(baseline.hash, baseline.folderMillis)
}

function objectNames(sqlite: Sqlite): Set<string> {
  const rows = sqlite.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/** `CREATE [UNIQUE] TABLE|INDEX \`ad\`` → `ad`. CREATE deyilsə `null`. */
function createdObjectName(stmt: string): string | null {
  const m = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)/i.exec(
    stmt,
  )
  return m?.[1] ?? null
}

function addColumnIfMissing(sqlite: Sqlite, table: string, column: string, ddl: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

/**
 * Sxemi cari vəziyyətə gətirir. `openDb` hər açılışda çağırır — istifadəçi
 * lokal tətbiqdə ayrıca migrasiya əmri yazmamalıdır.
 */
export function runMigrations(db: Db): void {
  const folder = migrationsFolder()
  baselineLegacyDb(db.$client, folder)
  migrate(db, { migrationsFolder: folder })
}
