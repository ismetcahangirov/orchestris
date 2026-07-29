import { describe, expect, it, vi } from 'vitest'
import type { Runner } from '@orchestris/shared'
import { buildApp } from './app.js'
import { openDb } from './db/client.js'
import { FakeRunner } from './runners/fake.js'
import { MemoryStore } from './secrets/keychain.js'

function makeApp() {
  const db = openDb(':memory:')
  const runners = new Map<string, Runner>([
    ['fake', new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })],
  ])
  // `MemoryStore` MƏCBURİDİR: default `KeyringStore` istifadəçinin real OS
  // anbarına yazardı və başsız CI runner-ində sınardı.
  return buildApp({ db, runners, credentials: new MemoryStore() })
}

async function newContext(
  app: ReturnType<typeof makeApp>,
  name = 'C',
  cwd?: string,
  profile?: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contexts',
    payload: { name, ...(cwd !== undefined ? { cwd } : {}) },
  })
  const ctx = res.json() as { id: string }
  if (profile !== undefined) {
    await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { amplificationProfile: profile },
    })
  }
  return ctx
}

describe('GET /api/health', () => {
  it('ok və runner siyahısı qaytarır', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, runners: ['fake'] })
  })
})

describe('POST /api/contexts', () => {
  it('kontekst yaradır', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'Layihəm', verifyCommands: ['pnpm typecheck'] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('Layihəm')
    expect(body.id).toBeTruthy()
    expect(JSON.parse(body.verifyCommandsJson)).toEqual(['pnpm typecheck'])
  })

  it('boş adı 400 ilə rədd edir', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('yanlış tipli sahəni 400 ilə rədd edir', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'A', verifyCommands: 'not-an-array' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/contexts', () => {
  it('yaradılmış kontekstləri sadalayır', async () => {
    const app = makeApp()
    await newContext(app, 'A')
    await newContext(app, 'B')
    const res = await app.inject({ method: 'GET', url: '/api/contexts' })
    expect(res.json()).toHaveLength(2)
  })
})

describe('POST /api/tasks', () => {
  it('taskı yaradır və 202 qaytarır', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'salam', runner: 'fake', model: 'm' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().taskId).toBeTruthy()
  })

  it('runner verilməsə mövcud olanı seçir', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'p', model: 'm' },
    })
    expect(res.statusCode).toBe(202)
  })

  it('mövcud olmayan kontekst üçün 404 verir', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: 'yoxdur', prompt: 'p', runner: 'fake', model: 'm' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('qeydiyyatda olmayan runner üçün 400 verir', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'p', runner: 'cli:codex', model: 'm' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().available).toEqual(['fake'])
  })

  it('boş prompt-u 400 ilə rədd edir', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: '', runner: 'fake', model: 'm' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/tasks/:id', () => {
  it('task, run-lar və hadisələri qaytarır', async () => {
    const app = makeApp()
    // `cheap` profili QƏSDƏN: bu test endpoint-in FORMASINI yoxlayır, nərdivanın
    // neçə pillə qalxdığını yox. `balanced` profili yoxlama əmri olmayan taskda
    // Pillə 3-ü (best-of-N) işə salır və nəticədə bir neçə run yaranır — o,
    // ladder testlərinin işidir.
    const ctx = await newContext(app, 'C', undefined, 'cheap')
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'p', runner: 'fake', model: 'm' },
      })
    ).json()

    // İcra fon rejimindədir — bitməsini gözləyirik.
    await vi.waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
      const b = r.json()
      expect(b.runs[0]?.status).toBe('succeeded')
    }, { timeout: 5000, interval: 25 })

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
    const body = res.json()
    expect(res.statusCode).toBe(200)
    expect(body.task.prompt).toBe('p')
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].events.length).toBeGreaterThan(2)
    expect(body.runs[0].tokensOut).toBe(59)
  })

  it('mövcud olmayan task üçün 404 verir', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/tasks/yoxdur' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/tasks/:id/cancel', () => {
  it('mövcud olmayan task üçün 404 verir', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/api/tasks/yoxdur/cancel',
    })
    expect(res.statusCode).toBe(404)
  })

  it('bitmiş task üçün boş siyahı qaytarır', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'p', runner: 'fake', model: 'm' },
      })
    ).json()
    await vi.waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
      expect(r.json().runs[0]?.status).toBe('succeeded')
    }, { timeout: 5000, interval: 25 })

    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.taskId}/cancel`,
    })
    expect(res.json().cancelled).toEqual([])
  })
})

describe('Pillə 0 — cache uçdan-uca', () => {
  it('eyni prompt ikinci dəfə keşdən gəlir', async () => {
    const app = makeApp()
    // FakeRunner-in default capabilities.fileAccess === true, ona görə keş
    // açarı repo barmaq izi tələb edir — kontekstə real git qovluğu lazımdır
    // (bax ladder.test.ts: "fayl girişi tələb edən task git olmayan qovluqda
    // keşlənmir").
    const ctx = await newContext(app, 'C', process.cwd())

    const post = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: { contextId: ctx.id, prompt: 'eyni sual', runner: 'fake', model: 'm' },
        })
      ).json() as { taskId: string }

    const waitDone = async (taskId: string) => {
      await vi.waitFor(
        async () => {
          const r = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })
          expect(r.json().runs[0]?.status).toBe('succeeded')
        },
        { timeout: 5000, interval: 25 },
      )
      return (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    }

    const first = await waitDone((await post()).taskId)
    expect(first.runs[0].cachedHit).toBe(false)

    const second = await waitDone((await post()).taskId)
    expect(second.runs[0].cachedHit).toBe(true)
    expect(second.runs[0].ladderRung).toBe(0)
  })
})

describe('GET /api/tasks/:id — yoxlama nəticələri', () => {
  it('run cavabında verifications massivi var', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'p', runner: 'fake', model: 'm' },
      })
    ).json()
    await vi.waitFor(
      async () => {
        const r = await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
        expect(r.json().runs[0]?.status).toBe('succeeded')
      },
      { timeout: 5000, interval: 25 },
    )
    const body = (
      await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
    ).json()
    expect(Array.isArray(body.runs[0].verifications)).toBe(true)
  })
})

describe('GET /api/providers', () => {
  it('CLI runner aşkarlama nəticələrini qaytarır', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/providers' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cli).toHaveLength(1)
    expect(body.cli[0]).toMatchObject({
      id: 'fake',
      kind: 'fake',
      installed: true,
      authenticated: true,
    })
    expect(body.cli[0].capabilities).toBeTruthy()
  })

  it('API provayderlərini kataloqdan doldurur və açar vəziyyətini göstərir', async () => {
    const body = (
      await makeApp().inject({ method: 'GET', url: '/api/providers' })
    ).json()

    expect(body.api.map((p: { id: string }) => p.id).sort()).toEqual([
      'anthropic',
      'google',
      'openai',
    ])
    expect(body.api[0]).toMatchObject({ hasCredential: false, modelCount: 0 })
    expect(body.keychain.ok).toBe(true)
    expect(body.catalog.source).toBeTruthy()
  })

  it('cavabda açar daşıya biləcək JSON sahəsi YOXDUR', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/providers' })

    // JSON AÇARLARI yoxlanılır (dırnaq + iki nöqtə), sadəcə alt-sətir yox:
    // `envVars` içindəki `GOOGLE_GENERATIVE_AI_API_KEY` env dəyişəninin
    // ADIDIR — sirr deyil və cavabda olması normaldır.
    expect(res.body).not.toMatch(/"(apiKey|api_key|credentialRef|secret|password)"\s*:/i)
  })
})
