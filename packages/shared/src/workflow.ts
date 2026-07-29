import { z } from 'zod'

/**
 * Workflow zəncirləri (Faza 4) — bir taskın nəticəsi digərinin girişi olur.
 *
 * Sxem PAYLAŞILAN paketdədir, çünki eyni tərif üç yerdə oxunur: server onu icra
 * edir, REST qatı onu validasiya edir, UI isə redaktoru onun üzərində qurur.
 * Üç yerdə təkrar yazsaydıq, biri dəyişəndə digərləri səssizcə köhnələrdi və
 * səhv yalnız icra vaxtı görünərdi.
 *
 * BÜTÜN ZƏNCİR MƏNTİQİ **SIFIR TOKEN** XƏRCLƏYİR: şərtlər determinist
 * predikatlardır, dəyişən əvəzlənməsi isə sadə mətn əməliyyatıdır. Şərtləri
 * modelə verib "bu cavab yaxşıdırmı?" soruşmaq ən asan yol olardı, amma o,
 * hər addımda əlavə icra ödəyərdi — layihənin bütün məqsədinin əksi (eyni
 * fəlsəfə: Pillə 2, determinist yoxlama).
 */

/** Bir zəncirdə ən çox addım — tərifin özü xərci məhdudlaşdırır. */
export const MAX_WORKFLOW_STEPS = 20

/**
 * Bir addımın ən çox təkrarı (`repeat.max`).
 *
 * Hər təkrar YENİ task deməkdir, yəni real pul. Limitsiz təkrar "şərt heç vaxt
 * ödənmir" halında sonsuz dövrə yaradardı — cədvəl üzrə icra ilə birləşəndə bu,
 * issue #12-dəki "$0.50 testdə → $50,000/ay" ssenarisinin ən qısa yoludur.
 */
export const MAX_STEP_REPEATS = 5

/** Bir icrada ən çox addım icrası (təkrarlar daxil) — zəncirin sərt tavanı. */
export const MAX_WORKFLOW_EXECUTIONS = 40

/** Addımın saxlanılan çıxışının limiti (simvol). */
export const STEP_OUTPUT_CHAR_LIMIT = 8000

/**
 * Şərtin baxdığı mənbə: `previous` = son İCRA OLUNMUŞ addım, və ya addım `id`-si.
 *
 * "Son icra olunmuş" QƏSDƏNDİR: `when` şərti ödənməyən addım ATLANIR və zəncir
 * üçün ŞƏFFAF olur. Əks halda budaqlanma özünü sındırardı — atlanan addımdan
 * sonrakı hər addım boş nəticə görərdi.
 */
export const StepConditionSource = z.string().min(1).max(64)

/**
 * Determinist şərt — **sıfır token**.
 *
 * `matches` (regex) QƏSDƏN YOXDUR. İstifadəçidən gələn regex katastrofik geri
 * izləmə (ReDoS) ilə serveri dondura bilər, halbuki zəncir budaqlanmasının real
 * ehtiyacları status yoxlaması və mətn axtarışıdır. Lazım olsa regex sonra,
 * timeout-lu icra ilə əlavə edilə bilər — indi əlavə etmək ölçülməmiş fayda
 * üçün ölçülə bilən risk almaq olardı.
 */
export const StepCondition = z.object({
  from: StepConditionSource.default('previous'),
  test: z.enum(['succeeded', 'failed', 'contains', 'empty']),
  /** `contains` üçün axtarılan mətn (hərf böyüklüyünə həssas DEYİL). */
  value: z.string().min(1).max(500).optional(),
  /** Şərti tərsinə çevirir. */
  negate: z.boolean().optional(),
})
export type StepCondition = z.infer<typeof StepCondition>

const StepBase = {
  /** Zəncir daxilində unikal — `{{step:<id>}}` və şərtlər ona istinad edir. */
  id: z.string().min(1).max(64),
  /** Şərt ödənməsə addım ATLANIR (zəncir dayanmır). */
  when: StepCondition.optional(),
  /**
   * Bu addım SINSA zəncir davam etsin.
   *
   * Default `false` — yəni sınıq zəncir DAYANIR. Əks default (həmişə davam)
   * sınmış birinci addımdan sonra qalan bütün addımların pulunu yandırardı,
   * özü də zibil giriş üzərində.
   *
   * `true` isə `test: 'failed'` şərtini işlək edir: "sındısa təmir addımını
   * qaçır" budağı yalnız zəncir sağ qaldıqda mümkündür. Ona görə davranış
   * MAGİYA ilə təxmin edilmir (məs. "sonrakı addımda `failed` şərti varmı?"),
   * istifadəçinin AÇIQ qərarı olur.
   */
  continueOnError: z.boolean().optional(),
}

/**
 * Model taskı addımı — real `tasks` sətri yaradılır və TAM nərdivandan keçir.
 *
 * Yəni keş, qayda routing, alət yoxlaması, best-of-N və eskalasiya addım
 * səviyyəsində normal işləyir. Zəncir nərdivana TOXUNMUR, onun üstündə oturur.
 */
export const TaskStep = z.object({
  ...StepBase,
  kind: z.literal('task'),
  /**
   * Task mətni. `{{previous}}` və `{{step:<id>}}` dəyişənləri əvəzlənir —
   * **sıfır token**, sadə mətn əməliyyatı.
   */
  prompt: z.string().min(1).max(20_000),
  /** Bu addımda task dekompozisiyası açılsın (qayda 52). */
  decompose: z.boolean().optional(),
  /**
   * Təkrar: `until` şərti ödənənə qədər addımı yenidən qaçır.
   *
   * Hər təkrar YENİ task, yəni yeni xərcdir — ona görə `max` MƏCBURİDİR və
   * `MAX_STEP_REPEATS` ilə tavanlanır.
   */
  repeat: z
    .object({
      max: z.number().int().min(1).max(MAX_STEP_REPEATS),
      until: StepCondition,
    })
    .optional(),
})
export type TaskStep = z.infer<typeof TaskStep>

/**
 * Xarici API çağırışı addımı.
 *
 * ÜÇ MƏHDUDİYYƏT VƏ HƏR BİRİNİN SƏBƏBİ:
 *
 * 1. **URL-də dəyişən əvəzlənmir.** Şablon yalnız `body`-dədir. URL-ə model
 *    çıxışını yapışdırmaq ona ünvanı seçdirmək olardı — yəni zəif modelin
 *    (və ya onun oxuduğu ETİBARSIZ mətnin, qayda 45) sorğunu istənilən yerə
 *    yönləndirməsi. Host onsuz da ağ siyahıdadır, amma yol və sorğu
 *    parametrləri də hücum səthidir.
 * 2. **Host AĞ SİYAHIDADIR** (`ORCHESTRIS_WORKFLOW_HTTP_ALLOW`) və siyahı boşdursa
 *    addım İCRA OLUNMUR (fail-closed, qayda 50 ilə eyni prinsip). Zəncir taskın
 *    nəticəsini XARİCƏ göndərir — bu, istifadəçinin açıq qərarı olmalıdır.
 * 3. **Başlıq yazmaq olmur.** `Authorization` başlığı yazmaq imkanı verilsəydi,
 *    istifadəçi açarını zəncir tərifinə (yəni SQLite-a, sonra UI-a) yazardı —
 *    məhz qayda 13-ün qadağan etdiyi şey.
 */
export const HttpStep = z.object({
  ...StepBase,
  kind: z.literal('http'),
  method: z.enum(['GET', 'POST']),
  /** Yalnız `http(s)://`. Şablon dəyişənləri BURADA əvəzlənmir. */
  url: z.string().url().max(2000),
  /** `{{previous}}` / `{{step:<id>}}` əvəzlənir. */
  body: z.string().max(20_000).optional(),
})
export type HttpStep = z.infer<typeof HttpStep>

export const WorkflowStep = z.discriminatedUnion('kind', [TaskStep, HttpStep])
export type WorkflowStep = z.infer<typeof WorkflowStep>

/**
 * Addım siyahısı — id-lər UNİKAL olmalıdır.
 *
 * Təkrarlanan id səssiz səhv olardı: `{{step:x}}` və şərtlər HANSI `x`-ə
 * baxdığını bilməzdi və zəncir hər icrada fərqli davrana bilərdi.
 */
export const WorkflowSteps = z
  .array(WorkflowStep)
  .min(1)
  .max(MAX_WORKFLOW_STEPS)
  .superRefine((steps, ctx) => {
    const seen = new Set<string>()
    for (const [i, step] of steps.entries()) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'id'],
          message: `Addım id-si təkrarlanır: ${step.id}`,
        })
      }
      seen.add(step.id)
    }
  })
export type WorkflowSteps = z.infer<typeof WorkflowSteps>

export const CreateWorkflowBody = z.object({
  contextId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  steps: WorkflowSteps,
})
export type CreateWorkflowBody = z.infer<typeof CreateWorkflowBody>

/** Qismən yeniləmə — verilməyən sahə DƏYİŞMİR. */
export const UpdateWorkflowBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  steps: WorkflowSteps.optional(),
  /** Arxivləşdirmə — zəncir SİLİNMİR, çünki icra tarixçəsi ona bağlıdır. */
  archived: z.boolean().optional(),
})
export type UpdateWorkflowBody = z.infer<typeof UpdateWorkflowBody>

/** Zəncirin bir icrasını əl ilə başladır. */
export const RunWorkflowBody = z.object({
  /**
   * Birinci addımın `{{previous}}` dəyişəninin başlanğıc dəyəri.
   *
   * Olmasa boş sətirdir — yəni zəncir öz-özünə tam olmalıdır. Bu sahə "eyni
   * zənciri fərqli girişlə qaçır" halı üçündür.
   */
  input: z.string().max(20_000).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
})
export type RunWorkflowBody = z.infer<typeof RunWorkflowBody>

/**
 * Cədvəl üzrə icranın ƏN QISA intervalı.
 *
 * Döşəmə LAZIMDIR: "hər saniyə" cədvəli maşını dondurmaqla yanaşı, hər tikdə
 * yeni zəncir başladardı. Bir dəqiqə avtomatik icra üçün onsuz da sıxdır — bir
 * zəncir adətən ondan uzun çəkir.
 */
export const MIN_SCHEDULE_INTERVAL_SECONDS = 60

/**
 * Baxılmamış diff tavanının DB defaultu (issue #38).
 *
 * NİYƏ ÜMUMİYYƏTLƏ DEFAULT VAR — halbuki qalan üç tavanda yoxdur: bu sütun
 * MÖVCUD cədvələ sonradan əlavə olunur və SQLite `ALTER TABLE … ADD COLUMN …
 * NOT NULL` əmrini DEFAULT olmadan ÜMUMİYYƏTLƏ qəbul etmir (sətir sayından
 * asılı olmayaraq). Yəni seçim "default var" ilə "sütun `NULL` ola bilər"
 * arasındadır — ikincisi isə məhz issue #12-nin qadağan etdiyi haldır
 * ("sonra doldurram" = limitsiz avtomatik icra).
 *
 * Rəqəm KİÇİK seçilib və bu, qəsdəndir. Səhvin iki istiqaməti eyni qiymətə
 * başa gəlmir:
 *  - **çox kiçik** → cədvəl vaxtından tez söndürülür; istifadəçi diff-lərə
 *    baxıb bir kliklə yenidən açır (`disabledReason` səbəbi göstərir)
 *  - **çox böyük** → hər baxılmamış diff reponun AYRICA nüsxəsidir və yetim
 *    təmizləyicisi ona QƏSDƏN toxunmur (qayda 44) — yəni disk heç nə ilə geri
 *    qaytarılmır
 *
 * Ucuz istiqamət birincidir (eyni mühakimə: qayda 46-dakı simvol→token nisbəti).
 * "Doğru" rəqəm real işlətmə ilə ölçülməlidir — ona görə sahə API-də
 * MƏCBURİDİR: default yalnız sxem miqrasiyasının tələbidir, istifadəçinin
 * seçimi deyil.
 */
export const DEFAULT_MAX_PENDING_DIFFS = 5

/**
 * Cədvəl tərifi — **hər dörd limit MƏCBURİDİR**.
 *
 * Issue #12-dəki xəbərdarlıq bu sxemin bütün formasını təyin edir: *"nəzarətsiz
 * cədvəl `$0.50 testdə → $50,000/ay` ssenarisinin ən asan yoludur"*. Ona görə
 * limitlər opsional DEYİL — biri unudulsa, məhz o istiqamətdən sızardı:
 *
 * | Limit | Nəyin qarşısını alır |
 * |---|---|
 * | `budgetUsdPerRun`  | bir icranın qaçması (uzun zəncir, təkrar dövrəsi) |
 * | `budgetUsdTotal`   | ÇOX icranın YIĞILMASI — dəqiqədə $0.50 aylıq $21,600-dür |
 * | `maxRuns`          | abunəlik icraları: real xərc `0`-dır, USD tavanı ONLARI TUTMUR |
 * | `maxPendingDiffs`  | DİSK: hər baxılmamış diff reponun ayrıca nüsxəsidir |
 *
 * `maxRuns` olmasaydı, CLI (abunəlik) işçisi ilə qurulan cədvəl SONSUZ qaçardı:
 * kartdan pul çıxmır, amma abunəlik limiti yanır və istifadəçi bunu yalnız
 * "rate limit" xətası ilə bilərdi.
 *
 * `maxPendingDiffs` (issue #38) FƏRQLİ resursu qoruyur: üç USD/sayğac tavanı
 * XƏRC üçün seçilir və `maxRuns: 500` tam qanunidir — amma repoya yazan zənciri
 * cədvəllə qaçıranda hər icra YENİ `pending` diff, yəni reponun yeni nüsxəsini
 * yaradır. Xərc tavanları buna kordur.
 */
export const CreateScheduleBody = z.object({
  workflowId: z.string().min(1),
  intervalSeconds: z.number().int().min(MIN_SCHEDULE_INTERVAL_SECONDS),
  /** İlk icranın vaxtı (unix ms). Verilməsə indidən bir interval sonra. */
  startAt: z.number().int().positive().optional(),
  budgetUsdPerRun: z.number().positive(),
  budgetUsdTotal: z.number().positive(),
  maxRuns: z.number().int().positive(),
  /** Cədvəlin yığa biləcəyi ən çox baxılmamış diff sayı (issue #38). */
  maxPendingDiffs: z.number().int().positive(),
})
export type CreateScheduleBody = z.infer<typeof CreateScheduleBody>

export const UpdateScheduleBody = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(MIN_SCHEDULE_INTERVAL_SECONDS).optional(),
  budgetUsdPerRun: z.number().positive().optional(),
  budgetUsdTotal: z.number().positive().optional(),
  maxRuns: z.number().int().positive().optional(),
  maxPendingDiffs: z.number().int().positive().optional(),
})
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBody>

export const WORKFLOW_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'budget_exceeded',
] as const

export const WORKFLOW_STEP_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'skipped',
  'budget_exceeded',
] as const
