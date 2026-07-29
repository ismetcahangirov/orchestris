import { defineConfig } from 'drizzle-kit'

/**
 * Migrasiya SQL-i BURADAN generasiya olunur:
 *
 *     pnpm --filter @orchestris/server db:generate
 *
 * `dbCredentials` qəsdən yoxdur — `drizzle-kit generate` bazaya QOŞULMUR,
 * yalnız sxemi əvvəlki snapshot ilə müqayisə edib SQL yazır. Qoşulma tələb
 * edən `push`/`studio` bu layihədə istifadə olunmur: migrasiyalar tətbiqin
 * öz başlanğıcında (`db/migrate.ts`) qaçırılır ki, istifadəçi ayrıca əmr
 * yazmasın.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
