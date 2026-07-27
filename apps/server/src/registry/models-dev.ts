import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { orchestrisHome } from '../paths.js'
import type { ModelPrice } from './pricing.js'
import bundledSnapshot from './models-snapshot.json' with { type: 'json' }

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 24 saat. models.dev gündə bir neçə dəfə yenilənir — daha tez-tez soruşmaq mənasızdır. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Sxem QƏSDƏN yumşaqdır: `id`-dən başqa hər şey opsionaldır və naməlum
 * açarlar sadəcə atılır.
 *
 * Səbəb: models.dev bizim nəzarətimizdə deyil. Sərt sxem yazsaq, onlar bir
 * sahə əlavə edən və ya bir modeldə sahəni buraxan kimi BÜTÜN kataloq
 * yüklənməzdi və sistem model siyahısız qalardı. Əvəzinə hər model AYRICA
 * yoxlanılır (`safeParse`) və yalnız pozuq model atılır.
 */
const RawCost = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
})

const RawLimit = z.object({
  context: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
})

const RawModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  cost: RawCost.optional(),
  limit: RawLimit.optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  release_date: z.string().optional(),
})

const RawProvider = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  env: z.array(z.string()).optional(),
  npm: z.string().optional(),
  doc: z.string().optional(),
  models: z.record(z.string(), z.unknown()),
})

const RawCatalog = z.record(z.string(), z.unknown())

const CacheFile = z.object({
  fetchedAt: z.number().int().nonnegative(),
  data: RawCatalog,
})

export interface CatalogModel {
  providerId: string
  modelId: string
  displayName: string
  price: ModelPrice
  contextLimit?: number
  outputLimit?: number
  toolCall: boolean
  structuredOutput: boolean
  reasoning: boolean
  inputModalities: string[]
  releaseDate?: string
}

export interface CatalogProvider {
  id: string
  name: string
  /** Bu provayderin açarını daşıyan env dəyişənləri (models.dev bildirir). */
  envVars: string[]
  npm?: string
  doc?: string
  models: CatalogModel[]
}

export interface Catalog {
  providers: CatalogProvider[]
  /** `'bundled'` = repodakı snapshot, `'cache'` = daha əvvəl yüklənmiş nüsxə. */
  source: 'bundled' | 'cache'
  /** `source: 'cache'` olduqda yüklənmə vaxtı (unix ms). */
  fetchedAt?: number
}

function normalizeModel(providerId: string, raw: unknown): CatalogModel | null {
  const parsed = RawModel.safeParse(raw)
  if (!parsed.success) return null
  const m = parsed.data

  // `cost` yoxdursa qiymət BİLİNMİR — sahələr buraxılır, `0` yazılmır.
  const price: ModelPrice = {
    ...(m.cost?.input !== undefined ? { input: m.cost.input } : {}),
    ...(m.cost?.output !== undefined ? { output: m.cost.output } : {}),
    ...(m.cost?.cache_read !== undefined ? { cacheRead: m.cost.cache_read } : {}),
    ...(m.cost?.cache_write !== undefined ? { cacheWrite: m.cost.cache_write } : {}),
  }

  return {
    providerId,
    modelId: m.id,
    displayName: m.name ?? m.id,
    price,
    ...(m.limit?.context !== undefined ? { contextLimit: m.limit.context } : {}),
    ...(m.limit?.output !== undefined ? { outputLimit: m.limit.output } : {}),
    toolCall: m.tool_call ?? false,
    structuredOutput: m.structured_output ?? false,
    reasoning: m.reasoning ?? false,
    inputModalities: m.modalities?.input ?? [],
    ...(m.release_date !== undefined ? { releaseDate: m.release_date } : {}),
  }
}

function normalizeProvider(key: string, raw: unknown): CatalogProvider | null {
  const parsed = RawProvider.safeParse(raw)
  if (!parsed.success) return null
  const p = parsed.data

  const models: CatalogModel[] = []
  for (const modelRaw of Object.values(p.models)) {
    const model = normalizeModel(p.id, modelRaw)
    if (model !== null) models.push(model)
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId))

  return {
    id: p.id,
    name: p.name ?? key,
    envVars: p.env ?? [],
    ...(p.npm !== undefined ? { npm: p.npm } : {}),
    ...(p.doc !== undefined ? { doc: p.doc } : {}),
    models,
  }
}

/** Xam models.dev cavabını (və ya snapshot-u) normallaşdırılmış kataloqa çevirir. */
export function normalizeCatalog(raw: unknown): CatalogProvider[] {
  const parsed = RawCatalog.safeParse(raw)
  if (!parsed.success) return []

  const providers: CatalogProvider[] = []
  for (const [key, value] of Object.entries(parsed.data)) {
    const provider = normalizeProvider(key, value)
    if (provider !== null) providers.push(provider)
  }
  providers.sort((a, b) => a.id.localeCompare(b.id))
  return providers
}

export function catalogCachePath(): string {
  return join(orchestrisHome(), 'models-cache.json')
}

export interface LoadCatalogOptions {
  cacheFile?: string
  /** Test üçün — sabit "indi". */
  now?: number
}

/**
 * Kataloqu yükləyir. ŞƏBƏKƏYƏ ÇIXMIR — yalnız keş faylına və repodakı
 * snapshot-a baxır. Şəbəkə yeniləməsi açıq şəkildə `refreshCatalog` ilə edilir.
 *
 * Bu ayrılıq qəsdəndir: kataloq oxumaq server startında və hər `/api/providers`
 * sorğusunda baş verir; onların hər birində 3 MB yükləmək (və şəbəkə yoxdursa
 * gözləmək) qəbuledilməzdir.
 */
export function loadCatalog(opts: LoadCatalogOptions = {}): Catalog {
  const file = opts.cacheFile ?? catalogCachePath()
  const now = opts.now ?? Date.now()

  try {
    const parsed = CacheFile.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (parsed.success && now - parsed.data.fetchedAt < CATALOG_TTL_MS) {
      const providers = normalizeCatalog(parsed.data.data)
      // Boş kataloq keşi işə yaramır — snapshot-a düşürük.
      if (providers.length > 0) {
        return { providers, source: 'cache', fetchedAt: parsed.data.fetchedAt }
      }
    }
  } catch {
    // Fayl yoxdur / pozuqdur / JSON deyil — snapshot-a düşürük.
  }

  return { providers: normalizeCatalog(bundledSnapshot), source: 'bundled' }
}

export interface RefreshCatalogOptions {
  cacheFile?: string
  now?: number
  /** Test üçün — şəbəkəyə çıxmayan `fetch`. */
  fetchImpl?: typeof fetch
  url?: string
}

/**
 * models.dev-dən yeni nüsxə yükləyib keşə yazır.
 *
 * Uğursuz olarsa ATIR — çağıran (REST route) istifadəçiyə "yenilənmədi, köhnə
 * nüsxə işlədilir" deyə bilsin. Səssizcə köhnə datanı qaytarmaq istifadəçini
 * qiymətin yeniləndiyinə inandırardı.
 */
export async function refreshCatalog(opts: RefreshCatalogOptions = {}): Promise<Catalog> {
  const file = opts.cacheFile ?? catalogCachePath()
  const now = opts.now ?? Date.now()
  const doFetch = opts.fetchImpl ?? fetch

  const res = await doFetch(opts.url ?? MODELS_DEV_URL)
  if (!res.ok) throw new Error(`models.dev → HTTP ${res.status}`)
  const data: unknown = await res.json()

  const providers = normalizeCatalog(data)
  if (providers.length === 0) {
    throw new Error('models.dev cavabından bir dənə də provayder çıxarıla bilmədi')
  }

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ fetchedAt: now, data }), 'utf8')

  return { providers, source: 'cache', fetchedAt: now }
}

/** Snapshot-da olan provayder açarları — `main.ts` hansı ApiRunner-ləri quracağını bilir. */
export const BUNDLED_PROVIDER_IDS: readonly string[] = Object.keys(bundledSnapshot)
