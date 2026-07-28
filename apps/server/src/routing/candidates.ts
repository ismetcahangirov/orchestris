import type { Capabilities, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  getProvider,
  listModels,
  upsertModels,
  upsertProvider,
  type ModelRecord,
  type ModelUpsert,
} from '../db/registry-repo.js'
import type { Catalog } from '../registry/models-dev.js'
import type { WorkerCandidate } from './router.js'

/**
 * CLI runner → models.dev-dəki provayder.
 *
 * FAKT, təxmin deyil: `claude` CLI Anthropic modellərini işlədir, `codex`
 * OpenAI modellərini. `claude --help` model adı kimi həm alias (`sonnet`),
 * həm də tam adı (`claude-fable-5`) qəbul edir — models.dev-dəki id-lər
 * ikinci formadır.
 *
 * Bu xəritə olmadan Auto rejimi CLI modellərini GÖRMÜR və routing-in əsas
 * qaydası ("fayl işi → CLI") heç vaxt işə düşə bilməzdi.
 */
export const CLI_CATALOG_PROVIDER: Readonly<Record<string, string>> = {
  'cli:claude': 'anthropic',
  'cli:codex': 'openai',
}

/** `models.provider_id` → runner id. CLI provayderinin id-si ELƏ runner id-sidir. */
export function runnerIdForProvider(providerId: string): string {
  return providerId.startsWith('cli:') ? providerId : `api:${providerId}`
}

/**
 * CLI runner-lərini `providers`/`models` cədvəllərinə yazır.
 *
 * Yalnız HƏQİQƏTƏN qeydiyyatda olan runner-lər üçün: `cli:codex` runner
 * siyahısında yoxdursa, onun modellərini göstərmək istifadəçiyə seçə
 * bilməyəcəyi işçi təklif etmək olardı.
 *
 * `upsertModels` istifadəçinin `enabled`/rol seçimlərini QORUYUR — bu funksiya
 * hər server startında çağırılır.
 */
export function seedCliProviders(
  db: Db,
  runners: ReadonlyMap<string, Runner>,
  catalog: Catalog,
): void {
  for (const [runnerId, catalogProviderId] of Object.entries(CLI_CATALOG_PROVIDER)) {
    const runner = runners.get(runnerId)
    if (runner === undefined) continue

    const source = catalog.providers.find((p) => p.id === catalogProviderId)
    if (source === undefined) continue

    upsertProvider(db, {
      id: runnerId,
      displayName: `${source.name} (CLI)`,
      kind: 'cli',
    })

    const models: ModelUpsert[] = source.models.map((m) => ({
      ...m,
      providerId: runnerId,
      source: 'models.dev' as const,
    }))
    upsertModels(db, runnerId, models)
  }
}

export interface CandidateInput {
  db: Db
  runners: ReadonlyMap<string, Runner>
  /**
   * Runner icraya hazırdırmı. Verilməsə hamısı hazır sayılır.
   *
   * `detect()` burada ÇAĞIRILMIR: CLI runner-lər üçün o, proses spawn edir və
   * routing hər taskda baş verir. Çağıran nəticəni keşləyib bura ötürür.
   */
  isRunnerReady?: (runnerId: string) => boolean
}

/**
 * Auto rejiminin seçə biləcəyi namizədlər.
 *
 * Spesifikasiya tələbi: **Auto yalnız istifadəçinin icazə verdiyi işçilər
 * arasından seçir.** Bu funksiya həmin icazənin tətbiq nöqtəsidir:
 *  - `role_worker = 1` (istifadəçi açıq şəkildə icazə verib)
 *  - `enabled = 1`
 *  - runner qeydiyyatdadır və hazırdır
 *  - API provayderinin açarı var (açarsız model dərhal `auth` xətası verərdi)
 */
export function listWorkerCandidates(input: CandidateInput): WorkerCandidate[] {
  return collect(input, (row) => row.roleWorker && row.enabled)
}

/**
 * Başçı və ya klassifikator rolundakı model.
 *
 * `role_worker` TƏLƏB OLUNMUR: başçı adətən işçi siyahısında olmur (bahalıdır),
 * amma `boss-only` profili və eskalasiya ona ehtiyac duyur.
 */
export function findRoleModel(
  input: CandidateInput,
  role: 'boss' | 'classifier',
): WorkerCandidate | undefined {
  return collect(input, (row) =>
    (role === 'boss' ? row.roleBoss : row.roleClassifier) && row.enabled,
  )[0]
}

function collect(
  input: CandidateInput,
  accept: (row: ModelRecord) => boolean,
): WorkerCandidate[] {
  const { db, runners } = input
  const ready = input.isRunnerReady ?? ((): boolean => true)

  const out: WorkerCandidate[] = []
  for (const row of listModels(db)) {
    if (!accept(row)) continue

    const runnerId = runnerIdForProvider(row.providerId)
    const runner = runners.get(runnerId)
    if (runner === undefined || !ready(runnerId)) continue

    const provider = getProvider(db, row.providerId)
    if (provider === undefined) continue
    // CLI abunəlikdən işləyir — açar tələb etmir. API üçün açar məcburidir.
    if (provider.kind !== 'cli' && provider.credentialRef === null) continue

    out.push({
      rowId: row.id,
      runnerId,
      modelId: row.modelId,
      displayName: row.displayName,
      kind: runner.kind,
      capabilities: capabilitiesFor(runner, row, provider.kind),
      contextLimit: row.contextLimit,
      priceIn: row.priceIn,
      priceOut: row.priceOut,
    })
  }
  return out
}

/**
 * Runner-in qabiliyyəti ilə modelin öz bayraqlarının KƏSİŞMƏSİ.
 *
 * API modelləri üçün models.dev "bu model alət çağıra bilmir" deyə bilər —
 * runner-in ümumi `toolUse: true` dəyəri bunu üstələməməlidir, yoxsa router
 * alət tələb edən taskı onu bacarmayan modelə verərdi.
 *
 * CLI üçün kəsişmə APARILMIR: CLI-nın alətləri modelin API qabiliyyətindən
 * asılı deyil — onları CLI-ın özü icra edir.
 */
function capabilitiesFor(
  runner: Runner,
  row: ModelRecord,
  providerKind: string,
): Capabilities {
  if (providerKind === 'cli') return runner.capabilities
  return {
    ...runner.capabilities,
    toolUse: runner.capabilities.toolUse && row.toolCall,
    structuredOutput: runner.capabilities.structuredOutput && row.structuredOutput,
  }
}
