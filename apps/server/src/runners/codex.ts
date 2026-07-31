import type {
  Capabilities,
  DetectResult,
  FileAccessLevel,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { CodexStreamParser } from './parse-codex.js'
import { resolveExecutable, type ResolvedExecutable } from './resolve-exe.js'
import { spawnLines } from './spawn.js'

export const CODEX_STABLE_FLAGS: readonly string[] = [
  '--json',
  '--skip-git-repo-check',
]

/**
 * Səviyyə → `codex --sandbox` (Faza 5A).
 *
 * `danger-full-access` XƏRİTƏDƏ YOXDUR, halbuki codex onu dəstəkləyir: bizim
 * `'extended'` səviyyəmiz SEÇİLMİŞ qovluqlar deməkdir, `danger-full-access`
 * isə bütün diski açır və claude tərəfində qarşılığı yoxdur. Qoysaydıq eyni
 * səviyyə iki runner-də fərqli şey ifadə edərdi — məhz o asimmetriya aradan
 * qaldırılır.
 */
const SANDBOX_BY_LEVEL: Record<FileAccessLevel, 'read-only' | 'workspace-write'> = {
  'read-only': 'read-only',
  workspace: 'workspace-write',
  extended: 'workspace-write',
}

export interface CodexArgOptions {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  outputSchemaPath?: string
}

export function buildCodexArgs(
  req: RunRequest,
  opts: CodexArgOptions = {},
): string[] {
  const args: string[] = ['exec']

  if (req.resumeSessionId !== undefined) args.push('resume', req.resumeSessionId)

  args.push(...CODEX_STABLE_FLAGS)
  args.push('--model', req.model)
  // Default `read-only`: yazma icazəsi yalnız açıq tələb olunanda verilir.
  const sandbox =
    req.fileAccess !== undefined
      ? SANDBOX_BY_LEVEL[req.fileAccess.level]
      : (opts.sandbox ?? 'read-only')
  args.push('--sandbox', sandbox)

  // ÖLÇÜLDÜ (`codex exec --help`): `--add-dir <DIR>` MÖVCUDDUR —
  // "Additional directories that should be writable alongside the primary
  // workspace". Yəni `'extended'` səviyyəsi hər iki CLI-da EYNİ mənanı verir.
  //
  // İki incəlik:
  //  - `cwd` ÖTÜRÜLMÜR: codex üçün o, artıq "primary workspace"-dir (prosesin
  //    öz qovluğu). Təkrar versək arqument mənasız dublikat olardı.
  //  - `read-only` sandbox-da HEÇ NƏ ötürülmür: bayrağın mənası "yazıla
  //    bilən" qovluqdur və yalnız-oxu rejimində bu, ziddiyyətdir.
  if (req.fileAccess !== undefined && sandbox === 'workspace-write') {
    for (const dir of req.fileAccess.dirs) {
      if (dir !== req.cwd) args.push('--add-dir', dir)
    }
  }
  if (opts.outputSchemaPath !== undefined) {
    args.push('--output-schema', opts.outputSchemaPath)
  }

  // Prompt SON arqumentdir — codex pozitional prompt gözləyir.
  args.push(req.prompt)
  return args
}

export function parseLoginStatus(
  stdout: string,
  exitCode: number | null,
): boolean {
  if (exitCode !== 0) return false
  return !/not logged in/i.test(stdout)
}

export class CodexCliRunner implements Runner {
  readonly id = 'cli:codex'
  readonly kind = 'cli' as const
  readonly capabilities: Capabilities = {
    fileAccess: true,
    toolUse: true,
    sessions: true,
    structuredOutput: true,
    subscriptionBilled: true,
  }

  private resolved: ResolvedExecutable | null | undefined
  private readonly argOptions: CodexArgOptions

  constructor(argOptions: CodexArgOptions = {}) {
    this.argOptions = argOptions
  }

  private resolve(): ResolvedExecutable | null {
    if (this.resolved === undefined) this.resolved = resolveExecutable('codex')
    return this.resolved
  }

  async detect(): Promise<DetectResult> {
    const exe = this.resolve()
    if (exe === null) {
      return {
        installed: false,
        authenticated: false,
        detail: 'codex PATH-da tapılmadı',
      }
    }

    const versionProc = spawnLines({
      command: exe.command,
      args: ['--version'],
      useShell: exe.useShell,
    })
    const versionLines: string[] = []
    for await (const l of versionProc.lines) versionLines.push(l)
    await versionProc.exitCode

    // Codex-in `login status` subkomandası var — auth-u ÖNCƏDƏN bilirik,
    // claude-dan fərqli olaraq ilk icranı gözləmək lazım deyil.
    const loginProc = spawnLines({
      command: exe.command,
      args: ['login', 'status'],
      useShell: exe.useShell,
    })
    const loginLines: string[] = []
    for await (const l of loginProc.lines) loginLines.push(l)
    const loginCode = await loginProc.exitCode
    const stdout = loginLines.join('\n')
    const authenticated = parseLoginStatus(stdout, loginCode)

    return {
      installed: true,
      authenticated,
      version: (versionLines[0] ?? '').trim(),
      execPath: exe.command,
      detail: authenticated
        ? stdout.trim() || 'Login olunmuş'
        : 'Login olunmayıb — terminalda `codex login` işlət',
    }
  }

  async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    const exe = this.resolve()
    if (exe === null) {
      yield {
        t: 'error',
        class: 'crashed',
        message: 'codex icra faylı tapılmadı',
      }
      return
    }

    // `spawnLines` stdin-i `ignore` edir — bu olmadan codex
    // "Reading additional input from stdin..." deyib əbədi donur.
    const proc = spawnLines({
      command: exe.command,
      args: buildCodexArgs(req, this.argOptions),
      useShell: exe.useShell,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    })

    const onAbort = (): void => void proc.kill()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const parser = new CodexStreamParser()
    try {
      for await (const line of proc.lines) {
        for (const event of parser.push(line)) yield event
        if (opts?.signal?.aborted === true) break
      }
      await proc.exitCode
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort)
      await proc.kill()
    }
  }
}
