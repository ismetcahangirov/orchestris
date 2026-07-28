import type { Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import { getModel, getProvider, modelPrice, modelRowId } from '../db/registry-repo.js'
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
 * Hər dəstəklənən API provayderi üçün bir `ApiRunner` qurur.
 *
 * Runner-lər açarı SAXLAMIR — hər icrada DB-dəki `credential_ref` üzərindən
 * OS anbarından yenidən oxuyurlar. Səbəb: istifadəçi açarı silsə və ya
 * dəyişsə, prosesi yenidən başlatmadan dərhal qüvvəyə minməlidir.
 *
 * Həqiqət mənbəyi DB-dəki `credential_ref`-dir, OS anbarındakı qeydin
 * mövcudluğu deyil: silinmiş provayderdən sonra anbarda qalıq qeyd qala
 * bilər və ona baxsaq, istifadəçinin sildiyi açar hələ də işlədilərdi.
 */
export function createApiRunners(input: CreateApiRunnersInput): ApiRunnerSet {
  const { db, credentials } = input

  const resolvePrice = (providerId: string, modelId: string): ModelPrice | undefined => {
    const row = getModel(db, modelRowId(providerId, modelId))
    // Model DB-də yoxdursa qiymət BİLİNMİR — `{}` qaytarmaq da olardı, amma
    // `undefined` daha dürüstdür: modelin özü haqqında heç nə bilmirik.
    return row === undefined ? undefined : modelPrice(row)
  }

  const runners = new Map<string, Runner>()
  for (const providerId of API_PROVIDER_IDS) {
    const runner = new ApiRunner({
      providerId,
      getApiKey: async () => {
        const provider = getProvider(db, providerId)
        if (provider?.credentialRef == null) return null
        return credentials.get(provider.credentialRef)
      },
      resolvePrice,
    })
    runners.set(runner.id, runner)
  }

  return { runners, resolvePrice }
}
