import type { Db } from '../db/client.js'
import { getContext } from '../db/repo.js'
import { getSavings } from '../db/savings-repo.js'
import {
  addScheduleSpend,
  disableSchedule,
  dueSchedules,
  getWorkflow,
  listStepRuns,
  markScheduleRun,
  parseSteps,
  type ScheduleRow,
} from '../db/workflow-repo.js'
import type { WorkflowEngine } from './workflow-engine.js'

/**
 * Cədvəl üzrə icra (Faza 4).
 *
 * BU MODULUN BÜTÜN DİZAYNI BİR CÜMLƏDƏN DOĞUR (issue #12): *"nəzarətsiz cədvəl
 * `$0.50 testdə → $50,000/ay` ssenarisinin ən asan yoludur"*. Ona görə burada
 * hər qərar "necə DAYANDIRAQ?" sualına cavabdır, "necə İŞLƏDƏK?" sualına yox.
 *
 * DÖRD TAVAN, HƏR BİRİ AYRI SIZMA YOLUNU BAĞLAYIR:
 *
 * 1. **`budget_usd_per_run`** → hər icraya `limits.maxCostUsd` kimi ötürülür.
 *    Bir uzun zəncirin qaçmasını `BudgetGuard` kəsir.
 * 2. **`budget_usd_total`** → ölçülmüş REAL xərc yığılır; tavan aşılanda cədvəl
 *    SÖNDÜRÜLÜR. Tək bu olsaydı belə kifayət etməzdi (bax 3).
 * 3. **`max_runs`** → abunəlik icralarında real xərc `0`-dır, yəni USD tavanı
 *    HEÇ VAXT işə düşməzdi və cədvəl sonsuz qaçardı, abunəlik limitini yandıraraq.
 * 4. **Naməlum xərc → SÖNDÜR.** Qayda 4 deyir ki, naməlum `0` deyil. Adi taskda
 *    bu, sadəcə ölçmənin boşluğudur; AVTOMATİK icrada isə "nə qədər xərclədiyimi
 *    bilmirəm, amma davam edirəm" deməkdir — yəni tavanın kor olması. Fail-closed
 *    seçilir (eyni prinsip: qayda 50).
 *
 * ÖLÇÜLMÜŞ İNCƏLİK — KEŞ USD TAVANINI DAYANDIRIR: cədvəlin addım mətnləri
 * tərifdə SABİTDİR, yəni hər icra eyni keş açarını verir (Pillə 0). İkinci
 * icradan sonra xərc praktiki olaraq `0`-a düşür və `budget_usd_total` bir daha
 * ARTMIR. Bu, qənaət baxımından yaxşıdır, amma tavan baxımından təhlükəlidir:
 * USD tək başına cədvəli heç vaxt dayandırmaya bilər. `max_runs` məhz buna görə
 * ayrıca və MƏCBURİ tavandır (bax `scheduler.test.ts`).
 *
 * ZAMAN İDARƏSİ ÇAĞIRANDADIR: sinif `setInterval` QURMUR, yalnız `tick(now)`
 * təqdim edir. Səbəb testlərdir — taymer qursaydıq, cədvəl məntiqini yoxlamaq
 * üçün real vaxt gözləmək lazım gələrdi və testlər ya yavaş, ya flaky olardı.
 * Taymer yalnız `main.ts`-dədir.
 */

/** İki tik arasındakı standart interval (ms) — `main.ts` bunu işlədir. */
export const SCHEDULER_TICK_MS = 30_000

export interface TickResult {
  /** Başladılan icraların `workflow_runs.id`-ləri. */
  started: string[]
  /** Söndürülən cədvəllər və səbəbi. */
  disabled: { scheduleId: string; reason: string }[]
}

export class Scheduler {
  constructor(
    private readonly db: Db,
    private readonly engine: WorkflowEngine,
  ) {}

  /**
   * Vaxtı çatmış cədvəlləri qaçırır.
   *
   * İCRA ARDICILDIR (`for await`): cədvəllər paralel başlasaydı, `max_parallel`
   * hovuzu onsuz da onları növbəyə düzərdi, amma büdcə hesabı YARIŞA düşərdi —
   * iki icra eyni anda "tavan hələ aşılmayıb" görüb ikisi də başlayardı.
   *
   * `now` PARAMETRDİR, `Date.now()` deyil: testlər saatı irəli sürərək aylıq
   * davranışı saniyələrdə yoxlaya bilir.
   */
  async tick(now: number = Date.now()): Promise<TickResult> {
    const result: TickResult = { started: [], disabled: [] }

    for (const schedule of dueSchedules(this.db, now)) {
      const stopped = this.enforceLimits(schedule)
      if (stopped !== null) {
        disableSchedule(this.db, schedule.id, stopped)
        result.disabled.push({ scheduleId: schedule.id, reason: stopped })
        continue
      }

      const started = await this.runOnce(schedule, now)
      if (started.error !== undefined) {
        // Zəncir tapılmadı / tərif oxunmadı / kontekst silindi — cədvəl
        // SÖNDÜRÜLÜR. Hər tikdə eyni səhvi təkrarlamaq jurnalı zibilləyər və
        // problemi gizlədərdi.
        disableSchedule(this.db, schedule.id, started.error)
        result.disabled.push({ scheduleId: schedule.id, reason: started.error })
        continue
      }
      if (started.workflowRunId !== undefined) result.started.push(started.workflowRunId)
    }

    return result
  }

  /**
   * Tavanlar aşılıbmı — icradan ƏVVƏL yoxlanılır.
   *
   * `>=` işlədilir, `>` yox: `maxRuns = 10` "on icra" deməkdir, on birinci
   * başlamamalıdır. `>` yazsaydıq hər tavan bir vahid sızardı.
   */
  private enforceLimits(schedule: ScheduleRow): string | null {
    if (schedule.runs >= schedule.maxRuns) {
      return `icra sayı həddi doldu (${schedule.maxRuns})`
    }
    if (schedule.spentUsd >= schedule.budgetUsdTotal) {
      return `ümumi büdcə doldu ($${schedule.budgetUsdTotal})`
    }
    return null
  }

  private async runOnce(
    schedule: ScheduleRow,
    now: number,
  ): Promise<{ workflowRunId?: string; error?: string }> {
    const workflow = getWorkflow(this.db, schedule.workflowId)
    if (workflow === undefined) return { error: 'zəncir tapılmadı' }
    if (workflow.archivedAt !== null) return { error: 'zəncir arxivləşdirilib' }

    const steps = parseSteps(workflow)
    if (steps === null) return { error: 'zəncir tərifi oxunmadı' }

    const ctx = getContext(this.db, workflow.contextId)
    if (ctx === undefined) return { error: 'kontekst tapılmadı' }

    // Növbəti vaxt İCRADAN ƏVVƏL yazılır: icra `intervalSeconds`-dən uzun
    // çəkərsə, sonra yazsaydıq hər tik yeni icra başladardı və onlar üst-üstə
    // yığılardı. `runs` sayğacı da burada artır — icra sınsa belə, o, cəhd
    // edilib və tavana daxildir.
    markScheduleRun(this.db, schedule.id, {
      nextRunAt: now + schedule.intervalSeconds * 1000,
      lastRunAt: now,
    })

    const { workflowRunId, done } = this.engine.start({
      workflowId: workflow.id,
      steps,
      trigger: 'schedule',
      context: {
        id: ctx.id,
        cwd: ctx.cwd,
        verifyCommandsJson: ctx.verifyCommandsJson,
        amplificationProfile: ctx.amplificationProfile,
        defaultWorkerModelId: ctx.defaultWorkerModelId,
        maxParallel: ctx.maxParallel,
        memoryScope: ctx.memoryScope,
        memoryEnabled: ctx.memoryEnabled,
      },
      // Sərt limit HƏR icraya ötürülür — `BudgetGuard` onu icra ANINDA tətbiq
      // edir. Yalnız sonradan hesablasaydıq, tavanı aşan icra ARTIQ ödənilmiş
      // olardı.
      limits: { maxCostUsd: schedule.budgetUsdPerRun },
    })

    // İcranın BİTMƏSİNİ gözləyirik: xərci ölçmədən növbəti tikə keçsək, tavan
    // hər dəfə köhnə rəqəmə baxar və `budget_usd_total` praktiki olaraq
    // söndürülmüş olardı.
    await done
    this.settleCost(schedule.id, workflowRunId)

    return { workflowRunId }
  }

  /**
   * İcranın REAL xərcini cədvələ yazır.
   *
   * Mənbə `savings_ledger`-dir, çünki qənaət hesabı ilə EYNİ rəqəm işlədilməlidir
   * — iki fərqli hesablama olsaydı, UI-dakı "xərclənib" və "qənaət" rəqəmləri
   * bir-birini təkzib edərdi.
   *
   * Naməlum xərc (`null`) cədvəli SÖNDÜRÜR: avtomatik icrada "bilmirəm" tavanın
   * kor olması deməkdir.
   */
  private settleCost(scheduleId: string, workflowRunId: string): void {
    let total = 0
    for (const step of listStepRuns(this.db, workflowRunId)) {
      if (step.taskId === null) continue
      const ledger = getSavings(this.db, step.taskId)
      // Ledger sətri YOXDURSA icra ümumiyyətlə baş verməyib (qayda 24) — bu,
      // naməlum xərc deyil, sıfırdır.
      if (ledger === undefined) continue
      if (ledger.actualCostUsd === null) {
        disableSchedule(
          this.db,
          scheduleId,
          'icranın real xərci bilinmir — avtomatik icra kor gedə bilməz',
        )
        return
      }
      total += ledger.actualCostUsd
    }
    addScheduleSpend(this.db, scheduleId, total)
  }
}
