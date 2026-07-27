import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, Runner } from '@orchestris/shared'
import { openDb } from '../db/client.js'
import {
  createContext,
  createTask,
  getCacheEntry,
  getTask,
  listEvents,
  listRunsForTask,
  listVerifications,
} from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { RunSupervisor } from './supervisor.js'
import { Ladder } from './ladder.js'

const NODE = process.execPath
const okCmd = `"${NODE}" -e "process.exit(0)"`
const failCmd = `"${NODE}" -e "console.error('TS2345 xeta');process.exit(1)"`
// Uğurla bitir, amma bir az vaxt aparır — yoxlama davam edərkən task.status-u
// müşahidə etmək üçün istifadə olunur (Bug 2 testi).
const slowOkCmd = `"${NODE}" -e "setTimeout(() => process.exit(0), 150)"`

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

function setup(verifyCommands: string[] = []) {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C', verifyCommands })
  const sup = new RunSupervisor(db)
  const ladder = new Ladder(db, sup)
  const newTask = (prompt = 'salam') =>
    createTask(db, { contextId: ctx.id, prompt })
  return { db, ctx, sup, ladder, newTask }
}

function runner(events: RunEvent[] = DONE): Runner {
  return new FakeRunner({ events, capabilities: { fileAccess: false } })
}

describe('Ladder — Pillə 0 cache', () => {
  it('ilk icra keşə yazılır', async () => {
    const { db, ctx, ladder, newTask } = setup()
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(r.cached).toBe(false)
    expect(r.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, r.cacheKey as string)?.events).toHaveLength(2)
  })

  it('eyni prompt ikinci dəfə keşdən gəlir — MODEL ÇAĞIRILMIR', async () => {
    const { ctx, ladder, newTask } = setup()
    const spy = runner()
    const runSpy = vi.spyOn(spy, 'run')

    await ladder.run({ task: newTask('eyni'), context: ctx, runner: spy, model: 'm' })
    expect(runSpy).toHaveBeenCalledTimes(1)

    const second = await ladder.run({
      task: newTask('eyni'),
      context: ctx,
      runner: spy,
      model: 'm',
    })
    expect(second.cached).toBe(true)
    expect(runSpy).toHaveBeenCalledTimes(1) // artmadı
  })

  it('keşdən gələn icra da hadisə jurnalına yazılır', async () => {
    const { db, ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('x'), context: ctx, runner: runner(), model: 'm' })
    const second = await ladder.run({
      task: newTask('x'),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(listEvents(db, second.runId)).toHaveLength(2)
  })

  it('keşdən gələn run cachedHit və ladderRung 0 ilə işarələnir', async () => {
    const { db, ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('x'), context: ctx, runner: runner(), model: 'm' })
    const t2 = newTask('x')
    const second = await ladder.run({
      task: t2,
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    const row = listRunsForTask(db, t2.id)[0]
    expect(second.cached).toBe(true)
    expect(row?.cachedHit).toBe(true)
    expect(row?.ladderRung).toBe(0)
    expect(row?.status).toBe('succeeded')
  })

  it('fərqli prompt keşdən gəlmir', async () => {
    const { ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('bir'), context: ctx, runner: runner(), model: 'm' })
    const second = await ladder.run({
      task: newTask('iki'),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(second.cached).toBe(false)
  })

  it('uğursuz icra keşə YAZILMIR', async () => {
    const { db, ctx, ladder, newTask } = setup()
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([{ t: 'error', class: 'crashed', message: 'partladi' }]),
      model: 'm',
    })
    expect(r.status).toBe('failed')
    expect(getCacheEntry(db, r.cacheKey as string)).toBeUndefined()
  })

  it('fayl girişi tələb edən task git olmayan qovluqda keşlənmir', async () => {
    const db = openDb(':memory:')
    const ctx = createContext(db, { name: 'C', cwd: process.env['TEMP'] ?? '/tmp' })
    const ladder = new Ladder(db, new RunSupervisor(db))
    const r = await ladder.run({
      task: createTask(db, { contextId: ctx.id, prompt: 'p' }),
      context: ctx,
      // fileAccess: true → repo barmaq izi lazımdır
      runner: new FakeRunner({ events: DONE }),
      model: 'm',
    })
    expect(r.cacheKey).toBeNull()
    expect(r.cached).toBe(false)
  })
})

describe('Ladder — Pillə 2 alət yoxlaması', () => {
  it('yoxlama əmri yoxdursa dövrə işə düşmür', async () => {
    const { db, ctx, ladder, newTask } = setup([])
    const t = newTask()
    const r = await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('succeeded')
    expect(r.attempts).toBe(1)
    expect(listVerifications(db, r.runId)).toHaveLength(0)
  })

  it('yoxlama keçirsə bir cəhdlə bitir', async () => {
    const { db, ctx, ladder, newTask } = setup([okCmd])
    const t = newTask()
    const r = await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('succeeded')
    expect(r.attempts).toBe(1)
    expect(r.verificationPassed).toBe(true)
    expect(listVerifications(db, r.runId)).toHaveLength(1)
  })

  it('yoxlama sınırsa yenidən cəhd edir və xəta mətnini geri ötürür', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const spy = runner()
    const runSpy = vi.spyOn(spy, 'run')

    const r = await ladder.run({ task: newTask(), context: ctx, runner: spy, model: 'm' })

    expect(r.attempts).toBe(3) // maxAttempts
    expect(runSpy).toHaveBeenCalledTimes(3)
    // 2-ci cəhdin promptu yoxlama xətasını daşımalıdır
    const secondPrompt = runSpy.mock.calls[1]?.[0]?.prompt ?? ''
    expect(secondPrompt).toContain('TS2345 xeta')
    expect(secondPrompt).toContain(failCmd)
  }, 30_000)

  it('3 cəhddən sonra dayanır və verification_failed qaytarır', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({ task: newTask(), context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('verification_failed')
    expect(r.verificationPassed).toBe(false)
  }, 30_000)

  it('yoxlamadan keçməyən nəticə keşə YAZILMIR', async () => {
    const { db, ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({ task: newTask(), context: ctx, runner: runner(), model: 'm' })
    expect(getCacheEntry(db, r.cacheKey as string)).toBeUndefined()
  }, 30_000)

  it('hər cəhd ayrıca run sətri yaradır və attempt artır', async () => {
    const { db, ctx, ladder, newTask } = setup([failCmd])
    const t = newTask()
    await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    const rows = listRunsForTask(db, t.id)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(rows.every((r) => r.ladderRung === 2)).toBe(true)
  }, 30_000)

  it('icra özü uğursuz olsa yoxlama qaçırılmır', async () => {
    const { db, ctx, ladder, newTask } = setup([okCmd])
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([{ t: 'error', class: 'auth', message: 'Not logged in' }]),
      model: 'm',
    })
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1) // auth xətasında təkrar cəhd mənasızdır
    expect(listVerifications(db, r.runId)).toHaveLength(0)
  })

  it('büdcə pozuntusunda təkrar cəhd etmir', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([
        { t: 'usage', inputTokens: 0, outputTokens: 999, billed: 'real' },
        { t: 'done', stopReason: 'end_turn' },
      ]),
      model: 'm',
      limits: { maxOutputTokens: 1 },
    })
    expect(r.status).toBe('budget_exceeded')
    expect(r.attempts).toBe(1)
  })

  it('büdcə cəhdlər arasında daşınır — tükənəndə YENİDƏN cəhd etmir (Bug 1)', async () => {
    // 1-ci cəhd tam olaraq 100 output token bildirir — özü limiti aşmır
    // (100 > 100 yalandır), ona görə `RunSupervisor`-un ÖZ `BudgetGuard`-ı
    // bunu kəsmir və icra uğurla bitir. Amma bu, bütün 100 tokenlik
    // limitini artıq xərcləyib — qalan büdcə 0-dır. Yoxlama (failCmd) sınır,
    // Ladder növbəti cəhdə keçmək istəyər — YALNIZ bizim yeni pre-attempt
    // qısaqapanma məntiqimiz (RunSupervisor-un öz guard-ı DEYİL, çünki o heç
    // çağırılmır) 2-ci cəhdi tamamilə əngəlləməlidir.
    const { ctx, ladder, newTask } = setup([failCmd])
    const spy = runner([
      { t: 'usage', inputTokens: 0, outputTokens: 100, billed: 'real' },
      { t: 'done', stopReason: 'end_turn' },
    ])
    const runSpy = vi.spyOn(spy, 'run')

    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: spy,
      model: 'm',
      limits: { maxOutputTokens: 100 },
    })

    expect(r.status).toBe('budget_exceeded')
    expect(r.attempts).toBe(1)
    expect(runSpy).toHaveBeenCalledTimes(1) // 2-ci cəhd HEÇ başlamadı
  })

  it('task.status yoxlama davam edərkən "running" qalır, keçəndə "succeeded" olur (Bug 2)', async () => {
    const { db, ctx, ladder, newTask } = setup([slowOkCmd])
    const t = newTask()

    const p = ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    // Model cavabı demək olar ki, dərhal bitir (delayMs yoxdur); bu an
    // artıq slowOkCmd-nin ~150ms-lik yoxlama pəncərəsinin ortasındayıq.
    await new Promise((r) => setTimeout(r, 20))
    expect(getTask(db, t.id)?.status).toBe('running')

    const r = await p
    expect(r.status).toBe('succeeded')
    expect(r.verificationPassed).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('succeeded')
  })
})

describe('Ladder — dayandırma', () => {
  it('cancel bütün cəhdləri dayandırır', async () => {
    const { ctx, ladder, sup, newTask } = setup([failCmd])
    const slow = new FakeRunner({
      events: Array.from({ length: 60 }, (_, i) => ({ t: 'text' as const, delta: String(i) })),
      delayMs: 5,
      capabilities: { fileAccess: false },
    })
    const p = ladder.run({ task: newTask(), context: ctx, runner: slow, model: 'm' })
    await new Promise((r) => setTimeout(r, 40))
    sup.cancelAll()
    const r = await p
    expect(['interrupted', 'failed']).toContain(r.status)
  }, 20_000)
})
