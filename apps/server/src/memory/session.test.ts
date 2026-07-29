import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import { listMemoryOps } from '../db/memory-repo.js'
import { createContext, createTask } from '../db/repo.js'
import { RECALL_OPEN } from './prompt.js'
import { NullProvider, type MemoryItem, type MemoryProvider } from './provider.js'
import { MemorySession, resolveScope } from './session.js'

/** Yaddaş anbarını təqlid edir — şəbəkə YOX, xarici proses YOX. */
class FakeProvider implements MemoryProvider {
  readonly id = 'fake'
  readonly written: { scope: string; items: readonly MemoryItem[] }[] = []
  lastBudget = -1

  constructor(
    private readonly opts: {
      items?: MemoryItem[]
      recallCost?: number | null
      writeCost?: number | null
      failRecall?: boolean
      failRemember?: boolean
    } = {},
  ) {}

  async recall(_query: string, _scope: string, tokenBudget: number) {
    this.lastBudget = tokenBudget
    if (this.opts.failRecall === true) throw new Error('worker sındı')
    return { items: this.opts.items ?? [], costUsd: this.opts.recallCost ?? 0 }
  }

  async remember(scope: string, items: readonly MemoryItem[]) {
    if (this.opts.failRemember === true) throw new Error('yazıla bilmədi')
    this.written.push({ scope, items })
    // `?? 0` İŞLƏMƏZ: testin bütün mənası `null` ("bilinmir") halını yoxlamaqdır.
    return { costUsd: 'writeCost' in this.opts ? (this.opts.writeCost ?? null) : 0 }
  }

  async health() {
    return { ok: true }
  }
}

function setup(provider: MemoryProvider, tokenBudget?: number): {
  db: Db
  session: MemorySession
  ctx: { id: string; memoryScope?: string | null; memoryEnabled?: boolean }
  taskId: string
} {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: row.id, prompt: 'p' })
  return {
    db,
    session: new MemorySession(db, provider, tokenBudget !== undefined ? { tokenBudget } : {}),
    ctx: { id: row.id },
    taskId: task.id,
  }
}

describe('resolveScope', () => {
  it('sahə verilməyibsə kontekstin ÖZ id-si işlədilir', () => {
    // Sabit default (məs. `'default'`) iki layihənin yaddaşını qarışdırardı.
    expect(resolveScope({ id: 'ctx-1' })).toBe('ctx-1')
    expect(resolveScope({ id: 'ctx-1', memoryScope: '  ' })).toBe('ctx-1')
  })

  it('açıq verilən ad paylaşıma imkan verir', () => {
    expect(resolveScope({ id: 'ctx-1', memoryScope: 'orchestris' })).toBe('orchestris')
  })
})

describe('MemorySession.recall', () => {
  it('qeydləri ETİBARSIZ çərçivə içində qaytarır', async () => {
    const s = setup(new FakeProvider({ items: [{ id: 'a', text: 'pnpm işlədilir' }] }))

    const out = await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'necə?' })

    expect(out.suffix).toContain(RECALL_OPEN)
    expect(out.suffix).toContain('pnpm işlədilir')
    expect(out.items).toBe(1)
    expect(out.digest).not.toBeNull()
  })

  it('provayder büdcəni AŞSA da nəticə kəsilir — uzaq tərəfə güvənmirik', async () => {
    const provider = new FakeProvider({
      items: [
        { id: 'böyük', text: 'x'.repeat(3000), score: 0.9 },
        { id: 'kiçik', text: 'y'.repeat(15), score: 0.1 },
      ],
    })
    const s = setup(provider, 200)

    const out = await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'q' })

    expect(out.suffix).not.toContain('x'.repeat(100))
    expect(out.suffix).toContain('y'.repeat(15))
    expect(out.tokens).toBeLessThanOrEqual(200)
  })

  it('çərçivənin öz tokeni büdcədən ÇIXILIR', async () => {
    const provider = new FakeProvider({ items: [] })
    const s = setup(provider, 100)

    await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'q' })

    // Provayderə verilən büdcə tam 100 DEYİL: çərçivə onsuz da ödəniləcək.
    expect(provider.lastBudget).toBeGreaterThan(0)
    expect(provider.lastBudget).toBeLessThan(100)
  })

  it('büdcə çərçivəyə belə çatmırsa yaddaş ÜMUMİYYƏTLƏ qoşulmur', async () => {
    const provider = new FakeProvider({ items: [{ id: 'a', text: 'qeyd' }] })
    const s = setup(provider, 1)

    const out = await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'q' })

    expect(out.suffix).toBe('')
    expect(provider.lastBudget).toBe(-1)
  })

  it('kontekstdə söndürülübsə provayder ÇAĞIRILMIR', async () => {
    const provider = new FakeProvider({ items: [{ id: 'a', text: 'qeyd' }] })
    const s = setup(provider)

    const out = await s.session.recall({
      taskId: s.taskId,
      ctx: { ...s.ctx, memoryEnabled: false },
      query: 'q',
    })

    expect(out.suffix).toBe('')
    expect(provider.lastBudget).toBe(-1)
  })

  it('provayder sınsa task DAYANMIR, hadisə jurnala düşür', async () => {
    const s = setup(new FakeProvider({ failRecall: true }))

    const out = await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'q' })

    expect(out.suffix).toBe('')
    expect(listMemoryOps(s.db, s.taskId)).toMatchObject([{ kind: 'recall', ok: false }])
  })

  it('heç nə etməyən əməliyyat jurnalı doldurmur', async () => {
    const s = setup(new NullProvider())

    await s.session.recall({ taskId: s.taskId, ctx: s.ctx, query: 'q' })

    expect(listMemoryOps(s.db, s.taskId)).toEqual([])
  })
})

describe('MemorySession.remember', () => {
  it('taskı və nəticəni yazır, xərci jurnala salır', async () => {
    const provider = new FakeProvider({ writeCost: 0.0002 })
    const s = setup(provider)

    await s.session.remember({
      taskId: s.taskId,
      ctx: s.ctx,
      prompt: 'testləri qaç',
      answer: 'hamısı keçdi',
    })

    expect(provider.written[0]?.items[0]?.text).toContain('testləri qaç')
    expect(provider.written[0]?.items[0]?.text).toContain('hamısı keçdi')
    expect(listMemoryOps(s.db, s.taskId)).toMatchObject([
      { kind: 'remember', ok: true, costUsd: 0.0002, items: 1 },
    ])
  })

  it('xərc bilinmirsə NULL yazılır — `0` "pulsuz" kimi oxunardı', async () => {
    const s = setup(new FakeProvider({ writeCost: null }))

    await s.session.remember({ taskId: s.taskId, ctx: s.ctx, prompt: 'p', answer: 'a' })

    expect(listMemoryOps(s.db, s.taskId)[0]?.costUsd).toBeNull()
  })

  it('boş cavab yazılmır', async () => {
    const provider = new FakeProvider()
    const s = setup(provider)

    await s.session.remember({ taskId: s.taskId, ctx: s.ctx, prompt: 'p', answer: '   ' })

    expect(provider.written).toEqual([])
  })

  it('uzun cavab KƏSİLİR və kəsilmə açıq işarələnir', async () => {
    const provider = new FakeProvider()
    const s = setup(provider)

    await s.session.remember({
      taskId: s.taskId,
      ctx: s.ctx,
      prompt: 'p',
      answer: 'z'.repeat(9000),
    })

    const text = provider.written[0]?.items[0]?.text ?? ''
    expect(text).toContain('…(kəsilib)')
    expect(text.length).toBeLessThan(3000)
  })

  it('yazma sınsa xəta ATILMIR — task onsuz da bitib', async () => {
    const s = setup(new FakeProvider({ failRemember: true }))

    await expect(
      s.session.remember({ taskId: s.taskId, ctx: s.ctx, prompt: 'p', answer: 'a' }),
    ).resolves.toBeUndefined()
    expect(listMemoryOps(s.db, s.taskId)).toMatchObject([{ kind: 'remember', ok: false }])
  })

  it('kontekstdə söndürülübsə heç nə yazılmır', async () => {
    const provider = new FakeProvider()
    const s = setup(provider)

    await s.session.remember({
      taskId: s.taskId,
      ctx: { ...s.ctx, memoryEnabled: false },
      prompt: 'p',
      answer: 'a',
    })

    expect(provider.written).toEqual([])
  })
})
