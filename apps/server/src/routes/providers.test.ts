import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import type { Catalog } from '../registry/models-dev.js'
import { createApiRunners } from '../runners/api-factory.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const KEY = 'sk-ant-api03-BuAcarSizmamalidir1234567890'

const CATALOG: Catalog = {
  source: 'bundled',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      envVars: ['ANTHROPIC_API_KEY'],
      doc: 'https://docs.anthropic.com',
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-tanınan',
          displayName: 'Claude Tanınan',
          price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextLimit: 200000,
          outputLimit: 64000,
          toolCall: true,
          structuredOutput: true,
          reasoning: true,
          inputModalities: ['text'],
        },
      ],
    },
    // Adapteri olmayan provayder — `seedProviders` onu ATMALIDIR.
    { id: 'adaptersiz', name: 'Adaptersiz', envVars: [], models: [] },
  ],
}

/** Şəbəkəyə çıxmayan `fetch`. */
function fetchReturning(
  body: unknown,
  init: { ok?: boolean; status?: number; text?: string } = {},
): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => init.text ?? '',
    }) as Response) as unknown as typeof fetch
}

const TWO_MODELS = {
  data: [{ id: 'claude-tanınan', display_name: 'Claude Tanınan' }, { id: 'claude-yeni' }],
}

function makeApp(
  opts: {
    fetchImpl?: typeof fetch
    credentials?: MemoryStore
    /** `createApiRunners` ilə API runner-lərini də qeydiyyatdan keçir. */
    withApiRunners?: boolean
    /** CLI runner-i qeydiyyatdan keçir — `seedCliProviders` işə düşsün. */
    withCliRunner?: boolean
  } = {},
) {
  const credentials = opts.credentials ?? new MemoryStore()
  const db = openDb(':memory:')
  const runners = new Map<string, Runner>([
    ['fake', new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })],
  ])
  if (opts.withCliRunner === true) {
    runners.set('cli:claude', new FakeRunner({ id: 'cli:claude', kind: 'cli', events: [] }))
  }
  if (opts.withApiRunners === true) {
    for (const [id, r] of createApiRunners({ db, credentials }).runners) runners.set(id, r)
  }
  const app = buildApp({
    db,
    runners,
    credentials,
    catalog: CATALOG,
    fetchImpl: opts.fetchImpl ?? fetchReturning(TWO_MODELS),
    catalogCacheFile: join(mkdtempSync(join(tmpdir(), 'orch-routes-')), 'cache.json'),
  })
  return { app, credentials }
}

function setKey(app: ReturnType<typeof makeApp>['app'], id = 'anthropic', apiKey = KEY) {
  return app.inject({
    method: 'POST',
    url: `/api/providers/${id}/credential`,
    payload: { apiKey },
  })
}

describe('seedProviders', () => {
  it('yalnız kəşf adapteri olan provayderləri yazır', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api.map((p: { id: string }) => p.id)).toEqual(['anthropic'])
  })
})

describe('POST /api/providers/:id/credential', () => {
  it('açarı anbara yazır və modelləri kəşf edir', async () => {
    const { app, credentials } = makeApp()
    const res = await setKey(app)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, modelCount: 2 })
    expect(await credentials.get('provider:anthropic')).toBe(KEY)
  })

  it('cavabda açarı GERİ QAYTARMIR', async () => {
    const { app } = makeApp()
    const res = await setKey(app)
    expect(res.body).not.toContain(KEY)
  })

  it('kəşf edilən modellər qiymətləri ilə düşür', async () => {
    const { app } = makeApp()
    await setKey(app)

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    const tanınan = models.find((m: { modelId: string }) => m.modelId === 'claude-tanınan')
    expect(tanınan).toMatchObject({
      priceIn: 3,
      priceOut: 15,
      source: 'models.dev',
      contextLimit: 200000,
      priceKnown: true,
    })
  })

  it('models.dev-də olmayan model işlədilə bilir, amma qiyməti NULL-dur', async () => {
    const { app } = makeApp()
    await setKey(app)

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    const yeni = models.find((m: { modelId: string }) => m.modelId === 'claude-yeni')
    expect(yeni).toMatchObject({ source: 'api', priceIn: null, priceKnown: false })
    expect(yeni.priceIn).not.toBe(0)
  })

  it('GET /api/providers açarın MÖVCUDLUĞUNU göstərir, açarı yox', async () => {
    const { app } = makeApp()
    await setKey(app)

    const res = await app.inject({ method: 'GET', url: '/api/providers' })
    expect(res.body).not.toContain(KEY)
    expect(res.json().api[0]).toMatchObject({ hasCredential: true, modelCount: 2 })
  })

  it('provayder xətasında açar cavaba SIZMIR', async () => {
    const { app } = makeApp({
      fetchImpl: fetchReturning({}, { ok: false, status: 401, text: `bad key: ${KEY}` }),
    })
    const res = await setKey(app)

    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain(KEY)
    expect(res.json().error).toContain('401')
  })

  it('kəşf xətası DB-də saxlanılır — açar KƏSİLMİŞ halda', async () => {
    const { app } = makeApp({
      fetchImpl: fetchReturning({}, { ok: false, status: 401, text: `bad key: ${KEY}` }),
    })
    await setKey(app)

    const res = await app.inject({ method: 'GET', url: '/api/providers' })
    expect(res.body).not.toContain(KEY)
    expect(res.json().api[0].lastDiscoveryError).toContain('401')
  })

  it('qısa açarı rədd edir və girişi ƏKS ETDİRMİR', async () => {
    const { app } = makeApp()
    const res = await setKey(app, 'anthropic', 'qisa')
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('qisa')
  })

  it('naməlum provayder üçün 404', async () => {
    const { app } = makeApp()
    expect((await setKey(app, 'yoxdur')).statusCode).toBe(404)
  })
})

describe('DELETE /api/providers/:id/credential', () => {
  it('açarı anbardan silir və ref-i təmizləyir', async () => {
    const { app, credentials } = makeApp()
    await setKey(app)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/providers/anthropic/credential',
    })
    expect(res.statusCode).toBe(200)
    expect(await credentials.get('provider:anthropic')).toBeNull()

    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api[0].hasCredential).toBe(false)
  })

  it('modelləri SİLMİR — istifadəçinin rol seçimləri itmir', async () => {
    const { app } = makeApp()
    await setKey(app)
    await app.inject({ method: 'DELETE', url: '/api/providers/anthropic/credential' })

    expect((await app.inject({ method: 'GET', url: '/api/models' })).json()).toHaveLength(2)
  })
})

describe('POST /api/providers/:id/discover', () => {
  it('saxlanılmış açarla yenidən kəşf edir', async () => {
    const { app } = makeApp()
    await setKey(app)

    const res = await app.inject({ method: 'POST', url: '/api/providers/anthropic/discover' })
    expect(res.statusCode).toBe(200)
    expect(res.json().modelCount).toBe(2)
  })

  it('açar yoxdursa 400', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/providers/anthropic/discover' })
    expect(res.statusCode).toBe(400)
  })

  it('ref var, amma anbarda açar yoxdursa 409', async () => {
    const { app, credentials } = makeApp()
    await setKey(app)
    // İstifadəçi açarı OS anbarından əl ilə sildi.
    await credentials.delete('provider:anthropic')

    const res = await app.inject({ method: 'POST', url: '/api/providers/anthropic/discover' })
    expect(res.statusCode).toBe(409)
  })
})

describe('model rolları', () => {
  it('işçi rolunu təyin edir', async () => {
    const { app } = makeApp()
    await setKey(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/models/role',
      payload: { id: 'anthropic:claude-tanınan', role: 'worker', value: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().roleWorker).toBe(true)
  })

  it('başçı rolu YALNIZ bir modeldə qalır', async () => {
    const { app } = makeApp()
    await setKey(app)

    for (const id of ['anthropic:claude-tanınan', 'anthropic:claude-yeni']) {
      await app.inject({
        method: 'POST',
        url: '/api/models/role',
        payload: { id, role: 'boss', value: true },
      })
    }

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    expect(models.filter((m: { roleBoss: boolean }) => m.roleBoss)).toHaveLength(1)
    expect(models.find((m: { roleBoss: boolean }) => m.roleBoss).modelId).toBe('claude-yeni')
  })

  it('başçı rolunu geri almaq mümkündür', async () => {
    const { app } = makeApp()
    await setKey(app)
    const id = 'anthropic:claude-tanınan'

    await app.inject({ method: 'POST', url: '/api/models/role', payload: { id, role: 'boss', value: true } })
    await app.inject({ method: 'POST', url: '/api/models/role', payload: { id, role: 'boss', value: false } })

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    expect(models.filter((m: { roleBoss: boolean }) => m.roleBoss)).toHaveLength(0)
  })

  it('`exclusive` işçi rolunu YALNIZ bir modeldə saxlayır', async () => {
    // İdarə panelindəki dropdown tək seçim deməkdir. Bayraq olmasaydı, klient
    // köhnə işçiləri təmizləmək üçün N ayrı sorğu göndərməli olardı — yarıda
    // sınsa sistem "işçi yoxdur" vəziyyətində qalardı.
    const { app } = makeApp()
    await setKey(app)

    for (const id of ['anthropic:claude-tanınan', 'anthropic:claude-yeni']) {
      await app.inject({
        method: 'POST',
        url: '/api/models/role',
        payload: { id, role: 'worker', value: true },
      })
    }
    // İki işçi QANUNİDİR — Auto onların içindən seçir.
    let models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    expect(models.filter((m: { roleWorker: boolean }) => m.roleWorker)).toHaveLength(2)

    await app.inject({
      method: 'POST',
      url: '/api/models/role',
      payload: {
        id: 'anthropic:claude-tanınan',
        role: 'worker',
        value: true,
        exclusive: true,
      },
    })

    models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    const workers = models.filter((m: { roleWorker: boolean }) => m.roleWorker)
    expect(workers).toHaveLength(1)
    expect(workers[0].modelId).toBe('claude-tanınan')
  })

  it('`exclusive` OLMADAN işçi rolu ƏLAVƏ olunur — köhnəsi qalır', async () => {
    // `/providers` səhifəsindəki checkbox məhz bu yolu işlədir; dropdown-un
    // davranışını ona da tətbiq etsəydik, çoxlu işçi qurmaq mümkün olmazdı.
    const { app } = makeApp()
    await setKey(app)

    for (const id of ['anthropic:claude-tanınan', 'anthropic:claude-yeni']) {
      await app.inject({
        method: 'POST',
        url: '/api/models/role',
        payload: { id, role: 'worker', value: true },
      })
    }

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    expect(models.filter((m: { roleWorker: boolean }) => m.roleWorker)).toHaveLength(2)
  })

  it('`exclusive` rol ALINANDA nəzərə alınmır', async () => {
    // "Nəyi tək qoyaq?" sualının cavabı yoxdur — bayraq yalnız rol VERİLƏNDƏ
    // mənalıdır.
    const { app } = makeApp()
    await setKey(app)
    const id = 'anthropic:claude-tanınan'

    await app.inject({
      method: 'POST',
      url: '/api/models/role',
      payload: { id, role: 'worker', value: true },
    })
    await app.inject({
      method: 'POST',
      url: '/api/models/role',
      payload: { id, role: 'worker', value: false, exclusive: true },
    })

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    expect(models.filter((m: { roleWorker: boolean }) => m.roleWorker)).toHaveLength(0)
  })

  it('naməlum model üçün 404', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/role',
      payload: { id: 'yoxdur', role: 'worker', value: true },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/models/enabled', () => {
  it('modeli söndürür və yandırır', async () => {
    const { app } = makeApp()
    await setKey(app)
    const id = 'anthropic:claude-tanınan'

    expect(
      (
        await app.inject({ method: 'POST', url: '/api/models/enabled', payload: { id, enabled: false } })
      ).json().enabled,
    ).toBe(false)
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/models/enabled', payload: { id, enabled: true } })
      ).json().enabled,
    ).toBe(true)
  })
})

describe('POST /api/registry/refresh', () => {
  it('kataloqu yeniləyir', async () => {
    const { app } = makeApp({
      fetchImpl: fetchReturning({
        anthropic: { id: 'anthropic', name: 'Anthropic', env: [], models: { m: { id: 'm' } } },
      }),
    })
    const res = await app.inject({ method: 'POST', url: '/api/registry/refresh' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, source: 'cache', providerCount: 1 })
  })

  it('yeniləmə sınsa 502 verir — "yeniləndi" demir', async () => {
    const { app } = makeApp({ fetchImpl: fetchReturning({}, { ok: false, status: 503 }) })
    const res = await app.inject({ method: 'POST', url: '/api/registry/refresh' })
    expect(res.statusCode).toBe(502)
    expect(res.json().ok).toBe(false)
  })
})

describe('keychain əlçatan olmadıqda', () => {
  it('açar QƏBUL EDİLMİR və fayla yazılmır', async () => {
    class BrokenStore extends MemoryStore {
      override async health() {
        return { ok: false, detail: 'OS açar anbarı əlçatan deyil: D-Bus yoxdur' }
      }
    }
    const broken = new BrokenStore()
    const { app } = makeApp({ credentials: broken })

    const res = await setKey(app)
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toContain('əlçatan deyil')
    // Açar HEÇ YERƏ yazılmadı.
    expect(await broken.get('provider:anthropic')).toBeNull()
  })
})

describe('GET /api/providers — CLI və API runner-lərinin ayrılması', () => {
  it('cli siyahısına API runner-lərini QARIŞDIRMIR', async () => {
    // Eyni siyahıya qatsaq, `/providers` səhifəsi `api:anthropic`-i quraşdırılmış
    // CLI kimi göstərərdi və istifadəçi onu `npm i -g` ilə "düzəltməyə" çalışardı.
    const { app } = makeApp({ withApiRunners: true })
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.cli.map((p: { id: string }) => p.id)).toEqual(['fake'])
  })

  it('API provayder sətri öz runner id-sini göstərir', async () => {
    const { app } = makeApp({ withApiRunners: true })
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api[0]).toMatchObject({ id: 'anthropic', runnerId: 'api:anthropic' })
  })

  it('runner qeydiyyatdan keçməyibsə runnerId null olur', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api[0].runnerId).toBeNull()
  })

  it('açar yoxdursa API runner authenticated deyil', async () => {
    const { app } = makeApp({ withApiRunners: true })
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api[0]).toMatchObject({ hasCredential: false, authenticated: false })
  })

  it('açar əlavə ediləndən sonra API runner authenticated olur', async () => {
    const { app } = makeApp({ withApiRunners: true })
    await setKey(app)
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(body.api[0]).toMatchObject({ hasCredential: true, authenticated: true })
  })
})

describe('GET /api/providers — CLI provayderləri API siyahısına düşmür', () => {
  it('api siyahısında yalnız kind=api provayderləri olur', async () => {
    // `seedCliProviders` CLI runner-lərini də `providers` cədvəlinə yazır
    // (Auto rejimi onların modellərini namizəd kimi görməlidir). Amma onlar
    // API provayderi DEYİL: `/providers` səhifəsi onlara "API açarı əlavə et"
    // formu göstərməməlidir — CLI-ın açarı yoxdur, abunəlikdən işləyir.
    const { app } = makeApp({ withCliRunner: true })
    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()

    expect(body.api.map((p: { id: string }) => p.id)).not.toContain('cli:claude')
    expect(body.cli.map((p: { id: string }) => p.id)).toContain('cli:claude')
  })
})
