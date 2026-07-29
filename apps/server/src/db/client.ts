import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dbPath } from '../paths.js'
import { runMigrations } from './migrate.js'
import * as schema from './schema.js'

/**
 * `$client` xam `better-sqlite3` bağlantısıdır. Migrasiya və PRAGMA-lar üçün
 * lazımdır — drizzle onları ifadə edə bilmir.
 */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

export function openDb(file = dbPath()): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  // WAL: oxuma yazmanı bloklamır — UI icra zamanı hadisələri oxuyur.
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  runMigrations(db)
  // `foreign_keys` MİGRASİYADAN SONRA açılır. SQLite bu pragma-nı tranzaksiya
  // içində saymır, drizzle isə migrasiyaları `BEGIN`/`COMMIT` arasında qaçırır —
  // gələcəkdə cədvəl yenidənqurma tələb edən migrasiya (SQLite-da sütun
  // dəyişikliyi belədir) FK açıq ikən sınardı.
  sqlite.pragma('foreign_keys = ON')
  return db
}
