import type { Runner } from '@orchestris/shared'
import type { TaskFeatures } from './classify.js'
import { eligible, type RoutingDecision, type WorkerCandidate } from './router.js'

/**
 * Pillə 1-in ikinci yarısı — **opsional** LLM klassifikatoru.
 *
 * Yalnız qayda uyğun gəlmədikdə işə düşür və hədəf ~50 tokendir. Bu, ən ucuz
 * uyğun modelə verilir (rol: `classifier`). Klassifikator təyin olunmayıbsa
 * bu addım tamamilə buraxılır.
 *
 * DÜRÜSTLÜK ŞƏRTİ: bu çağırış pul yandırır və qərar verə bilməsə də yandırır.
 * Ona görə `tokens`/`costUsd` HƏMİŞƏ qaytarılır və `routing_decisions`-a
 * yazılır — orkestrasiyanın öz xərci sayılmasa "qənaət" rəqəmi uydurma olar
 * (issue #8).
 */

/** Sərt çıxış limiti: klassifikatordan bir sətir JSON gözlənilir. */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 64

/** Task promptunun klassifikatora göstərilən hissəsi. */
const PROMPT_EXCERPT_CHARS = 400

/** Bundan aşağı inamlılıqda qərar QƏBUL EDİLMİR — dürüst "bilmirəm". */
export const CLASSIFIER_MIN_CONFIDENCE = 0.6

export interface ClassifierInput {
  runner: Runner
  /** Klassifikator modeli (rol: `classifier`). */
  modelId: string
  prompt: string
  features: TaskFeatures
  candidates: readonly WorkerCandidate[]
  signal?: AbortSignal
}

export interface ClassifierOutcome {
  /** `null` = klassifikator əmin deyil və ya cavabı yararsızdır. */
  decision: RoutingDecision | null
  /** Giriş + çıxış tokenləri. Qərar verilməsə də ödənilib. */
  tokens: number
  /** `undefined` = xərc BİLİNMİR (qayda 4). */
  costUsd?: number
}

export function buildClassifierPrompt(
  prompt: string,
  candidates: readonly WorkerCandidate[],
): string {
  const list = candidates
    .map((c) => `- ${c.rowId} (${c.kind}, ${c.displayName})`)
    .join('\n')
  // Prompt QƏSDƏN qısadır: bu addımın bütün mənası ucuz olmasıdır.
  return [
    'Aşağıdakı task üçün ən uyğun modeli seç. Yalnız JSON qaytar:',
    '{"model":"<id>","confidence":<0..1>}',
    '',
    'Namizədlər:',
    list,
    '',
    `Task: ${prompt.slice(0, PROMPT_EXCERPT_CHARS)}`,
  ].join('\n')
}

/** Mətnin içindən ilk JSON obyektini çıxarır. Kiçik modellər onu mətnə bükür. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function runClassifier(input: ClassifierInput): Promise<ClassifierOutcome> {
  const pool = eligible(input.features, input.candidates)

  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | undefined
  let failed = false

  const stream = input.runner.run(
    {
      prompt: buildClassifierPrompt(input.prompt, pool),
      model: input.modelId,
    },
    {
      maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  )

  try {
    for await (const event of stream) {
      if (event.t === 'text') text += event.delta
      else if (event.t === 'usage') {
        inputTokens = event.inputTokens
        outputTokens = event.outputTokens
        costUsd = event.costUsd
      } else if (event.t === 'error') failed = true
    }
  } catch {
    // Klassifikatorun sınması TASKI sındırmamalıdır — bu addım opsionaldır.
    failed = true
  }

  const tokens = inputTokens + outputTokens
  const spent: Pick<ClassifierOutcome, 'tokens' | 'costUsd'> = {
    tokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  }

  if (failed) return { decision: null, ...spent }

  const parsed = extractJson(text) as { model?: unknown; confidence?: unknown } | null
  const rowId = typeof parsed?.model === 'string' ? parsed.model : undefined
  const confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0

  // Namizəd siyahısında OLMAYAN id qəbul edilmir: model uydura bilər və biz
  // istifadəçinin icazə vermədiyi modelə keçmiş olardıq.
  const chosen = pool.find((c) => c.rowId === rowId)
  if (chosen === undefined || confidence < CLASSIFIER_MIN_CONFIDENCE) {
    return { decision: null, ...spent }
  }

  return {
    decision: {
      strategy: 'classifier',
      runnerId: chosen.runnerId,
      modelId: chosen.modelId,
      chosenRowId: chosen.rowId,
      confidence,
      reason: `klassifikator seçdi (${tokens} token)`,
      decisionTokens: tokens,
      ...(costUsd !== undefined ? { decisionCostUsd: costUsd } : {}),
    },
    ...spent,
  }
}
