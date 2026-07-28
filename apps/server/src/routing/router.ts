import { canHandle, type Capabilities, type TaskRequirements } from '@orchestris/shared'
import type { TaskFeatures } from './classify.js'
import { matchRule, type RoutingRule } from './rules.js'

/**
 * Qərar strategiyası — `routing_decisions.strategy` sütununda saxlanılır.
 *
 * `manual` istifadəçinin seçimi; `rule` 0 token; `classifier` ~50 token;
 * `default` kontekstin default işçisi; `fallback` "qayda tutmadı, namizədlər
 * arasından ən uyğununu seçdim".
 */
export type RoutingStrategy =
  | 'manual'
  | 'rule'
  | 'classifier'
  /** `boss-only` profili — baseline ölçməsi. Faza 2-də başçının real qərarı da bura düşəcək. */
  | 'boss'
  | 'default'
  | 'fallback'

export interface WorkerCandidate {
  /** `models.id` — `${providerId}:${modelId}` */
  rowId: string
  runnerId: string
  /** Runner-ə ötürülən model adı. */
  modelId: string
  displayName: string
  kind: 'cli' | 'api' | 'fake'
  capabilities: Capabilities
  /** `null` = bilinmir (models.dev bildirməyib) — namizədi ATMIR. */
  contextLimit: number | null
  /** USD / 1M token. `null` = bilinmir, `0` deyil (CLAUDE.md qayda 4). */
  priceIn: number | null
  priceOut: number | null
}

export interface RoutingDecision {
  strategy: RoutingStrategy
  runnerId: string
  modelId: string
  /** `models.id`. Əl ilə seçimdə model cədvəldə olmaya bilər → `null`. */
  chosenRowId: string | null
  confidence: number
  reason: string
  /** Qərarın ÖZ xərci. Qayda və default üçün həmişə 0. */
  decisionTokens: number
  decisionCostUsd?: number
  ruleId?: string
}

export interface RouteInput {
  features: TaskFeatures
  candidates: readonly WorkerCandidate[]
  /** Kontekstin default işçisi (`models.id`). */
  defaultWorkerRowId?: string | null
  rules?: readonly RoutingRule[]
}

/**
 * Promptun təxmini token sayı. Dəqiq tokenizasiya İSTƏMİRİK: o, model başına
 * fərqlidir və kitabxana tələb edir. 4 simvol ≈ 1 token yaxınlaşması kontekst
 * limitini filtrləmək üçün kifayətdir.
 */
const CHARS_PER_TOKEN = 4
/** Cavab + sistem promptu üçün ehtiyat. */
const RESPONSE_HEADROOM_TOKENS = 4000

export function estimateTokens(promptChars: number): number {
  return Math.ceil(promptChars / CHARS_PER_TOKEN) + RESPONSE_HEADROOM_TOKENS
}

function requirementsOf(f: TaskFeatures): TaskRequirements {
  return {
    ...(f.needsFileAccess ? { needsFileAccess: true } : {}),
    ...(f.needsToolUse ? { needsToolUse: true } : {}),
    ...(f.needsStructuredOutput ? { needsStructuredOutput: true } : {}),
  }
}

/**
 * Taskı ÜMUMİYYƏTLƏ görə bilən namizədlər.
 *
 * Bu filtr qaydadan ÜSTÜNDÜR: qayda "API-yə göndər" desə də, fayl girişi
 * bacarmayan model fayl taskını edə bilməz. Filtr həm də spesifikasiyanın
 * "Auto yalnız icazə verilənlər arasından seçir" tələbinin son həlqəsidir —
 * namizəd siyahısı onsuz da yalnız istifadəçinin işçi kimi işarələdiyi
 * modellərdən qurulur (`candidates.ts`).
 */
export function eligible(
  features: TaskFeatures,
  candidates: readonly WorkerCandidate[],
): WorkerCandidate[] {
  const req = requirementsOf(features)
  const needed = estimateTokens(features.promptChars)
  return candidates.filter((c) => {
    if (!canHandle(c.capabilities, req)) return false
    // `null` = limit BİLİNMİR. Atmaq models.dev-də limiti göstərilməyən
    // modelləri həmişəlik sıradan çıxarardı — bilinməyəni pis saymırıq.
    if (c.contextLimit !== null && c.contextLimit < needed) return false
    return true
  })
}

/**
 * Ucuzdan bahaya sıralayır. Qiyməti BİLİNMƏYƏN modellər sona düşür: orada
 * büdcə mühafizəsi kor qalır (qayda 4, 15), ona görə eyni şərtlərdə bilinən
 * qiymət üstündür. `0` isə "həqiqətən pulsuz"dur və birinci gəlir.
 */
function byPrice(a: WorkerCandidate, b: WorkerCandidate): number {
  const priceOf = (c: WorkerCandidate): number | null =>
    c.priceIn === null || c.priceOut === null ? null : c.priceIn + c.priceOut
  const pa = priceOf(a)
  const pb = priceOf(b)
  if (pa === null && pb === null) return a.rowId.localeCompare(b.rowId)
  if (pa === null) return 1
  if (pb === null) return -1
  if (pa !== pb) return pa - pb
  return a.rowId.localeCompare(b.rowId)
}

function decisionFor(
  candidate: WorkerCandidate,
  fields: Omit<RoutingDecision, 'runnerId' | 'modelId' | 'chosenRowId'>,
): RoutingDecision {
  return {
    ...fields,
    runnerId: candidate.runnerId,
    modelId: candidate.modelId,
    chosenRowId: candidate.rowId,
  }
}

/**
 * Pillə 1 — qayda routing. SIFIR token.
 *
 * `null` qaytarmaq NORMALDIR və dürüstdür: qayda uyğun gəlmədi, ya da uyğun
 * gələn qaydanın istədiyi növdə namizəd yoxdur. Çağıran o zaman klassifikatora
 * və ya default işçiyə keçir — uydurma qərar vermir.
 */
export function routeByRules(input: RouteInput): RoutingDecision | null {
  const pool = eligible(input.features, input.candidates)
  if (pool.length === 0) return null

  const rule = matchRule(input.features, input.rules)
  if (rule === undefined) return null

  const preferred = pool.filter((c) => c.kind === rule.prefer).sort(byPrice)
  const chosen = preferred[0]
  if (chosen === undefined) return null

  return decisionFor(chosen, {
    strategy: 'rule',
    confidence: input.features.confidence,
    reason: `qayda "${rule.id}": ${rule.description}`,
    ruleId: rule.id,
    decisionTokens: 0,
    decisionCostUsd: 0,
  })
}

/**
 * Qayda tutmadıqda (və klassifikator yoxdursa) son həlqə.
 *
 * Spesifikasiya Faza 1 üçün belə deyir: qeyri-müəyyənlikdə kontekstin
 * `default_worker_model_id` işçisi seçilir. Başçının qərar verməsi Faza 2-dədir.
 */
export function pickFallback(input: RouteInput): RoutingDecision | null {
  const pool = eligible(input.features, input.candidates)
  if (pool.length === 0) return null

  const preferred =
    input.defaultWorkerRowId != null
      ? pool.find((c) => c.rowId === input.defaultWorkerRowId)
      : undefined

  if (preferred !== undefined) {
    return decisionFor(preferred, {
      strategy: 'default',
      confidence: input.features.confidence,
      reason: 'qayda uyğun gəlmədi → kontekstin default işçisi',
      decisionTokens: 0,
      decisionCostUsd: 0,
    })
  }

  // Default işçi namizəd deyilsə (söndürülüb, qabiliyyəti çatmır və ya
  // istifadəçi onu işçi siyahısından çıxarıb) ona KEÇMİRİK — bu, icazə
  // verilməmiş modelə keçmək olardı.
  const chosen = [...pool].sort(byPrice)[0]
  if (chosen === undefined) return null

  return decisionFor(chosen, {
    strategy: 'fallback',
    confidence: input.features.confidence,
    reason:
      input.defaultWorkerRowId == null
        ? 'qayda uyğun gəlmədi, default işçi təyin olunmayıb → ən ucuz uyğun namizəd'
        : 'default işçi bu task üçün uyğun deyil → ən ucuz uyğun namizəd',
    decisionTokens: 0,
    decisionCostUsd: 0,
  })
}
