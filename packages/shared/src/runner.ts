import type { RunEvent } from './events.js'

export const CAPABILITY_KEYS = [
  'fileAccess',
  'toolUse',
  'sessions',
  'structuredOutput',
  'subscriptionBilled',
] as const

export interface Capabilities {
  /** Fayl sistemi oxuya/yaza bilir (CLI = true, API = false) */
  fileAccess: boolean
  toolUse: boolean
  /** Sessiya davam etdirilə bilir (`--resume`) */
  sessions: boolean
  structuredOutput: boolean
  /** Abunəlikdən ödənilir → real pul çıxmır, xərc istinad qiymətidir */
  subscriptionBilled: boolean
}

/** Task-ın runner-dən tələbləri. Təyin olunmayan sahə "əhəmiyyətsiz" deməkdir. */
export interface TaskRequirements {
  needsFileAccess?: boolean
  needsToolUse?: boolean
  needsSessions?: boolean
  needsStructuredOutput?: boolean
}

export function canHandle(
  caps: Capabilities,
  req: TaskRequirements,
): boolean {
  if (req.needsFileAccess && !caps.fileAccess) return false
  if (req.needsToolUse && !caps.toolUse) return false
  if (req.needsSessions && !caps.sessions) return false
  if (req.needsStructuredOutput && !caps.structuredOutput) return false
  return true
}

export interface DetectResult {
  installed: boolean
  authenticated: boolean
  version?: string
  execPath?: string
  /** İnsan üçün izah — `/providers` səhifəsində göstərilir */
  detail: string
}

/**
 * Kontekstin fayl icazə səviyyəsi.
 *
 * Runner-ə xas bayraq adları BURADA YOXDUR və bu qəsdəndir: `RunRequest`
 * `ApiRunner` tərəfindən də işlədilir və orada `--permission-mode` anlayışı
 * ümumiyyətlə yoxdur. Paylaşılan müqavilə NİYYƏTİ daşıyır, tərcüməni isə hər
 * runner öz `build*Args` funksiyasında edir — yəni bayraq bilikləri onu
 * işlədən yeganə faylda qalır və hər yeni CLI üçün bu tip genişlənmir.
 */
export const FILE_ACCESS_LEVELS = ['read-only', 'workspace', 'extended'] as const
export type FileAccessLevel = (typeof FILE_ACCESS_LEVELS)[number]

export interface FileAccess {
  level: FileAccessLevel
  /**
   * Agentin toxuna biləcəyi qovluqlar — DETERMİNİST sıralanmış.
   *
   * Sıralamasaydıq, eyni qovluq dəsti fərqli sıra ilə fərqli əmr sətri verər
   * və Anthropic prompt-cache-i lazımsız yerə sınardı (CLAUDE.md qayda 1).
   */
  dirs: readonly string[]
}

export interface RunRequest {
  prompt: string
  model: string
  /** İş qovluğu — CLI runner-lər üçün məcburi */
  cwd?: string
  /** Mövcud sessiyanı davam etdir */
  resumeSessionId?: string
  /**
   * Fayl icazəsi (Faza 5A). Verilməsə runner öz konstruktor default-una
   * düşür — mövcud çağırışlar və testlər sınmır.
   */
  fileAccess?: FileAccess
  /**
   * MCP / plugin / daxili skill seçimi (Faza 5C).
   *
   * `undefined` = fərdiləşdirmə YOXDUR. Bu, sadəcə "boş seçim" deyil: runner
   * o zaman ÖZ DEFAULT bayraq dəstini işlədir və əmr sətri bayt-bayt köhnə
   * qalır — mövcud prompt keşlərinin toxunulmazlığı buna bağlıdır.
   *
   * Bayraq adları BURADA YOXDUR (qayda 65 ilə eyni prinsip): tərcüməni hər
   * runner özü edir, paylaşılan müqavilə yalnız NİYYƏTİ daşıyır.
   */
  customizations?: RunCustomizations
}

export interface RunCustomizations {
  /** MCP konfiqurasiya FAYLININ yolu — JSON heç vaxt argv-yə qoyulmur. */
  mcpConfigPath?: string
  /** Plugin qovluqları — DETERMİNİST sıralanmış. */
  pluginDirs: readonly string[]
  /** CLI-nin daxili skill dəsti açılsınmı (hamısı-birdən). */
  builtinSkills: boolean
}

export interface RunOptions {
  /** Sərt limitlər. Aşıldıqda proses ağacı öldürülür. */
  maxOutputTokens?: number
  maxSeconds?: number
  /**
   * YALNIZ `subscriptionBilled: false` olan runner-lərə tətbiq edilir.
   * Abunəlik icralarında `costUsd` istinad qiymətidir və real pul çıxmır —
   * orada bu limit gözardı edilir, `maxOutputTokens`/`maxSeconds` isə hər
   * halda tətbiq olunur. (Ölçülmüş: `claude` CLI-nın ~21.7k token döşəməsi
   * trivial taskda ~$0.0085 istinad qiyməti verir; bunu real limit saysaq
   * hər icra kəsilərdi.)
   */
  maxCostUsd?: number
  signal?: AbortSignal
}

export interface Runner {
  readonly id: string
  readonly kind: 'cli' | 'api' | 'fake'
  readonly capabilities: Capabilities
  detect(): Promise<DetectResult>
  run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent>
}
