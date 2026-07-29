import { and, asc, eq } from 'drizzle-orm'
import type { CatalogModel } from '../registry/models-dev.js'
import type { ModelPrice } from '../registry/pricing.js'
import type { Db } from './client.js'
import { models, providers } from './schema.js'

export type ProviderRecord = typeof providers.$inferSelect
export type ModelRecord = typeof models.$inferSelect

const now = (): number => Date.now()

/** `models.id` — provayderlər arası ad toqquşmasının qarşısını alır. */
export function modelRowId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

export function upsertProvider(
  db: Db,
  input: { id: string; displayName: string; kind?: 'api' | 'cli'; baseUrl?: string },
): ProviderRecord {
  const kind = input.kind ?? 'api'
  db.insert(providers)
    .values({
      id: input.id,
      kind,
      displayName: input.displayName,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      createdAt: now(),
    })
    .onConflictDoUpdate({
      target: providers.id,
      // `createdAt` və `credentialRef` QƏSDƏN yenilənmir: provayder metadatası
      // hər server startında yenidən yazılır, amma istifadəçinin açarı və
      // provayderin nə vaxt əlavə olunduğu itməməlidir.
      //
      // `baseUrl` yalnız VERİLƏNDƏ yenilənir: `seedProviders` hər startda
      // qaçır və öz SDK-sı olan provayderlər üçün ünvan ötürmür — şərtsiz
      // yazsaydıq, istifadəçinin əlavə etdiyi provayderin ünvanı `NULL`-a
      // düşərdi və runner ilk sorğuda sınardı.
      set: {
        displayName: input.displayName,
        kind,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      },
    })
    .run()
  return getProvider(db, input.id) as ProviderRecord
}

export function getProvider(db: Db, id: string): ProviderRecord | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get()
}

export function listProviders(db: Db): ProviderRecord[] {
  return db.select().from(providers).orderBy(asc(providers.id)).all()
}

/**
 * Açarın anbardakı adını qeyd edir. AÇARIN ÖZÜ buraya gəlmir — parametr adı
 * `ref`-dir və çağıran `credentialRef(providerId)` nəticəsini ötürür.
 */
export function setProviderCredentialRef(db: Db, id: string, ref: string): void {
  db.update(providers).set({ credentialRef: ref }).where(eq(providers.id, id)).run()
}

export function clearProviderCredentialRef(db: Db, id: string): void {
  db.update(providers)
    .set({ credentialRef: null, lastDiscoveryAt: null, lastDiscoveryError: null })
    .where(eq(providers.id, id))
    .run()
}

export function setProviderDiscoveryResult(
  db: Db,
  id: string,
  result: { ok: true } | { ok: false; error: string },
): void {
  db.update(providers)
    .set(
      result.ok
        ? { lastDiscoveryAt: now(), lastDiscoveryError: null }
        : { lastDiscoveryError: result.error },
    )
    .where(eq(providers.id, id))
    .run()
}

export interface ModelUpsert extends CatalogModel {
  source: 'api' | 'models.dev' | 'manual'
}

/**
 * Provayderin modellərini yenidən yazır.
 *
 * `delete + insert` DEYİL, upsert işlədilir: silmək istifadəçinin təyin etdiyi
 * rol/`enabled` seçimlərini hər kəşfdə sıfırlayardı. Kəşf yalnız METADATANI
 * (ad, qiymət, limit, qabiliyyət) yeniləyir.
 *
 * Kəşfdə görünməyən köhnə modellər saxlanılır — provayder endpoint-i müvəqqəti
 * natamam cavab versə, istifadəçinin işlətdiyi model siyahıdan yoxa çıxmamalıdır.
 */
export function upsertModels(db: Db, providerId: string, list: readonly ModelUpsert[]): void {
  const at = now()
  for (const m of list) {
    const values = {
      id: modelRowId(providerId, m.modelId),
      providerId,
      modelId: m.modelId,
      displayName: m.displayName,
      contextLimit: m.contextLimit ?? null,
      outputLimit: m.outputLimit ?? null,
      // `?? null` — qiymət yoxdursa NULL ("bilinmir"), 0 YOX.
      priceIn: m.price.input ?? null,
      priceOut: m.price.output ?? null,
      priceCacheRead: m.price.cacheRead ?? null,
      priceCacheWrite: m.price.cacheWrite ?? null,
      toolCall: m.toolCall,
      structuredOutput: m.structuredOutput,
      reasoning: m.reasoning,
      source: m.source,
      updatedAt: at,
    }
    db.insert(models)
      .values(values)
      .onConflictDoUpdate({
        target: models.id,
        // `enabled` və rol sütunları YENİLƏNMİR — onlar istifadəçinin qərarıdır.
        set: {
          displayName: values.displayName,
          contextLimit: values.contextLimit,
          outputLimit: values.outputLimit,
          priceIn: values.priceIn,
          priceOut: values.priceOut,
          priceCacheRead: values.priceCacheRead,
          priceCacheWrite: values.priceCacheWrite,
          toolCall: values.toolCall,
          structuredOutput: values.structuredOutput,
          reasoning: values.reasoning,
          source: values.source,
          updatedAt: at,
        },
      })
      .run()
  }
}

export function listModels(db: Db, providerId?: string): ModelRecord[] {
  const q = db.select().from(models)
  const rows =
    providerId === undefined
      ? q.orderBy(asc(models.id)).all()
      : q.where(eq(models.providerId, providerId)).orderBy(asc(models.id)).all()
  return rows
}

export function getModel(db: Db, id: string): ModelRecord | undefined {
  return db.select().from(models).where(eq(models.id, id)).get()
}

/** DB sütunlarını qiymət hesablayıcısının gözlədiyi formaya çevirir. */
export function modelPrice(row: ModelRecord): ModelPrice {
  return {
    ...(row.priceIn !== null ? { input: row.priceIn } : {}),
    ...(row.priceOut !== null ? { output: row.priceOut } : {}),
    ...(row.priceCacheRead !== null ? { cacheRead: row.priceCacheRead } : {}),
    ...(row.priceCacheWrite !== null ? { cacheWrite: row.priceCacheWrite } : {}),
  }
}

export function setModelEnabled(db: Db, id: string, enabled: boolean): void {
  db.update(models).set({ enabled }).where(eq(models.id, id)).run()
}

export type ExclusiveRole = 'boss' | 'classifier'

/**
 * Başçı və ya klassifikator rolunu təyin edir.
 *
 * Əvvəlcə rolu HƏR YERDƏN silir, sonra hədəfə verir. Bazadakı qismən unikal
 * indeks bunu onsuz da məcbur edir — amma indeksə çırpılıb 500 qaytarmaqdansa
 * köhnə sahibi burada təmizləmək düzgün davranışdır: istifadəçi "başçını
 * dəyiş" deyir, "əvvəlcə köhnəni sil" yox.
 */
export function setExclusiveRole(db: Db, role: ExclusiveRole, modelRowIdValue: string): void {
  const column = role === 'boss' ? models.roleBoss : models.roleClassifier
  const field = role === 'boss' ? 'roleBoss' : 'roleClassifier'

  db.transaction((tx) => {
    tx.update(models)
      .set({ [field]: false })
      .where(eq(column, true))
      .run()
    tx.update(models)
      .set({ [field]: true })
      .where(eq(models.id, modelRowIdValue))
      .run()
  })
}

/** Eksklüziv rolu heç kimə vermir — mövcud sahibdən alır. */
export function clearExclusiveRole(db: Db, role: ExclusiveRole): void {
  const column = role === 'boss' ? models.roleBoss : models.roleClassifier
  const field = role === 'boss' ? 'roleBoss' : 'roleClassifier'
  db.update(models)
    .set({ [field]: false })
    .where(eq(column, true))
    .run()
}

export function setWorkerRole(db: Db, id: string, isWorker: boolean): void {
  db.update(models).set({ roleWorker: isWorker }).where(eq(models.id, id)).run()
}

/**
 * İşçi rolunu YALNIZ bir modelə verir — qalanlarından alır.
 *
 * NİYƏ AYRICA FUNKSİYA: `role_worker` ÇOXLUQdur (Auto onun içindən seçir) və
 * `/providers` səhifəsindəki checkbox-lar məhz bunu idarə edir. İdarə
 * panelindəki DROPDOWN isə tək seçim deməkdir — "işçi budur". İki fərqli
 * niyyət, iki fərqli əməliyyat; birini digərinin üstündən yazsaydıq, checkbox
 * ilə qurulmuş çoxlu-işçi konfiqurasiyası hər dropdown toxunuşunda səssizcə
 * dağılardı və istifadəçi bunu yalnız routing qərarlarında görərdi.
 *
 * `setExclusiveRole` ilə eyni forma (tranzaksiya: əvvəlcə hamıdan al, sonra
 * hədəfə ver) — amma bazada UNİKAL İNDEKS YOXDUR, çünki çoxlu işçi QANUNİDİR.
 * Yəni burada tənhalıq tətbiq qatının qərarıdır, baza təminatı deyil; bu fərq
 * qəsdəndir və `models_single_boss_idx` ilə qarışdırılmamalıdır.
 */
export function setSoleWorkerRole(db: Db, id: string): void {
  db.transaction((tx) => {
    tx.update(models).set({ roleWorker: false }).where(eq(models.roleWorker, true)).run()
    tx.update(models).set({ roleWorker: true }).where(eq(models.id, id)).run()
  })
}

export function listWorkerModels(db: Db): ModelRecord[] {
  return db
    .select()
    .from(models)
    .where(and(eq(models.roleWorker, true), eq(models.enabled, true)))
    .orderBy(asc(models.id))
    .all()
}
