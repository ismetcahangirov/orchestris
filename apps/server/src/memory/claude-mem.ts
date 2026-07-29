import { z } from 'zod'
import { redactAll } from '../secrets/redact.js'
import type {
  MemoryHealth,
  MemoryItem,
  MemoryProvider,
  MemoryUsage,
  RecallResult,
} from './provider.js'

/**
 * claude-mem adapteri — lokal worker HTTP API-si ilə danışır.
 *
 * ⚠️ **BU ADAPTERİN SİM PROTOKOLU REAL QURAŞDIRMA İLƏ TƏSDİQLƏNMƏYİB.** Bu
 * maşında claude-mem quraşdırılmayıb (`~/.claude-mem` yoxdur), ona görə
 * endpoint yolları və cavab sahələri SƏNƏDƏ ƏSASLANIR, ölçməyə yox. Layihənin
 * qaydası budur: təxmin edilən şey təxmin olduğunu YAZIR (bax "Bilinən
 * boşluqlar").
 *
 * Məhz buna görə burada hər şey KONFİQURASİYA ilə idarə olunur: ünvan,
 * endpoint yolları, minimum versiya. Protokol fərqli çıxsa bir env dəyişikliyi
 * (və ya bir obyekt) kifayət edir — adapterin bütün mənası budur.
 *
 * TƏHLÜKƏSİZLİK: heç bir yol taskı DAYANDIRMIR. Provayder sınsa
 * `MemorySession` onu tutur və task yaddaşsız davam edir (eyni prinsip:
 * worktree izolyasiyası, CLAUDE.md qayda 41).
 */

const HealthResponse = z.object({
  version: z.string().min(1).optional(),
  ok: z.boolean().optional(),
})

const RecallResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        text: z.string(),
        score: z.number().optional(),
        at: z.number().optional(),
      }),
    )
    .default([]),
  costUsd: z.number().nullable().optional(),
})

const RememberResponse = z.object({
  costUsd: z.number().nullable().optional(),
})

export interface ClaudeMemConfig {
  /** Lokal worker-in ünvanı. Yalnız 127.0.0.1 — bulud sinxronu İSTİFADƏ OLUNMUR. */
  baseUrl: string
  healthPath: string
  recallPath: string
  rememberPath: string
  /**
   * Qəbul edilən ƏN AŞAĞI claude-mem versiyası.
   *
   * `null` = TƏYİN OLUNMAYIB → provayder işə DÜŞMÜR. Bu, qəsdən belədir:
   * claude-mem-də keçmişdə command-injection zəifliyi olub (#354, düzəldilib),
   * amma hansı versiyada düzəldiyini BU MAŞINDAN yoxlaya bilmirik. Uydurma
   * rəqəm yazsaydıq iki səhvdən biri qaçılmaz olardı — ya zəif versiyanı
   * səssizcə qəbul edərdik, ya da işləyən quraşdırmanı səbəbsiz rədd edərdik.
   * Ona görə cavabı istifadəçidən tələb edirik və o, `/api/memory`-də görünür.
   */
  minVersion: string | null
  timeoutMs: number
  /**
   * Bir `remember` çağırışının bəyan edilmiş xərci (USD).
   *
   * `null` = BİLİNMİR (qayda 4) — və cavabda `costUsd` yoxdursa nəticə də
   * `null` olur, `0` yox. Sıxma MODEL ÇAĞIRIŞIDIR; onu susaraq pulsuz saysaq
   * `savings_ledger` qənaəti şişirdərdi.
   *
   * İstifadəçi spesifikasiyadakı konfiqurasiyanı işlədirsə
   * (`CLAUDE_MEM_PROVIDER=openrouter`, `…:free` modeli) burada `0` bəyan edə
   * bilər. Bu, BƏYANDIR — ölçmə deyil, ona görə default `null`-dır.
   */
  declaredWriteCostUsd: number | null
}

export const DEFAULT_CLAUDE_MEM_CONFIG: ClaudeMemConfig = {
  baseUrl: 'http://127.0.0.1:37777',
  healthPath: '/health',
  recallPath: '/recall',
  rememberPath: '/remember',
  minVersion: null,
  timeoutMs: 3000,
  declaredWriteCostUsd: null,
}

/**
 * `a >= b` müqayisəsi — nöqtə ilə ayrılmış rəqəmlər üzrə.
 *
 * `localeCompare` İŞLƏMİR: `'10' < '9'` sətir müqayisəsində doğrudur, versiya
 * müqayisəsində yalandır. Rəqəm olmayan hissə (`4.1.0-beta`) kəsilir — ön
 * buraxılış versiyası ən aşağı sayılır ki, "beta minimumu ödəyir" deyilməsin.
 */
export function isAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? -1 : n))

  const a = parse(version)
  const b = parse(minimum)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

export interface ClaudeMemOptions {
  fetchImpl?: typeof fetch
  config?: Partial<ClaudeMemConfig>
}

export class ClaudeMemProvider implements MemoryProvider {
  readonly id = 'claude-mem'
  readonly config: ClaudeMemConfig
  private readonly doFetch: typeof fetch

  constructor(opts: ClaudeMemOptions = {}) {
    this.config = { ...DEFAULT_CLAUDE_MEM_CONFIG, ...opts.config }
    this.doFetch = opts.fetchImpl ?? fetch
  }

  /**
   * Worker əlçatandırmı və versiyası kifayətdirmi.
   *
   * Versiya YOXLANMADAN `ok` qaytarılmır: adapterin bütün mənası "sınsa bir
   * ayarla çıxarılsın"dır, amma zəiflikli versiya SINMIR — səssizcə işləyir.
   * Ona görə qapı buradadır.
   */
  async health(): Promise<MemoryHealth> {
    if (this.config.minVersion === null) {
      return {
        ok: false,
        detail:
          'minimum claude-mem versiyası təyin olunmayıb — ORCHESTRIS_CLAUDE_MEM_MIN_VERSION verin',
      }
    }

    try {
      const body = await this.request(this.config.healthPath, undefined)
      const parsed = HealthResponse.safeParse(body)
      if (!parsed.success) return { ok: false, detail: 'health cavabı gözlənilən formatda deyil' }

      const version = parsed.data.version
      if (version === undefined) return { ok: false, detail: 'worker versiya bildirmir' }
      if (!isAtLeast(version, this.config.minVersion)) {
        return {
          ok: false,
          detail: `versiya ${version} < tələb olunan ${this.config.minVersion}`,
        }
      }
      return { ok: true, detail: `claude-mem ${version}` }
    } catch (err) {
      return { ok: false, detail: message(err) }
    }
  }

  async recall(query: string, scope: string, tokenBudget: number): Promise<RecallResult> {
    const body = await this.request(this.config.recallPath, { query, scope, tokenBudget })
    const parsed = RecallResponse.safeParse(body)
    if (!parsed.success) throw new Error('claude-mem: recall cavabı gözlənilən formatda deyil')

    return {
      items: parsed.data.items.map((item, i) => ({
        id: item.id ?? `recall-${i}`,
        text: item.text,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.at !== undefined ? { at: item.at } : {}),
      })),
      // Axtarış LOKALDIR (SQLite FTS5 + Chroma, bulud sinxronu söndürülüb) —
      // model çağırışı yoxdur. Ona görə cavab xərc bildirməsə `0` yazılır və bu,
      // "bilinmir" deyil: qayda 4-dəki fərq məhz burada işə yarayır.
      costUsd: parsed.data.costUsd ?? 0,
    }
  }

  async remember(scope: string, items: readonly MemoryItem[]): Promise<MemoryUsage> {
    const body = await this.request(this.config.rememberPath, { scope, items })
    const parsed = RememberResponse.safeParse(body)
    if (!parsed.success) throw new Error('claude-mem: remember cavabı gözlənilən formatda deyil')

    // Yazma SIXILMA tələb edir — o, model çağırışıdır. Cavab xərc bildirmirsə
    // bəyan edilmiş qiymətə düşürük, o da yoxdursa `null` (BİLİNMİR).
    return { costUsd: parsed.data.costUsd ?? this.config.declaredWriteCostUsd }
  }

  private async request(path: string, payload: unknown): Promise<unknown> {
    const res = await this.doFetch(`${this.config.baseUrl}${path}`, {
      ...(payload === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(redactAll(`claude-mem: HTTP ${res.status} ${text.slice(0, 200)}`.trim()))
    }
    return res.json()
  }
}

/**
 * Xəta mətni — HƏMİŞƏ kəsilmiş.
 *
 * Lokal worker öz konfiqurasiyasını (o cümlədən OpenRouter açarını) xəta
 * mətnində əks etdirə bilər. O mətn `memory_ops.detail`-ə yazılır və oradan
 * UI-a gedir — kəsmə mənbədə edilir (qayda 18 ilə eyni prinsip).
 */
function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactAll(raw).slice(0, 300)
}
