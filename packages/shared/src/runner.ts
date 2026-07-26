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

export interface RunRequest {
  prompt: string
  model: string
  /** İş qovluğu — CLI runner-lər üçün məcburi */
  cwd?: string
  /** Mövcud sessiyanı davam etdir */
  resumeSessionId?: string
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
