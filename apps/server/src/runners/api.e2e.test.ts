import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import { ApiRunner } from './api.js'

/**
 * REAL API çağırışı edən YEGANƏ test — və o, default olaraq İŞLƏMİR.
 *
 * `pnpm test` sıfır token xərcləməlidir (CLAUDE.md qayda 11), CI isə heç vaxt
 * real çağırış etməməlidir. Ona görə bu blok yalnız hər ikisi verildikdə
 * qaçır:
 *   ORCHESTRIS_E2E=1  ANTHROPIC_API_KEY=sk-ant-...  pnpm test
 *
 * Nə üçün saxlanılır: saxta axın SDK-nın hissə formatını bizim ANLADIĞIMIZ
 * kimi təsvir edir. Format dəyişsə saxta test yaşıl qalar və biz bunu ancaq
 * istehsalda bilərik. Bu test onu bir əmrlə yoxlamağa imkan verir.
 */
const enabled =
  process.env['ORCHESTRIS_E2E'] === '1' &&
  (process.env['ANTHROPIC_API_KEY'] ?? '').length > 8

describe.skipIf(!enabled)('ApiRunner — REAL Anthropic çağırışı (opt-in)', () => {
  it('mətn, usage və done verir', async () => {
    const runner = new ApiRunner({
      providerId: 'anthropic',
      getApiKey: async () => process.env['ANTHROPIC_API_KEY'] ?? null,
      // Qiymət DB-siz gəlmir — burada məqsəd axın formatını yoxlamaqdır.
      resolvePrice: () => ({ input: 1, output: 5 }),
    })

    const events: RunEvent[] = []
    for await (const e of runner.run(
      { prompt: 'Yalnız "OK" yaz.', model: 'claude-haiku-4-5' },
      // Sərt limit: bu test bir neçə sentin altında qalmalıdır.
      { maxOutputTokens: 16 },
    )) {
      events.push(e)
    }

    expect(events.filter((e) => e.t === 'error')).toHaveLength(0)
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(events.at(-1)?.t).toBe('done')

    const usage = events.find((e) => e.t === 'usage')
    expect(usage).toMatchObject({ billed: 'real' })
    expect((usage as { outputTokens: number }).outputTokens).toBeGreaterThan(0)
  }, 60_000)
})
