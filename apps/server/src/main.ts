import type { Runner } from '@orchestris/shared'
import { buildApp } from './app.js'
import { openDb } from './db/client.js'
import { ClaudeCliRunner } from './runners/claude.js'
import { CodexCliRunner } from './runners/codex.js'

const PORT = Number(process.env['PORT'] ?? 4319)

const db = openDb()
const runners = new Map<string, Runner>([
  ['cli:claude', new ClaudeCliRunner({ permissionMode: 'acceptEdits' })],
  ['cli:codex', new CodexCliRunner()],
])

const app = buildApp({ db, runners, logger: true })

// Yalnız 127.0.0.1 — xarici şəbəkəyə açılmır (spesifikasiya tələbi).
await app.listen({ port: PORT, host: '127.0.0.1' })
app.log.info(`Orchestris http://127.0.0.1:${PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}
