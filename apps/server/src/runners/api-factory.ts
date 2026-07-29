import type { Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  getModel,
  getProvider,
  listProviders,
  modelPrice,
  modelRowId,
} from '../db/registry-repo.js'
import type { ModelPrice } from '../registry/pricing.js'
import type { CredentialStore } from '../secrets/keychain.js'
import { API_PROVIDER_IDS, ApiRunner } from './api.js'

export interface CreateApiRunnersInput {
  db: Db
  credentials: CredentialStore
}

export interface ApiRunnerSet {
  /** `api:anthropic` → runner. */
  runners: Map<string, Runner>
  /** Model qiymətini DB-dən oxuyur — `main.ts` və testlər üçün açıq saxlanılır. */
  resolvePrice: (providerId: string, modelId: string) => ModelPrice | undefined
}

/**
 * Model qiymətini DB-dən oxuyan funksiya.
 *
 * Model DB-də yoxdursa qiymət BİLİNMİR — `{}` qaytarmaq da olardı, amma
 * `undefined` daha dürüstdür: modelin özü haqqında heç nə bilmirik (qayda 4).
 */
export function makeResolvePrice(
  db: Db,
): (providerId: string, modelId: string) => ModelPrice | undefined {
  return (providerId, modelId) => {
    const row = getModel(db, modelRowId(providerId, modelId))
    return row === undefined ? undefined : modelPrice(row)
  }
}

/**
 * Hər API provayderi üçün bir `ApiRunner` qurur.
 *
 * Runner-lər açarı SAXLAMIR — hər icrada DB-dəki `credential_ref` üzərindən
 * OS anbarından yenidən oxuyurlar. Səbəb: istifadəçi açarı silsə və ya
 * dəyişsə, prosesi yenidən başlatmadan dərhal qüvvəyə minməlidir.
 *
 * Həqiqət mənbəyi DB-dəki `credential_ref`-dir, OS anbarındakı qeydin
 * mövcudluğu deyil: silinmiş provayderdən sonra anbarda qalıq qeyd qala
 * bilər və ona baxsaq, istifadəçinin sildiyi açar hələ də işlədilərdi.
 *
 * SİYAHI DB-DƏN GƏLİR, SABİT DEYİL (issue #44). Əvvəl `API_PROVIDER_IDS`
 * üzərində dövr edirdi — yəni istifadəçinin əlavə etdiyi DeepSeek üçün runner
 * HEÇ VAXT qurulmazdı və provayder `/providers`-də "runner yoxdur" görünərdi.
 * Üç sabit id yenə də əlavə olunur: onların sətri DB-də hələ olmaya bilər
 * (ilk start, `seedProviders`-dən əvvəl), halbuki runner-ləri həmişə mövcud
 * olmalıdır — `detect()` onsuz da açarsız halda `authenticated: false` verir.
 */
export function createApiRunners(input: CreateApiRunnersInput): ApiRunnerSet {
  const { db, credentials } = input
  const resolvePrice = makeResolvePrice(db)

  const runners = new Map<string, Runner>()
  const ids = new Set<string>(API_PROVIDER_IDS)
  for (const p of listProviders(db)) {
    if (p.kind !== 'cli') ids.add(p.id)
  }

  for (const providerId of ids) {
    runners.set(providerId, buildApiRunner({ db, credentials, providerId, resolvePrice }).runner)
  }

  return { runners: remap(runners), resolvePrice }
}

/** `Map` açarları runner id-si olmalıdır (`api:<provider>`), provayder id-si yox. */
function remap(byProvider: Map<string, Runner>): Map<string, Runner> {
  const out = new Map<string, Runner>()
  for (const runner of byProvider.values()) out.set(runner.id, runner)
  return out
}

export interface BuildApiRunnerInput {
  db: Db
  credentials: CredentialStore
  providerId: string
  /** Verilməsə DB-dən oxunur (`makeResolvePrice`). */
  resolvePrice?: (providerId: string, modelId: string) => ModelPrice | undefined
}

/**
 * Tək provayder üçün runner qurur — `POST /api/providers` bunu İCRA ANINDA
 * çağırır (issue #44).
 *
 * NİYƏ AYRICA İXRAC: yeni provayder əlavə olunanda runner dərhal lazımdır.
 * Prosesin yenidən başladılmasını tələb etsəydik, istifadəçi açarı yazandan
 * sonra "runner yoxdur" görər və səbəbini heç yerdə tapa bilməzdi.
 *
 * `getBaseUrl` FUNKSİYADIR: provayder silinib başqa ünvanla yenidən əlavə
 * oluna bilər, runner isə prosesin ömrü boyu yaşayır (eyni mühakimə:
 * `getApiKey`).
 */
export function buildApiRunner(input: BuildApiRunnerInput): { runner: ApiRunner } {
  const { db, credentials, providerId } = input
  const runner = new ApiRunner({
    providerId,
    getApiKey: async () => {
      const provider = getProvider(db, providerId)
      if (provider?.credentialRef == null) return null
      return credentials.get(provider.credentialRef)
    },
    getBaseUrl: () => getProvider(db, providerId)?.baseUrl ?? undefined,
    resolvePrice: input.resolvePrice ?? makeResolvePrice(db),
  })
  return { runner }
}
