import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { memoryCostForTask } from '../db/memory-repo.js'
import { modelPrice, type ModelRecord } from '../db/registry-repo.js'
import { getTask, listEvents, listRunsForTask } from '../db/repo.js'
import { listRoutingDecisions } from '../db/routing-repo.js'
import { models } from '../db/schema.js'
import { computeCostUsd, type TokenCounts } from '../registry/pricing.js'
import { DISTILL_RUNG } from './distill.js'

/**
 * Qənaətin DÜRÜST ölçülməsi.
 *
 * Layihənin bütün iddiası budur: *zəif modeldən güclü model performansı, az
 * xərclə*. İddia ölçülməsə marketing cümləsidir. Bu modul onu ölçür və
 * ölçmənin yalan danışa biləcəyi hər yeri qapayır:
 *
 * | Təhlükə | Qapanma |
 * |---|---|
 * | Orkestratorun öz xərci sayılmır | `orchestrationCostUsd` net qənaətdən ÇIXILIR |
 * | Abunəlik real pul kimi göstərilir | ayrıca sütun (`actualSubscriptionUsd`) |
 * | Naməlum xərc `0` sayılır | `null` yayılır, uydurma rəqəm verilmir |
 * | Uğursuz taskda "qənaət" iddiası | baseline `null` — nəticə alınmayıb |
 *
 * Baseline ƏKS-FAKTDIR: eyni tokenlər başçının qiymətləri ilə. Bu, TƏXMİNDİR
 * — başçı həmin taskı daha az (və ya daha çox) token ilə həll edə bilərdi.
 * Dəqiq müqayisə üçün `boss-only` amplifikasiya profili var: onunla eyni task
 * həqiqətən başçıya verilir və iki ölçmə tutuşdurulur.
 */

export interface RungCost {
  rung: number
  runs: number
  costUsd: number
  subscriptionUsd: number
}

export interface TaskSavings {
  taskId: string
  /** REAL pul. `null` = bilinmir (hansısa icranın xərci naməlumdur). */
  actualCostUsd: number | null
  /** Abunəlikdən gedən İSTİNAD xərci — kartdan çıxmayan pul. */
  actualSubscriptionUsd: number | null
  /** Əks-fakt: eyni tokenlər başçının qiymətləri ilə. */
  baselineCostUsd: number | null
  /** `models.id`. Başçı təyin olunmayıbsa `null`. */
  baselineModelId: string | null
  /** Başçı abunəlikdən gedirsə baseline də istinad qiymətidir. */
  baselineSubscription: boolean
  /** Routing/klassifikator qərarlarının ÖZ xərci. */
  orchestrationCostUsd: number | null
  /**
   * Yaddaşın öz xərci (Faza 3) — `memory_ops` sətirlərindən.
   *
   * `null` = ən azı bir yaddaş əməliyyatının xərci BİLİNMİR. Yaddaş işə
   * düşməyibsə `0` və bu, DOĞRUDUR (bilinməzlik deyil).
   */
  memoryCostUsd: number | null
  /** `baseline − (actual + orchestration + memory)`. Komponent naməlumdursa `null`. */
  netSavingUsd: number | null
  /** Nəticə keşdən gəldi — icra xərci sıfırdır, qənaət tamdır. */
  cachedHit: boolean
  /** Baseline hesabına girən tokenlər — rəqəmin haradan gəldiyi görünsün. */
  baselineTokens: TokenCounts
  byRung: RungCost[]
}

function bossModel(db: Db): ModelRecord | undefined {
  return db.select().from(models).where(eq(models.roleBoss, true)).get()
}

/** `usage` hadisəsindən token sayları — keş təkrarında run sətri boş qalır. */
function cachedTokens(db: Db, runId: string): TokenCounts {
  const empty: TokenCounts = { inputTokens: 0, outputTokens: 0 }
  for (const stored of listEvents(db, runId)) {
    if (stored.event.t !== 'usage') continue
    const e = stored.event
    return {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
      ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
    }
  }
  return empty
}

export function computeTaskSavings(db: Db, taskId: string): TaskSavings {
  const task = getTask(db, taskId)
  const runs = listRunsForTask(db, taskId)

  let actualReal = 0
  let actualSubscription = 0
  let actualKnown = true
  let subscriptionKnown = true
  let cachedHit = false

  const baselineTokens: Required<TokenCounts> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  const rungs = new Map<number, RungCost>()
  // Prompt distilləsinin xərci — bu taskın CAVABINA girmir, ona görə aşağıda
  // orkestrasiya xərcinə qatılır (klassifikator ilə eyni məntiq, qayda 22).
  let distillation = 0
  let distillationKnown = true

  for (const run of runs) {
    const tokens: TokenCounts = run.cachedHit
      ? cachedTokens(db, run.id)
      : {
          inputTokens: run.tokensIn,
          outputTokens: run.tokensOut,
          cacheReadTokens: run.tokensCacheRead,
          cacheWriteTokens: run.tokensCacheWrite,
        }

    // Distillə icrası BASELINE-a girmir: baseline "başçı bu taskı təkbaşına
    // həll etsəydi" əks-faktıdır, başçı isə orada şablon YAZMAZDI. Tokenlərini
    // ora qatsaq baseline şişər və qənaət olduğundan böyük görünərdi (qayda 23,
    // 25 ilə eyni prinsip). Xərci isə gizlədilmir — aşağıda görünür.
    const isDistillation = run.ladderRung === DISTILL_RUNG
    if (!isDistillation) {
      baselineTokens.inputTokens += tokens.inputTokens
      baselineTokens.outputTokens += tokens.outputTokens
      baselineTokens.cacheReadTokens += tokens.cacheReadTokens ?? 0
      baselineTokens.cacheWriteTokens += tokens.cacheWriteTokens ?? 0
    }

    const usedTokens = tokens.inputTokens + tokens.outputTokens
    // Keş təkrarı HƏQİQƏTƏN pulsuzdur: model çağırılmayıb. Bu, `null`
    // ("bilinmir") deyil — fərqi qarışdırsaq keş qənaəti itərdi.
    const cost = run.cachedHit ? 0 : run.costUsd
    if (run.cachedHit) cachedHit = true

    const bucket = rungs.get(run.ladderRung) ?? {
      rung: run.ladderRung,
      runs: 0,
      costUsd: 0,
      subscriptionUsd: 0,
    }
    bucket.runs += 1

    if (isDistillation) {
      // `byRung`-da GÖRÜNÜR (bucket yuxarıda artırıldı) — bir dəfəlik
      // investisiya gizlədilməməlidir; sadəcə taskın həll xərci deyil.
      if (cost === null) {
        if (usedTokens > 0) distillationKnown = false
      } else {
        distillation += cost
        if (run.subscriptionBilled) bucket.subscriptionUsd += cost
        else bucket.costUsd += cost
      }
      rungs.set(run.ladderRung, bucket)
      continue
    }

    if (run.subscriptionBilled) {
      if (cost === null) {
        // Sıfır token xərcləməyən icranın naməlum xərci nəticəyə təsir etmir.
        if (usedTokens > 0) subscriptionKnown = false
      } else {
        actualSubscription += cost
        bucket.subscriptionUsd += cost
      }
    } else if (cost === null) {
      if (usedTokens > 0) actualKnown = false
    } else {
      actualReal += cost
      bucket.costUsd += cost
    }

    rungs.set(run.ladderRung, bucket)
  }

  // ── Orkestrasiya xərci ────────────────────────────────────────────────
  // Distillə buraya girir: o, taskın cavabını yazmır, gələcək taskların iş
  // üsulunu yazır — yəni klassifikator kimi ORKESTRASİYA xərcidir. Net
  // qənaətdən çıxılır, çünki pul REAL yanıb (qayda 22).
  let orchestration = distillation
  let orchestrationKnown = distillationKnown
  for (const decision of listRoutingDecisions(db, taskId)) {
    if (decision.decisionCostUsd === null) {
      // Qərar tokensizdirsə (qayda routing) xərc onsuz da 0-dır.
      if (decision.decisionTokens > 0) orchestrationKnown = false
    } else {
      orchestration += decision.decisionCostUsd
    }
  }

  // ── Baseline ──────────────────────────────────────────────────────────
  const boss = bossModel(db)
  const succeeded = task?.status === 'succeeded'
  // Uğursuz taskda "qənaət etdim" demək olmaz: nəticə alınmayıb, müqayisə
  // ediləcək bir şey yoxdur. Xərc isə real gedib və aşağıda saxlanılır.
  const baselineCostUsd =
    boss === undefined || !succeeded ? null : (computeCostUsd(modelPrice(boss), baselineTokens) ?? null)

  const actualCostUsd = actualKnown ? actualReal : null
  const orchestrationCostUsd = orchestrationKnown ? orchestration : null
  // Yaddaş xərci ORKESTRASİYA xərcinə qatılmır, AYRICA sütundadır (spesifikasiya
  // §10): ikisi fərqli qərarların nəticəsidir və "yaddaş özünü ödəyirmi?"
  // sualına yalnız ayrı sütun cavab verə bilər. Net qənaətdən isə hər ikisi
  // çıxılır — pul hər iki halda REAL yanıb.
  const { costUsd: memoryCostUsd } = memoryCostForTask(db, taskId)

  const netSavingUsd =
    baselineCostUsd === null ||
    actualCostUsd === null ||
    orchestrationCostUsd === null ||
    memoryCostUsd === null
      ? null
      : baselineCostUsd - (actualCostUsd + orchestrationCostUsd + memoryCostUsd)

  return {
    taskId,
    actualCostUsd,
    actualSubscriptionUsd: subscriptionKnown ? actualSubscription : null,
    baselineCostUsd,
    baselineModelId: boss?.id ?? null,
    // CLI başçısı ilə müqayisə iki istinad qiymətinin müqayisəsidir — UI bunu
    // "real pul qənaəti" kimi göstərməməlidir.
    baselineSubscription: boss !== undefined && boss.providerId.startsWith('cli:'),
    orchestrationCostUsd,
    memoryCostUsd,
    netSavingUsd,
    cachedHit,
    baselineTokens,
    byRung: [...rungs.values()].sort((a, b) => a.rung - b.rung),
  }
}
