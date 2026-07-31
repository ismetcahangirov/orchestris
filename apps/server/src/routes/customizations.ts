import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CreateMcpServerBody, CreatePluginBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import {
  contextsUsingMcpServer,
  contextsUsingPlugin,
  createMcpServer,
  createPluginSource,
  deleteMcpServer,
  deletePluginSource,
  getMcpServer,
  listMcpServers,
  listPluginSources,
  type McpServer,
} from '../db/customization-repo.js'
import type { CredentialStore } from '../secrets/keychain.js'

/** Keychain-dəki MCP sirrinin adı — qayda 13 ilə eyni forma. */
export function mcpSecretRef(serverId: string, envVar: string): string {
  return `mcp:${serverId}:${envVar}`
}

/**
 * Cavab forması — SİRR YOXDUR.
 *
 * Yalnız `hasSecret` və dəyişən ADLARI verilir. Dəyər heç bir cavab sxemində
 * olmamalıdır (qayda 13) — bu funksiya həmin təminatın yeganə yeridir.
 */
function publicView(s: McpServer): Record<string, unknown> {
  const secretNames = JSON.parse(s.secretEnvJson) as string[]
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: JSON.parse(s.argsJson) as string[],
    env: JSON.parse(s.envJson) as Record<string, string>,
    secretEnvNames: secretNames,
    hasSecret: secretNames.length > 0,
    url: s.url,
    enabled: s.enabled,
    createdAt: s.createdAt,
  }
}

/** Yolun mövcudluğu — qovluq VƏ YA `.zip` faylı qəbul edilir. */
async function pathProblem(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return `Yol mütləq olmalıdır: ${path}`
  try {
    const info = await stat(path)
    if (info.isDirectory()) return null
    if (info.isFile() && path.toLowerCase().endsWith('.zip')) return null
    return `Plugin qovluq və ya .zip olmalıdır: ${path}`
  } catch {
    return `Yol tapılmadı: ${path}`
  }
}

export interface CustomizationRouteDeps {
  db: Db
  credentials: CredentialStore
}

export function registerCustomizationRoutes(
  app: FastifyInstance,
  deps: CustomizationRouteDeps,
): void {
  const { db, credentials } = deps

  app.get('/api/mcp-servers', async () => ({
    servers: listMcpServers(db).map(publicView),
  }))

  app.post('/api/mcp-servers', async (req, reply) => {
    const parsed = CreateMcpServerBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    const body = parsed.data

    const secretEntries = Object.entries(body.secretEnv ?? {})
    // Keychain əlçatan deyilsə sirli server ƏLAVƏ EDİLMİR: səssizcə DB-yə
    // yazmaq qadağandır (qayda 13). Sirsiz server isə normal əlavə olunur.
    if (secretEntries.length > 0) {
      const health = await credentials.health()
      if (!health.ok) {
        return reply.code(503).send({
          error: `OS açar anbarı əlçatmazdır: ${health.detail ?? 'səbəb bilinmir'}`,
        })
      }
    }

    const server = createMcpServer(db, {
      name: body.name,
      transport: body.transport,
      ...(body.command !== undefined ? { command: body.command } : {}),
      ...(body.args !== undefined ? { args: body.args } : {}),
      ...(body.env !== undefined ? { env: body.env } : {}),
      secretEnv: secretEntries.map(([name]) => name),
      ...(body.url !== undefined ? { url: body.url } : {}),
    })

    for (const [name, value] of secretEntries) {
      await credentials.set(mcpSecretRef(server.id, name), value)
    }

    return reply.code(201).send(publicView(server))
  })

  app.delete<{ Params: { id: string } }>('/api/mcp-servers/:id', async (req, reply) => {
    const server = getMcpServer(db, req.params.id)
    if (server === undefined) return reply.code(404).send({ error: 'Server tapılmadı' })

    // İşlədən kontekst varsa SƏSSİZCƏ silmirik: həmin kontekstlərin növbəti
    // icrası fərqli əmr sətri ilə qaçar (bəlkə də tamamilə fərdiləşdirməsiz)
    // və istifadəçi səbəbini heç yerdə görməzdi.
    const used = contextsUsingMcpServer(db, server.id)
    if (used.length > 0) {
      return reply
        .code(409)
        .send({ error: 'Server kontekstlərdə işlədilir', contexts: used })
    }

    for (const name of JSON.parse(server.secretEnvJson) as string[]) {
      await credentials.delete(mcpSecretRef(server.id, name))
    }
    deleteMcpServer(db, server.id)
    return { ok: true }
  })

  app.get('/api/plugins', async () => ({ plugins: listPluginSources(db) }))

  app.post('/api/plugins', async (req, reply) => {
    const parsed = CreatePluginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    // Yol icra anında deyil, İNDİ yoxlanılır: səhv yol yalnız ilk taskda üzə
    // çıxsaydı istifadəçi artıq gözləyir və pul ödəyib (qayda 65 ilə eyni).
    const problem = await pathProblem(parsed.data.path)
    if (problem !== null) return reply.code(400).send({ error: problem })

    return reply.code(201).send(createPluginSource(db, parsed.data))
  })

  app.delete<{ Params: { id: string } }>('/api/plugins/:id', async (req, reply) => {
    const used = contextsUsingPlugin(db, req.params.id)
    if (used.length > 0) {
      return reply
        .code(409)
        .send({ error: 'Plugin kontekstlərdə işlədilir', contexts: used })
    }
    deletePluginSource(db, req.params.id)
    return { ok: true }
  })

  /**
   * İstifadəçinin `~/.claude.json`-undakı MCP serverləri — YALNIZ OXUNUR.
   *
   * Məqsəd: istifadəçi onsuz da qurduğu serveri əl ilə yenidən yazmasın.
   * Fayl DƏYİŞDİRİLMİR və sirlər QAYTARILMIR — yalnız ad, transport və (stdio
   * üçün) əmr. `env` dəyərləri açar daşıya bilir, ona görə onlar da atılır;
   * istifadəçi sirri əlavə edərkən özü yazır.
   */
  app.get('/api/mcp-servers/available', async () => {
    let raw: string
    try {
      raw = await readFile(join(homedir(), '.claude.json'), 'utf8')
    } catch {
      return { servers: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { servers: [] }
    }
    const map = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers
    if (typeof map !== 'object' || map === null) return { servers: [] }

    const existing = new Set(listMcpServers(db).map((s) => s.name))
    const servers = Object.entries(map).map(([name, value]) => {
      const v = value as { command?: unknown; url?: unknown; type?: unknown }
      return {
        name,
        transport:
          typeof v.type === 'string' ? v.type : v.url !== undefined ? 'http' : 'stdio',
        command: typeof v.command === 'string' ? v.command : null,
        url: typeof v.url === 'string' ? v.url : null,
        /** Artıq əlavə edilibsə UI onu təkrar təklif etməməlidir. */
        added: existing.has(name),
      }
    })
    return { servers }
  })
}
