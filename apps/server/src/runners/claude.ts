import { randomUUID } from 'node:crypto'
import type {
  Capabilities,
  DetectResult,
  FileAccessLevel,
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

/**
 * İKİNCİ dondurulmuş dəst — fərdiləşdirmə (MCP/plugin/skill) seçilmiş
 * kontekstlər üçün (Faza 5C).
 *
 * `CLAUDE_STABLE_FLAGS` DƏYİŞMİR və default olaraq qalır: seçim etməyən
 * kontekstin əmr sətri BAYT-BAYT köhnə qalır, yəni mövcud keşlər sınmır.
 *
 * ÖLÇÜLMÜŞ (claude 2.1.220, `claude-haiku-4-5`, eyni prompt, ardıcıl icralar):
 *
 * | Konfiqurasiya | cache_read | cache_create | isti xərc |
 * |---|---|---|---|
 * | sabit dəst (etalon) | 23,447 | 0 | $0.0032 |
 * | −`--safe-mode` +MCP | **0** | **76,161** | $0.0084 |
 * | −`--safe-mode` +MCP +`--setting-sources ''` | 24,872 | 1,579 | **$0.0036** |
 *
 * `--safe-mode`-u SADƏCƏ çıxarmaq fəlakətdir: o, MCP-ni yox, istifadəçinin
 * CLAUDE.md-sini, hook-larını və bütün plugin-lərini geri gətirir — prompt
 * 23k → 76k, keş TAM sınır və bir dəfəlik xərc isti etalonun 48 mislidir
 * ($0.1528). `--setting-sources ''` bunu +3,004 tokenə (+12.5%) endirir.
 *
 * `--strict-mcp-config` HƏR İKİ dəstdə qalır: o, "yalnız `--mcp-config`-dəkilər"
 * deməkdir, yəni istifadəçinin qlobal MCP konfiqurasiyası heç vaxt səssizcə
 * sızmır.
 *
 * `--disable-slash-commands` burada YOXDUR — o, şərtə görə əlavə olunur.
 * ÖLÇÜLDÜ ki, skill-ləri söndürən məhz odur, `--safe-mode` deyil: onu
 * çıxaranda 16 daxili skill və 45 əmr gəlir, qiyməti +3,648 token.
 */
export const CLAUDE_CUSTOM_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  // `--safe-mode`-un YERİNƏ: fərdiləşdirmə qapısını açır, amma istifadəçinin
  // bütün ayar mənbələrini (CLAUDE.md, hook, plugin) BAĞLI saxlayır.
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--exclude-dynamic-system-prompt-sections',
]

/**
 * Səviyyə → `claude --permission-mode` (Faza 5A).
 *
 * `'read-only'` üçün `manual` DEYİL, `plan`: `-p` (print) rejimində interaktiv
 * icazə pəncərəsi göstərilə bilmir, yəni `manual` praktikada "hər alət sorğusu
 * rədd edilir" deməkdir — model faylı OXUYA da bilməzdi və nəticə mənasız
 * olardı. `plan` oxumağa icazə verir, yazmağa yox — istənilən məhz budur.
 */
const PERMISSION_BY_LEVEL: Record<FileAccessLevel, 'plan' | 'acceptEdits'> = {
  'read-only': 'plan',
  workspace: 'acceptEdits',
  extended: 'acceptEdits',
}

export interface ClaudeArgOptions {
  sessionId?: string
  permissionMode?: 'acceptEdits' | 'plan' | 'dontAsk' | 'manual'
  fallbackModel?: string
  /**
   * Hərf-hərf axın (`--include-partial-messages`). Default AÇIQ.
   *
   * Bayraq `CLAUDE_STABLE_FLAGS`-a QOYULMUR (qayda 1: o dəst dondurulub),
   * amma keşi də sındırmır — ÖLÇÜLDÜ (`claude` 2.1.220, Haiku 4.5, eyni
   * prompt, ardıcıl iki icra):
   *
   * | İcra | cache_read | cache_creation | xərc |
   * |---|---|---|---|
   * | bayraqsız | 21,102 | 2,224 | $0.0075 |
   * | bayraqla  | 21,102 | 2,180 | $0.0074 |
   *
   * `cache_read` eynidir — bayraq yalnız stdout-un dənəvərliyini dəyişir,
   * modelə gedən prompt prefiksinə toxunmur.
   */
  partialMessages?: boolean
}

export function buildClaudeArgs(
  req: RunRequest,
  opts: ClaudeArgOptions = {},
): string[] {
  // Fərdiləşdirmə seçilibsə İKİNCİ dondurulmuş dəst işlədilir (Faza 5C).
  // Seçilməyibsə dəst BAYT-BAYT köhnədir — mövcud keşlər sınmır (qayda 1).
  const custom = req.customizations
  const args: string[] = [
    '-p',
    req.prompt,
    ...(custom === undefined ? CLAUDE_STABLE_FLAGS : CLAUDE_CUSTOM_FLAGS),
  ]

  if (custom !== undefined) {
    // Daxili 16 skill YALNIZ açıq istənəndə gəlir (+3,648 token, ölçülmüş).
    if (!custom.builtinSkills) args.push('--disable-slash-commands')
    if (custom.mcpConfigPath !== undefined) {
      args.push('--mcp-config', custom.mcpConfigPath)
    }
    // Sıra `resolveCustomizations`-da bir dəfə determinist edilib — burada
    // yenidən sıralamırıq (eyni prinsip: `--add-dir`, qayda 65).
    for (const dir of custom.pluginDirs) args.push('--plugin-dir', dir)
  }

  if (opts.partialMessages !== false) args.push('--include-partial-messages')

  args.push('--model', req.model)

  if (req.resumeSessionId !== undefined) {
    args.push('--resume', req.resumeSessionId)
  } else {
    args.push('--session-id', opts.sessionId ?? randomUUID())
  }

  // İcazə `RunRequest`-dən gəlirsə O ÜSTÜNDÜR; konstruktor seçimi yalnız
  // default-dur (mövcud çağırışlar və testlər sınmasın deyə).
  if (req.fileAccess !== undefined) {
    // Sıra `resolveFileAccess`-də bir dəfə determinist edilib — burada yenidən
    // sıralamırıq, yoxsa iki yerdə iki fərqli qayda yaranardı və hansının
    // keşə düşdüyü bilinməzdi.
    for (const dir of req.fileAccess.dirs) args.push('--add-dir', dir)
    args.push('--permission-mode', PERMISSION_BY_LEVEL[req.fileAccess.level])
  } else {
    if (req.cwd !== undefined) args.push('--add-dir', req.cwd)
    if (opts.permissionMode !== undefined) {
      args.push('--permission-mode', opts.permissionMode)
    }
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
