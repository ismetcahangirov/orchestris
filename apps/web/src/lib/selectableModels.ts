import type { ModelRow, ProvidersResponse } from './api.js'

/** Seçicidə görünən model + onun runner-inin vəziyyəti. */
export interface SelectableModel {
  model: ModelRow
  runnerId: string
  /** `true` = CLI (abunəlik), `false` = API (real pul). */
  subscription: boolean
  providerLabel: string
  ready: boolean
}

/** `models.provider_id` → runner id. Serverdəki `runnerIdForProvider` ilə eyni qayda. */
function runnerIdFor(providerId: string): string {
  return providerId.startsWith('cli:') ? providerId : `api:${providerId}`
}

/**
 * Seçilə bilən modellər.
 *
 * Dörd filtr, hər biri ayrıca bir yalanın qarşısını alır:
 *  - `enabled` — istifadəçi modeli söndürübsə, onu rol siyahısında göstərmək
 *    "seç" deyib sonra işlətməmək olardı
 *  - `taskCapable` — embedding/şəkil/audio modeli başçı və ya işçi OLA BİLMƏZ
 *    (issue #47); seçilsə task icra anında sınardı. Siqnal serverdə kataloqdan
 *    hesablanır (`registry/capability.ts`) — burada yalnız tətbiq olunur.
 *    `/providers` səhifəsindəki siyahıya bu filtr TOXUNMUR: orada istifadəçi
 *    hər şeyi görməli və əl ilə aktiv/söndürə bilməlidir
 *  - runner tanınır — server o runner-i qeydiyyatdan keçirməyibsə seçim heç
 *    vaxt icra olunmazdı
 *  - hazır DEYİLSƏ siyahıda QALIR, amma işarələnir: "quraşdır" mesajını
 *    görmək üçün istifadəçi modeli seçə bilməlidir, yoxsa səbəb gizli qalardı
 */
export function selectableModels(
  models: readonly ModelRow[],
  providers: ProvidersResponse | undefined,
): SelectableModel[] {
  if (providers === undefined) return []

  const cli = new Map(providers.cli.map((p) => [p.id, p]))
  const apiByRunner = new Map(
    providers.api.filter((p) => p.runnerId !== null).map((p) => [p.runnerId as string, p]),
  )

  const out: SelectableModel[] = []
  for (const model of models) {
    if (!model.enabled || !model.taskCapable) continue
    const runnerId = runnerIdFor(model.providerId)

    const cliRow = cli.get(runnerId)
    if (cliRow !== undefined) {
      out.push({
        model,
        runnerId,
        subscription: true,
        providerLabel: `${runnerId} · abunəlik`,
        ready: cliRow.authenticated,
      })
      continue
    }

    const apiRow = apiByRunner.get(runnerId)
    if (apiRow !== undefined) {
      out.push({
        model,
        runnerId,
        subscription: false,
        providerLabel: `${apiRow.displayName} · real pul`,
        ready: apiRow.authenticated,
      })
    }
    // Nə CLI, nə API siyahısında — runner qeydiyyatdan keçməyib; seçim
    // mənasız olardı, ona görə DÜŞMÜR.
  }
  return out
}
