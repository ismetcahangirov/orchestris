import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpServer, PluginSource } from '../db/customization-repo.js'

/**
 * Faza 5C — MCP / plugin / daxili skill seçiminin icraya çevrilməsi.
 *
 * ÖLÇÜLMÜŞ TƏMƏL (claude 2.1.220, haiku, eyni prompt, ardıcıl icralar):
 *
 * | Konfiqurasiya | cache_read | cache_create | isti xərc |
 * |---|---|---|---|
 * | sabit dəst (etalon) | 23,447 | 0 | $0.0032 |
 * | −`--safe-mode` +MCP | 0 | **76,161** | $0.0084 |
 * | −`--safe-mode` +MCP +`--setting-sources ''` | 24,872 | 1,579 | **$0.0036** |
 *
 * Yəni `--safe-mode`-u sadəcə çıxarmaq promptu 3.2x böyüdür və keşi TAM
 * sındırır (bir dəfəlik $0.1528 — isti etalonun 48 misli); `--setting-sources ''`
 * isə bunu +12.5%-ə endirir. Bütün bu qat həmin ölçmənin nəticəsidir.
 */

export interface Customizations {
  /** MCP konfiqurasiya faylının yolu. Yoxdursa MCP qoşulmur. */
  mcpConfigPath?: string
  /** Plugin qovluqları — DETERMİNİST sıralanmış. */
  pluginDirs: readonly string[]
  /** Claude Code-un daxili 16 skill-i açılsınmı (+3,648 token, ölçülmüş). */
  builtinSkills: boolean
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(raw)
    return value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

/**
 * Seçilmiş serverlərdən MCP konfiqurasiyası qurur.
 *
 * `secrets` dəyəri tapılmayan server ATILIR (kəsilmir — qayda 39 prinsipi):
 * yarımçıq `env` ilə server ya sınar, ya da səlahiyyətsiz işləyər və səbəb heç
 * yerdə görünməz. Atılan server `skipped` siyahısında qaytarılır ki, çağıran
 * bunu jurnala yaza bilsin.
 */
export function buildMcpConfig(
  servers: readonly McpServer[],
  secrets: (serverId: string, envVar: string) => string | undefined,
): { config: McpConfig | null; skipped: string[] } {
  const mcpServers: Record<string, McpServerConfig> = {}
  const skipped: string[] = []

  for (const s of servers) {
    if (!s.enabled) continue

    const env = parseJson<Record<string, string>>(s.envJson, {})
    const secretNames = parseJson<string[]>(s.secretEnvJson, [])
    let missing = false
    for (const name of secretNames) {
      const value = secrets(s.id, name)
      if (value === undefined) {
        missing = true
        break
      }
      env[name] = value
    }
    if (missing) {
      skipped.push(s.name)
      continue
    }

    const entry: McpServerConfig = {}
    if (s.transport === 'stdio') {
      if (s.command === null) {
        skipped.push(s.name)
        continue
      }
      entry.command = s.command
      entry.args = parseJson<string[]>(s.argsJson, [])
      if (Object.keys(env).length > 0) entry.env = env
    } else {
      if (s.url === null) {
        skipped.push(s.name)
        continue
      }
      entry.type = s.transport
      entry.url = s.url
    }
    mcpServers[s.name] = entry
  }

  return {
    // Boş konfiqurasiya YAZILMIR: `--mcp-config` ilə boş fayl vermək
    // `--safe-mode`-u çıxarmaq deməkdir və ÖDƏNİŞ verir (+3,004 token) —
    // qarşılığında heç nə almadan.
    config: Object.keys(mcpServers).length === 0 ? null : { mcpServers },
    skipped,
  }
}

/**
 * Konfiqurasiyanı FAYLA yazır və yolunu qaytarır.
 *
 * ARGV-yə JSON QOYULMUR: `env` API açarı daşıya bilir və əmr sətri arqumentləri
 * proses siyahısında (`ps`, Task Manager) maşındakı HƏR prosesə görünür. Bu,
 * qayda 14-ün eyni prinsipidir — orada açar URL-ə qoyulmurdu, burada argv-yə.
 *
 * Fayl hər dəfə ÜZƏRİNƏ yazılır (keşlənmir): seçim dəyişəndə köhnə fayl
 * səssizcə işlədilərdi.
 */
export function writeMcpConfig(dir: string, contextId: string, config: McpConfig): string {
  const path = join(dir, `${contextId}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  return path
}

/**
 * Fərdiləşdirmə deskriptoru.
 *
 * `undefined` = HEÇ NƏ seçilməyib → runner `CLAUDE_STABLE_FLAGS` işlədir və
 * əmr sətri BAYT-BAYT köhnə qalır. Mövcud prompt keşlərinin toxunulmazlığı
 * məhz buna bağlıdır (qayda 1).
 */
export function resolveCustomizations(input: {
  mcpConfigPath: string | undefined
  pluginDirs: readonly string[]
  builtinSkills: boolean
}): Customizations | undefined {
  const dirs = [...new Set(input.pluginDirs)].sort()
  if (input.mcpConfigPath === undefined && dirs.length === 0 && !input.builtinSkills) {
    return undefined
  }
  return {
    ...(input.mcpConfigPath !== undefined ? { mcpConfigPath: input.mcpConfigPath } : {}),
    pluginDirs: dirs,
    builtinSkills: input.builtinSkills,
  }
}

/** Kontekstin seçdiyi plugin qovluqları. */
export function pluginDirsOf(plugins: readonly PluginSource[]): string[] {
  return plugins.map((p) => p.path)
}
