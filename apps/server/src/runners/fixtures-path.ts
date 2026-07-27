import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repo kökünü tapır — `pnpm-workspace.yaml` faylının olduğu qovluq.
 *
 * `process.cwd()` işlətmək OLMAZ: vitest `apps/server`-i ayrı proyekt kimi
 * qaçırır və cwd repo kökü olmur.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Repo kökü tapılmadı (pnpm-workspace.yaml axtarıldı)')
}

export function fixturesDir(): string {
  return join(repoRoot(), 'fixtures', 'cli')
}

export function fixturePath(name: string): string {
  return join(fixturesDir(), name)
}
