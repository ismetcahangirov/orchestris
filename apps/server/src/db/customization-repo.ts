import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { Db } from './client.js'
import {
  contextMcpServers,
  contextPlugins,
  mcpServers,
  pluginSources,
} from './schema.js'

export type McpServer = typeof mcpServers.$inferSelect
export type PluginSource = typeof pluginSources.$inferSelect

const now = (): number => Date.now()

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} tapılmadı`)
  return row
}

export function createMcpServer(
  db: Db,
  input: {
    name: string
    transport: string
    command?: string
    args?: readonly string[]
    env?: Record<string, string>
    /** YALNIZ dəyişən ADLARI — dəyərlər keychain-dədir (qayda 13). */
    secretEnv?: readonly string[]
    url?: string
  },
): McpServer {
  const id = randomUUID()
  db.insert(mcpServers)
    .values({
      id,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      argsJson: JSON.stringify(input.args ?? []),
      envJson: JSON.stringify(input.env ?? {}),
      secretEnvJson: JSON.stringify(input.secretEnv ?? []),
      url: input.url ?? null,
      createdAt: now(),
    })
    .run()
  return required(getMcpServer(db, id), 'mcp_servers')
}

export function getMcpServer(db: Db, id: string): McpServer | undefined {
  return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
}

export function listMcpServers(db: Db): McpServer[] {
  return db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all()
}

export function deleteMcpServer(db: Db, id: string): void {
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run()
}

export function createPluginSource(
  db: Db,
  input: { name: string; path: string },
): PluginSource {
  const id = randomUUID()
  db.insert(pluginSources)
    .values({ id, name: input.name, path: input.path, createdAt: now() })
    .run()
  return required(
    db.select().from(pluginSources).where(eq(pluginSources.id, id)).get(),
    'plugin_sources',
  )
}

export function listPluginSources(db: Db): PluginSource[] {
  return db.select().from(pluginSources).orderBy(asc(pluginSources.name)).all()
}

export function deletePluginSource(db: Db, id: string): void {
  db.delete(pluginSources).where(eq(pluginSources.id, id)).run()
}

/**
 * Kontekstin seçdiyi serverlər — ADA GÖRƏ SIRALANMIŞ.
 *
 * Sıralama determinist olmalıdır (qayda 65-dəki eyni səbəb): eyni dəst fərqli
 * sıra ilə fərqli əmr sətri və fərqli MCP konfiqurasiyası verər, yəni prompt
 * keşi lazımsız yerə sınardı.
 */
export function listContextMcpServers(db: Db, contextId: string): McpServer[] {
  return db
    .select({ s: mcpServers })
    .from(contextMcpServers)
    .innerJoin(mcpServers, eq(contextMcpServers.mcpServerId, mcpServers.id))
    .where(eq(contextMcpServers.contextId, contextId))
    .orderBy(asc(mcpServers.name))
    .all()
    .map((r) => r.s)
}

export function listContextPlugins(db: Db, contextId: string): PluginSource[] {
  return db
    .select({ p: pluginSources })
    .from(contextPlugins)
    .innerJoin(pluginSources, eq(contextPlugins.pluginSourceId, pluginSources.id))
    .where(eq(contextPlugins.contextId, contextId))
    .orderBy(asc(pluginSources.name))
    .all()
    .map((r) => r.p)
}

/**
 * Seçimi TAM ƏVƏZ EDİR (əvvəlcə silir, sonra yazır).
 *
 * Qismən yeniləmə «hansı silindi?» sualını çağırana yükləyərdi və UI-dakı
 * checkbox siyahısı onsuz da bütöv vəziyyət göndərir.
 */
export function setContextMcpServers(
  db: Db,
  contextId: string,
  ids: readonly string[],
): void {
  db.delete(contextMcpServers).where(eq(contextMcpServers.contextId, contextId)).run()
  for (const mcpServerId of new Set(ids)) {
    db.insert(contextMcpServers).values({ contextId, mcpServerId }).run()
  }
}

export function setContextPlugins(
  db: Db,
  contextId: string,
  ids: readonly string[],
): void {
  db.delete(contextPlugins).where(eq(contextPlugins.contextId, contextId)).run()
  for (const pluginSourceId of new Set(ids)) {
    db.insert(contextPlugins).values({ contextId, pluginSourceId }).run()
  }
}

/**
 * «Bu server hansı kontekstlərdə işlədilir?»
 *
 * Silmədən ƏVVƏL lazımdır: səssizcə silsək, həmin kontekstlərin növbəti
 * icrası fərqli əmr sətri ilə qaçar və istifadəçi səbəbini heç yerdə görməzdi.
 */
export function contextsUsingMcpServer(db: Db, id: string): string[] {
  return db
    .select({ contextId: contextMcpServers.contextId })
    .from(contextMcpServers)
    .where(eq(contextMcpServers.mcpServerId, id))
    .all()
    .map((r) => r.contextId)
}

export function contextsUsingPlugin(db: Db, id: string): string[] {
  return db
    .select({ contextId: contextPlugins.contextId })
    .from(contextPlugins)
    .where(eq(contextPlugins.pluginSourceId, id))
    .all()
    .map((r) => r.contextId)
}
