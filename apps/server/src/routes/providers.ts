import {
  AddProviderBody,
  SetCredentialBody,
  SetModelEnabledBody,
  SetModelRoleBody,
  type Runner,
} from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import {
  clearExclusiveRole,
  clearProviderCredentialRef,
  getModel,
  getProvider,
  listModels,
  listProviders,
  setExclusiveRole,
  setModelEnabled,
  setProviderCredentialRef,
  setProviderDiscoveryResult,
  setSoleWorkerRole,
  setWorkerRole,
  upsertModels,
  upsertProvider,
} from '../db/registry-repo.js'
import { adapterFor, discoverModels, providerSupport } from '../registry/discovery.js'
import { loadCatalog, refreshCatalog, type Catalog } from '../registry/models-dev.js'
import { buildApiRunner } from '../runners/api-factory.js'
import { credentialRef, type CredentialStore } from '../secrets/keychain.js'
import { redactAll } from '../secrets/redact.js'

export interface ProviderRouteDeps {
  db: Db
  /**
   * DƏYİŞDİRİLƏ BİLƏN xəritə — `POST /api/providers` yeni runner-i BURA yazır
   * (issue #44).
   *
   * `ReadonlyMap` deyil, çünki provayder əlavə olunanda runner dərhal
   * qeydiyyata düşməlidir. Xəritə `main.ts`-də bir dəfə yaradılıb bütün
   * istehlakçılara (router, readiness, `/api/health`) EYNİ istinad kimi
   * ötürülür — yəni `set` çağırışı prosesi yenidən başlatmadan hər yerdə
   * görünür. Nüsxə saxlasaydıq, yeni provayder yalnız növbəti startdan sonra
   * işləyərdi və istifadəçi səbəbini heç yerdə tapa bilməzdi.
   */
  runners: Map<string, Runner>
  credentials: CredentialStore
  /** Server startında yüklənən kataloq; `POST /api/registry/refresh` onu əvəz edir. */
  catalog: Catalog
  /** Test üçün — kəşf şəbəkəyə çıxmasın. */
  fetchImpl?: typeof fetch
  /** Test üçün — kataloq keşi müvəqqəti fayla yazılsın. */
  catalogCacheFile?: string
}

/**
 * Kataloqdan provayder cədvəlini doldurur.
 *
 * YALNIZ öz kəşf adapteri olan üç provayder AVTOMATİK yazılır. Qalan ~135
 * OpenAI-uyğun provayder (issue #44) AVTOMATİK YAZILMIR: hamısını yazsaydıq,
 * `/providers` səhifəsi istifadəçinin heç vaxt işlətməyəcəyi 170 sətirlə
 * dolar və "hansı biri mənimdir?" sualı yaranardı. Onlar `POST /api/providers`
 * ilə AÇIQ şəkildə əlavə olunur — seçim istifadəçinindir.
 */
export function seedProviders(db: Db, catalog: Catalog): void {
  for (const p of catalog.providers) {
    if (adapterFor(p.id) === undefined) continue
    upsertProvider(db, { id: p.id, displayName: p.name })
  }
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteDeps): void {
  const { db, runners, credentials } = deps
  // Kataloq startda bir dəfə yüklənir və `refresh` ilə əvəz olunur —
  // hər sorğuda 3 MB JSON parse etmək mənasızdır.
  let catalog = deps.catalog

  const catalogProvider = (id: string) => catalog.providers.find((p) => p.id === id)

  /**
   * Kəşfi işlədib nəticəni DB-yə yazır. ATMIR — nəticəni qaytarır ki, həm
   * açar yazma, həm də açıq "yenidən kəşf et" yolu eyni davranışı bölüşsün.
   */
  async function runDiscovery(
    providerId: string,
    apiKey: string,
  ): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
    try {
      const discovered = await discoverModels({
        providerId,
        apiKey,
        catalogProvider: catalogProvider(providerId),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      })
      upsertModels(db, providerId, discovered)
      setProviderDiscoveryResult(db, providerId, { ok: true })
      return { ok: true, modelCount: discovered.length }
    } catch (err) {
      // İkiqat kəsmə: `discoverModels` onsuz da kəsir, amma bu yol xətanın
      // DB-yə və HTTP cavabına çıxdığı SON nöqtədir — burada da təkrarlanır.
      const message = redactAll(err instanceof Error ? err.message : String(err), apiKey)
      setProviderDiscoveryResult(db, providerId, { ok: false, error: message })
      return { ok: false, error: message }
    }
  }

  app.get('/api/providers', async () => {
    // API runner-ləri BURAYA qarışmır: `cli` siyahısı "quraşdırılmış icra
    // faylı" mənasını daşıyır və UI onun üçün `npm i -g` məsləhəti göstərir.
    // `api:anthropic` üçün quraşdırılacaq heç nə yoxdur — onun vəziyyəti
    // aşağıdakı `api` sətrində, açarın yanında göstərilir.
    const cli = await Promise.all(
      [...runners.entries()]
        .filter(([, runner]) => runner.kind !== 'api')
        .map(async ([id, runner]) => ({
          id,
          kind: runner.kind,
          capabilities: runner.capabilities,
          ...(await runner.detect()),
        })),
    )

    const models = listModels(db)
    const api = await Promise.all(
      // CLI provayderləri (`kind: 'cli'`) də cədvəldədir — Auto rejimi onların
      // modellərini namizəd kimi görməlidir. Amma onlar bura DÜŞMÜR: bu
      // siyahının hər sətri "API açarı əlavə et" formu göstərir, CLI-ın isə
      // açarı yoxdur (abunəlikdən işləyir). Onların vəziyyəti `cli` siyahısındadır.
      listProviders(db)
        .filter((p) => p.kind !== 'cli')
        .map(async (p) => {
        const meta = catalogProvider(p.id)
        const runnerId = `api:${p.id}`
        const runner = runners.get(runnerId)
        return {
          id: p.id,
          displayName: p.displayName,
          // Açar ÖZÜ deyil, yalnız mövcudluğu bildirilir.
          hasCredential: p.credentialRef !== null,
          enabled: p.enabled,
          modelCount: models.filter((m) => m.providerId === p.id).length,
          lastDiscoveryAt: p.lastDiscoveryAt,
          lastDiscoveryError: p.lastDiscoveryError,
          envVars: meta?.envVars ?? [],
          // Task göndərişində işlədiləcək runner id-si. Runner qeydiyyatdan
          // keçməyibsə `null` — UI provayderi seçilə bilən kimi göstərməməlidir.
          runnerId: runner !== undefined ? runnerId : null,
          authenticated: runner !== undefined ? (await runner.detect()).authenticated : false,
          ...(meta?.doc !== undefined ? { doc: meta.doc } : {}),
        }
      }),
    )

    return {
      cli,
      api,
      keychain: await credentials.health(),
      catalog: {
        source: catalog.source,
        ...(catalog.fetchedAt !== undefined ? { fetchedAt: catalog.fetchedAt } : {}),
        providerCount: catalog.providers.length,
      },
    }
  })

  /**
   * Kataloqda mövcud, amma hələ əlavə edilməmiş provayderlər (issue #44).
   *
   * Siyahı models.dev-dən gəlir və `providerSupport` ilə süzülür: öz adapteri
   * olanlar + `openai-compatible` protokolu göstərənlər. Dəstəklənməyəni
   * göstərmək istifadəçiyə işləməyən düymə vermək olardı.
   */
  app.get('/api/providers/available', async () => ({
    providers: catalog.providers
      .filter((p) => providerSupport(p) !== null && getProvider(db, p.id) === undefined)
      .map((p) => ({
        id: p.id,
        name: p.name,
        support: providerSupport(p),
        modelCount: p.models.length,
        envVars: p.envVars,
        ...(p.doc !== undefined ? { doc: p.doc } : {}),
      })),
    catalogSource: catalog.source,
  }))

  /**
   * Kataloqdan provayder əlavə edir.
   *
   * Runner DƏRHAL qeydiyyata düşür — prosesin yenidən başladılmasını tələb
   * etsəydik, istifadəçi açarı yazandan sonra "runner yoxdur" görər və səbəbini
   * heç yerdə tapa bilməzdi.
   *
   * Açar OPSİONALDIR: lokal provayderlər (Ollama, LM Studio) onu tələb etmir.
   * Verilibsə OS anbarına yazılır (qayda 13 — fayla ASLA) və model kəşfi qaçır.
   */
  app.post('/api/providers', async (req, reply) => {
    const parsed = AddProviderBody.safeParse(req.body)
    // Gövdədə açar ola bilər — zod `issues` girişin ÖZÜNÜ əks etdirə bilir,
    // ona görə burada yalnız sabit mətn qaytarılır (qayda 13).
    if (!parsed.success) return reply.code(400).send({ error: 'id və ya apiKey yararsızdır' })

    const meta = catalogProvider(parsed.data.id)
    if (meta === undefined) {
      return reply.code(404).send({ error: 'Provayder kataloqda tapılmadı' })
    }
    const support = providerSupport(meta)
    if (support === null) {
      return reply.code(400).send({
        error: 'Bu provayderin protokolu dəstəklənmir (yalnız OpenAI-uyğun olanlar)',
      })
    }
    if (getProvider(db, meta.id) !== undefined) {
      return reply.code(409).send({ error: 'Provayder artıq əlavə edilib' })
    }

    upsertProvider(db, {
      id: meta.id,
      displayName: meta.name,
      // Öz SDK-sı olanda ünvan paketin içindədir — sütun NULL qalır.
      ...(support === 'openai-compatible' ? { baseUrl: meta.baseUrl as string } : {}),
    })

    // Runner ƏVVƏLCƏ qurulur: açar yazılışı sınsa belə provayder siyahıda
    // görünməli və "açar əlavə et" formu işləməlidir.
    const { runner } = buildApiRunner({ db, credentials, providerId: meta.id })
    runners.set(runner.id, runner)

    if (parsed.data.apiKey === undefined) {
      // Açarsız əlavə: modellər kataloqdan yazılır ki, seçicidə görünsün.
      // Kəşf açar tələb edir, kataloq isə etmir.
      upsertModels(
        db,
        meta.id,
        meta.models.map((m) => ({ ...m, source: 'models.dev' as const })),
      )
      return reply.code(201).send({ ok: true, modelCount: meta.models.length })
    }

    const health = await credentials.health()
    if (!health.ok) {
      // Açar HEÇ VAXT fayla yazılmır (qayda 13) — provayder əlavə olundu, açar
      // yox; istifadəçi onu sonra əlavə edə bilər.
      return reply.code(503).send({ error: health.detail })
    }
    const ref = credentialRef(meta.id)
    await credentials.set(ref, parsed.data.apiKey)
    setProviderCredentialRef(db, meta.id, ref)

    const result = await runDiscovery(meta.id, parsed.data.apiKey)
    return reply.code(result.ok ? 201 : 502).send(result)
  })

  app.post<{ Params: { id: string } }>(
    '/api/providers/:id/credential',
    async (req, reply) => {
      const parsed = SetCredentialBody.safeParse(req.body)
      // DİQQƏT: `parsed.error.issues` zod tərəfindən yaradılır və `received`
      // sahəsində girişin ÖZÜNÜ daşıya bilər — açarı geri əks etdirməmək üçün
      // burada yalnız sabit mətn qaytarılır.
      if (!parsed.success) {
        return reply.code(400).send({ error: 'apiKey 8–500 simvol olmalıdır' })
      }

      const provider = getProvider(db, req.params.id)
      if (provider === undefined) {
        return reply.code(404).send({ error: 'Provayder tapılmadı' })
      }
      if (adapterFor(provider.id) === undefined) {
        return reply.code(400).send({ error: 'Bu provayder üçün model kəşfi dəstəklənmir' })
      }

      const health = await credentials.health()
      if (!health.ok) {
        // Açıq xəta — açar HEÇ VAXT fayla yazılmır (CLAUDE.md qayda 13).
        return reply.code(503).send({ error: health.detail })
      }

      const ref = credentialRef(provider.id)
      await credentials.set(ref, parsed.data.apiKey)
      setProviderCredentialRef(db, provider.id, ref)

      const result = await runDiscovery(provider.id, parsed.data.apiKey)
      // Cavabda açar YOXDUR — yalnız nəticə.
      return reply.code(result.ok ? 200 : 502).send(result)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/providers/:id/credential',
    async (req, reply) => {
      const provider = getProvider(db, req.params.id)
      if (provider === undefined) {
        return reply.code(404).send({ error: 'Provayder tapılmadı' })
      }

      await credentials.delete(credentialRef(provider.id))
      clearProviderCredentialRef(db, provider.id)
      // Modellər QƏSDƏN saxlanılır: istifadəçinin rol/aktivlik seçimləri
      // itməsin. Açarsız provayderin modelləri router-in namizəd filtrindən
      // onsuz da keçmir.
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>('/api/providers/:id/discover', async (req, reply) => {
    const provider = getProvider(db, req.params.id)
    if (provider === undefined) {
      return reply.code(404).send({ error: 'Provayder tapılmadı' })
    }
    if (provider.credentialRef === null) {
      return reply.code(400).send({ error: 'Bu provayder üçün açar təyin olunmayıb' })
    }

    const apiKey = await credentials.get(provider.credentialRef)
    if (apiKey === null) {
      return reply.code(409).send({
        error: 'Açar OS anbarında tapılmadı — yenidən əlavə et',
      })
    }

    const result = await runDiscovery(provider.id, apiKey)
    return reply.code(result.ok ? 200 : 502).send(result)
  })

  app.get<{ Querystring: { provider?: string } }>('/api/models', async (req) => {
    const rows = listModels(db, req.query.provider)
    return rows.map((m) => ({
      ...m,
      // `null` qiymət "bilinmir" deməkdir — UI bunu `0` kimi göstərməməlidir.
      priceKnown: m.priceIn !== null && m.priceOut !== null,
    }))
  })

  app.post('/api/models/role', async (req, reply) => {
    const parsed = SetModelRoleBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const model = getModel(db, parsed.data.id)
    if (model === undefined) return reply.code(404).send({ error: 'Model tapılmadı' })

    if (parsed.data.role === 'worker') {
      // `exclusive` yalnız rol VERİLƏNDƏ mənalıdır: "tək işçi bu olsun".
      // Rol ALINANDA (`value: false`) onun mənası olmazdı — nəyi tək qoyaq?
      if (parsed.data.value && parsed.data.exclusive === true) {
        setSoleWorkerRole(db, model.id)
      } else {
        setWorkerRole(db, model.id, parsed.data.value)
      }
    } else if (parsed.data.value) {
      setExclusiveRole(db, parsed.data.role, model.id)
    } else {
      clearExclusiveRole(db, parsed.data.role)
    }

    return reply.send(getModel(db, model.id))
  })

  app.post('/api/models/enabled', async (req, reply) => {
    const parsed = SetModelEnabledBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const model = getModel(db, parsed.data.id)
    if (model === undefined) return reply.code(404).send({ error: 'Model tapılmadı' })

    setModelEnabled(db, model.id, parsed.data.enabled)
    return reply.send(getModel(db, model.id))
  })

  app.post('/api/registry/refresh', async (_req, reply) => {
    try {
      catalog = await refreshCatalog({
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.catalogCacheFile !== undefined ? { cacheFile: deps.catalogCacheFile } : {}),
      })
      seedProviders(db, catalog)
      return reply.send({
        ok: true,
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        providerCount: catalog.providers.length,
      })
    } catch (err) {
      // Yeniləmə sınsa köhnə kataloq QALIR — istifadəçi "yeniləndi" yazısı
      // görüb köhnə qiymətlərə inanmamalıdır.
      return reply.code(502).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/** `buildApp` üçün: kataloq verilməyibsə diskdən/snapshot-dan yüklə. */
export function defaultCatalog(cacheFile?: string): Catalog {
  return loadCatalog(cacheFile !== undefined ? { cacheFile } : {})
}
