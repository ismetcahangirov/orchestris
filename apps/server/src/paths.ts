import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Bütün vəziyyət `~/.orchestris/` altındadır. API açarları BURAYA YAZILMIR —
 * onlar OS keychain-də saxlanılır (sonraki faza).
 *
 * `ORCHESTRIS_HOME` testlərdə müvəqqəti qovluğa yönləndirmək üçündür.
 */
export function orchestrisHome(): string {
  return process.env['ORCHESTRIS_HOME'] ?? join(homedir(), '.orchestris')
}

export function dbPath(): string {
  return join(orchestrisHome(), 'orchestris.db')
}

export function worktreesDir(): string {
  return join(orchestrisHome(), 'worktrees')
}
