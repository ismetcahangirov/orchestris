import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client.js'
import {
  createContext,
  createTask,
  getTask,
  listEvents,
  listRunsForTask,
} from '../db/repo.js'
import type { StoredEvent } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { RunSupervisor } from './supervisor.js'

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'salam' })
  return { db, ctx, task, sup: new RunSupervisor(db) }
}

describe('RunSupervisor — uğurlu icra', () => {
  it('fixture axınını DB-yə yazır və run-u succeeded edir', async () => {
    const { db, task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'claude-haiku-4-5-20251001',
      prompt: 'salam',
    })

    expect(result.status).toBe('succeeded')
    const rows = listRunsForTask(db, task.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('succeeded')
    expect(rows[0]?.tokensOut).toBe(59)
    expect(rows[0]?.tokensCacheRead).toBe(22411)
    expect(rows[0]?.subscriptionBilled).toBe(true)
  })

  it('sessionId-i start hadisəsindən tutur', async () => {
    const { db, task, sup } = setup()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'm',
      prompt: 'p',
    })
    expect(listRunsForTask(db, task.id)[0]?.sessionId).toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it('bütün hadisələri fasiləsiz sıra ilə jurnala yazır', async () => {
    const { db, task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'm',
      prompt: 'p',
    })
    const events = listEvents(db, result.runId)
    expect(events.length).toBeGreaterThan(3)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events.at(-1)?.event.t).toBe('done')
  })

  it('taskı succeeded kimi işarələyir', async () => {
    const { db, task, sup } = setup()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'done', stopReason: 'end_turn' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(getTask(db, task.id)?.status).toBe('succeeded')
  })
})

describe('RunSupervisor — dinləyicilər', () => {
  it('hər hadisəni dinləyiciyə ötürür', async () => {
    const { task, sup } = setup()
    const seen: StoredEvent[] = []
    sup.onEvent((_runId, stored) => seen.push(stored))

    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'text', delta: 'a' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.event).toEqual({ t: 'text', delta: 'a' })
  })

  it('onEvent qaytardığı funksiya abunəliyi ləğv edir', async () => {
    const { task, sup } = setup()
    let count = 0
    const off = sup.onEvent(() => count++)
    off()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'done', stopReason: 'end_turn' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(count).toBe(0)
  })

  it('bir dinləyicinin xətası icranı dayandırmır', async () => {
    const { task, sup } = setup()
    sup.onEvent(() => {
      throw new Error('dinləyici qırıldı')
    })
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'done', stopReason: 'end_turn' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('succeeded')
  })
})

describe('RunSupervisor — xəta halları', () => {
  it('auth xətasını failed + errorClass kimi yazır', async () => {
    const { db, task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'codex-auth-error.jsonl', flavor: 'codex' }),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('auth')
    expect(listRunsForTask(db, task.id)[0]?.errorClass).toBe('auth')
  })

  it('xəta hadisəsindəki sessionId-i saxlayır — davam etdirmək üçün', async () => {
    const { db, task, sup } = setup()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'codex-auth-error.jsonl', flavor: 'codex' }),
      model: 'm',
      prompt: 'p',
    })
    expect(listRunsForTask(db, task.id)[0]?.sessionId).toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it('done gəlmədən axın bitərsə failed edir', async () => {
    const { task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'text', delta: 'yarımçıq' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('crashed')
  })

  it('runner atdığı istisnanı tutur və failed edir', async () => {
    const { db, task, sup } = setup()
    // Nə fixture nə events verilməyib → materialize() istisna atır
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({}),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('crashed')
    // İstisna hadisə kimi də jurnala yazılır
    expect(
      listEvents(db, result.runId).some((e) => e.event.t === 'error'),
    ).toBe(true)
  })
})

describe('RunSupervisor — büdcə mühafizəsi', () => {
  it('token limiti aşıldıqda icranı kəsir və hadisəni jurnala YAZMIR', async () => {
    const { db, task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'text', delta: 'a' },
          { t: 'usage', inputTokens: 0, outputTokens: 500, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
      limits: { maxOutputTokens: 10 },
    })

    expect(result.status).toBe('budget_exceeded')
    expect(listRunsForTask(db, task.id)[0]?.errorClass).toBe('budget_exceeded')

    const events = listEvents(db, result.runId)
    // Pozan `usage` və ondan sonraki `done` jurnala düşməməlidir
    expect(events.some((e) => e.event.t === 'usage')).toBe(false)
    expect(events.some((e) => e.event.t === 'done')).toBe(false)
    expect(events.some((e) => e.event.t === 'text')).toBe(true)
  })

  it('KƏSİLMİŞ icranın tokenləri yenə də DB-yə yazılır', async () => {
    // Hadisə jurnala düşmür (yuxarıdakı test), amma HESAB yazılır: `usage`
    // görülmüş işin qeydidir, icazə istəyi deyil — ona baxanda pul ARTIQ
    // xərclənib. Əvvəl `applyUsageToRun` pozuntu yoxlamasından SONRA idi və
    // 26,007 tokenlik real icra `tokens_out = 0` kimi yazılırdı: `RemainingBudget`
    // onu xərcə saymırdı, ledger isə ödənilmiş pulu gizlədirdi (qayda 22/23/49).
    const { db, task, sup } = setup()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'usage', inputTokens: 7, outputTokens: 500, costUsd: 3, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
      limits: { maxOutputTokens: 10 },
    })

    const run = listRunsForTask(db, task.id)[0]
    expect(run?.tokensOut).toBe(500)
    expect(run?.costUsd).toBe(3)
  })

  it('`report` rejimində limit aşılsa da icra DAYANMIR', async () => {
    // İstifadəçinin əl ilə göndərdiyi taskın rejimi budur: `usage` işin
    // sonunda gəlir, yəni kəsmək ödənilmiş nəticəni atmaqdan başqa heç nə
    // etmir — nə pul qaytarır, nə vaxt.
    const { db, task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'text', delta: 'tam cavab' },
          { t: 'usage', inputTokens: 0, outputTokens: 500, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
      limits: { maxOutputTokens: 10, enforcement: 'report' },
    })

    expect(result.status).toBe('succeeded')
    expect(listRunsForTask(db, task.id)[0]?.tokensOut).toBe(500)
    // Nəticə ATILMIR — cavab jurnalda qalır.
    const events = listEvents(db, result.runId)
    expect(events.some((e) => e.event.t === 'done')).toBe(true)
  })

  it('abunəlik icralarında dollar limiti icranı kəsmir', async () => {
    const { task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'm',
      prompt: 'p',
      limits: { maxCostUsd: 0.000001 },
    })
    expect(result.status).toBe('succeeded')
  })

  it('real ödənişli icrada dollar limiti kəsir', async () => {
    const { task, sup } = setup()
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 1, billed: 'real' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
      limits: { maxCostUsd: 0.01 },
    })
    expect(result.status).toBe('budget_exceeded')
  })
})

describe('RunSupervisor — dayandırma', () => {
  it('cancel() icranı interrupted edir', async () => {
    const { task, sup } = setup()
    const runner = new FakeRunner({
      events: Array.from({ length: 60 }, (_, i) => ({
        t: 'text' as const,
        delta: String(i),
      })),
      delayMs: 5,
    })

    const p = sup.execute({ taskId: task.id, runner, model: 'm', prompt: 'p' })
    await new Promise((r) => setTimeout(r, 40))
    const active = sup.activeRunIds()
    expect(active).toHaveLength(1)
    expect(sup.cancel(active[0]!)).toBe(true)

    expect((await p).status).toBe('interrupted')
  }, 20_000)

  it('mövcud olmayan runId üçün cancel false qaytarır', () => {
    const { sup } = setup()
    expect(sup.cancel('yoxdur')).toBe(false)
  })

  it('icra bitdikdən sonra aktiv siyahıdan çıxır', async () => {
    const { task, sup } = setup()
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'done', stopReason: 'end_turn' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(sup.activeRunIds()).toHaveLength(0)
  })

  it('cancelAll bütün aktiv icraları dayandırır', async () => {
    const { task, sup } = setup()
    const mk = () =>
      new FakeRunner({
        events: Array.from({ length: 60 }, (_, i) => ({
          t: 'text' as const,
          delta: String(i),
        })),
        delayMs: 5,
      })
    const a = sup.execute({ taskId: task.id, runner: mk(), model: 'm', prompt: 'p' })
    const b = sup.execute({ taskId: task.id, runner: mk(), model: 'm', prompt: 'p' })
    await new Promise((r) => setTimeout(r, 40))
    expect(sup.activeRunIds()).toHaveLength(2)
    sup.cancelAll()
    expect((await a).status).toBe('interrupted')
    expect((await b).status).toBe('interrupted')
  }, 20_000)
})
