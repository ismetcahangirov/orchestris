import type { RunEvent, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client.js'
import { createContext, createTask } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

/**
 * Runner-ə gələn `RunRequest`-i tutan sarğı.
 *
 * `FakeRunner` sorğunu saxlamır — bizə isə məhz icazənin ORAYA çatması
 * lazımdır. Nərdivan `supervisor.execute`-i bir neçə yerdən çağırır və
 * onlardan birinin unudulması yalnız real fayl korlanmasında görünərdi.
 */
function recording(inner: Runner, sink: RunRequest[]): Runner {
  return {
    id: inner.id,
    kind: inner.kind,
    capabilities: inner.capabilities,
    detect: () => inner.detect(),
    run: (req, opts) => {
      sink.push(req)
      return inner.run(req, opts)
    },
  }
}

function setup(over: { fileAccess?: string; extraDirsJson?: string } = {}) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: 'C:/repo',
    // `cheap` — tək işçi icrası, eskalasiya yoxdur. İcazə pillələrdən asılı
    // deyil, ona görə ən sadə profil seçilir.
    amplificationProfile: 'cheap',
    // İzolyasiya söndürülür (`worktrees` verilmir) — `cwd` kontekstinkidir.
    maxParallel: 1,
    fileAccess: over.fileAccess ?? 'workspace',
    extraDirsJson: over.extraDirsJson ?? '[]',
  }
  const seen: RunRequest[] = []
  const runner = recording(
    new FakeRunner({ events: DONE, capabilities: { fileAccess: true } }),
    seen,
  )
  const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined)
  const run = async (prompt = 'salam'): Promise<void> => {
    const task = createTask(db, { contextId: ctx.id, prompt })
    await ladder.run({ task, context: ctx, runner, model: 'm' })
  }
  return { seen, run }
}

describe('Ladder — fayl icazəsi hər icraya ötürülür', () => {
  it('icazə HEÇ BİR icrada boş qalmır', async () => {
    const { seen, run } = setup()
    await run()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((r) => r.fileAccess !== undefined)).toBe(true)
  })

  it('read-only kontekstdə səviyyə read-only-dur', async () => {
    const { seen, run } = setup({ fileAccess: 'read-only' })
    await run()
    expect(seen.every((r) => r.fileAccess?.level === 'read-only')).toBe(true)
  })

  it('workspace səviyyəsində əlavə qovluqlar OXUNMUR', async () => {
    const { seen, run } = setup({ extraDirsJson: '["C:/başqa"]' })
    await run()
    expect(seen[0]?.fileAccess?.dirs).toEqual(['C:/repo'])
  })

  it('extended səviyyəsində əlavə qovluq da verilir', async () => {
    const { seen, run } = setup({
      fileAccess: 'extended',
      extraDirsJson: '["C:/başqa"]',
    })
    await run()
    expect(seen[0]?.fileAccess?.dirs).toEqual(['C:/başqa', 'C:/repo'])
  })
})
