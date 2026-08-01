import type { Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendVerification,
  createTask,
  getRun,
  listEvents,
  listRunsForTask,
  setTaskStatus,
} from '../db/repo.js'
import { recordSavings } from '../db/savings-repo.js'
import { classifyTask } from '../routing/classify.js'
import type { WorkerRouter } from '../routing/decide.js'
import { capLimits, scaleLimits, type BudgetLimits } from './budget.js'
import {
  buildDecomposeRequestPrompt,
  DECOMPOSE_RUNG,
  parseDecomposition,
  shouldDecompose,
} from './decompose.js'
import { collectAnswerText } from './escalation.js'
import { resolveFileAccess } from './file-access.js'
import { RemainingBudget, type Ladder, type LadderContext, type LadderStatus } from './ladder.js'
import { computeTaskSavings } from './savings.js'
import type { RunSupervisor } from './supervisor.js'
import { runVerifications } from './verify.js'
import { shouldIsolate, type Worktree, type WorktreeManager } from './worktree.js'
import { finalizeWorktree } from './worktree-artifact.js'

/**
 * Task dekompozisiyası (Faza 4) — nərdivanın ÜSTÜNDƏ oturan qat.
 *
 * `Ladder` bir taskı bir neçə İCRA ilə həll edir; `Decomposer` isə bir taskı
 * bir neçə TASKA çevirir və hər birini ayrıca nərdivandan keçirir. Nərdivana
 * toxunmur: alt-tasklar üçün keş, routing, alət yoxlaması, best-of-N və
 * eskalasiya normal işləyir.
 *
 * ÜÇ QƏRAR BU SİNFİN BÜTÜN DAVRANIŞINI İZAH EDİR:
 *
 * 1. **Alt-tasklar ARDICIL və EYNİ ağacda qaçır.** Bölgü müqaviləsi "sonrakı
 *    əvvəlkinin nəticəsi üzərində işləyir" deyir — yəni alt-tasklar
 *    ASILIDIR. Onları paralel qaçırsaydıq iki nəticədən biri qaçılmaz olardı:
 *    ya eyni fayllarda yarış, ya da ayrı worktree-lərdə bir-birinin işini
 *    GÖRMƏMƏK (məhz qayda 40-ın qarşısını aldığı səhv). Paralellik onsuz da var
 *    — o, MÜSTƏQİL istifadəçi taskları arasındadır (`pool.ts`).
 * 2. **Alt-tasklarda determinist yoxlama SÖNDÜRÜLÜR, yekunda BİR DƏFƏ qaçır.**
 *    Yarımçıq işdə `tsc` QURULUŞ ETİBARI İLƏ sınır: 4 alt-taskdan 1-cisi
 *    bitəndə kod hələ tamam deyil. Yoxlamanı orada saxlasaydıq, hər alt-task
 *    3 cəhd yandırıb başçıya qalxardı — yəni mexanizm ən bahalı halı MƏCBURİ
 *    edərdi. Ağac ortaq olduğu üçün sonda bir dəfə qaçan yoxlama bütün
 *    parçaların BİRLİKDƏ nəticəsini görür (issue #12: "yekun yoxlama").
 * 3. **Bölgü alınmasa mexanizm SƏSSİZCƏ geri çəkilir.** Başçı JSON qaytarmadı,
 *    bir parça verdi, ya da icra sındı — hər üç halda task adi nərdivandan
 *    keçir. Bölgünün uğursuzluğu taskın uğursuzluğu deyil; əks halda bir
 *    orkestrasiya qərarı istifadəçinin nəticəsini məhv edərdi (monoton qayda,
 *    qayda 32 ilə eyni prinsip).
 */

export interface DecomposeInput {
  task: { id: string; prompt: string }
  context: LadderContext
  /** İstifadəçi `POST /api/tasks`-da açıq şəkildə istədi. */
  requested: boolean
  runner?: Runner
  model?: string
  limits?: BudgetLimits
  /**
   * ÇAĞIRAN TƏRƏFİN AÇDIĞI worktree (workflow zənciri, issue #36).
   *
   * Verilibsə `Decomposer` öz ağacını AÇMIR və verilən ağacı BAĞLAMIR — sahibi
   * çağırandır (`LadderInput.worktree` ilə eyni müqavilə, sadəcə bir səviyyə
   * yuxarıda). Zəncirin bir addımı `decompose: true` ilə bölünəndə parçalar
   * zəncirin ORTAQ ağacında işləməlidir: burada ayrıca ağac açsaydıq, həmin
   * addımın işi öz `pending` diff-ində qalar və NÖVBƏTİ addım onu görməzdi —
   * yəni düzəltdiyimiz səhv bir səviyyə aşağıda təkrarlanardı.
   */
  worktree?: Worktree
  /**
   * İSTİFADƏÇİ İŞTİRAKI mümkündürmü (Faza 5B). Default `true`.
   *
   * Alt-tasklara OLDUĞU KİMİ ötürülür: bölgü zəncirin addımından gəlibsə orada
   * cavab verəcək insan yoxdur və parçanın sualı zənciri əbədi dondurardı.
   */
  interactive?: boolean
}

export interface SubtaskOutcome {
  taskId: string
  index: number
  prompt: string
  status: LadderStatus
  /** Nəticəni verən icranın pilləsi — "neçə alt-task 7-yə çatdı?" sualı üçün. */
  finalRung: number
}

export interface DecomposeResult {
  /** Bölgü HƏQİQƏTƏN baş verdimi. `false` → çağıran adi nərdivana düşməlidir. */
  decomposed: boolean
  /** Niyə — UI-da və log-da görünür. */
  reason: string
  /** Bölgü icrası (başçı). Bölgü baş verməyibsə `null`. */
  decomposeRunId: string | null
  subtasks: SubtaskOutcome[]
  /** Bütün alt-tasklar uğurlu olubmu. */
  status: LadderStatus
  /** Yekun determinist yoxlamanın nəticəsi; əmr yoxdursa `null`. */
  verificationPassed: boolean | null
}

export class Decomposer {
  constructor(
    private readonly db: Db,
    private readonly supervisor: RunSupervisor,
    private readonly ladder: Ladder,
    private readonly router?: WorkerRouter,
    private readonly worktrees?: WorktreeManager,
  ) {}

  /**
   * Taskı bölüb alt-taskları qaçırır.
   *
   * `decomposed: false` qaytarırsa HEÇ NƏ olmayıb kimi davranmaq olar: alt-task
   * yaradılmayıb, ağac açılmayıb. Yeganə istisna — başçının bölgü icrasıdır; o,
   * baş tutubsa DB-də QALIR və orkestrasiya xərcinə yazılır (qayda 22: ödənilən
   * pul gizlədilmir).
   */
  async run(input: DecomposeInput): Promise<DecomposeResult> {
    const profile = input.context.amplificationProfile ?? 'balanced'
    const verdict = shouldDecompose({
      profile,
      requested: input.requested,
      hasRouter: this.router !== undefined,
    })
    if (!verdict.decompose) return this.skipped(verdict.reason)

    const budget = new RemainingBudget(input.limits)
    const split = await this.askBoss(input, budget)
    if (split.subtasks === null) return this.skipped(split.reason, split.runId)

    const rows = split.subtasks.map((prompt, index) =>
      createTask(this.db, {
        contextId: input.context.id,
        prompt,
        parentTaskId: input.task.id,
        subtaskIndex: index,
      }),
    )

    // Ağac VALİDEYN taskındır: bütün alt-tasklar orada işləyir və diff sonda
    // BİR sətir kimi yazılır. Alt-task başına ağac açsaydıq, 2-ci alt-task
    // 1-cinin yazdığı faylı görməzdi (qayda 40).
    //
    // Çağıran ağac veribsə (zəncir addımı — issue #36) ONU işlədirik və sonda
    // BAĞLAMIRIQ: diff-i zəncirin sintetik valideyn taskı yazacaq.
    const external = input.worktree !== undefined
    const worktree = input.worktree ?? (await this.openWorktree(input))

    try {
      const outcomes = await this.runSubtasks(input, rows, worktree, split.runId)
      const verification = await this.verifyOnce(input, worktree, split.runId)
      const status = this.settle(input.task.id, outcomes, verification)

      return {
        decomposed: true,
        reason: verdict.reason,
        decomposeRunId: split.runId,
        subtasks: outcomes,
        status,
        verificationPassed: verification,
      }
    } finally {
      // Ledger `finally`-dədir: bölgü icrası ödənilib və atılan xəta onu
      // ölçmədən çıxarmamalıdır.
      recordSavings(this.db, computeTaskSavings(this.db, input.task.id))
      if (!external && this.worktrees !== undefined && worktree !== undefined) {
        await finalizeWorktree({
          db: this.db,
          worktrees: this.worktrees,
          taskId: input.task.id,
          worktree,
        })
      }
    }
  }

  /** Bölgü baş vermədi — çağıran adi nərdivana düşür. */
  private skipped(reason: string, runId: string | null = null): DecomposeResult {
    return {
      decomposed: false,
      reason,
      decomposeRunId: runId,
      subtasks: [],
      status: 'failed',
      verificationPassed: null,
    }
  }

  /**
   * Başçıdan bölgünü istəyir.
   *
   * İcra `DECOMPOSE_RUNG` (mənfi) ilə qeyd olunur: `savings.ts` onun tokenlərini
   * baseline-dan ÇIXARIR (başçı taskı təkbaşına həll etsəydi bölgü YAZMAZDI —
   * girsəydi baseline şişər və qənaət olduğundan böyük görünərdi), xərcini isə
   * ORKESTRASİYA xərcinə yazır (qayda 22, 37 ilə eyni məntiq).
   */
  private async askBoss(
    input: DecomposeInput,
    budget: RemainingBudget,
  ): Promise<{ subtasks: string[] | null; reason: string; runId: string | null }> {
    if (this.router === undefined) {
      return { subtasks: null, reason: 'başçı yoxdur', runId: null }
    }
    // Büdcə onsuz da bitibsə bölgü icrası ilə başlamaq sərt limitin mənasını
    // pozardı — üstəlik alt-taskları qaçıracaq büdcə də qalmazdı.
    if (budget.exhausted()) {
      return { subtasks: null, reason: 'büdcə bitdi', runId: null }
    }

    const boss = this.router.resolveBoss('task dekompozisiyası')
    if (!boss.ok) return { subtasks: null, reason: boss.error, runId: null }

    const limits = budget.remaining()
    const exec = await this.supervisor.execute({
      taskId: input.task.id,
      runner: boss.runner,
      model: boss.decision.modelId,
      prompt: buildDecomposeRequestPrompt(input.task.prompt),
      attempt: 1,
      ladderRung: DECOMPOSE_RUNG,
      ...(input.context.cwd !== null ? { cwd: input.context.cwd } : {}),
      // Bölgü icrası da kontekstin icazəsi ilə işləyir: başçı bölgü yazarkən
      // repo-ya baxır və `read-only` kontekstdə ona yazmaq icazəsi verilməməlidir.
      fileAccess: resolveFileAccess({
        fileAccess: input.context.fileAccess ?? '',
        extraDirsJson: input.context.extraDirsJson ?? '[]',
        cwd: input.context.cwd ?? undefined,
      }),
      ...(limits !== undefined ? { limits } : {}),
    })
    budget.charge(getRun(this.db, exec.runId))

    if (exec.status !== 'succeeded') {
      return { subtasks: null, reason: 'bölgü icrası uğursuz oldu', runId: exec.runId }
    }

    const parsed = parseDecomposition(this.answerOf(exec.runId))
    if (parsed === null) {
      // Sərt parse: başçı müqaviləyə əməl etmədi, ya da bölgü bir parçadan
      // ibarətdir. Hər iki halda bölmək mənasızdır.
      return {
        subtasks: null,
        reason: 'başçı yararlı bölgü qaytarmadı — task bütöv qaçırılır',
        runId: exec.runId,
      }
    }
    return { subtasks: parsed.subtasks, reason: 'bölgü alındı', runId: exec.runId }
  }

  /**
   * Alt-taskları SIRA İLƏ qaçırır.
   *
   * Determinist yoxlama alt-tasklarda SÖNDÜRÜLÜR (`verifyCommandsJson: '[]'`):
   * yarımçıq işdə `tsc` quruluş etibarı ilə sınır və hər alt-taskı 3 cəhd + başçı
   * eskalasiyası yandırmağa məcbur edərdi. Yoxlama sonda, bütöv nəticə üzərində
   * bir dəfə qaçır.
   *
   * Alt-task SINSA dövrə DAYANMIR: qalanları yenə də qaçır. Səbəb ölçülə bilən
   * fərqdir — 4 parçadan 3-ü hazır olan nəticə istifadəçi üçün 1 parçadan
   * yaxşıdır, halbuki hər ikisi `failed` sayılır. Yekun status onsuz da bunu
   * gizlətmir.
   *
   * BÜDCƏ: hər alt-task TAM limiti alır, valideyn isə parça sayına görə
   * miqyaslanmış ÜMUMİ tavana tabedir (`scaleLimits`). Əvvəl limit bütöv
   * paylaşılırdı və ölçülmüş nəticə budur (2026-08-01, altı parçalı task):
   * bölgü + iki parça büdcəni yedi, qalan DÖRD parça bir icra belə etmədən
   * `failed` yazıldı. Bölünmə taskı KİÇİLTMİR — onu hissələrə ayırır; büdcəni
   * bölmək isə hər parçanı öz işini bitirə bilməyəcək hala salırdı.
   */
  private async runSubtasks(
    input: DecomposeInput,
    rows: readonly { id: string; prompt: string }[],
    worktree: Worktree | undefined,
    decomposeRunId: string | null,
  ): Promise<SubtaskOutcome[]> {
    const outcomes: SubtaskOutcome[] = []
    const ceiling = new RemainingBudget(scaleLimits(input.limits, rows.length))
    // Bölgü icrası da valideynin tavanına yazılır: o, orkestrasiya xərcidir
    // (qayda 51), amma ödənilmiş pul ödənilmiş puldur.
    if (decomposeRunId !== null) ceiling.charge(getRun(this.db, decomposeRunId))

    for (const [index, row] of rows.entries()) {
      if (ceiling.exhausted()) {
        // Büdcə bitdi — qalan alt-tasklar İCRA OLUNMUR, amma `pending` da
        // qalmır: UI-da "gözləyir" görünən, əslində heç vaxt başlamayacaq task
        // yalandır.
        //
        // SƏBƏB DB-YƏ YAZILIR. Əvvəl yalnız `'failed'` yazılırdı və səbəb
        // yaddaşdakı `outcome` obyektində qalırdı — icra sətri də olmadığı
        // üçün istifadəçi "niyə?" sualının cavabını HEÇ YERDƏ tapa bilmirdi.
        setTaskStatus(
          this.db,
          row.id,
          'failed',
          'Valideyn taskın ümumi büdcəsi bitdi — bu parça başlamadı',
        )
        outcomes.push({
          taskId: row.id,
          index,
          prompt: row.prompt,
          status: 'budget_exceeded',
          finalRung: -1,
        })
        continue
      }

      const limits = capLimits(input.limits, ceiling.remaining())

      const result = await this.ladder.run({
        task: { id: row.id, prompt: row.prompt },
        context: { ...input.context, verifyCommandsJson: '[]' },
        ...(input.runner !== undefined && input.model !== undefined
          ? { runner: input.runner, model: input.model }
          : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
      })

      for (const run of listRunsForTask(this.db, row.id)) ceiling.charge(run)

      outcomes.push({
        taskId: row.id,
        index,
        prompt: row.prompt,
        status: result.status,
        finalRung: result.finalRung,
      })
    }

    return outcomes
  }

  /**
   * Yekun determinist yoxlama — bütün parçalar bitdikdən SONRA, BİR dəfə.
   *
   * Nəticə bölgü icrasına (`decomposeRunId`) yazılır: `verification_runs`
   * `runs`-a bağlıdır və bu yoxlama HƏR HANSI bir alt-taskın deyil, BÜTÖV taskın
   * yoxlamasıdır — onu alt-taskın icrasına yazsaydıq, həmin alt-task başqasının
   * səhvinə görə uğursuz görünərdi.
   *
   * SIFIR token: bu, pulsuz və ən güclü siqnaldır (Pillə 2-nin əsas fikri).
   */
  private async verifyOnce(
    input: DecomposeInput,
    worktree: Worktree | undefined,
    decomposeRunId: string | null,
  ): Promise<boolean | null> {
    const commands = this.parseVerifyCommands(input.context.verifyCommandsJson)
    if (commands.length === 0 || decomposeRunId === null) return null

    const verification = await runVerifications(commands, {
      cwd: worktree?.path ?? input.context.cwd ?? process.cwd(),
    })
    for (const r of verification.results) {
      appendVerification(this.db, decomposeRunId, {
        command: r.command,
        exitCode: r.exitCode,
        passed: r.passed,
        outputExcerpt: r.output,
        durationMs: r.durationMs,
      })
    }
    return verification.passed
  }

  /**
   * Valideyn taskın statusunu yazır.
   *
   * MƏCBURİDİR və `Ladder.settle` ilə eyni səbəbə görədir: `RunSupervisor` hər
   * icradan sonra statusu yazır, ona görə valideynin statusu bölgü icrasından
   * qalıb — halbuki taskın taleyini ALT-TASKLAR həll edir.
   */
  private settle(
    parentTaskId: string,
    outcomes: readonly SubtaskOutcome[],
    verification: boolean | null,
  ): LadderStatus {
    const allSucceeded =
      outcomes.length > 0 && outcomes.every((o) => o.status === 'succeeded')
    const status: LadderStatus = !allSucceeded
      ? 'failed'
      : verification === false
        ? 'verification_failed'
        : 'succeeded'

    // Səbəb MƏTNİ statusla birlikdə yazılır: `failed` tək başına "hansı parça,
    // niyə?" sualına cavab vermir və istifadəçi cavabı DB-də əl ilə axtarmalı
    // olurdu.
    const skipped = outcomes.filter((o) => o.status === 'budget_exceeded').length
    const failed = outcomes.filter(
      (o) => o.status !== 'succeeded' && o.status !== 'budget_exceeded',
    ).length
    const reason =
      status === 'succeeded'
        ? null
        : verification === false
          ? 'Yekun avtomatik yoxlama keçmədi'
          : skipped > 0
            ? `${outcomes.length} parçadan ${skipped}-i büdcə bitdiyi üçün başlamadı`
            : `${outcomes.length} parçadan ${failed}-i uğursuz oldu`

    setTaskStatus(
      this.db,
      parentTaskId,
      status === 'succeeded' ? 'succeeded' : 'failed',
      reason,
    )
    return status
  }

  /**
   * Valideyn task üçün ağac açır.
   *
   * Task tipi burada `classify.ts` ilə hesablanır (0 token): valideyn taskın
   * ÖZÜ heç bir işçiyə getmir, yəni routing-in təsnifatı yoxdur. `fileAccess`
   * `true` sayılır, çünki alt-taskların runner-i hələ seçilməyib — ən pis halda
   * heç nə yazılmır və boş ağac sonda silinir (`finalizeWorktree`).
   */
  private async openWorktree(input: DecomposeInput): Promise<Worktree | undefined> {
    const cwd = input.context.cwd
    if (this.worktrees === undefined || cwd === null) return undefined
    const taskType = classifyTask({ prompt: input.task.prompt, cwd }).taskType
    const isolate = shouldIsolate({
      maxParallel: input.context.maxParallel ?? 0,
      taskType,
      cwd,
      fileAccess: true,
    })
    if (!isolate) return undefined
    return (await this.worktrees.create({ repo: cwd, taskId: input.task.id })) ?? undefined
  }

  private answerOf(runId: string): string {
    return collectAnswerText(listEvents(this.db, runId).map((s) => s.event))
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
}
