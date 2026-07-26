import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Vitest 3 resolves `test.projects` entries eagerly: a literal (non-glob)
// path that doesn't exist yet throws a hard startup error instead of just
// matching nothing. At this point in the monorepo, apps/server and
// packages/* don't exist yet (later tasks create them), so we only list a
// project entry once its directory is actually present. When nothing exists
// yet, `projects` is omitted entirely and vitest falls back to its normal
// single-project mode (reporting "No test files found").
const projects: string[] = []
if (existsSync('packages')) projects.push('packages/*')
if (existsSync('apps/server')) projects.push('apps/server')

export default defineConfig({
  test: projects.length > 0 ? { projects } : {},
})
