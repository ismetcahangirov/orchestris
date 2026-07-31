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

/**
 * MCP konfiqurasiya fayllarının qovluğu (Faza 5C).
 *
 * Fayl argv-də verilmir: `env` API açarı daşıya bilir və əmr sətri arqumentləri
 * proses siyahısında maşındakı HƏR prosesə görünür (qayda 14 ilə eyni prinsip).
 */
export function mcpConfigDir(): string {
  return join(orchestrisHome(), 'mcp')
}

export function worktreesDir(): string {
  return join(orchestrisHome(), 'worktrees')
}
