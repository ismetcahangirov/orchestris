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
          outputModalities: ['text'],
        },
        // Task icra EDƏ BİLMƏYƏN model (issue #47): çıxışı şəkildir.
        {
          providerId: 'anthropic',
          modelId: 'şəkil-modeli',
          displayName: 'Şəkil Modeli',
          price: { input: 5, output: 30 },
          toolCall: false,
          structuredOutput: false,
          reasoning: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['image'],
        },
      ],
    },
    // Adapteri olmayan provayder — `seedProviders` onu ATMALIDIR.
    { id: 'adaptersiz', name: 'Adaptersiz', envVars: [], models: [] },
    // OpenAI-uyğun provayder (issue #44): öz adapteri YOXDUR, amma models.dev
    // həm protokolu (`npm`), həm ünvanı (`baseUrl`) bildirir.
    {
      id: 'deepseek',
      name: 'DeepSeek',
      envVars: ['DEEPSEEK_API_KEY'],
      npm: '@ai-sdk/openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      models: [
        {
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          displayName: 'DeepSeek Chat',
          price: { input: 0.27, output: 1.1 },
          contextLimit: 64000,
          toolCall: true,
          structuredOutput: true,
          reasoning: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
        },
      ],
    },
    // `npm` OpenAI-uyğun, amma ÜNVAN yoxdur — əlavə edilə BİLMƏZ.
    {
      id: 'unvansiz',
      name: 'Ünvansız',
      envVars: [],
      npm: '@ai-sdk/openai-compatible',
      models: [],
    },
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
  return { app, credentials, db, runners }
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

describe('Provayder əlavə etmək (issue #44)', () => {
  it('mövcud siyahı yalnız DƏSTƏKLƏNƏN və hələ əlavə edilməmişləri verir', async () => {
    const { app } = makeApp()
    const body = (await app.inject({ method: 'GET', url: '/api/providers/available' })).json()

    // `anthropic` ARTIQ əlavə edilib (`seedProviders`), `adaptersiz`
    // ümumiyyətlə dəstəklənmir, `unvansiz` isə `npm` düzgün olsa da ünvansızdır
    // — dəstəklənməyəni göstərmək işləməyən düymə vermək olardı.
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['deepseek'])
    expect(body.providers[0].support).toBe('openai-compatible')
    expect(body.providers[0].modelCount).toBe(1)
  })

  it('OpenAI-uyğun provayderi əlavə edir və runner-i DƏRHAL qeydiyyata salır', async () => {
    // Runner prosesin yenidən başladılmasını gözləsəydi, istifadəçi açarı
    // yazandan sonra "runner yoxdur" görər və səbəbini heç yerdə tapmazdı.
    const { app, runners, db } = makeApp({
      fetchImpl: fetchReturning({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek', apiKey: 'sk-deepseek-0123456789' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().modelCount).toBe(2)
    expect(runners.has('api:deepseek')).toBe(true)

    // Ünvan DB-də SAXLANILIR: models.dev bizim nəzarətimizdə deyil və provayder
    // oradan silinsə istifadəçinin işləyən quraşdırması sınmamalıdır.
    const { getProvider } = await import('../db/registry-repo.js')
    expect(getProvider(db, 'deepseek')?.baseUrl).toBe('https://api.deepseek.com')
  })

  it('kəşf models.dev qiymətini SAXLAYIR — naməlum model qiymətsiz qalır', async () => {
    // Qayda 4: kataloqda olmayan model üçün `0` yazmaq onu "pulsuz" göstərərdi.
    const { app } = makeApp({
      fetchImpl: fetchReturning({ data: [{ id: 'deepseek-chat' }, { id: 'tanınmayan' }] }),
    })
    await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek', apiKey: 'sk-deepseek-0123456789' },
    })

    const models = (
      await app.inject({ method: 'GET', url: '/api/models?provider=deepseek' })
    ).json()
    const known = models.find((m: { modelId: string }) => m.modelId === 'deepseek-chat')
    const unknown = models.find((m: { modelId: string }) => m.modelId === 'tanınmayan')

    expect(known.priceIn).toBe(0.27)
    expect(known.priceKnown).toBe(true)
    expect(unknown.priceKnown).toBe(false)
    expect(unknown.priceIn).toBeNull()
  })

  it('AÇARSIZ əlavə mümkündür — modellər kataloqdan yazılır', async () => {
    // Lokal provayderlər (Ollama, LM Studio) açar tələb etmir. Kəşf açarsız
    // qaça bilməz, ona görə model siyahısı kataloqdan gəlir.
    const { app, db } = makeApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().modelCount).toBe(1)
    const { getProvider } = await import('../db/registry-repo.js')
    expect(getProvider(db, 'deepseek')?.credentialRef).toBeNull()
  })

  it('dəstəklənməyən provayder 400 verir', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'adaptersiz' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('ÜNVANSIZ openai-compatible provayder 400 verir', async () => {
    // `npm` düzgün olsa da ünvan olmadan runner qurula bilməz.
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'unvansiz' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('kataloqda olmayan provayder 404 verir', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'yoxdur' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('təkrar əlavə 409 verir — mövcud açar üstündən yazılmır', async () => {
    const { app } = makeApp()
    await app.inject({ method: 'POST', url: '/api/providers', payload: { id: 'deepseek' } })

    const again = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('yararsız gövdədə cavab açarı ƏKS ETDİRMİR', async () => {
    // zod `issues` girişin ÖZÜNÜ daşıya bilər (qayda 13).
    const { app } = makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek', apiKey: 'qisa' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).not.toContain('qisa')
  })

  it('əlavə edilmiş provayder `/api/providers` siyahısında runner id-si ilə görünür', async () => {
    const { app } = makeApp()
    await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'deepseek', apiKey: 'sk-deepseek-0123456789' },
    })

    const body = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    const row = body.api.find((p: { id: string }) => p.id === 'deepseek')
    expect(row.runnerId).toBe('api:deepseek')
    expect(row.authenticated).toBe(true)
    // Artıq əlavə edilib — "mövcud" siyahısından çıxmalıdır.
    const avail = (await app.inject({ method: 'GET', url: '/api/providers/available' })).json()
    expect(avail.providers.map((p: { id: string }) => p.id)).not.toContain('deepseek')
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

  it('modelin task icra edə bilib-bilmədiyini bildirir (issue #47)', async () => {
    // Süzgəc SEÇİCİ üçündür, siyahı üçün deyil: `/api/models` yararsız modeli
    // də QAYTARIR (istifadəçi `/providers`-də hər şeyi görməli və əl ilə
    // söndürə bilməlidir), sadəcə onu işarələyir.
    const { app } = makeApp({
      fetchImpl: fetchReturning({
        data: [{ id: 'claude-tanınan' }, { id: 'şəkil-modeli' }, { id: 'claude-yeni' }],
      }),
    })
    await setKey(app)

    const models = (await app.inject({ method: 'GET', url: '/api/models' })).json()
    const byId = (modelId: string): { taskCapable: boolean } =>
      models.find((m: { modelId: string }) => m.modelId === modelId)

    expect(byId('claude-tanınan').taskCapable).toBe(true)
    expect(byId('şəkil-modeli').taskCapable).toBe(false)
    // Kataloqda YOXDUR → modalitlər bilinmir → BURAXILIR. İşlək modeli səssizcə
    // siyahıdan atmaq səhvin bahalı istiqamətidir.
    expect(byId('claude-yeni').taskCapable).toBe(true)
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

  it('BOŞ gövdə + JSON content-type 400 verir — klient başlığı QOYMAMALIDIR (issue #50)', async () => {
    // Serverin davranışı DOĞRUDUR və maskalanmır. Bu test brauzerin göndərdiyi
    // sorğu formasını təkrarlayır: qalan testlər content-type təyin etmədiyi
    // üçün səhv HEÇ BİR testdə görünmürdü — yalnız brauzerdə (issue #50).
    const { app } = makeApp({
      fetchImpl: fetchReturning({
        anthropic: { id: 'anthropic', name: 'Anthropic', env: [], models: { m: { id: 'm' } } },
      }),
    })

    const withHeader = await app.inject({
      method: 'POST',
      url: '/api/registry/refresh',
      headers: { 'content-type': 'application/json' },
    })
    expect(withHeader.statusCode).toBe(400)
    expect(withHeader.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY')

    // Başlıqsız EYNİ sorğu işləyir — yəni düzəliş klientdə olmalıdır.
    const withoutHeader = await app.inject({ method: 'POST', url: '/api/registry/refresh' })
    expect(withoutHeader.statusCode).toBe(200)
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
