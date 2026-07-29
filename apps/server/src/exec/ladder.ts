import { AMPLIFICATION_PROFILES, type RunEvent, type Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  appendVerification,
  createRun,
  finishRun,
  listRunsForTask,
  getCacheEntry,
  getRun,
  listEvents,
  putCacheEntry,
  recordCacheHit,
  setTaskStatus,
  setTaskType,
} from '../db/repo.js'
import { recordRoutingDecision } from '../db/routing-repo.js'
import { recordSavings } from '../db/savings-repo.js'
import type { WorkerRouter } from '../routing/decide.js'
import type { RoutingDecision } from '../routing/router.js'
import {
  AGREEMENT_STEPS,
  measureAgreement,
  type AgreementSample,
} from './agreement.js'
import type { BudgetLimits } from './budget.js'
import { computeCacheKey } from './cache-key.js'
import {
  buildEscalationPrompt,
  collectAnswerText,
  ESCALATION_CONTRACT,
  parseEscalation,
  type Escalation,
} from './escalation.js'
import { buildHintedPrompt, buildHintRequestPrompt } from './hint.js'
import { computeTaskSavings } from './savings.js'
import type { RunSupervisor } from './supervisor.js'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

/** Yoxlama dövrəsinin maksimum cəhd sayı. */
const MAX_ATTEMPTS = 3

/** Pillə 0 — hazır nəticə keşi. */
const RUNG_CACHE = 0
/** Pillə 1 — qayda routing. Həmişə işləyir; siyahıda sənəd üçün var. */
const RUNG_ROUTING = 1
/** Pillə 2 — zəif model (varsa alət yoxlaması dövrəsi ilə). */
const RUNG_WORKER = 2
/** Pillə 3 — best-of-N + razılaşma. */
const RUNG_BEST_OF_N = 3
/**
 * Pillə 4 — ipucu (shepherding).
 *
 * BU NÖMRƏ HƏM BAŞÇININ İPUCU İCRASINA, HƏM İŞÇİNİN İPUCULU İCRASINA yazılır.
 * Başçının ipucusunu 7 kimi qeyd etsək, "taskların <20%-i 7-yə çatmalıdır"
 * hədəfi (qayda 31) onu tam başçı icrası kimi sayardı — halbuki pillənin bütün
 * mənası məhz tam icradan QAÇMAQDIR: uğurlu ipucu metrikada uğursuzluq kimi
 * görünərdi.
 */
const RUNG_HINT = 4
/** Pillə 6 — işçinin özünü dayandırması. */
const RUNG_SELF_ESCALATION = 6
/** Pillə 7 — tam güclü model. Son çarə. */
const RUNG_BOSS = 7

export { AMPLIFICATION_PROFILES }

/**
 * Profil → aktiv pillələr.
 *
 * DİQQƏT — 7 `balanced`/`quality`-də QƏSDƏN var, spesifikasiyadakı cədvəldə
 * sadalanmasa da: Pillə 3 və 6 "yuxarı qalx" qərarı verir və qalxacaq yer
 * yoxdursa hər ikisi mənasızdır (işçi "bacarmıram" deyir, biz isə onun
 * imtinasını cavab kimi qaytarırıq). 7 həmin pillələrin HƏDƏFİDİR, ayrıca
 * seçilən addım deyil — hədəf taskların <20%-nin ora çatmasıdır.
 *
 * `cheap` isə eskalasiyasızdır və bu, davranışı Faza 1C ilə EYNİ saxlayır.
 *
 * Pillə 4 (ipucu) YALNIZ `quality`-dədir: o, başçının ƏLAVƏ icrasını (ipucu)
 * ödəyir və işçini bir daha qaçırır — yəni uğurlu halda 7-dən ucuz, UĞURSUZ
 * halda ondan bahadır. `balanced` gündəlik iş üçündür, ona görə orada bu risk
 * götürülmür.
 *
 * Pillə 5 (plan/icra bölgüsü) hələ tətbiq olunmayıb — siyahıda YOXDUR, yoxsa
 * `activeRungs` yalan danışardı (UI onu bu cavabdan oxuyur).
 */
const PROFILE_RUNGS: Readonly<Record<string, readonly number[]>> = {
  cheap: [RUNG_CACHE, RUNG_ROUTING, RUNG_WORKER],
  balanced: [
    RUNG_CACHE,
    RUNG_ROUTING,
    RUNG_WORKER,
    RUNG_BEST_OF_N,
    RUNG_SELF_ESCALATION,
    RUNG_BOSS,
  ],
  quality: [
    RUNG_CACHE,
    RUNG_ROUTING,
    RUNG_WORKER,
    RUNG_BEST_OF_N,
    RUNG_HINT,
    RUNG_SELF_ESCALATION,
    RUNG_BOSS,
  ],
  // Baseline: nə keş, nə yoxlama dövrəsi, nə eskalasiya — yalnız başçının
  // tək icrası. Qayda 25-dəki ölçmə bundan asılıdır.
  'boss-only': [RUNG_BOSS],
}

export function activeRungs(profile: string): ReadonlySet<number> {
  return new Set(PROFILE_RUNGS[profile] ?? PROFILE_RUNGS['balanced'])
}

export type LadderStatus =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'budget_exceeded'
  | 'verification_failed'
  /**
   * İşçi taskı həll edə bilmədiyini bildirdi (Pillə 6) və ya nüsxələr
   * razılaşmadı (Pillə 3), amma başçıya qalxmaq MÜMKÜN OLMADI — profil 7-ni
   * söndürüb, başçı təyin olunmayıb, ya da büdcə bitib.
   *
   * `failed`-dən ayrıdır, çünki səbəb tamamilə fərqlidir: icra sınmayıb,
   * nərdivan bitib. UI istifadəçiyə "başçı seç" deməlidir, "yenidən cəhd et"
   * yox.
   */
  | 'escalation_unavailable'

/** Nə üçün yuxarı pilləyə qalxıldı. */
export type EscalationTrigger = 'self' | 'verification' | 'disagreement'

export interface LadderContext {
  id: string
  cwd: string | null
  verifyCommandsJson: string
  /** `cheap` | `balanced` | `quality` | `boss-only`. Default `balanced`. */
  amplificationProfile?: string
  /** Qayda tutmadıqda seçilən işçi (`models.id`). */
  defaultWorkerModelId?: string | null
}

export interface LadderInput {
  task: { id: string; prompt: string }
  context: LadderContext
  /**
   * İstifadəçinin ƏL İLƏ seçimi. Verilməsə Pillə 1 (Auto) işə düşür —
   * bunun üçün `Ladder` konstruktoruna router ötürülməlidir.
   */
  runner?: Runner
  model?: string
  limits?: BudgetLimits
}

export interface AgreementSummary {
  n: number
  votes: number
  threshold: number
  agreed: boolean
}

export interface EscalationSummary {
  trigger: EscalationTrigger
  reason: string
  /** Başçı həqiqətən işə düşdümü. `false` → `escalation_unavailable`. */
  reached: boolean
}

export interface HintSummary {
  /** İşçi nə üçün ilişmişdi — ipucu məhz ona görə istənildi. */
  trigger: EscalationTrigger
  /** Başçının ipucu icrası. */
  hintRunId: string
  /** İpucunun uzunluğu (simvol) — "başçı nə qədər yazdı?" sualının cavabı. */
  hintChars: number
  /**
   * İpuculu işçi cəhdi taskı həll etdimi.
   *
   * `false` olsa da sahə QALIR: ipucu ödənilib və nəticədə gizlədilməməlidir —
   * əks halda Pillə 4 həmişə "pulsuz" görünərdi (eyni prinsip: qayda 22).
   */
  accepted: boolean
}

export interface LadderResult {
  runId: string
  status: LadderStatus
  /** Nəticə keşdən gəldimi (Pillə 0). */
  cached: boolean
  /** Keşləmək təhlükəlidirsə `null`. */
  cacheKey: string | null
  /** Neçə icra cəhdi edildi (Pillə 2 dövrəsi). */
  attempts: number
  /** Yoxlama əmrləri varsa nəticəsi; yoxdursa `null`. */
  verificationPassed: boolean | null
  /**
   * Nəticəni verən icranın pilləsi. "Taskların <20%-i 7-yə çatmalıdır"
   * hədəfi MƏHZ bununla ölçülür — ona görə ayrıca sahədir.
   */
  finalRung: number
  /** Pillə 3 işə düşübsə nüsxələrin razılaşma ölçüsü. */
  agreement?: AgreementSummary
  /** Pillə 4 işə düşübsə ipucunun taleyi. */
  hint?: HintSummary
  /** Pillə 6 və ya 3 yuxarı qalxmaq istəyibsə. */
  escalation?: EscalationSummary
  /** Pillə 1-in qərarı — UI-da "niyə bu model?" sualına cavab verir. */
  decision?: RoutingDecision
  errorClass?: string
  errorMessage?: string
}

/**
 * Cəhdlər arasında QALAN büdcə.
 *
 * `RunSupervisor.execute` hər çağırışda TAM YENİ `BudgetGuard` yaradır (öz
 * limitlərinə görə). Nərdivan isə eyni task üçün onu bir neçə dəfə çağırır:
 * yoxlama dövrəsi (3-ə qədər), best-of-N (5-ə qədər), başçı (1). Limiti
 * çağırışlar arasında ÖZÜMÜZ izləməsək, hər icra orijinal limiti təzədən alar
 * və bir task limitin doqquz mislini xərcləyə bilərdi.
 *
 * `Ladder`-in sahəsi DEYİL, hər `run()` üçün yeni yaradılır — eyni instansiya
 * paralel tasklar arasında paylaşılır.
 */
class RemainingBudget {
  private readonly startedAt = Date.now()
  private outputTokens = 0
  private costUsd = 0

  constructor(private readonly base: BudgetLimits | undefined) {}

  /**
   * Bitmiş icranın xərcini yazır.
   *
   * `costUsd` NULL-dursa xərc BİLİNMİR (qayda 4) — cari məbləğə `0` qatılır,
   * çünki bilinməyəni bundan yaxşı təxmin edə bilmərik. `BudgetGuard` da eyni
   * səbəbdən `costUsd` `undefined` olanda dollar yoxlamasını tamamilə keçir.
   */
  charge(run: { tokensOut: number; costUsd: number | null } | undefined): void {
    if (run === undefined) return
    this.outputTokens += run.tokensOut
    if (run.costUsd !== null) this.costUsd += run.costUsd
  }

  /** Növbəti icraya ötürüləcək limitlər. Baza limit yoxdursa `undefined`. */
  remaining(): BudgetLimits | undefined {
    if (this.base === undefined) return undefined
    const { maxOutputTokens, maxCostUsd, maxSeconds } = this.base
    return {
      ...this.base,
      ...(maxOutputTokens !== undefined
        ? { maxOutputTokens: Math.max(0, maxOutputTokens - this.outputTokens) }
        : {}),
      ...(maxCostUsd !== undefined
        ? { maxCostUsd: Math.max(0, maxCostUsd - this.costUsd) }
        : {}),
      ...(maxSeconds !== undefined
        ? { maxSeconds: Math.max(0, maxSeconds - this.elapsedSeconds()) }
        : {}),
    }
  }

  /**
   * Komponentlərdən biri tükənibsə `true` — növbəti icranı BAŞLATMAQ ÖZÜ pul
   * yandırmaq olardı (prompt döşəməsi ~21.7k token).
   */
  exhausted(): boolean {
    const left = this.remaining()
    if (left === undefined) return false
    return left.maxOutputTokens === 0 || left.maxCostUsd === 0 || left.maxSeconds === 0
  }

  private elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000
  }
}

/** Bir icranın nərdivan daxilindəki konteksti — metodlar arasında ötürülür. */
interface Phase {
  input: LadderInput
  runner: Runner
  model: string
  cwd: string | undefined
  rungs: ReadonlySet<number>
  cacheKey: string | null
  verifyCommands: string[]
  decision: RoutingDecision
  budget: RemainingBudget
  /** İşçi icralarının pilləsi. `boss-only`-də işçi ELƏ başçıdır → 7. */
  workerRung: number
}

type WorkerOutcome =
  | { kind: 'result'; result: LadderResult }
  | {
      kind: 'escalate'
      trigger: EscalationTrigger
      reason: string
      /** Pillə 6-dan gəlirsə işçinin qismən nəticəsi. */
      escalation?: Escalation
      fromRunId: string
      /** Başçıya qalxmaq mümkün olmasa qaytarılacaq nəticə (monoton qayda). */
      fallback: LadderResult
    }

/**
 * Amplifikasiya nərdivanı — Pillə 0, 2, 3, 6 və 7.
 *
 * `RunSupervisor` bir icranı idarə edir və bu sinif ona toxunmur. Ladder
 * onun üzərində oturur: keşə baxır, lazım olsa supervisor-u bir neçə dəfə
 * çağırır, hər dəfə determinist yoxlamadan keçirir, işçi imtina edəndə və ya
 * nüsxələr razılaşmayanda başçıya qalxır.
 *
 * MONOTON QAYDA: yuxarı pillə DAHA PİS nəticə verə bilər (kaskad failure).
 * Ona görə hər eskalasiya öz `fallback`-ını daşıyır — başçı yoxdursa, büdcə
 * bitibsə və ya başçı da sınıbsa əvvəlki nəticə ATILMIR.
 */
export class Ladder {
  private readonly db: Db
  private readonly supervisor: RunSupervisor
  private readonly router: WorkerRouter | undefined

  constructor(db: Db, supervisor: RunSupervisor, router?: WorkerRouter) {
    this.db = db
    this.supervisor = supervisor
    this.router = router
  }

  /**
   * Taskı başdan-sona aparır və SONDA qənaət ledger-ini yazır.
   *
   * Ledger yazılışı `run()`-ın hər `return`-ündən sonra təkrarlanmasın deyə
   * burada, bir yerdə edilir — unudulan bir yol ölçmədə səssiz boşluq yaradardı.
   */
  async run(input: LadderInput): Promise<LadderResult> {
    const result = await this.execute(input)
    this.recordLedger(input.task.id)
    return result
  }

  /**
   * Ledger sətrini yazır — YALNIZ həqiqətən icra olubsa.
   *
   * İcrasız uğursuzluqda (məs. "işçi təyin olunmayıb") ölçüləcək bir şey
   * yoxdur: pul yanmayıb. Belə taskı ledger-ə yazsaq, "task sayı" şişər və
   * orta qənaət olduğundan kiçik görünərdi.
   */
  private recordLedger(taskId: string): void {
    if (listRunsForTask(this.db, taskId).length === 0) return
    recordSavings(this.db, computeTaskSavings(this.db, taskId))
  }

  private async execute(input: LadderInput): Promise<LadderResult> {
    const cwd = input.context.cwd ?? undefined
    const profile = input.context.amplificationProfile ?? 'balanced'

    // ── Pillə 1 — işçi seçimi ──────────────────────────────────────────
    // Pillə 0-dan ƏVVƏL gəlir, çünki keş açarı model və runner id-sini
    // ehtiva edir (`cache-key.ts`) — hansı modelin işlədiləcəyini bilmədən
    // keşə baxmaq mümkün deyil. Qayda routing-i 0 token xərcləyir, ona görə
    // bu sıra adi halda heç nəyə başa gəlmir; yalnız klassifikator işə
    // düşəndə (qeyri-müəyyən task) keş yoxlanışından əvvəl ~50 token gedir.
    const selected = await this.selectWorker(input, profile)
    if ('error' in selected) {
      setTaskStatus(this.db, input.task.id, 'failed')
      return {
        runId: '',
        status: 'failed',
        cached: false,
        cacheKey: null,
        attempts: 0,
        verificationPassed: null,
        finalRung: RUNG_ROUTING,
        errorClass: 'crashed',
        errorMessage: selected.error,
      }
    }
    const { runner, model, decision } = selected

    const rungs = activeRungs(profile)

    const cacheKey = rungs.has(RUNG_CACHE)
      ? computeCacheKey({
          prompt: input.task.prompt,
          modelId: model,
          runnerId: runner.id,
          needsFileAccess: runner.capabilities.fileAccess,
          ...(cwd !== undefined ? { cwd } : {}),
        })
      : null

    // ── Pillə 0 — cache ────────────────────────────────────────────────
    if (cacheKey !== null) {
      const hit = this.replayFromCache(input, runner, model, cacheKey)
      if (hit !== null) return { ...hit, decision }
    }

    const phase: Phase = {
      input,
      runner,
      model,
      cwd,
      rungs,
      cacheKey,
      decision,
      verifyCommands: rungs.has(RUNG_WORKER)
        ? this.parseVerifyCommands(input.context.verifyCommandsJson)
        : [],
      budget: new RemainingBudget(input.limits),
      // `boss-only` profilində işçi rolunu başçı oynayır — icranı 2-ci pillə
      // kimi qeyd etsək baseline ölçməsi (qayda 25) yalan olardı.
      workerRung: rungs.has(RUNG_WORKER) ? RUNG_WORKER : RUNG_BOSS,
    }

    const outcome = await this.workerPhase(phase)
    if (outcome.kind === 'result') return outcome.result
    return this.escalate(phase, outcome)
  }

  /**
   * İşçi ilişdi — nə edək?
   *
   * Sıra ucuzdan bahayadır: əvvəlcə Pillə 4 (başçının QISA ipucusu + işçinin
   * bir icrası), o tutmasa Pillə 7 (başçının TAM icrası). İpucu nəticəsi
   * qaytarılan cavaba HƏR HALDA yapışdırılır — qəbul edilməsə də ödənilib.
   */
  private async escalate(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): Promise<LadderResult> {
    const hinted = await this.hintPhase(phase, outcome)
    if (hinted.result !== undefined) return hinted.result

    // İpuculu cəhd də sınıbsa zəncir 2 → 4 → 4 → 7-dir: başçının TAM icrası
    // ƏN SON icradan doğur, ilk işçi cəhdindən yox.
    const next =
      hinted.fromRunId !== undefined ? { ...outcome, fromRunId: hinted.fromRunId } : outcome

    const result = await this.escalateToBoss(phase, next)
    return hinted.hint === undefined ? result : { ...result, hint: hinted.hint }
  }

  /**
   * Pillə 4 — ipucu (shepherding).
   *
   * Başçıdan TAM cavab yox, həllin ilk 10–30%-i istənilir, sonra işçi ONUN
   * üzərində bir dəfə də qaçırılır. Uğurlu halda başçının bahalı çıxışının
   * yalnız kiçik hissəsi ödənilir.
   *
   * NİYƏ CƏMİ BİR CƏHD: kaskad riski (issue #9) — hər pillə maksimum bir dəfə.
   * İkinci ipucu üçün ödəniş artıq başçının tam icrasına yaxınlaşır və pillənin
   * mənası itir.
   *
   * NİYƏ RAZILAŞMAMA (Pillə 3) HALINDA İŞƏ DÜŞMÜR: orada işçi ilişməyib —
   * cavab verib, sadəcə nüsxələr uyğun gəlməyib. Onların hər biri onsuz da
   * ödənilib (3–5 icra), üstünə daha bir işçi icrası + başçı icrası qoymaq
   * birbaşa 7-yə qalxmaqdan bahadır.
   */
  private async hintPhase(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): Promise<{ result?: LadderResult; hint?: HintSummary; fromRunId?: string }> {
    if (!phase.rungs.has(RUNG_HINT)) return {}
    if (outcome.trigger === 'disagreement') return {}
    if (this.router === undefined) return {}
    // Büdcə bitibsə YENİ icra başlatmaq sərt limitin mənasını pozardı.
    if (phase.budget.exhausted()) return {}

    const boss = this.router.resolveBoss(`ipucu (Pillə 4): ${outcome.reason}`)
    if (!boss.ok) return {}
    recordRoutingDecision(this.db, phase.input.task.id, boss.decision)

    const hintExec = await this.supervisor.execute({
      taskId: phase.input.task.id,
      runner: boss.runner,
      model: boss.decision.modelId,
      prompt: buildHintRequestPrompt({
        task: phase.input.task.prompt,
        reason: outcome.reason,
        ...(outcome.escalation?.partial !== undefined
          ? { partial: outcome.escalation.partial }
          : {}),
      }),
      attempt: 1,
      ladderRung: RUNG_HINT,
      escalatedFromRunId: outcome.fromRunId,
      ...(phase.cwd !== undefined ? { cwd: phase.cwd } : {}),
      ...(this.limitsFor(phase) ?? {}),
    })
    phase.budget.charge(getRun(this.db, hintExec.runId))

    // İpucu alınmadı (xəta, ləğv, büdcə) — Pillə 7 hələ də açıqdır.
    if (hintExec.status !== 'succeeded') return {}
    const hintText = this.answerOf(hintExec.runId).trim()
    if (hintText === '') return {}

    const summary = (accepted: boolean): HintSummary => ({
      trigger: outcome.trigger,
      hintRunId: hintExec.runId,
      hintChars: hintText.length,
      accepted,
    })

    if (phase.budget.exhausted()) return { hint: summary(false) }

    // Müqavilə (Pillə 6) SAXLANILIR: ipucu ilə də bacarmırsa işçi yenidən
    // imtina edə bilməlidir — yoxsa o, uydurma cavab yazmağa məcbur qalardı.
    const contractSuffix = phase.rungs.has(RUNG_SELF_ESCALATION)
      ? `\n\n${ESCALATION_CONTRACT}`
      : ''
    const workerExec = await this.runOnce(phase, {
      prompt: `${buildHintedPrompt(phase.input.task.prompt, hintText)}${contractSuffix}`,
      attempt: 1,
      rung: RUNG_HINT,
      escalatedFromRunId: hintExec.runId,
    })

    if (workerExec.status !== 'succeeded') {
      return { hint: summary(false), fromRunId: workerExec.runId }
    }
    if (contractSuffix !== '' && parseEscalation(this.answerOf(workerExec.runId)) !== null) {
      return { hint: summary(false), fromRunId: workerExec.runId }
    }

    // Nəticə SIFIRDAN qurulur: `outcome.fallback`-ı yaymaq ora yapışmış xəta
    // sahələrini (`errorClass`, `escalation_unavailable`) uğurlu cavabın üstünə
    // daşıyardı.
    const base: LadderResult = {
      runId: workerExec.runId,
      status: 'succeeded',
      cached: false,
      cacheKey: phase.cacheKey,
      attempts: outcome.fallback.attempts,
      verificationPassed: null,
      finalRung: RUNG_HINT,
      decision: phase.decision,
      hint: summary(true),
    }

    // İPUCULU CAVAB KEŞLƏNMİR: keş açarı yalnız model + runner id-sindən
    // qurulur (`cache-key.ts`), başçının köməyini göstərmir. Ora yazsaq sonrakı
    // `cheap` profilli icra (Pillə 4 və 7-ni QƏSDƏN söndürən) səssizcə başçı
    // köməyi ilə alınmış cavabı alardı — qayda 33 ilə eyni səbəb.
    if (phase.verifyCommands.length === 0) {
      return { result: this.settle(phase, base) }
    }

    const verification = await this.verify(phase, workerExec.runId)
    if (verification.passed) {
      return { result: this.settle(phase, { ...base, verificationPassed: true }) }
    }
    // Determinist alət "hələ də səhvdir" dedi — ipucu tutmadı, 7 qalır.
    return { hint: summary(false), fromRunId: workerExec.runId }
  }

  /**
   * Pillə 2 (+6, +3) — zəif modelin işi.
   *
   * Sıra QƏSDƏN belədir:
   *  1. eskalasiya siqnalı (Pillə 6) — bir neçə onluq token, ƏN UCUZ siqnal
   *  2. determinist yoxlama (Pillə 2) — 0 token, ƏN GÜCLÜ siqnal
   *  3. best-of-N (Pillə 3) — N icra, ƏN BAHA siqnal
   *
   * Best-of-N yalnız yoxlama əmri OLMAYANDA işə düşür: `tsc` üç eyni səhv
   * cavabı da tutur, razılaşma isə tutmur — pulsuz və güclü siqnal varkən
   * bahalısını almaq mənasızdır.
   */
  private async workerPhase(phase: Phase): Promise<WorkerOutcome> {
    const { input } = phase
    const useContract = phase.rungs.has(RUNG_SELF_ESCALATION)
    const hasVerification = phase.verifyCommands.length > 0

    // Müqavilə istifadəçi mesajının SONUNA əlavə olunur — sistem promptu
    // toxunulmaz qalır (CLAUDE.md qayda 1: prefiks dəyişməsi keşi sındırır).
    const contractSuffix = useContract ? `\n\n${ESCALATION_CONTRACT}` : ''
    let prompt = `${input.task.prompt}${contractSuffix}`
    let attempts = 0

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1

      const exec = await this.runOnce(phase, {
        prompt,
        attempt: attempts,
        rung: phase.workerRung,
      })

      const base: LadderResult = {
        runId: exec.runId,
        status: exec.status,
        cached: false,
        cacheKey: phase.cacheKey,
        attempts,
        verificationPassed: null,
        finalRung: phase.workerRung,
        decision: phase.decision,
        ...(exec.errorClass !== undefined ? { errorClass: exec.errorClass } : {}),
        ...(exec.errorMessage !== undefined ? { errorMessage: exec.errorMessage } : {}),
      }

      // İcranın özü uğursuz olubsa yoxlamağa nə isə yoxdur. Təkrar cəhd
      // yalnız təkrarlana bilən xəta siniflərində mənalıdır — `auth` və
      // `budget_exceeded` halında yenidən cəhd etmək pul yandırmaqdır.
      if (exec.status !== 'succeeded') return { kind: 'result', result: base }

      // ── Pillə 6 — işçi özü dayandı ────────────────────────────────────
      if (useContract) {
        const escalation = parseEscalation(this.answerOf(exec.runId))
        if (escalation !== null) {
          return {
            kind: 'escalate',
            trigger: 'self',
            reason: escalation.reason,
            escalation,
            fromRunId: exec.runId,
            // İşçi AÇIQ ŞƏKİLDƏ "həll etmədim" dedi. Onun imtinasını cavab
            // kimi `succeeded` qaytarmaq UI-da yalan olardı.
            fallback: { ...base, status: 'escalation_unavailable' },
          }
        }
      }

      if (!hasVerification) {
        // ── Pillə 3 — best-of-N ─────────────────────────────────────────
        // Nüsxələr EYNİ promptu alır (müqavilə daxil): fərqli promptdan gələn
        // cavabları müqayisə etmək razılaşma ölçüsünü mənasız edərdi.
        if (phase.rungs.has(RUNG_BEST_OF_N)) return this.bestOfN(phase, base, prompt)
        this.storeInCache(phase, exec.runId)
        return { kind: 'result', result: base }
      }

      const verification = await this.verify(phase, exec.runId)
      if (verification.passed) {
        this.storeInCache(phase, exec.runId)
        return {
          kind: 'result',
          result: { ...base, verificationPassed: true },
        }
      }

      const failedResult: LadderResult = {
        ...base,
        status: 'verification_failed',
        verificationPassed: false,
      }

      // Cəhdlər bitdi. Determinist alət "səhvdir" dedi — burada best-of-N
      // mənasızdır (üç səhv nüsxə də yoxlamadan keçməz), tək qalan yol
      // başçıdır.
      if (attempts === MAX_ATTEMPTS) {
        setTaskStatus(this.db, input.task.id, 'failed')
        return {
          kind: 'escalate',
          trigger: 'verification',
          reason: `${MAX_ATTEMPTS} cəhddən sonra avtomatik yoxlama keçmədi`,
          fromRunId: exec.runId,
          fallback: failedResult,
        }
      }

      // Hələ cəhd qalıb — icra özü uğurlu olsa da task HƏLƏ BİTMƏYİB.
      // Supervisor `succeeded` görüb taskı elə işarələyib; statusu geri
      // `running`-ə qaytarırıq ki UI "bitdi" yalanı danışmasın.
      setTaskStatus(this.db, input.task.id, 'running')

      if (phase.budget.exhausted()) {
        setTaskStatus(this.db, input.task.id, 'failed')
        return {
          kind: 'result',
          result: { ...failedResult, status: 'budget_exceeded' },
        }
      }

      // Xəta mətnini modelə geri ötürüb yenidən cəhd et. Yoxlama SIFIR token
      // xərcləyir; yalnız yeni icra xərcləyir.
      prompt = `${input.task.prompt}\n\n${buildFeedbackPrompt(
        verification.results,
      )}${contractSuffix}`
    }

    // Bura yalnız MAX_ATTEMPTS < 1 olsa çatıla bilər — bu proqramçı xətasıdır.
    throw new Error('Ladder: MAX_ATTEMPTS ən azı 1 olmalıdır')
  }

  /**
   * Pillə 3 — nüsxələri artırıb razılaşma axtarır.
   *
   * İlk nüsxə ARTIQ ödənilib (`first`), ona görə `AGREEMENT_STEPS` kumulyativ
   * cəmi göstərir: 3 → 2 əlavə icra, 5 → yenə 2. Hər addımdan sonra dayanmaq
   * imkanı var — bu, sabit N=5-dən ~4x səmərəlidir.
   */
  private async bestOfN(
    phase: Phase,
    first: LadderResult,
    prompt: string,
  ): Promise<WorkerOutcome> {
    const samples: AgreementSample[] = [
      { runId: first.runId, answer: this.answerOf(first.runId) },
    ]
    let outcome = measureAgreement(samples)

    for (const target of AGREEMENT_STEPS) {
      while (samples.length < target) {
        // Büdcə bitibsə ƏLDƏ OLANLA qərar veririk: yeni icra başlatmaq sərt
        // limitin mənasını pozardı.
        if (phase.budget.exhausted()) break

        const copy = await this.runOnce(phase, {
          prompt,
          // `attempt` burada "neçənci NÜSXƏ" deməkdir — yoxlama dövrəsindəki
          // təkrar cəhd deyil. Pillə nömrəsi (3) ikisini ayırır.
          attempt: samples.length + 1,
          rung: RUNG_BEST_OF_N,
        })
        // Sınmış nüsxə səs vermir: onu "fərqli cavab" saysaq razılaşma
        // süni şəkildə pozulub task boş yerə başçıya qalxardı.
        if (copy.status !== 'succeeded') break

        samples.push({ runId: copy.runId, answer: this.answerOf(copy.runId) })
      }

      outcome = measureAgreement(samples)
      if (outcome.agreed) break
      // Nüsxə əlavə edə bilmədiksə (büdcə/xəta) növbəti addım da edə bilməz.
      if (samples.length < target) break
    }

    const agreement: AgreementSummary = {
      n: outcome.n,
      votes: outcome.votes,
      threshold: outcome.threshold,
      agreed: outcome.agreed,
    }

    // Tək nüsxə qalıbsa razılaşma ölçüsü mənasızdır — bu, sadəcə Pillə 2-nin
    // nəticəsidir və onu "razılaşdı" kimi göstərmək yalan olardı.
    if (outcome.agreed && samples.length > 1) {
      this.storeInCache(phase, outcome.winnerRunId)
      return {
        kind: 'result',
        result: this.settle(phase, {
          ...first,
          runId: outcome.winnerRunId,
          finalRung: RUNG_BEST_OF_N,
          agreement,
        }),
      }
    }

    if (samples.length === 1) {
      // Nüsxə çoxalda bilmədik (büdcə və ya sınmış icra). Əlimizdə Pillə 2-nin
      // nəticəsi var və o, uğurludur — onu ATMIRIQ.
      this.storeInCache(phase, first.runId)
      return { kind: 'result', result: this.settle(phase, first) }
    }

    return {
      kind: 'escalate',
      trigger: 'disagreement',
      reason: `${outcome.n} nüsxədən yalnız ${outcome.votes}-i razılaşdı (lazım: ${outcome.threshold})`,
      fromRunId: outcome.winnerRunId,
      // Razılaşma yoxdur, amma cavab VAR. Başçı əlçatmazsa ən çox səs toplayan
      // nüsxəni qaytarırıq — "cavab yoxdur" demək istifadəçi üçün daha pisdir.
      fallback: {
        ...first,
        runId: outcome.winnerRunId,
        finalRung: RUNG_BEST_OF_N,
        agreement,
      },
    }
  }

  /**
   * Pillə 7 — son çarə.
   *
   * Hər çıxış yolu `outcome.fallback`-a qayıdır: başçı yoxdursa, büdcə
   * bitibsə və ya başçı da sınıbsa əvvəlki nəticə saxlanılır (monoton qayda).
   * Kaskadın tək modeldən PİS nəticə verməsi məhz bu yolla qapanır.
   */
  private async escalateToBoss(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): Promise<LadderResult> {
    const summary = (reached: boolean): EscalationSummary => ({
      trigger: outcome.trigger,
      reason: outcome.reason,
      reached,
    })
    const giveUp = (why: string): LadderResult => {
      const fallback = this.settle(phase, {
        ...outcome.fallback,
        escalation: summary(false),
      })
      // `errorMessage` YALNIZ uğursuz nəticəyə yazılır. Razılaşmama halında
      // əlimizdə işləyən cavab var (ən çox səs toplayan nüsxə) — ona xəta
      // mətni bağlasaq UI uğurlu nəticəni sınmış kimi göstərərdi.
      if (fallback.status === 'succeeded') return fallback
      return {
        ...fallback,
        errorMessage: `${outcome.reason} — başçıya qalxmaq mümkün olmadı: ${why}`,
      }
    }

    if (!phase.rungs.has(RUNG_BOSS)) {
      return giveUp('profil Pillə 7-ni söndürüb')
    }
    if (this.router === undefined) {
      return giveUp('əl ilə seçimdə başçı təyin edilə bilmir')
    }
    if (phase.budget.exhausted()) {
      return giveUp('büdcə bitdi')
    }

    const boss = this.router.resolveBoss(`eskalasiya (${outcome.trigger}): ${outcome.reason}`)
    if (!boss.ok) return giveUp(boss.error)

    // Eskalasiya qərarı da `routing_decisions`-a yazılır: istifadəçi "niyə
    // başçı işə düşdü?" sualının cavabını UI-da görməlidir. Qərarın öz xərci
    // sıfırdır (0 token) və qənaət hesabını şişirtmir.
    recordRoutingDecision(this.db, phase.input.task.id, boss.decision)

    const prompt =
      outcome.escalation !== undefined
        ? buildEscalationPrompt(phase.input.task.prompt, outcome.escalation)
        : phase.input.task.prompt

    const exec = await this.supervisor.execute({
      taskId: phase.input.task.id,
      runner: boss.runner,
      model: boss.decision.modelId,
      prompt,
      attempt: 1,
      ladderRung: RUNG_BOSS,
      escalatedFromRunId: outcome.fromRunId,
      ...(phase.cwd !== undefined ? { cwd: phase.cwd } : {}),
      ...(this.limitsFor(phase) ?? {}),
    })
    phase.budget.charge(getRun(this.db, exec.runId))

    const base: LadderResult = {
      ...outcome.fallback,
      runId: exec.runId,
      status: exec.status,
      finalRung: RUNG_BOSS,
      verificationPassed: null,
      escalation: summary(true),
      ...(exec.errorClass !== undefined ? { errorClass: exec.errorClass } : {}),
      ...(exec.errorMessage !== undefined ? { errorMessage: exec.errorMessage } : {}),
    }

    // Başçı da sındı — MONOTON qayda: işçinin nəticəsi daha yaxşıdır.
    // Başçının icrası DB-də qalır (xərc gizlədilmir), amma nəticə onun deyil.
    if (exec.status !== 'succeeded') {
      return this.settle(phase, { ...outcome.fallback, escalation: summary(true) })
    }

    if (phase.verifyCommands.length === 0) {
      // Başçının cavabı İŞÇİNİN keş açarı altında saxlanılmır: açar model və
      // runner id-sini ehtiva edir (`cache-key.ts`), ona görə orada başqa
      // modelin cavabını gizlətmək girişi yalançı edərdi — və sonrakı `cheap`
      // profilli icra (Pillə 7-ni QƏSDƏN söndürən) səssizcə başçı cavabı alardı.
      return base
    }

    const verification = await this.verify(phase, exec.runId)
    if (verification.passed) return { ...base, verificationPassed: true }

    setTaskStatus(this.db, phase.input.task.id, 'failed')
    return { ...base, status: 'verification_failed', verificationPassed: false }
  }

  /**
   * Taskın DB statusunu QAYTARILAN nəticə ilə uyğunlaşdırır.
   *
   * MƏCBURİDİR, çünki `RunSupervisor` hər icradan sonra taskın statusunu
   * SON İCRAYA görə yazır — nərdivan isə sonda başqa icranın nəticəsini
   * qaytara bilər (monoton qayda: başçı sındı → işçinin cavabı qalib;
   * best-of-N-də sonuncu nüsxə sındı → əvvəlki nüsxə qalib). Uyğunlaşdırmasaq
   * `/tasks/:id` uğurlu cavabı "failed" kimi göstərərdi.
   */
  private settle(phase: Phase, result: LadderResult): LadderResult {
    setTaskStatus(
      this.db,
      phase.input.task.id,
      result.status === 'succeeded' ? 'succeeded' : 'failed',
    )
    return result
  }

  /** Bir icra + büdcə uçotu. */
  private async runOnce(
    phase: Phase,
    step: {
      prompt: string
      attempt: number
      rung: number
      /** Bu icra hansı icradan doğdu — Pillə 4-də başçının ipucu icrası. */
      escalatedFromRunId?: string
    },
  ): Promise<{ runId: string; status: LadderStatus; errorClass?: string; errorMessage?: string }> {
    const exec = await this.supervisor.execute({
      taskId: phase.input.task.id,
      runner: phase.runner,
      model: phase.model,
      prompt: step.prompt,
      attempt: step.attempt,
      ladderRung: step.rung,
      ...(step.escalatedFromRunId !== undefined
        ? { escalatedFromRunId: step.escalatedFromRunId }
        : {}),
      ...(phase.cwd !== undefined ? { cwd: phase.cwd } : {}),
      ...(this.limitsFor(phase) ?? {}),
    })
    phase.budget.charge(getRun(this.db, exec.runId))
    return exec
  }

  /** `{ limits }` və ya heç nə — limitsiz tasklarda davranış dəyişməz qalır. */
  private limitsFor(phase: Phase): { limits: BudgetLimits } | undefined {
    const limits = phase.budget.remaining()
    return limits === undefined ? undefined : { limits }
  }

  /** İcranın mətn cavabı — Pillə 6 və 3 bunun üzərində işləyir. */
  private answerOf(runId: string): string {
    return collectAnswerText(listEvents(this.db, runId).map((s) => s.event))
  }

  private async verify(
    phase: Phase,
    runId: string,
  ): Promise<{ passed: boolean; results: Awaited<ReturnType<typeof runVerifications>>['results'] }> {
    const verification = await runVerifications(phase.verifyCommands, {
      cwd: phase.cwd ?? process.cwd(),
    })
    for (const r of verification.results) {
      appendVerification(this.db, runId, {
        command: r.command,
        exitCode: r.exitCode,
        passed: r.passed,
        outputExcerpt: r.output,
        durationMs: r.durationMs,
      })
    }
    return verification
  }

  private parseVerifyCommands(json: string): string[] {
    try {
      const parsed: unknown = JSON.parse(json)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    } catch {
      return []
    }
  }

  /**
   * Keşdən nəticə tapılıbsa, onu YENİ run sətri kimi qeyd edir və hadisələri
   * jurnala yazır. Belə olsa UI heç bir xüsusi hal bilmədən eyni şeyi göstərir,
   * amma sətir `cachedHit: true` və `ladderRung: 0` ilə işarələnir.
   */
  private replayFromCache(
    input: LadderInput,
    runner: Runner,
    model: string,
    cacheKey: string,
  ): LadderResult | null {
    const entry = getCacheEntry(this.db, cacheKey)
    if (entry === undefined) return null

    const run = createRun(this.db, {
      taskId: input.task.id,
      runnerId: runner.id,
      modelId: model,
      ladderRung: RUNG_CACHE,
      cachedHit: true,
      subscriptionBilled: runner.capabilities.subscriptionBilled,
    })
    for (const event of entry.events) appendEvent(this.db, run.id, event)
    recordCacheHit(this.db, cacheKey)
    finishRun(this.db, run.id, { status: 'succeeded' })
    setTaskStatus(this.db, input.task.id, 'succeeded')

    return {
      runId: run.id,
      status: 'succeeded',
      cached: true,
      cacheKey,
      attempts: 0,
      verificationPassed: null,
      finalRung: RUNG_CACHE,
    }
  }

  /** Yalnız uğurlu VƏ (varsa) yoxlamadan keçmiş İŞÇİ nəticəsi keşlənir. */
  private storeInCache(phase: Phase, runId: string): void {
    if (phase.cacheKey === null) return
    const events: RunEvent[] = listEvents(this.db, runId).map((s) => s.event)
    putCacheEntry(this.db, {
      hash: phase.cacheKey,
      modelId: phase.model,
      runnerId: phase.runner.id,
      events,
    })
  }

  /**
   * Pillə 1 — kim icra edəcək?
   *
   * Əl ilə seçim varsa router-ə TOXUNULMUR. Hər iki halda qərar
   * `routing_decisions`-a yazılır: istifadəçi `/tasks/:id` səhifəsində
   * "niyə bu model?" sualının cavabını görməlidir.
   */
  private async selectWorker(
    input: LadderInput,
    profile: string,
  ): Promise<
    { runner: Runner; model: string; decision: RoutingDecision } | { error: string }
  > {
    if (input.runner !== undefined && input.model !== undefined) {
      const decision: RoutingDecision = {
        strategy: 'manual',
        runnerId: input.runner.id,
        modelId: input.model,
        chosenRowId: null,
        confidence: 1,
        reason: 'istifadəçi əl ilə seçdi',
        decisionTokens: 0,
        decisionCostUsd: 0,
      }
      recordRoutingDecision(this.db, input.task.id, decision)
      return { runner: input.runner, model: input.model, decision }
    }

    if (this.router === undefined) {
      return { error: 'Auto rejimi üçün router qurulmayıb — runner və model açıq verilməlidir' }
    }

    const outcome = await this.router.decide({
      task: input.task,
      context: {
        cwd: input.context.cwd,
        amplificationProfile: profile,
        defaultWorkerModelId: input.context.defaultWorkerModelId ?? null,
      },
    })
    if (!outcome.ok) return { error: outcome.error }

    recordRoutingDecision(this.db, input.task.id, outcome.decision)
    setTaskType(this.db, input.task.id, outcome.taskType)
    return {
      runner: outcome.runner,
      model: outcome.decision.modelId,
      decision: outcome.decision,
    }
  }
}
