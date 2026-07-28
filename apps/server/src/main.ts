import type { Runner } from '@orchestris/shared'
import { buildApp } from './app.js'
import { openDb } from './db/client.js'
import { createApiRunners } from './runners/api-factory.js'
import { ClaudeCliRunner } from './runners/claude.js'
import { CodexCliRunner } from './runners/codex.js'
import { KeyringStore } from './secrets/keychain.js'

const PORT = Number(process.env['PORT'] ?? 4319)

const db = openDb()
// Anbar İKİ yerdə lazımdır — REST route-ları (açar yazma) və API runner-ləri
// (açar oxuma). Eyni nüsxə paylaşılır ki, `health()` nəticəsi də eyni olsun.
const credentials = new KeyringStore()

const runners = new Map<string, Runner>([
  ['cli:claude', new ClaudeCliRunner({ permissionMode: 'acceptEdits' })],
  ['cli:codex', new CodexCliRunner()],
  ...createApiRunners({ db, credentials }).runners,
])

const app = buildApp({ db, runners, credentials, logger: true })

// Yalnız 127.0.0.1 — xarici şəbəkəyə açılmır (spesifikasiya tələbi).
await app.listen({ port: PORT, host: '127.0.0.1' })
app.log.info(`Orchestris http://127.0.0.1:${PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}
