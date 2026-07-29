import { readFileSync } from 'node:fs'
import type {
  Capabilities,
  DetectResult,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { ClaudeStreamParser } from './parse-claude.js'
import { CodexStreamParser } from './parse-codex.js'

const DEFAULT_CAPS: Capabilities = {
  fileAccess: true,
  toolUse: true,
  sessions: true,
  structuredOutput: true,
  subscriptionBilled: true,
}

export interface FakeRunnerConfig {
  /** `fixtures/cli/` içindəki fayl adı */
  fixture?: string
  flavor?: 'claude' | 'codex'
  /**
   * Runner növü. Default `'fake'`.
   *
   * Routing qaydaları məhz bu sahəyə baxır ("fayl işi → `cli`", "qısa mətn →
   * `api`"), çünki fərq ölçülmüş prompt döşəməsindədir (~21.7k vs ~0), nə
   * qabiliyyətdə, nə də qiymətdə. Router testlərinin real CLI/API runner-i
   * işə salmadan bu yolları yoxlaya bilməsi üçün konfiqurasiya edilir.
   */
  kind?: 'cli' | 'api' | 'fake'
  /**
   * Runner id-si. Default `'fake'`.
   *
   * Produksiyada runner id-si onun `runners` xəritəsindəki açarı ilə eynidir
   * (`cli:claude`) və routing qərarları məhz o id üzərində qurulur. Testlərin
   * bu invariantı təkrarlaya bilməsi üçün konfiqurasiya edilir.
   */
  id?: string
  /** Fixture yerinə birbaşa hadisə siyahısı */
  events?: readonly RunEvent[]
  /**
   * ÇAĞIRIŞ-BAŞINA fərqli cavablar: birinci `run()` birinci siyahını verir,
   * ikinci ikincini və s. Siyahı tükənəndə SONUNCU təkrarlanır.
   *
   * Pillə 3 (best-of-N) üçün lazımdır: sabit cavab verən runner ilə nüsxələr
   * həmişə 100% razılaşardı və "razılaşmadılar → yuxarı pillə" yolu heç vaxt
   * test edilə bilməzdi.
   */
  eventsPerCall?: readonly (readonly RunEvent[])[]
  detect?: DetectResult
  capabilities?: Partial<Capabilities>
  /** Hər hadisə arasında gecikmə (ms). Default 0 — testlər sürətli olsun. */
  delayMs?: number
}

/**
 * Real fixture-ləri təkrar oynadan Runner.
 *
 * Bu sinif layihənin test strategiyasının təməlidir: supervisor, büdcə
 * mühafizəsi, DB yazması, WebSocket yayımı və UI — hamısı bunun üzərində
 * SIFIR token xərcləyərək test olunur.
 */
export class FakeRunner implements Runner {
  readonly id: string
  readonly kind: 'cli' | 'api' | 'fake'
  readonly capabilities: Capabilities
  /** `eventsPerCall` üçün sayğac — neçənci `run()` çağırışıdır. */
  private calls = 0

  constructor(private readonly config: FakeRunnerConfig) {
    this.id = config.id ?? 'fake'
    this.kind = config.kind ?? 'fake'
    this.capabilities = { ...DEFAULT_CAPS, ...config.capabilities }
  }

  async detect(): Promise<DetectResult> {
    return (
      this.config.detect ?? {
        installed: true,
        authenticated: true,
        version: 'fake-1.0.0',
        detail: 'FakeRunner — fixture təkrar oynadır',
      }
    )
  }

  async *run(_req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    // Hadisələr HƏR çağırışda yenidən hesablanır: parser vəziyyət saxlayır
    // (`sawResult`), ona görə paylaşılan instansiya ikinci icrada `usage` və
    // `done` verməzdi.
    for (const event of this.materialize()) {
      if (opts?.signal?.aborted) return
      if (this.config.delayMs !== undefined && this.config.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.delayMs))
      }
      yield event
    }
  }

  private materialize(): RunEvent[] {
    const perCall = this.config.eventsPerCall
    if (perCall !== undefined && perCall.length > 0) {
      const index = Math.min(this.calls, perCall.length - 1)
      this.calls += 1
      return [...(perCall[index] as readonly RunEvent[])]
    }
    if (this.config.events) return [...this.config.events]

    const { fixture, flavor } = this.config
    if (fixture === undefined) {
      throw new Error('FakeRunner: `fixture` və ya `events` verilməlidir')
    }

    const text = readFileSync(fixturePath(fixture), 'utf8')
    const parser =
      flavor === 'codex' ? new CodexStreamParser() : new ClaudeStreamParser()

    const out: RunEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      out.push(...parser.push(line))
    }
    return out
  }
}
