import { randomUUID } from 'node:crypto'
import type {
  Capabilities,
  DetectResult,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { ClaudeStreamParser } from './parse-claude.js'
import { resolveExecutable, type ResolvedExecutable } from './resolve-exe.js'
import { spawnLines } from './spawn.js'

/**
 * DƏYİŞMƏZ bayraq dəsti.
 *
 * ÖLÇÜLMÜŞ SƏBƏB: prompt prefiksi dəyişəndə Anthropic prompt-cache-i sınır və
 * ~21.7k token `cache_creation` tarifi (1.25x) ilə yenidən ödənilir. Real
 * ölçmədə öz `--system-prompt`-unu vermək promptu KİÇİLTDİ (25,076 → 21,718),
 * amma xərci 5x ARTIRDI ($0.0085 → $0.0444), çünki keş sındı.
 *
 * Buraya yeni bayraq əlavə etmək = bütün mövcud keşlərin bir dəfəlik sınması.
 * Task-a xas heç nə bura girmir — yalnız istifadəçi mesajına.
 */
export const CLAUDE_STABLE_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  // `stream-json` bunsuz xəta verir:
  // "When using --print, --output-format=stream-json requires --verbose"
  '--verbose',
  // İstifadəçinin CLAUDE.md-si, hook-ları, 45 skill-i və 6 MCP serveri hər
  // çağırışa yüklənir (ölçülmüş: 31,447 → 25,076 prompt token, $0.0251 →
  // $0.0085). Bu onları söndürür, AUTH isə qalır — `--bare`-dən fərqli olaraq.
  '--safe-mode',
  '--strict-mcp-config',
  // Per-maşın bölmələri sistem promptundan çıxarır → keş təkrar istifadəsi artır
  '--exclude-dynamic-system-prompt-sections',
  '--disable-slash-commands',
]

export interface ClaudeArgOptions {
  sessionId?: string
  permissionMode?: 'acceptEdits' | 'plan' | 'dontAsk' | 'manual'
  fallbackModel?: string
}

export function buildClaudeArgs(
  req: RunRequest,
  opts: ClaudeArgOptions = {},
): string[] {
  const args: string[] = ['-p', req.prompt, ...CLAUDE_STABLE_FLAGS]

  args.push('--model', req.model)

  if (req.resumeSessionId !== undefined) {
    args.push('--resume', req.resumeSessionId)
  } else {
    args.push('--session-id', opts.sessionId ?? randomUUID())
  }

  if (req.cwd !== undefined) args.push('--add-dir', req.cwd)
  if (opts.permissionMode !== undefined) {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.fallbackModel !== undefined) {
    args.push('--fallback-model', opts.fallbackModel)
  }

  return args
}

export class ClaudeCliRunner implements Runner {
  readonly id = 'cli:claude'
  readonly kind = 'cli' as const
  readonly capabilities: Capabilities = {
    fileAccess: true,
    toolUse: true,
    sessions: true,
    structuredOutput: true,
    // Abunəlikdən ödənilir → real pul çıxmır, `costUsd` istinad qiymətidir.
    subscriptionBilled: true,
  }

  private resolved: ResolvedExecutable | null | undefined
  private readonly argOptions: ClaudeArgOptions

  constructor(argOptions: ClaudeArgOptions = {}) {
    this.argOptions = argOptions
  }

  private resolve(): ResolvedExecutable | null {
    if (this.resolved === undefined) this.resolved = resolveExecutable('claude')
    return this.resolved
  }

  async detect(): Promise<DetectResult> {
    const exe = this.resolve()
    if (exe === null) {
      return {
        installed: false,
        authenticated: false,
        detail: 'claude PATH-da tapılmadı. `npm i -g @anthropic-ai/claude-code`',
      }
    }

    const proc = spawnLines({
      command: exe.command,
      args: ['--version'],
      useShell: exe.useShell,
    })
    const lines: string[] = []
    for await (const l of proc.lines) lines.push(l)
    const code = await proc.exitCode

    if (code !== 0) {
      return {
        installed: true,
        authenticated: false,
        execPath: exe.command,
        detail: `claude --version xəta verdi (kod ${code}): ${proc
          .stderrText()
          .slice(0, 200)}`,
      }
    }

    // `--version` auth yoxlamır və model çağırmır (pulsuzdur). Auth yalnız
    // ilk real icrada bilinir; onda parser `auth` sinifli xəta emit edir.
    return {
      installed: true,
      authenticated: true,
      version: (lines[0] ?? '').trim(),
      execPath: exe.command,
      detail: 'Hazırdır (auth ilk icrada təsdiqlənir)',
    }
  }

  async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    const exe = this.resolve()
    if (exe === null) {
      yield {
        t: 'error',
        class: 'crashed',
        message: 'claude icra faylı tapılmadı',
      }
      return
    }

    const proc = spawnLines({
      command: exe.command,
      args: buildClaudeArgs(req, this.argOptions),
      useShell: exe.useShell,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    })

    const onAbort = (): void => void proc.kill()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const parser = new ClaudeStreamParser()
    try {
      for await (const line of proc.lines) {
        for (const event of parser.push(line)) yield event
        if (opts?.signal?.aborted === true) break
      }

      const code = await proc.exitCode
      if (code !== 0 && !proc.killed) {
        const stderr = proc.stderrText().trim()
        if (stderr !== '') {
          yield {
            t: 'error',
            class: 'crashed',
            message: `claude çıxış kodu ${code}: ${stderr.slice(0, 500)}`,
            ...(parser.sessionId !== undefined
              ? { sessionId: parser.sessionId }
              : {}),
          }
        }
      }
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort)
      // Ağacı hər halda öldür: yetim `claude.exe` işləməyə davam edərsə
      // istifadəçinin tokenini yandırar.
      await proc.kill()
    }
  }
}
