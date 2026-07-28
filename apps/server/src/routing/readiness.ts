import type { Runner } from '@orchestris/shared'

/**
 * Runner-lərin `detect()` nəticəsinin TTL-li keşi.
 *
 * NİYƏ KEŞ: `ClaudeCliRunner.detect()` hər çağırışda proses spawn edir
 * (`claude --version`). Routing HƏR taskda baş verir — yoxlamanı keşləməsək,
 * hər task ~100 ms gecikmə və bir prosesə başa gələrdi. Halbuki auth
 * vəziyyəti dəqiqələrlə ölçülən müddətdə dəyişir.
 *
 * NİYƏ OPTİMİST BAŞLANĞIC: ilk yoxlamadan əvvəl hamı hazır sayılır. Əks halda
 * server startından sonrakı ilk task "işçi yoxdur" xətası ilə sınardı —
 * halbuki runner sadəcə hələ yoxlanmayıb.
 */
export interface ReadinessOptions {
  /** Default 60 saniyə. */
  ttlMs?: number
  /** Test üçün — sabit saat. */
  now?: () => number
}

const DEFAULT_TTL_MS = 60_000

export class RunnerReadiness {
  private readonly runners: ReadonlyMap<string, Runner>
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly ready = new Map<string, boolean>()
  private checkedAt = 0
  /** Paralel `refresh()` çağırışları eyni yoxlamanı bölüşür. */
  private inFlight: Promise<void> | null = null

  constructor(runners: ReadonlyMap<string, Runner>, opts: ReadinessOptions = {}) {
    this.runners = runners
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? Date.now
  }

  isReady(runnerId: string): boolean {
    return this.ready.get(runnerId) ?? true
  }

  async refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    if (this.checkedAt !== 0 && this.now() - this.checkedAt < this.ttlMs) return

    this.inFlight = this.detectAll()
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async detectAll(): Promise<void> {
    await Promise.all(
      [...this.runners.entries()].map(async ([id, runner]) => {
        try {
          const result = await runner.detect()
          this.ready.set(id, result.installed && result.authenticated)
        } catch {
          // `detect()` atırsa runner işlək deyil — taskı ona vermək onsuz da
          // sınardı, amma xəta burada TASKI sındırmamalıdır.
          this.ready.set(id, false)
        }
      }),
    )
    this.checkedAt = this.now()
  }
}
