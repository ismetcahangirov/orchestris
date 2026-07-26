import { describe, expect, it } from 'vitest'
import { RunEventSchema, type RunEvent } from '@orchestris/shared'
import { FakeRunner } from './fake.js'

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('FakeRunner — fixture təkrar oynadır', () => {
  it('claude fixture-ini RunEvent axınına çevirir', async () => {
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })
    const events = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(events.filter((e) => e.t === 'text')).toEqual([{ t: 'text', delta: 'SALAM' }])
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
    expect(events[0]?.t).toBe('start')
  })

  it('emit edilən hər hadisə RunEvent sxemini keçir', async () => {
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })
    for (const e of await collect(runner.run({ prompt: 'x', model: 'm' }))) {
      expect(() => RunEventSchema.parse(e)).not.toThrow()
    }
  })

  it('codex fixture-ini codex parser-i ilə oynadır', async () => {
    const runner = new FakeRunner({ fixture: 'codex-auth-error.jsonl', flavor: 'codex' })
    const events = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(events.some((e) => e.t === 'error' && e.class === 'auth')).toBe(true)
    expect(events.filter((e) => e.t === 'done')).toHaveLength(0)
  })

  it('hər çağırışda təzə parser işlədir — vəziyyət icralar arasında sızmır', async () => {
    // Parser `sawResult` bayrağı saxlayır. Paylaşılan parser instansiyası
    // ikinci icrada `usage`/`done` verməzdi.
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })
    const first = await collect(runner.run({ prompt: 'x', model: 'm' }))
    const second = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(second.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(second).toEqual(first)
  })
})

describe('FakeRunner — birbaşa hadisə siyahısı', () => {
  it('verilmiş hadisələri olduğu kimi oynadır', async () => {
    const runner = new FakeRunner({
      events: [
        { t: 'text', delta: 'a' },
        { t: 'done', stopReason: 'end_turn' },
      ],
    })
    expect(await collect(runner.run({ prompt: 'x', model: 'm' }))).toEqual([
      { t: 'text', delta: 'a' },
      { t: 'done', stopReason: 'end_turn' },
    ])
  })

  it('nə fixture nə events verilməsə aydın xəta atır', async () => {
    const runner = new FakeRunner({})
    await expect(collect(runner.run({ prompt: 'x', model: 'm' }))).rejects.toThrow(
      /fixture/i,
    )
  })
})

describe('FakeRunner — Runner interfeysi', () => {
  it('detect() default olaraq hazır vəziyyət qaytarır', async () => {
    const runner = new FakeRunner({ events: [] })
    const d = await runner.detect()
    expect(d.installed).toBe(true)
    expect(d.authenticated).toBe(true)
  })

  it('detect() nəticəsi override edilə bilir', async () => {
    const runner = new FakeRunner({
      events: [],
      detect: { installed: true, authenticated: false, detail: 'test' },
    })
    expect(await runner.detect()).toEqual({
      installed: true,
      authenticated: false,
      detail: 'test',
    })
  })

  it('capabilities qismən override edilə bilir', () => {
    const runner = new FakeRunner({ events: [], capabilities: { fileAccess: false } })
    expect(runner.capabilities.fileAccess).toBe(false)
    expect(runner.capabilities.toolUse).toBe(true)
  })

  it('kind sahəsi fake-dir', () => {
    expect(new FakeRunner({ events: [] }).kind).toBe('fake')
  })
})

describe('FakeRunner — dayandırma', () => {
  it('AbortSignal axını yarıda kəsir', async () => {
    const ac = new AbortController()
    const runner = new FakeRunner({
      events: [
        { t: 'text', delta: 'a' },
        { t: 'text', delta: 'b' },
        { t: 'text', delta: 'c' },
        { t: 'done', stopReason: 'end_turn' },
      ],
    })
    const out: RunEvent[] = []
    for await (const e of runner.run({ prompt: 'x', model: 'm' }, { signal: ac.signal })) {
      out.push(e)
      ac.abort()
    }
    expect(out).toEqual([{ t: 'text', delta: 'a' }])
  })

  it('əvvəlcədən abort edilmiş signal ilə heç nə vermir', async () => {
    const ac = new AbortController()
    ac.abort()
    const runner = new FakeRunner({ events: [{ t: 'text', delta: 'a' }] })
    const out = await collect(runner.run({ prompt: 'x', model: 'm' }, { signal: ac.signal }))
    expect(out).toEqual([])
  })

  it('delayMs hadisələr arasında gecikmə yaradır', async () => {
    const runner = new FakeRunner({
      events: [
        { t: 'text', delta: 'a' },
        { t: 'text', delta: 'b' },
      ],
      delayMs: 20,
    })
    const started = Date.now()
    await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })
})
