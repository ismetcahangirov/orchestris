import { AMPLIFICATION_PROFILES, type RunEvent, type Runner } from '@orchestris/shared'
import { saveDiffArtifact } from '../db/artifact-repo.js'
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
import {
  countBossAssistedTasks,
  getTemplate,
  recordTemplateEscalation,
  recordTemplateUse,
  saveTemplate,
  type TaskTemplate,
} from '../db/template-repo.js'
import type { MemorySession } from '../memory/session.js'
import { classifyTask } from '../routing/classify.js'
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
  buildDistillRequestPrompt,
  buildTemplatedPrompt,
  DISTILL_RUNG,
  parseTemplate,
  shouldDistill,
  templateId,
} from './distill.js'
import {
  buildEscalationPrompt,
  collectAnswerText,
  ESCALATION_CONTRACT,
  parseEscalation,
  type Escalation,
} from './escalation.js'
import { buildHintedPrompt, buildHintRequestPrompt } from './hint.js'
import { buildPlannedPrompt, buildPlanRequestPrompt, detectMultiStep } from './plan.js'
import { computeTaskSavings } from './savings.js'
import type { RunSupervisor } from './supervisor.js'
import { buildFeedbackPrompt, runVerifications } from './verify.js'
import { shouldIsolate, type Worktree, type WorktreeManager } from './worktree.js'

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
/**
 * Pillə 5 — plan güclü / icra zəif.
 *
 * Pillə 4 ilə EYNİ SƏBƏBDƏN həm başçının plan icrasına, həm işçinin planlı
 * icrasına yazılır: pillənin mənası tam başçı icrasından qaçmaqdır, ona görə
 * onu 7 saymaq uğuru uğursuzluq kimi göstərərdi (qayda 31).
 */
const RUNG_PLAN = 5
/** Pillə 6 — işçinin özünü dayandırması. */
const RUNG_SELF_ESCALATION = 6
/** Pillə 7 — tam güclü model. Son çarə. */
const RUNG_BOSS = 7

/**
 * Başçının qarışdığı pillələr — prompt distilləsinin qapısı bunları sayır.
 *
 * Distillə pillə DEYİL (kəsişən mexanizmdir), ona görə `PROFILE_RUNGS`-da
 * yoxdur. Amma onun qapısı "bu tipdə başçı neçə dəfə lazım oldu?" sualına
 * cavab verməlidir və o cavab MƏHZ bu nömrələrdədir.
 */
const BOSS_ASSIST_RUNGS = [RUNG_HINT, RUNG_PLAN, RUNG_BOSS] as const

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
 * Pillə 4 (ipucu) və 5 (plan) YALNIZ `quality`-dədir: hər ikisi başçının ƏLAVƏ
 * icrasını ödəyir və işçini bir daha qaçırır — yəni uğurlu halda 7-dən ucuz,
 * UĞURSUZ halda ondan bahadır. `balanced` gündəlik iş üçündür, ona görə orada
 * bu risk götürülmür.
 *
 * 4 və 5 EYNİ YERDƏ dayanır və biri-birini istisna edir (`pickShepherd`):
 * ardıcıl qaçsaydılar eskalasiya zənciri 6 icraya çıxardı və pillələrin
 * qənaəti kaskad riskinə qurban gedərdi.
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
    RUNG_PLAN,
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
  /**
   * `contexts.max_parallel` XAM dəyəri (0 = avtomatik).
   *
   * Nərdivan taskları paralel qaçırmır — hovuz bunu ondan kənarda edir. Dəyər
   * BURADA yalnız bir suala cavab verir: "eyni anda başqa task da işləyə
   * bilərmi?" Cavab yoxdursa ayrıca worktree açmaq boş xərcdir (`shouldIsolate`).
   */
  maxParallel?: number
  /** Yaddaş sahəsi (Faza 3). `null`/boş = kontekstin öz `id`-si. */
  memoryScope?: string | null
  /** Kontekst səviyyəsində yaddaş opt-out-u. Default `true`. */
  memoryEnabled?: boolean
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

export interface PlanSummary {
  /** İşçi nə üçün ilişmişdi — plan məhz ona görə istənildi. */
  trigger: EscalationTrigger
  /** Başçının plan icrası. */
  planRunId: string
  /**
   * Planın uzunluğu (simvol) — "başçı nə qədər yazdı?" sualının cavabı.
   *
   * Pillənin iqtisadiyyatı MƏHZ bununla ölçülür: başçı planla kifayətlənməyib
   * addımları doldurursa, pillə Pillə 7-dən bahaya işləyir.
   */
  planChars: number
  /** Planlı işçi cəhdi taskı həll etdimi. `false` olsa da sahə QALIR (qayda 22). */
  accepted: boolean
}

/** Faza 3 — bu taskda yaddaşın nə etdiyi. */
export interface MemorySummary {
  /** Prompta qoşulan qeyd sayı. `0` = yaddaş boş idi və ya söndürülüb. */
  recalled: number
  /** Həmin qeydlərin təxmini token dəyəri — büdcənin nə qədəri işlədildi. */
  tokens: number
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
  /** Pillə 5 işə düşübsə planın taleyi. `hint` ilə eyni anda GƏLMİR. */
  plan?: PlanSummary
  /** Pillə 6 və ya 3 yuxarı qalxmaq istəyibsə. */
  escalation?: EscalationSummary
  /** Pillə 1-in qərarı — UI-da "niyə bu model?" sualına cavab verir. */
  decision?: RoutingDecision
  /** Yaddaş qoşulubsa nə qədəri. Pillə DEYİL — kəsişən mexanizm. */
  memory?: MemorySummary
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
  /** İcranın işlədiyi qovluq — izolyasiya varsa worktree, yoxsa kontekstin `cwd`-si. */
  cwd: string | undefined
  /** İzolyasiya açıqdırsa worktree; yoxsa `undefined` (davranış əvvəlki kimi qalır). */
  worktree: Worktree | undefined
  rungs: ReadonlySet<number>
  cacheKey: string | null
  verifyCommands: string[]
  decision: RoutingDecision
  budget: RemainingBudget
  /** İşçi icralarının pilləsi. `boss-only`-də işçi ELƏ başçıdır → 7. */
  workerRung: number
  /** Kontekstin amplifikasiya profili — distillə qapısı ona baxır. */
  profile: string
  /** `classify.ts`-in determinist təsnifatı — şablon məhz tipə bağlıdır. */
  taskType: string
  /** Bu tip üçün hazır şablon (Prompt distilləsi). Yoxdursa `undefined`. */
  template: TaskTemplate | undefined
  /**
   * İŞÇİ promptuna qoşulan yaddaş suffiksi (Faza 3). Boş sətir = yaddaş yoxdur.
   *
   * YALNIZ işçi promptuna gedir — başçının (Pillə 4, 5, 7) promptuna YOX.
   * Səbəb: yaddaş mətni ETİBARSIZDIR (`memory/prompt.ts`), başçı icrası isə ən
   * bahalı və ən çox etibar edilən addımdır; ona etibarsız mətn qatmaq ən pis
   * yerdə ən böyük hücum səthini açardı. Faydası isə ölçülməyib — ölçülənə
   * qədər dar qapı saxlanılır.
   */
  memorySuffix: string
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
 * Pillə 4 və 5 EYNİ AXINDIR: başçıdan qısa mətn al → işçini onunla bir dəfə
 * qaçır → pulsuz siqnalla yoxla. Fərq yalnız İSTƏNİLƏN MƏTNDƏDİR.
 *
 * Axını iki dəfə yazmaq həmin incə şərtləri (büdcə, müqavilə saxlanması,
 * keşləmə qadağası, `fromRunId` zənciri) iki yerdə saxlamaq demək olardı — biri
 * dəyişəndə digəri səssizcə köhnələrdi.
 */
interface ShepherdStrategy {
  rung: number
  /** Nəticəyə hansı sahə kimi yapışır. */
  key: 'hint' | 'plan'
  buildBossPrompt(input: { task: string; reason: string; partial?: string }): string
  buildWorkerPrompt(task: string, assist: string): string
}

const HINT_STRATEGY: ShepherdStrategy = {
  rung: RUNG_HINT,
  key: 'hint',
  buildBossPrompt: buildHintRequestPrompt,
  buildWorkerPrompt: buildHintedPrompt,
}

const PLAN_STRATEGY: ShepherdStrategy = {
  rung: RUNG_PLAN,
  key: 'plan',
  buildBossPrompt: buildPlanRequestPrompt,
  buildWorkerPrompt: buildPlannedPrompt,
}

/** `ShepherdStrategy`-nin nəticəsi — açara görə `hint` və ya `plan` olur. */
interface ShepherdSummary {
  trigger: EscalationTrigger
  runId: string
  chars: number
  accepted: boolean
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
  private readonly worktrees: WorktreeManager | undefined
  private readonly memory: MemorySession | undefined

  constructor(
    db: Db,
    supervisor: RunSupervisor,
    router?: WorkerRouter,
    worktrees?: WorktreeManager,
    memory?: MemorySession,
  ) {
    this.db = db
    this.supervisor = supervisor
    this.router = router
    // Verilməsə izolyasiya TAMAMİLƏ söndürülür — nərdivan Faza 1C-dəki kimi
    // birbaşa kontekstin `cwd`-sində işləyir.
    this.worktrees = worktrees
    // Verilməsə yaddaş TAMAMİLƏ söndürülür (Faza 1–2 davranışı). Default
    // QƏSDƏN yoxdur: `NullProvider` belə hər taska iki cərgə jurnal yazardı və
    // `buildApp` səviyyəsində qərar verilməli olan şeyi nərdivan qərarlaşdırardı.
    this.memory = memory
  }

  /**
   * Taskı başdan-sona aparır və SONDA qənaət ledger-ini + worktree diff-ini yazır.
   *
   * Hər ikisi `run()`-ın hər `return`-ündən sonra təkrarlanmasın deyə burada,
   * bir yerdə edilir — unudulan bir yol ölçmədə səssiz boşluq, worktree-də isə
   * diskdə qalan yetim qovluq yaradardı. Ona görə diff toplanması `finally`-dədir:
   * icra atılan xəta ilə bitsə də agentin yazdıqları itməməlidir.
   */
  async run(input: LadderInput): Promise<LadderResult> {
    // Worktree `execute()`-in İÇİNDƏ açılır (task tipi yalnız routing-dən sonra
    // bilinir), amma bağlanışı BURADA olmalıdır — ona görə vəziyyət paylaşılan
    // obyektlə ötürülür.
    const session: { worktree: Worktree | undefined } = { worktree: undefined }
    try {
      const result = await this.execute(input, session)
      // Yaddaş yazılışı ledger-dən ƏVVƏLDİR: sıxmanın xərci `memory_ops`-a
      // düşür və `computeTaskSavings` onu oradan oxuyur. Sonra yazsaydıq, hər
      // taskın yaddaş xərci BİR TASK GECİKMƏ ilə görünərdi — yəni heç vaxt
      // düzgün görünməzdi.
      await this.remember(input, result)
      this.recordLedger(input.task.id)
      return result
    } finally {
      await this.closeWorktree(input.task.id, session.worktree)
    }
  }

  /**
   * Worktree-ni yekunlaşdırır: dəyişiklik varsa diff saxlanılır, yoxdursa qovluq
   * DƏRHAL silinir.
   *
   * "Dəyişiklik yoxdursa sil" qaydası vacibdir: hər mətn və ya uğursuz task
   * diskdə boş worktree qoysaydı, istifadəçinin `~/.orchestris/worktrees/`
   * qovluğu yüzlərlə mənasız qovluqla dolardı və UI-da "baxılası dəyişiklik"
   * siyahısı yalan danışardı.
   *
   * Dəyişiklik VARSA worktree QALIR — diff-in tətbiqi istifadəçinin qərarıdır
   * və o qərar verilənə qədər işi silmək olmaz.
   */
  private async closeWorktree(taskId: string, worktree: Worktree | undefined): Promise<void> {
    if (this.worktrees === undefined || worktree === undefined) return
    try {
      const diff = await this.worktrees.collect(worktree)
      if (diff.files === 0) {
        await this.worktrees.remove(worktree)
        return
      }
      saveDiffArtifact(this.db, {
        taskId,
        worktreePath: worktree.path,
        branch: worktree.branch,
        repoPath: worktree.repo,
        content: diff.diff,
        files: diff.files,
        truncated: diff.truncated,
      })
    } catch {
      // Diff toplanmadı (git sındı, disk doldu) — worktree DİSKDƏ SAXLANILIR.
      // Silmək agentin işini geri qaytarılmaz şəkildə məhv etmək olardı;
      // qalan qovluğu isə istifadəçi əl ilə də oxuya bilər.
    }
  }

  /**
   * Ledger sətrini yazır — YALNIZ həqiqətən icra olubsa.
   *
   * İcrasız uğursuzluqda (məs. "işçi təyin olunmayıb") ölçüləcək bir şey
   * yoxdur: pul yanmayıb. Belə taskı ledger-ə yazsaq, "task sayı" şişər və
   * orta qənaət olduğundan kiçik görünərdi.
   */
  /**
   * Nəticəni yaddaşa yazır — YALNIZ uğurlu VƏ keşdən GƏLMƏYƏN nəticəni.
   *
   * Uğursuz cavabı yazmaq həmin sahədəki bütün gələcək taskları zəhərləyərdi
   * (`memory/session.ts`). Keş təkrarını yazmaq isə eyni qeydi dönə-dönə
   * çoxaldardı: keş cavabı ARTIQ bir dəfə yadda saxlanılıb, yeni məlumat
   * yaranmayıb — üstəlik hər təkrar sıxma xərci ödəyərdi.
   */
  private async remember(input: LadderInput, result: LadderResult): Promise<void> {
    if (this.memory === undefined) return
    if (result.status !== 'succeeded' || result.cached) return
    if (result.runId === '') return

    await this.memory.remember({
      taskId: input.task.id,
      ctx: this.memoryContext(input),
      prompt: input.task.prompt,
      answer: this.answerOf(result.runId),
    })
  }

  private memoryContext(input: LadderInput): {
    id: string
    memoryScope?: string | null
    memoryEnabled?: boolean
  } {
    const { id, memoryScope, memoryEnabled } = input.context
    return {
      id,
      ...(memoryScope !== undefined ? { memoryScope } : {}),
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
    }
  }

  private recordLedger(taskId: string): void {
    if (listRunsForTask(this.db, taskId).length === 0) return
    recordSavings(this.db, computeTaskSavings(this.db, taskId))
  }

  private async execute(
    input: LadderInput,
    session: { worktree: Worktree | undefined },
  ): Promise<LadderResult> {
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
    const { runner, model, decision, taskType } = selected

    const rungs = activeRungs(profile)

    // Prompt distilləsi — hazır şablon varsa işçi onu SIFIR əlavə başçı tokeni
    // ilə alır. Profildən ASILI DEYİL: şablon pillə deyil, artıq ödənilmiş
    // mətndir; `cheap` profilində də tətbiq olunmalıdır.
    const template = getTemplate(this.db, taskType)

    // Yaddaşın oxunması (Faza 3) — keş AÇARINDAN ƏVVƏL olmalıdır.
    //
    // Worktree-dən (Pillə 0-dan SONRA açılır) fərqli olaraq burada sıra tərsdir:
    // yaddaş işçinin promptunu dəyişir, yəni açarın özü ondan asılıdır. Sonra
    // oxusaydıq, açar yaddaşsız hesablanar və yaddaşlı cavab yaddaşsız açar
    // altında saxlanılardı — sonrakı icra səssizcə səhv cavab alardı.
    //
    // Oxuma LOKAL axtarışdır (`memory/claude-mem.ts`), ona görə keşdən cavab
    // alan taskda da ödənilən şey praktiki olaraq sıfırdır.
    const recalled =
      this.memory === undefined
        ? null
        : await this.memory.recall({
            taskId: input.task.id,
            ctx: this.memoryContext(input),
            query: input.task.prompt,
          })

    const cacheKey = rungs.has(RUNG_CACHE)
      ? computeCacheKey({
          prompt: input.task.prompt,
          modelId: model,
          runnerId: runner.id,
          needsFileAccess: runner.capabilities.fileAccess,
          ...(cwd !== undefined ? { cwd } : {}),
          // Şablon promptu dəyişir → köhnə cavab artıq eyni sualın cavabı deyil.
          ...(template !== undefined ? { templateId: template.id } : {}),
          // Yaddaş da promptu dəyişir — eyni səbəb.
          ...(recalled?.digest !== null && recalled?.digest !== undefined
            ? { memoryDigest: recalled.digest }
            : {}),
        })
      : null

    const memorySummary: MemorySummary | undefined =
      recalled === null || recalled.items === 0
        ? undefined
        : { recalled: recalled.items, tokens: recalled.tokens }

    // ── Pillə 0 — cache ────────────────────────────────────────────────
    if (cacheKey !== null) {
      const hit = this.replayFromCache(input, runner, model, cacheKey)
      if (hit !== null) {
        return {
          ...hit,
          decision,
          ...(memorySummary !== undefined ? { memory: memorySummary } : {}),
        }
      }
    }

    // ── İzolyasiya — paralel kod taskları üçün ayrıca git worktree ─────
    // Keş yoxlanışından SONRA gəlir: keşdən cavab alınan task heç nə icra
    // etmir, ona ~200–500 ms worktree açmaq təmiz israf olardı.
    session.worktree = await this.openWorktree(input, taskType, runner)

    const phase: Phase = {
      input,
      runner,
      model,
      // Worktree açılıbsa BÜTÜN icralar (yoxlama əmrləri daxil) orada işləyir —
      // əks halda agent bir ağacda yazar, `tsc` başqasında oxuyardı.
      cwd: session.worktree?.path ?? cwd,
      worktree: session.worktree ?? undefined,
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
      profile,
      taskType,
      template,
      memorySuffix: recalled?.suffix ?? '',
    }

    const outcome = await this.workerPhase(phase)
    const result =
      outcome.kind === 'result' ? outcome.result : await this.escalate(phase, outcome)
    // Yaddaş NƏTİCƏYƏ toxunmur, ona görə xülasə sonda yapışdırılır: hansı
    // pillənin qazandığından asılı olmayaraq "bu taska nə qədər yaddaş
    // qoşuldu?" sualının cavabı eynidir və gizlədilməməlidir (qayda 22).
    return memorySummary === undefined ? result : { ...result, memory: memorySummary }
  }

  /**
   * İşçi ilişdi — nə edək?
   *
   * Sıra ucuzdan bahayadır: əvvəlcə başçının QISA köməyi (Pillə 4 ipucu VƏ YA
   * Pillə 5 plan) + işçinin bir icrası, o tutmasa Pillə 7 (başçının TAM
   * icrası). Kömək nəticəsi qaytarılan cavaba HƏR HALDA yapışdırılır — qəbul
   * edilməsə də ödənilib (qayda 22).
   */
  private async escalate(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): Promise<LadderResult> {
    // Şablon tətbiq olunmuşdu, amma task yenə qalxır — distillənin ÖLÇÜSÜ
    // budur. Nəticədən ASILI OLMAYARAQ qeyd olunur: sonrakı başçı icrası uğurlu
    // olsa da, şablon işçini saxlaya bilməyib.
    if (phase.template !== undefined) recordTemplateEscalation(this.db, phase.taskType)

    const final = await this.escalationResult(phase, outcome)
    // Distillə eskalasiyadan SONRA gəlir: qapı "bu tipdə başçı neçə dəfə lazım
    // oldu?" sualını sayır və cari taskın öz başçı icrası da o saya girməlidir.
    await this.distill(phase, outcome, final)
    return final
  }

  private async escalationResult(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): Promise<LadderResult> {
    const strategy = this.pickShepherd(phase, outcome)
    const shepherded =
      strategy === undefined ? {} : await this.shepherdPhase(phase, outcome, strategy)
    if (shepherded.result !== undefined) return shepherded.result

    // Köməkli cəhd də sınıbsa zəncir 2 → 4 → 4 → 7-dir: başçının TAM icrası
    // ƏN SON icradan doğur, ilk işçi cəhdindən yox.
    const next =
      shepherded.fromRunId !== undefined
        ? { ...outcome, fromRunId: shepherded.fromRunId }
        : outcome

    const result = await this.escalateToBoss(phase, next)
    if (strategy === undefined || shepherded.summary === undefined) return result
    return this.attachSummary(result, strategy, shepherded.summary)
  }

  /**
   * Prompt distilləsi — başçıdan bu TASKIN həllini yox, bu TİPİN iş üsulunu
   * istəyir və `task_templates`-ə yazır.
   *
   * Nərdivanın pilləsi DEYİL: nəticəyə toxunmur, yalnız gələcək taskları
   * ucuzlaşdırır. Ona görə burada hər şey "ən pis halda heç nə olmasın"
   * prinsipi ilə qurulub — uğursuz distillə taskın nəticəsini DƏYİŞMİR.
   *
   * İKİ İNCƏLİK:
   *  - `RunSupervisor` hər icradan sonra taskın statusunu YAZIR. Distillə
   *    icrası nəticə verildikdən SONRA gəldiyi üçün, sınsa taskı `failed`
   *    göstərərdi — ona görə sonda status bərpa olunur (`settle`).
   *  - İcra `DISTILL_RUNG` (mənfi) ilə qeyd olunur: `savings.ts` onu baseline
   *    tokenlərindən çıxarır və orkestrasiya xərcinə yazır (bax `distill.ts`).
   */
  private async distill(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
    settled: LadderResult,
  ): Promise<void> {
    if (this.router === undefined) return
    const verdict = shouldDistill({
      profile: phase.profile,
      taskType: phase.taskType,
      hasTemplate: phase.template !== undefined,
      assistedTasks: countBossAssistedTasks(this.db, phase.taskType, BOSS_ASSIST_RUNGS),
    })
    if (!verdict.distill) return
    // Büdcə bitibsə YENİ icra başlatmaq sərt limitin mənasını pozardı —
    // üstəlik bu icra cari taskın nəticəsinə heç nə qatmır.
    if (phase.budget.exhausted()) return

    const boss = this.router.resolveBoss(`prompt distilləsi: ${verdict.reason}`)
    if (!boss.ok) return

    const exec = await this.supervisor.execute({
      taskId: phase.input.task.id,
      runner: boss.runner,
      model: boss.decision.modelId,
      prompt: buildDistillRequestPrompt({
        taskType: phase.taskType,
        examplePrompt: phase.input.task.prompt,
        reason: outcome.reason,
      }),
      attempt: 1,
      ladderRung: DISTILL_RUNG,
      ...this.where(phase),
      ...(this.limitsFor(phase) ?? {}),
    })
    phase.budget.charge(getRun(this.db, exec.runId))

    // Status bərpası HƏR yolda lazımdır: icra uğurlu olsa da supervisor taskı
    // `succeeded` yazıb — halbuki nəticə `settled`-dəndir və o, `failed` ola bilər.
    try {
      if (exec.status !== 'succeeded') return
      const template = parseTemplate(this.answerOf(exec.runId))
      // Başçı müqaviləyə əməl etməyibsə (başlıqlar yoxdur, ya da hədd aşılıb)
      // heç nə saxlanılmır: səhv şablon bir taska deyil, BÜTÜN gələcək
      // tasklara yapışardı.
      if (template === null) return

      const run = getRun(this.db, exec.runId)
      saveTemplate(this.db, {
        id: templateId(template),
        taskType: phase.taskType,
        workerPrompt: template.workerPrompt,
        rubric: template.rubric,
        authoredByModelId: boss.decision.modelId,
        authoringRunId: exec.runId,
        ...(run?.costUsd !== null && run?.costUsd !== undefined
          ? { authoringCostUsd: run.costUsd }
          : {}),
      })
    } finally {
      this.settle(phase, settled)
    }
  }

  /**
   * Pillə 4, yoxsa Pillə 5? — **sıfır token** ilə verilən qərar.
   *
   * İkisi ardıcıl qaçmır, çünki hər biri BİR başçı + BİR işçi icrası ödəyir:
   * zəncirlə 2 → 4 → 4 → 5 → 5 → 7 altı icra edərdi və pillələrin qənaəti
   * kaskad riskinə (issue #9) qurban gedərdi.
   *
   * Seçim taskın ŞƏKLİNƏ görədir, təsadüfi deyil:
   *  - çoxaddımlı task → PLAN. İpucu (həllin ilk 10–30%-i) burada yalnız 1-ci
   *    addımdır və qalan addımlar barədə işçiyə heç nə demir.
   *  - təkaddımlı task → İPUCU. Orada "plan" bir sətrə yığılır və elə ipucunun
   *    özünə çevrilir; plan promptunun əlavə tələbləri isə başçıya boş yerə
   *    token yazdırardı.
   *
   * Razılaşmama (Pillə 3) halında heç biri işə düşmür — işçi ilişməyib, cavab
   * verib; nüsxələr onsuz da ödənilib (qayda 34).
   */
  private pickShepherd(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
  ): ShepherdStrategy | undefined {
    if (outcome.trigger === 'disagreement') return undefined
    const multiStep = detectMultiStep(phase.input.task.prompt).multiStep
    const strategy = multiStep ? PLAN_STRATEGY : HINT_STRATEGY
    return phase.rungs.has(strategy.rung) ? strategy : undefined
  }

  private attachSummary(
    result: LadderResult,
    strategy: ShepherdStrategy,
    summary: ShepherdSummary,
  ): LadderResult {
    const { trigger, runId, chars, accepted } = summary
    return strategy.key === 'plan'
      ? { ...result, plan: { trigger, planRunId: runId, planChars: chars, accepted } }
      : { ...result, hint: { trigger, hintRunId: runId, hintChars: chars, accepted } }
  }

  /**
   * Pillə 4 (ipucu) və Pillə 5 (plan) — başçının QISA köməyi.
   *
   * Başçıdan TAM cavab yox, ya həllin ilk 10–30%-i (ipucu), ya da addım
   * bölgüsü + skelet (plan) istənilir; sonra işçi ONUN üzərində bir dəfə də
   * qaçırılır. Uğurlu halda başçının bahalı çıxışının yalnız kiçik hissəsi
   * ödənilir.
   *
   * NİYƏ CƏMİ BİR CƏHD: kaskad riski (issue #9) — hər pillə maksimum bir dəfə.
   * İkinci kömək üçün ödəniş artıq başçının tam icrasına yaxınlaşır və pillənin
   * mənası itir.
   *
   * Hansı pillənin seçildiyi `pickShepherd`-dədir — burada axın eynidir.
   */
  private async shepherdPhase(
    phase: Phase,
    outcome: Extract<WorkerOutcome, { kind: 'escalate' }>,
    strategy: ShepherdStrategy,
  ): Promise<{ result?: LadderResult; summary?: ShepherdSummary; fromRunId?: string }> {
    if (this.router === undefined) return {}
    // Büdcə bitibsə YENİ icra başlatmaq sərt limitin mənasını pozardı.
    if (phase.budget.exhausted()) return {}

    const boss = this.router.resolveBoss(`Pillə ${strategy.rung}: ${outcome.reason}`)
    if (!boss.ok) return {}
    recordRoutingDecision(this.db, phase.input.task.id, boss.decision)

    const assistExec = await this.supervisor.execute({
      taskId: phase.input.task.id,
      runner: boss.runner,
      model: boss.decision.modelId,
      prompt: strategy.buildBossPrompt({
        task: phase.input.task.prompt,
        reason: outcome.reason,
        ...(outcome.escalation?.partial !== undefined
          ? { partial: outcome.escalation.partial }
          : {}),
      }),
      attempt: 1,
      ladderRung: strategy.rung,
      escalatedFromRunId: outcome.fromRunId,
      ...this.where(phase),
      ...(this.limitsFor(phase) ?? {}),
    })
    phase.budget.charge(getRun(this.db, assistExec.runId))

    // Kömək alınmadı (xəta, ləğv, büdcə) — Pillə 7 hələ də açıqdır.
    if (assistExec.status !== 'succeeded') return {}
    const assistText = this.answerOf(assistExec.runId).trim()
    if (assistText === '') return {}

    const summary = (accepted: boolean): ShepherdSummary => ({
      trigger: outcome.trigger,
      runId: assistExec.runId,
      chars: assistText.length,
      accepted,
    })

    if (phase.budget.exhausted()) return { summary: summary(false) }

    // Müqavilə (Pillə 6) SAXLANILIR: köməklə də bacarmırsa işçi yenidən
    // imtina edə bilməlidir — yoxsa o, uydurma cavab yazmağa məcbur qalardı.
    const contractSuffix = phase.rungs.has(RUNG_SELF_ESCALATION)
      ? `\n\n${ESCALATION_CONTRACT}`
      : ''
    const workerExec = await this.runOnce(phase, {
      prompt: `${strategy.buildWorkerPrompt(phase.input.task.prompt, assistText)}${contractSuffix}`,
      attempt: 1,
      rung: strategy.rung,
      escalatedFromRunId: assistExec.runId,
    })

    if (workerExec.status !== 'succeeded') {
      return { summary: summary(false), fromRunId: workerExec.runId }
    }
    if (contractSuffix !== '' && parseEscalation(this.answerOf(workerExec.runId)) !== null) {
      return { summary: summary(false), fromRunId: workerExec.runId }
    }

    // Nəticə SIFIRDAN qurulur: `outcome.fallback`-ı yaymaq ora yapışmış xəta
    // sahələrini (`errorClass`, `escalation_unavailable`) uğurlu cavabın üstünə
    // daşıyardı.
    const base = this.attachSummary(
      {
        runId: workerExec.runId,
        status: 'succeeded',
        cached: false,
        cacheKey: phase.cacheKey,
        attempts: outcome.fallback.attempts,
        verificationPassed: null,
        finalRung: strategy.rung,
        decision: phase.decision,
      },
      strategy,
      summary(true),
    )

    // KÖMƏKLİ CAVAB KEŞLƏNMİR: keş açarı yalnız model + runner id-sindən
    // qurulur (`cache-key.ts`), başçının köməyini göstərmir. Ora yazsaq sonrakı
    // `cheap` profilli icra (Pillə 4, 5 və 7-ni QƏSDƏN söndürən) səssizcə başçı
    // köməyi ilə alınmış cavabı alardı — qayda 33 ilə eyni səbəb.
    if (phase.verifyCommands.length === 0) {
      return { result: this.settle(phase, base) }
    }

    const verification = await this.verify(phase, workerExec.runId)
    if (verification.passed) {
      return { result: this.settle(phase, { ...base, verificationPassed: true }) }
    }
    // Determinist alət "hələ də səhvdir" dedi — kömək tutmadı, 7 qalır.
    return { summary: summary(false), fromRunId: workerExec.runId }
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

    // Prompt distilləsi — başçının bir dəfə yazdığı təlimat. Onu tətbiq etmək
    // SIFIR əlavə başçı tokeni xərcləyir; ödəniş çoxdan olub.
    // SIRA VACİBDİR: task → şablon → yaddaş → müqavilə.
    //  - şablon TƏLİMATDIR (etibarlı, başçı yazıb) → yaddaşdan əvvəl
    //  - yaddaş MƏLUMATDIR (etibarsız) → çərçivəsi ilə birlikdə ortada
    //  - müqavilə ƏN SONDA qalmalıdır: model son göstərişə daha çox əhəmiyyət
    //    verir və "bacarmırsansa `escalate` qaytar" məhz həmin göstərişdir.
    const templated =
      phase.template === undefined
        ? input.task.prompt
        : buildTemplatedPrompt(input.task.prompt, phase.template)
    const workerPrompt =
      phase.memorySuffix === '' ? templated : `${templated}\n\n${phase.memorySuffix}`
    if (phase.template !== undefined) {
      // Task başına BİR dəfə: `workerPhase` bir taskda bir dəfə çağırılır.
      // Cəhd/nüsxə başına saysaydıq, "şablon N taskda işlədildi" rəqəmi yoxlama
      // dövrəsinin təkrarlarından şişərdi.
      recordTemplateUse(this.db, phase.taskType)
    }

    let prompt = `${workerPrompt}${contractSuffix}`
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
      // xərcləyir; yalnız yeni icra xərcləyir. Şablon SAXLANILIR — o, bu tipin
      // iş üsuludur və səhv düzəlişində də keçərlidir.
      prompt = `${workerPrompt}\n\n${buildFeedbackPrompt(
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
      ...this.where(phase),
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
      ...this.where(phase),
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

  /**
   * Hər icranın "harada işlədi" hissəsi — bir yerdən verilir.
   *
   * Nərdivan `supervisor.execute`-i dörd yerdən çağırır (işçi/nüsxə, ipucu-plan,
   * başçı, distillə). Qovluğu hər çağırış yerində əl ilə yazsaydıq, biri
   * unudulanda həmin icra izolyasiyadan KƏNARDA — istifadəçinin əsl repo-sunda —
   * işləyərdi. Belə səhv yalnız real fayl korlanmasında görünərdi.
   */
  private where(phase: Phase): { cwd?: string; worktreePath?: string } {
    return {
      ...(phase.cwd !== undefined ? { cwd: phase.cwd } : {}),
      ...(phase.worktree !== undefined ? { worktreePath: phase.worktree.path } : {}),
    }
  }

  /**
   * Lazımdırsa izolyasiya edilmiş worktree açır.
   *
   * Alınmasa `undefined` qaytarır və nərdivan əsas `cwd`-də davam edir: git
   * yoxdur, repo deyil, commit yoxdur və ya `worktree add` sındı — heç biri
   * taskı dayandırmaq üçün səbəb deyil. İzolyasiya OPTİMALLAŞDIRMADIR, tələb
   * deyil.
   */
  private async openWorktree(
    input: LadderInput,
    taskType: string,
    runner: Runner,
  ): Promise<Worktree | undefined> {
    const cwd = input.context.cwd
    if (this.worktrees === undefined || cwd === null) return undefined
    const isolate = shouldIsolate({
      maxParallel: input.context.maxParallel ?? 0,
      taskType,
      cwd,
      fileAccess: runner.capabilities.fileAccess,
    })
    if (!isolate) return undefined
    return (await this.worktrees.create({ repo: cwd, taskId: input.task.id })) ?? undefined
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
    | { runner: Runner; model: string; decision: RoutingDecision; taskType: string }
    | { error: string }
  > {
    if (input.runner !== undefined && input.model !== undefined) {
      // Əl ilə seçimdə router işə düşmür, amma task TİPİ yenə lazımdır: prompt
      // distilləsi şablonu tipə görə tapır. Təsnifat 0 token xərcləyir, ona
      // görə burada təkrar hesablamaq sərbəstdir (`decide()` də eyni funksiyanı
      // çağırır — `classify.ts` saf funksiyadır).
      const taskType = classifyTask({
        prompt: input.task.prompt,
        ...(input.context.cwd !== null ? { cwd: input.context.cwd } : {}),
      }).taskType
      setTaskType(this.db, input.task.id, taskType)

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
      return { runner: input.runner, model: input.model, decision, taskType }
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
      taskType: outcome.taskType,
    }
  }
}
