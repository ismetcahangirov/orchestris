import type { RunEvent, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client.js'
import { createContext, createTask } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import type { Customizations } from './customizations.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

function recording(sink: RunRequest[]): Runner {
  const inner = new FakeRunner({ events: DONE })
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: { ...inner.capabilities, fileAccess: false },
    detect: () => inner.detect(),
    run: (req, opts) => {
      sink.push(req)
      return inner.run(req, opts)
    },
  }
}

function setup(customizations?: Customizations) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: null,
    amplificationProfile: 'cheap',
    maxParallel: 1,
    ...(customizations !== undefined ? { customizations } : {}),
  }
  const seen: RunRequest[] = []
  const ladder = new Ladder(db, new RunSupervisor(db))
  const run = async (): Promise<void> => {
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner: recording(seen), model: 'm' })
  }
  return { seen, run }
}

describe('Ladder — fərdiləşdirmə (Faza 5C)', () => {
  it('seçim YOXDURSA customizations undefined qalır', async () => {
    // Fazanın ƏSAS təminatı: seçim etməyən kontekstin əmr sətri bayt-bayt
    // köhnə qalır və mövcud prompt keşləri sınmır (qayda 1).
    const { seen, run } = setup()
    await run()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.customizations).toBeUndefined()
  })

  it('seçim VARSA hər icraya ötürülür', async () => {
    const custom: Customizations = {
      mcpConfigPath: '/cfg.json',
      pluginDirs: ['/plug'],
      builtinSkills: true,
    }
    const { seen, run } = setup(custom)
    await run()
    expect(seen.every((r) => r.customizations?.mcpConfigPath === '/cfg.json')).toBe(true)
    expect(seen[0]?.customizations?.pluginDirs).toEqual(['/plug'])
    expect(seen[0]?.customizations?.builtinSkills).toBe(true)
  })

  it('yalnız daxili skill-lər seçilibsə də ötürülür', async () => {
    const { seen, run } = setup({ pluginDirs: [], builtinSkills: true })
    await run()
    expect(seen[0]?.customizations?.builtinSkills).toBe(true)
    expect(seen[0]?.customizations?.mcpConfigPath).toBeUndefined()
  })
})
