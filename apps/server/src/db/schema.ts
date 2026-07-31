import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** İş sahəsi — istifadəçinin "yeni kontekst başlat" dediyi şey. */
export const contexts = sqliteTable('contexts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cwd: text('cwd'),
  amplificationProfile: text('amplification_profile').notNull().default('balanced'),
  workerMode: text('worker_mode').notNull().default('auto'),
  autoSubmode: text('auto_submode').notNull().default('cheap'),
  defaultWorkerModelId: text('default_worker_model_id'),
  /** JSON massiv: yoxlama əmrləri, məs. ["pnpm typecheck","pnpm test"] */
  verifyCommandsJson: text('verify_commands_json').notNull().default('[]'),
  budgetTokens: integer('budget_tokens'),
  budgetUsd: real('budget_usd'),
  budgetSeconds: integer('budget_seconds'),
  /**
   * Bu kontekstdə eyni anda neçə task icra oluna bilər.
   *
   * `0` = **avtomatik** (`resolveMaxParallel` → `min(4, nüvə-2)`). Sabit rəqəm
   * default ola bilməz, çünki cavab maşından asılıdır; `1` yazsaydıq isə
   * paralellik heç vaxt öz-özünə işə düşməzdi.
   */
  maxParallel: integer('max_parallel').notNull().default(0),
  /**
   * Yaddaşın adlandırılmış sahəsi (Faza 3).
   *
   * NULL = **avtomatik**: kontekstin öz `id`-si işlədilir. Sabit default
   * (məs. `'default'`) qoysaydıq, iki fərqli layihənin yaddaşı bir yerə
   * qarışardı — "React komponenti belə yazılır" qeydi Python repo-suna
   * yapışardı. Ayrıca ad isə istifadəçiyə İKİ kontekstin yaddaşını QƏSDƏN
   * paylaşmaq imkanı verir (məs. eyni repo üzərində iki iş sahəsi).
   */
  memoryScope: text('memory_scope'),
  /**
   * Bu kontekstdə yaddaş işə düşürmü.
   *
   * Provayder SERVER səviyyəsindədir (env ilə), bu bayraq isə kontekst
   * səviyyəsində opt-out-dur: istifadəçi yaddaşı ümumiyyətlə söndürmədən
   * konkret iş sahəsində (məs. gizli repo) onu kənarda saxlaya bilməlidir.
   */
  memoryEnabled: integer('memory_enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * Bu kontekstdə agentin fayl sisteminə icazəsi (Faza 5A).
   *
   * `'read-only'` | `'workspace'` | `'extended'`
   *
   * Default `'workspace'`-dir, `'read-only'` DEYİL — və bu, qayda 43-ün ƏKS
   * istiqamətidir. Orada köhnə `max_parallel = 1` istifadəçinin seçimi deyildi
   * (dəyişdirmək üçün API ümumiyyətlə yox idi), ona görə `0`-a çevrildi.
   * Burada isə `acceptEdits` FAKTİKİ davranışdır: istifadəçi ona güvənərək
   * task göndərib. Miqrasiyada `'read-only'` yazsaydıq, işləyən qurulum bir
   * gecədə səssizcə yazmağı dayandırardı və səbəbi heç yerdə görünməzdi.
   * Seçilməmiş default-u dəyişmək olar; işləyən davranışı yox.
   */
  fileAccess: text('file_access').notNull().default('workspace'),
  /**
   * `'extended'` səviyyəsində icazəli ƏLAVƏ qovluqların JSON massivi.
   *
   * Ayrıca cədvəl DEYİL: siyahı yalnız bütöv oxunur (icra anında `--add-dir`
   * arqumentlərinə çevrilir), üzərində sorğu, filtr və ya birləşdirmə yoxdur —
   * `verify_commands_json` ilə eyni formadır.
   */
  extraDirsJson: text('extra_dirs_json').notNull().default('[]'),
  /**
   * İşçi bu kontekstdə İSTİFADƏÇİYƏ sual verə bilirmi (Faza 5B).
   *
   * Default AÇIQ: müqavilə bağlı olduqca mexanizm heç vaxt özünü göstərməz və
   * istifadəçi onun mövcud olduğunu bilməz. Qiyməti ~40 tokendir — eskalasiya
   * müqaviləsi ilə eyni ölçüdə.
   *
   * Bayraq AÇIQ olsa belə CƏDVƏL və ZƏNCİR icralarında suallar SÖNDÜRÜLÜR:
   * orada cavab verəcək insan yoxdur və task əbədi gözləyərdi
   * (`LadderInput.interactive`).
   */
  questionsEnabled: integer('questions_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  /**
   * Claude Code-un DAXİLİ 16 skill-i bu kontekstdə açılsınmı (Faza 5C).
   *
   * Default SÖNÜLÜDÜR — `file_access`-dən (qayda 65) FƏRQLİ olaraq. Orada
   * `acceptEdits` FAKTİKİ mövcud davranış idi; burada isə daxili skill-lər heç
   * vaxt açıq olmayıb və default açsaydıq HƏR mövcud kontekst bir dəfə
   * ÖLÇÜLMÜŞ +3,648 token ödəyərdi.
   *
   * Bu, hamısı-birdən bayraqdır (`--disable-slash-commands`-ın çıxarılması) —
   * CLI-də ədəd-ədəd söndürmə YOXDUR. Fərdi skill-lər `plugin_sources` ilə
   * gəlir.
   */
  builtinSkillsEnabled: integer('builtin_skills_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
})

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    parentTaskId: text('parent_task_id'),
    /**
     * Dekompozisiyada (Faza 4) alt-taskın SIRA nömrəsi, 0-dan başlayır.
     * Valideyn tasklarda NULL.
     *
     * NİYƏ `created_at` KİFAYƏT ETMİR: alt-tasklar bir dövrədə, eyni
     * millisaniyədə yaradılır — vaxta görə sıralama onları təsadüfi qaydada
     * qaytarardı. Halbuki bölgünün müqaviləsi məhz SIRADIR: "sonrakı alt-task
     * əvvəlkinin nəticəsi üzərində işləyir". Sıra itsə, icra da, UI-dakı ağac
     * da yanlış olardı.
     */
    subtaskIndex: integer('subtask_index'),
    prompt: text('prompt').notNull(),
    taskType: text('task_type').notNull().default('unknown'),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    index('tasks_context_idx').on(t.contextId, t.createdAt),
    // Alt-task ağacı hər task səhifəsində oxunur — indekssiz bu, tam cədvəl
    // taraması olardı.
    index('tasks_parent_idx').on(t.parentTaskId, t.subtaskIndex),
  ],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runnerId: text('runner_id').notNull(),
    modelId: text('model_id').notNull(),
    ladderRung: integer('ladder_rung').notNull().default(7),
    /**
     * Yoxlama dövrəsində neçənci cəhddir. 1-dən başlayır. Eyni task üçün
     * bir neçə run olur: hər uğursuz yoxlamadan sonra yenisi yaradılır.
     * `escalatedFromRunId` bundan FƏRQLİDİR — o, pillələr arası keçid üçündür.
     */
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull().default('running'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    /** NULL = xərc BİLİNMİR (codex xərc bildirmir). 0 = həqiqətən pulsuz. */
    costUsd: real('cost_usd'),
    /** true → abunəlikdən getdi, real pul çıxmadı */
    subscriptionBilled: integer('subscription_billed', { mode: 'boolean' })
      .notNull()
      .default(false),
    cachedHit: integer('cached_hit', { mode: 'boolean' }).notNull().default(false),
    escalatedFromRunId: text('escalated_from_run_id'),
    sessionId: text('session_id'),
    worktreePath: text('worktree_path'),
    /**
     * Bu icranın cavabı hansı keş açarı altında saxlanıldı (Faza 5B).
     *
     * NİYƏ LAZIMDIR: review yazılanda həmin keş sətri SİLİNMƏLİDİR —
     * istifadəçi rəy yazırsa, deməli cavab səhv idi, amma o cavab Pillə 0
     * keşinə ARTIQ düşüb və eyni prompt bir daha göndəriləndə qaytarılardı.
     *
     * Açarı route-da yenidən hesablamaq OLMAZ: o, model, runner, şablon və
     * yaddaş digest-indən asılıdır (`cache-key.ts`) və hesablamanı iki yerdə
     * təkrarlamaq səssiz uyğunsuzluq mənbəyidir. Sütun `tasks`-da deyil
     * `runs`-dadır, çünki bir taskda bir neçə icra olur (yoxlama dövrəsi,
     * best-of-N) və keşə hansının düşdüyü məhz İCRA faktıdır.
     */
    cacheKey: text('cache_key'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
  },
  (t) => [index('runs_task_idx').on(t.taskId, t.startedAt)],
)

/** Append-only hadisə jurnalı — "modellərin gördüyü işi görə bilək" budur. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('run_events_seq_idx').on(t.runId, t.seq)],
)

/**
 * Pillə 0 — hazır nəticə keşi.
 *
 * `hash` açarı `cache-key.ts`-də hesablanır və iş qovluğunun git vəziyyətini
 * də əhatə edir: eyni prompt fərqli kod üzərində fərqli cavab tələb edir.
 */
export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    hash: text('hash').primaryKey(),
    modelId: text('model_id').notNull(),
    runnerId: text('runner_id').notNull(),
    /** Saxlanılan `RunEvent[]` — JSON massiv. */
    eventsJson: text('events_json').notNull(),
    hits: integer('hits').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    lastHitAt: integer('last_hit_at'),
  },
  (t) => [index('cache_model_idx').on(t.modelId)],
)

/**
 * Pillə 1 — hər routing qərarı və onun ÖZ XƏRCİ.
 *
 * `decision_tokens` / `decision_cost_usd` qəsdən burada saxlanılır: orkestrasiya
 * qərarının xərci sayılmasa, "qənaət" rəqəmi uydurma olar (issue #8). Qayda
 * routing-i 0 token xərcləyir və bunu SÜBUT etmək üçün də sütun lazımdır.
 */
export const routingDecisions = sqliteTable(
  'routing_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** `manual` | `rule` | `classifier` | `default` | `fallback` */
    strategy: text('strategy').notNull(),
    /** `models.id`. NULL = seçilən model cədvəldə qeydiyyatda deyil (əl ilə seçim). */
    chosenModelId: text('chosen_model_id'),
    runnerId: text('runner_id').notNull(),
    /** Runner-ə ötürülən model adı. */
    modelId: text('model_id').notNull(),
    confidence: real('confidence').notNull(),
    decisionTokens: integer('decision_tokens').notNull().default(0),
    /** NULL = qərarın xərci BİLİNMİR. 0 = həqiqətən pulsuz (qayda routing). */
    decisionCostUsd: real('decision_cost_usd'),
    /** Hansı qayda işə düşdü — UI-da göstərilir. */
    ruleId: text('rule_id'),
    reason: text('reason').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('routing_task_idx').on(t.taskId, t.at)],
)

/** Pillə 2 — hər determinist yoxlama əmrinin nəticəsi. */
export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    exitCode: integer('exit_code'),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    /** Çıxışın ilk hissəsi — modelə geri ötürülən budur. */
    outputExcerpt: text('output_excerpt').notNull(),
    durationMs: integer('duration_ms').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('verification_run_idx').on(t.runId)],
)

/**
 * API provayderləri (anthropic, openai, google). CLI runner-lər burada YOX —
 * onlar PATH-dan dinamik aşkarlanır və açar tələb etmir.
 *
 * `credentialRef` OS açar anbarındakı qeydin ADIDIR. Açarın ÖZÜ nə bu
 * cədvələ, nə də hər hansı fayla yazılır (CLAUDE.md qayda 13).
 */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  /**
   * `api` — açar tələb edən provayder (`anthropic`, `openai`, `google`).
   * `cli` — lokal CLI runner (`cli:claude`, `cli:codex`). Onun `id`-si eyni
   * zamanda runner id-sidir və açarı yoxdur (abunəlikdən işləyir).
   *
   * CLI-lar da cədvəldə saxlanılır ki, Auto rejimi onların modellərini
   * NAMİZƏD kimi görə bilsin: routing-in əsas qaydası ("fayl işi → CLI")
   * onsuz işləməzdi.
   */
  kind: text('kind').notNull().default('api'),
  /** models.dev-dən gələn insan üçün ad. */
  displayName: text('display_name').notNull(),
  /**
   * OpenAI-uyğun provayderin kök ünvanı (issue #44). NULL = öz SDK-sı var
   * (`anthropic`, `openai`, `google`) və ya CLI-dır.
   *
   * NİYƏ SAXLANILIR, HƏR DƏFƏ KATALOQDAN OXUNMUR: models.dev bizim
   * nəzarətimizdə deyil. Provayder oradan silinsə və ya ünvanı dəyişsə,
   * istifadəçinin İŞLƏYƏN quraşdırması bir gecədə sınardı — halbuki açar hələ
   * də həmin ünvana aiddir. Kataloq ilk əlavə anında OXUNUR, sonra sətir
   * müstəqil yaşayır.
   */
  baseUrl: text('base_url'),
  /** OS keychain qeydinin adı. NULL = açar təyin olunmayıb. */
  credentialRef: text('credential_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Son uğurlu model kəşfi (unix ms). NULL = heç vaxt kəşf edilməyib. */
  lastDiscoveryAt: integer('last_discovery_at'),
  /** Son kəşf cəhdinin xəta mətni — açar KƏSİLMİŞ halda saxlanılır. */
  lastDiscoveryError: text('last_discovery_error'),
  createdAt: integer('created_at').notNull(),
})

/**
 * Kəşf edilmiş modellər — qiymətləri, limitləri və rolları ilə.
 *
 * Qiymət sütunları NULL ola bilər və bu "BİLİNMİR" deməkdir, `0` deyil.
 * Ölçülmüş: models.dev-dəki 103 modeldən 9-unun qiyməti ümumiyyətlə yoxdur.
 * `0` yazsaydıq büdcə mühafizəsi o modellərdə heç vaxt işə düşməzdi
 * (CLAUDE.md qayda 4).
 */
export const models = sqliteTable(
  'models',
  {
    /** `${providerId}:${modelId}` — provayderlər arası ad toqquşmasının qarşısını alır. */
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    contextLimit: integer('context_limit'),
    outputLimit: integer('output_limit'),
    /** USD / 1M token. NULL = bilinmir. */
    priceIn: real('price_in'),
    priceOut: real('price_out'),
    priceCacheRead: real('price_cache_read'),
    priceCacheWrite: real('price_cache_write'),
    toolCall: integer('tool_call', { mode: 'boolean' }).notNull().default(false),
    structuredOutput: integer('structured_output', { mode: 'boolean' })
      .notNull()
      .default(false),
    reasoning: integer('reasoning', { mode: 'boolean' }).notNull().default(false),
    /**
     * `api` — provayderin öz endpoint-i bildirdi, models.dev-də yoxdur (qiymət NULL).
     * `models.dev` — hər iki mənbə uyğun gəldi.
     * `manual` — istifadəçi əl ilə əlavə etdi.
     */
    source: text('source').notNull().default('models.dev'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    roleBoss: integer('role_boss', { mode: 'boolean' }).notNull().default(false),
    roleWorker: integer('role_worker', { mode: 'boolean' }).notNull().default(false),
    roleClassifier: integer('role_classifier', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('models_provider_idx').on(t.providerId),
    // Başçı və klassifikator YALNIZ BİR model ola bilər. Qismən (partial)
    // unikal indeks: yalnız 1 olan sətirlərə tətbiq olunur, 0-lar sərbəst
    // təkrarlanır. Bu, "iki başçı" vəziyyətini tətbiq qatında yox, BAZADA
    // qeyri-mümkün edir — ona görə sxemdə olmalıdır, yoxsa migrasiya onu
    // yaratmaz və yeni bazalarda təminat itər.
    uniqueIndex('models_single_boss_idx')
      .on(t.roleBoss)
      .where(sql`${t.roleBoss} = 1`),
    uniqueIndex('models_single_classifier_idx')
      .on(t.roleClassifier)
      .where(sql`${t.roleClassifier} = 1`),
  ],
)

/**
 * Prompt distilləsi — task TİPİ başına bir dəfə yazılan işçi promptu + rubrika.
 *
 * Nərdivanın pilləsi DEYİL, kəsişən mexanizmdir: başçı bir dəfə ödənilir,
 * sonrakı bütün eyni tipli tasklar onu SIFIR əlavə token ilə işlədir.
 *
 * NİYƏ `runs`-a XARİCİ AÇAR YOXDUR: şablonu ödəyən taskın silinməsi (kontekst
 * silinəndə kaskad) şablonu APARMAMALIDIR — bütün məqsəd odur ki, investisiya
 * onu doğuran taskdan UZUN yaşasın. `authoring_run_id` sadəcə izdir.
 *
 * `uses` və `escalations_after` birlikdə "şablon işləyirmi?" sualına cavab
 * verir: şablon tətbiq olunub, amma task yenə başçıya qalxırsa, distillə
 * zərərə işləyir və bu, ölçülə bilməlidir (eyni prinsip: qayda 22).
 */
export const taskTemplates = sqliteTable(
  'task_templates',
  {
    /** Məzmun hash-i — şablon yenidən yazılanda DƏYİŞİR (keş açarı bundan asılıdır). */
    id: text('id').primaryKey(),
    taskType: text('task_type').notNull(),
    workerPrompt: text('worker_prompt').notNull(),
    rubric: text('rubric').notNull(),
    authoredByModelId: text('authored_by_model_id').notNull(),
    authoringRunId: text('authoring_run_id'),
    /** NULL = bir dəfəlik investisiyanın xərci BİLİNMİR (qayda 4). */
    authoringCostUsd: real('authoring_cost_usd'),
    /** Şablon neçə taskda tətbiq olundu. */
    uses: integer('uses').notNull().default(0),
    /** Şablon tətbiq olunduğu HALDA yenə başçıya qalxan tasklar. */
    escalationsAfter: integer('escalations_after').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  // Task tipi başına BİR aktiv şablon. Təminat BAZADA verilir: tətbiq qatında
  // saxlansaydı, iki paralel task eyni tip üçün iki şablon yazıb bir-birinin
  // investisiyasını görünməz edərdi.
  (t) => [uniqueIndex('task_templates_type_idx').on(t.taskType)],
)

/**
 * Qənaətin ölçülməsi — task başına BİR sətir.
 *
 * Sütunların ayrılığı qəsdəndir və hər biri bir yalanın qarşısını alır:
 *  - `actual_cost_usd` yalnız REAL puldur; abunəlik `actual_subscription_usd`-dədir
 *    (CLAUDE.md qayda 5)
 *  - naməlum xərc NULL-dur, `0` deyil (qayda 4)
 *  - `orchestration_cost_usd` net qənaətdən çıxılır — orkestratorun öz xərci
 *    sayılmasa rəqəm uydurma olar
 *  - `baseline_subscription` abunəlik baseline-ının real pul qənaəti kimi
 *    göstərilməsinin qarşısını alır
 */
export const savingsLedger = sqliteTable(
  'savings_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Task başına bir sətir — unikal. Təkrar yazılış sətri əvəz edir. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskType: text('task_type').notNull().default('unknown'),
    /** REAL pul. NULL = bilinmir. */
    actualCostUsd: real('actual_cost_usd'),
    /** Abunəlik istinad xərci — kartdan çıxmayan pul. */
    actualSubscriptionUsd: real('actual_subscription_usd'),
    /** Əks-fakt: eyni tokenlər başçının qiymətləri ilə. */
    baselineCostUsd: real('baseline_cost_usd'),
    baselineModelId: text('baseline_model_id'),
    baselineSubscription: integer('baseline_subscription', { mode: 'boolean' })
      .notNull()
      .default(false),
    orchestrationCostUsd: real('orchestration_cost_usd'),
    /**
     * Yaddaşın öz xərci (Faza 3). **NULL = BİLİNMİR**, `0` yox (qayda 4).
     *
     * Əvvəl `NOT NULL DEFAULT 0` idi, çünki yaddaş yox idi və `0` DOĞRU idi.
     * İndi provayder sıxma xərcini bildirməyə bilər — onu susaraq `0` saysaq,
     * "bu ay $X qənaət" rəqəmi ödədiyimiz pulu gizlədərdi (qayda 23 ilə eyni
     * səhv). Yaddaşsız tasklarda dəyər yenə `0`-dır və bu, DOĞRUDUR.
     */
    memoryCostUsd: real('memory_cost_usd'),
    netSavingUsd: real('net_saving_usd'),
    cachedHit: integer('cached_hit', { mode: 'boolean' }).notNull().default(false),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('savings_task_idx').on(t.taskId), index('savings_at_idx').on(t.at)],
)

/**
 * Paralel icranın nəticəsi — izolyasiya edilmiş worktree-dəki diff.
 *
 * NİYƏ AYRI CƏDVƏL, NİYƏ `runs`-DA SÜTUN DEYİL: diff bir İCRANIN deyil, bütün
 * TASKIN nəticəsidir. Nərdivan eyni taskda bir neçə icra qaçırır (yoxlama
 * dövrəsi, best-of-N, başçı) və hamısı EYNİ worktree-də işləyir — hər icraya
 * ayrıca diff yazsaydıq, istifadəçi eyni dəyişikliyin üç yarımçıq variantını
 * görərdi.
 *
 * `status` ilə `pending` qalan sətir diskdə QALAN worktree deməkdir: qəbul və
 * ya rədd edilənə qədər dəyişiklik heç yerə getmir. Server başlanğıcındakı
 * yetim təmizləyicisi məhz bu sətirlərə baxır — `pending` worktree yetim DEYİL,
 * istifadəçinin baxmadığı işdir.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Hazırda yalnız `diff`. Sahə gələcək artefakt növləri üçün açıq saxlanılır. */
    kind: text('kind').notNull().default('diff'),
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    /** Diff hansı repoya tətbiq olunmalıdır. Worktree silindikdən sonra yeganə ünvan budur. */
    repoPath: text('repo_path').notNull(),
    content: text('content').notNull(),
    files: integer('files').notNull().default(0),
    /** Diff hədd aşıb kəsilibsə `true` — belə diff TƏTBİQ EDİLƏ BİLMƏZ, yalnız baxış üçündür. */
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    /** `pending` | `accepted` | `rejected` */
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  // Task + növ başına BİR sətir: nərdivanın sonrakı icrası diff-i ƏVƏZ edir,
  // yeni sətir yaratmır (yoxsa "hansı diff sonuncudur?" sualı yaranardı).
  (t) => [uniqueIndex('artifacts_task_kind_idx').on(t.taskId, t.kind)],
)

/**
 * Yaddaş əməliyyatları (Faza 3) — hər `recall` / `remember` bir sətir.
 *
 * NİYƏ `runs`-DA DEYİL: yaddaş çağırışı bizim runner-lərimizdən KEÇMİR (xarici
 * lokal worker-ə gedir), ona görə orada nə `runner_id`, nə `model_id`, nə də
 * hadisə jurnalı olardı — sətir yalanla dolardı.
 *
 * NİYƏ ÜMUMİYYƏTLƏ SAXLANILIR: `savings_ledger.memory_cost_usd` bu sətirlərdən
 * hesablanır. Yaddaşın xərcini ölçmədən "qənaət etdik" demək uydurma olardı
 * (issue #8, qayda 22 ilə eyni prinsip). `ok = false` sətirlər də QALIR: sınmış
 * yaddaş taskı dayandırmır, amma "yaddaş işləyir" illüziyası da yaratmamalıdır.
 */
export const memoryOps = sqliteTable(
  'memory_ops',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** `null` | `claude-mem` — hansı adapter işlədi. */
    provider: text('provider').notNull(),
    /** `recall` | `remember` */
    kind: text('kind').notNull(),
    scope: text('scope').notNull(),
    /** Neçə qeyd oxundu/yazıldı. */
    items: integer('items').notNull().default(0),
    /** Prompta HƏQİQƏTƏN qoşulan (və ya yazılan) təxmini token sayı. */
    tokens: integer('tokens').notNull().default(0),
    /** NULL = xərc BİLİNMİR (qayda 4). 0 = həqiqətən pulsuz (lokal axtarış). */
    costUsd: real('cost_usd'),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    /** Xəta mətni — KƏSİLMİŞ saxlanılır (qayda 18). */
    detail: text('detail'),
    at: integer('at').notNull(),
  },
  (t) => [index('memory_ops_task_idx').on(t.taskId, t.at)],
)

/**
 * Workflow zəncirləri (Faza 4) — bir taskın nəticəsi digərinin girişi.
 *
 * NİYƏ ADDIMLAR AYRICA CƏDVƏLDƏ DEYİL, JSON-DA: addımlar zəncirin TƏRİFİDİR,
 * müstəqil varlıq deyil — heç vaxt tək-tək sorğulanmır, həmişə bütöv oxunur və
 * bütöv yazılır. Ayrı cədvəl hər redaktədə sıra nömrələrinin yenidən
 * hesablanmasını tələb edərdi və "addım silindi, ona istinad edən şərt qaldı"
 * halını BAZA səviyyəsində həll etməzdi (bunu onsuz da Zod `superRefine` edir).
 *
 * `steps_json` sxemi `@orchestris/shared` → `WorkflowSteps`-dədir və HƏM server,
 * HƏM UI onu oxuyur — iki mənbə olmasın deyə.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** `WorkflowSteps` JSON massivi. */
    stepsJson: text('steps_json').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Arxivləşdirilmiş zəncir işə salına bilmir, amma tarixçəsi QALIR. */
    archivedAt: integer('archived_at'),
  },
  (t) => [index('workflows_context_idx').on(t.contextId, t.createdAt)],
)

/** Zəncirin bir icrası. */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** `manual` | `schedule` — avtomatik icranı əl ilə icradan ayırmaq üçün. */
    trigger: text('trigger').notNull().default('manual'),
    status: text('status').notNull().default('running'),
    /**
     * Zəncirin TƏRİFİ icra anında — sonrakı redaktə tarixçəni yalan
     * danışdırmamalıdır. Tərifi yalnız `workflows`-dan oxusaydıq, addım
     * dəyişdirildikdən sonra köhnə icra "başqa addımları qaçırıb" kimi
     * görünərdi.
     */
    stepsJson: text('steps_json').notNull(),
    /**
     * Zəncir icrasının SİNTETİK valideyn taskı (issue #36).
     *
     * NİYƏ LAZIMDIR: `artifacts` cədvəli TASKA bağlıdır, yəni ortaq worktree-nin
     * diff-ini yazacaq sahib olmadan zəncirin `code` addımları istifadəçinin
     * repo-suna BİRBAŞA yazırdı — qayda 42-dəki baxış qapısı zəncirdə işə
     * düşmürdü. Sintetik task o sahibi verir və eyni zamanda addımların
     * task-larını alt-task ağacına yığır.
     *
     * NULL ola bilər: yalnız `http` addımlarından ibarət zəncirin taska ehtiyacı
     * yoxdur — yaradılsaydı `/history` səhifəsi heç bir icrası olmayan boş
     * tasklarla dolardı.
     *
     * XARİCİ AÇAR YOXDUR — `workflow_step_runs.task_id` ilə eyni səbəb: kontekst
     * silinəndə tasklar kaskadla gedir, zəncirin tarixçəsi isə QALMALIDIR.
     */
    rootTaskId: text('root_task_id'),
    /**
     * İcranı hansı cədvəl başlatdı (issue #38). `manual` icrada NULL.
     *
     * NİYƏ `trigger` KİFAYƏT ETMİR: `trigger: 'schedule'` yalnız "avtomatikdir"
     * deyir. Baxılmamış diff tavanı isə CƏDVƏL BAŞINADIR — eyni zəncirə iki
     * cədvəl qurulubsa, `workflow_id` üzrə saysaydıq biri digərinin diff-lərinə
     * görə söndürülərdi.
     *
     * XARİCİ AÇAR YOXDUR: `rootTaskId` ilə eyni səbəb — cədvəl silinəndə
     * zəncirin tarixçəsi QALMALIDIR ("bu cədvəl keçən ay nə etdi?").
     */
    scheduleId: text('schedule_id'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    error: text('error'),
  },
  (t) => [index('workflow_runs_wf_idx').on(t.workflowId, t.startedAt)],
)

/**
 * Zəncirin bir addımının bir icrası (təkrarda bir neçə sətir olur).
 *
 * `task_id`-də XARİCİ AÇAR YOXDUR: kontekst silinəndə tasklar kaskadla gedir,
 * amma zəncirin tarixçəsi QALMALIDIR — "bu zəncir keçən ay nə etdi?" sualının
 * cavabı taskın ömründən uzun yaşayır (eyni yanaşma: `task_templates`).
 */
export const workflowStepRuns = sqliteTable(
  'workflow_step_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    /** Tərifdəki sıra nömrəsi, 0-dan. */
    stepIndex: integer('step_index').notNull(),
    /** `task` | `http` */
    kind: text('kind').notNull(),
    /** Təkrar nömrəsi, 1-dən. `repeat` olmayan addımda həmişə 1. */
    attempt: integer('attempt').notNull().default(1),
    /** Model addımının taskı. HTTP addımında NULL. */
    taskId: text('task_id'),
    status: text('status').notNull().default('running'),
    /** Addımın çıxışı — növbəti addımın `{{previous}}` dəyəri. KƏSİLMİŞ saxlanılır. */
    output: text('output').notNull().default(''),
    /** Çıxış hədd aşıb kəsilibsə `true` — istifadəçi tam mətnin taskda olduğunu bilməlidir. */
    outputTruncated: integer('output_truncated', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Atlanan addımda "hansı şərt ödənmədi" — budaqlanma səbəbsiz qalmasın. */
    detail: text('detail'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('workflow_step_runs_run_idx').on(t.workflowRunId, t.id)],
)

/**
 * Cədvəl üzrə icra (Faza 4) — **hər limit `NOT NULL`**.
 *
 * Sxemin forması issue #12-dəki xəbərdarlıqdan doğur: *"nəzarətsiz cədvəl
 * `$0.50 testdə → $50,000/ay` ssenarisinin ən asan yoludur"*. Limitləri
 * opsional (NULL) saxlasaydıq, "sonra doldurram" deyən istifadəçi LİMİTSİZ
 * avtomatik icra alardı — və bunu yalnız hesabı görəndə bilərdi. Baza
 * səviyyəsindəki `NOT NULL` bunu qeyri-mümkün edir (eyni prinsip: qayda 26 —
 * bazadakı təminat tətbiq qatındakından güclüdür).
 *
 * DÖRD AYRI TAVAN, ÇÜNKİ HƏR BİRİ FƏRQLİ SIZMA YOLUNU BAĞLAYIR:
 *  - `budget_usd_per_run` — bir icranın qaçması
 *  - `budget_usd_total`   — icraların YIĞILMASI (dəqiqədə $0.50 = aylıq $21,600)
 *  - `max_runs`           — abunəlik icraları: real xərc `0`-dır və USD tavanı
 *    onları HEÇ VAXT tutmur; sayğac isə tutur
 *  - `max_pending_diffs`  — DİSK (issue #38): yuxarıdakı üçü XƏRC üçün seçilir və
 *    `max_runs: 500` tam qanunidir, amma repoya yazan zəncirin hər avtomatik
 *    icrası YENİ `pending` diff = reponun yeni nüsxəsi yaradır
 */
export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    intervalSeconds: integer('interval_seconds').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    budgetUsdPerRun: real('budget_usd_per_run').notNull(),
    budgetUsdTotal: real('budget_usd_total').notNull(),
    maxRuns: integer('max_runs').notNull(),
    /**
     * Cədvəlin yığa biləcəyi ən çox baxılmamış (`pending`) diff sayı (issue #38).
     *
     * SAYĞAC DEYİL, TAVAN: cari say `artifacts`-dan CANLI hesablanır
     * (`countPendingDiffsForSchedule`). Sütunda saxlasaydıq, istifadəçi diff-i
     * qəbul/rədd edəndə sayğac köhnəlmiş qalar və cədvəl artıq mövcud olmayan
     * qovluqlara görə söndürülərdi.
     *
     * DB DEFAULTU VAR — qalan üç tavandan fərqli olaraq. Səbəb sxem
     * miqrasiyasıdır, mühakimə deyil: SQLite `ADD COLUMN … NOT NULL` əmrini
     * DEFAULT olmadan qəbul etmir. Rəqəm KİÇİK seçilib ki, API-dən yan keçən
     * sətir ən DAR tavanı alsın, ən genişini yox.
     *
     * RƏQƏM LİTERALDIR, `DEFAULT_MAX_PENDING_DIFFS` importu YOX: `drizzle-kit
     * generate` bu faylı CJS kimi yükləyir və `@orchestris/shared`-in ESM `.js`
     * spesifikatorlarını həll edə bilmir (`MODULE_NOT_FOUND`) — yəni import
     * migrasiya generasiyasını tamamilə sındırardı. İki mənbənin ayrılmasını
     * `schema.test.ts` bağlayır: default shared sabitinə BƏRABƏR olmalıdır.
     */
    maxPendingDiffs: integer('max_pending_diffs').notNull().default(5),
    /** İndiyə qədər ölçülmüş REAL xərc. Abunəlik icralarında `0` qalır. */
    spentUsd: real('spent_usd').notNull().default(0),
    runs: integer('runs').notNull().default(0),
    nextRunAt: integer('next_run_at').notNull(),
    lastRunAt: integer('last_run_at'),
    /**
     * Cədvəl NİYƏ söndürüldü.
     *
     * Sahə olmasaydı istifadəçi "niyə işləmir?" sualının cavabını heç yerdə
     * tapa bilməzdi — avtomatik icranın səssizcə dayanması ən pis haldır: adam
     * işin getdiyini zənn edir.
     */
    disabledReason: text('disabled_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('schedules_due_idx').on(t.enabled, t.nextRunAt)],
)

export const contextsRelations = relations(contexts, ({ many }) => ({
  tasks: many(tasks),
}))
export const providersRelations = relations(providers, ({ many }) => ({
  models: many(models),
}))
export const modelsRelations = relations(models, ({ one }) => ({
  provider: one(providers, { fields: [models.providerId], references: [providers.id] }),
}))
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  context: one(contexts, { fields: [tasks.contextId], references: [contexts.id] }),
  runs: many(runs),
}))
export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  events: many(runEvents),
  verifications: many(verificationRuns),
}))

/**
 * İşçinin istifadəçiyə verdiyi suallar (Faza 5B).
 *
 * `runs`-da SAXLANILA BİLMƏZDİ: sual bir icranın NƏTİCƏSİDİR, cavab isə
 * BAŞQA icraya aiddir — bir sətirdə ikisini birləşdirsək "hansı icra
 * gözləyir" sualının cavabı itərdi.
 */
export const taskQuestions = sqliteTable(
  'task_questions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Sualı VERƏN icra. */
    runId: text('run_id').notNull(),
    question: text('question').notNull(),
    /** `yes_no` | `single` | `multi` */
    kind: text('kind').notNull(),
    optionsJson: text('options_json').notNull().default('[]'),
    /** NULL = hələ cavab yoxdur. */
    answerJson: text('answer_json'),
    /** `pending` | `answered` | `cancelled` */
    status: text('status').notNull().default('pending'),
    askedAt: integer('asked_at').notNull(),
    answeredAt: integer('answered_at'),
  },
  (t) => [
    index('questions_task_idx').on(t.taskId, t.askedAt),
    // "Gözləyən suallar" sorğusu `LiveBar` nişanı üçün hər açılışda qaçır.
    index('questions_status_idx').on(t.status),
  ],
)

/**
 * İstifadəçinin işləyən icraya yazdığı rəy (Faza 5B).
 *
 * `applied_at` NULL olduqca rəy "tətbiq olunmayıb" sayılır: nərdivan onu
 * növbəti icrada boşaldır, route isə icra işləmirsə yeni icra başladır.
 */
export const taskReviews = sqliteTable(
  'task_reviews',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Rəy yazılanda işləyən icra; yoxdursa NULL. */
    runId: text('run_id'),
    text: text('text').notNull(),
    /** `next` | `interrupt` */
    mode: text('mode').notNull(),
    appliedAt: integer('applied_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('reviews_task_idx').on(t.taskId, t.createdAt)],
)

/**
 * İstifadəçinin əlavə etdiyi MCP serverləri (Faza 5C).
 *
 * SİRLƏR BURADA SAXLANILMIR (qayda 13): `secret_env_json` yalnız dəyişənlərin
 * ADLARINI daşıyır, dəyərlər OS keychain-dədir (`mcp:<serverId>:<VAR>`).
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  /** Konfiqurasiya faylındakı açar — unikal olmalıdır. */
  name: text('name').notNull().unique(),
  /** `stdio` | `http` | `sse` */
  transport: text('transport').notNull(),
  command: text('command'),
  argsJson: text('args_json').notNull().default('[]'),
  /** SİRSİZ env dəyərləri. */
  envJson: text('env_json').notNull().default('{}'),
  /** Yalnız dəyişən ADLARI — dəyərlər keychain-dədir. */
  secretEnvJson: text('secret_env_json').notNull().default('[]'),
  url: text('url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
})

/**
 * Plugin / öz skill dəstlərinin mənbələri (Faza 5C).
 *
 * `--plugin-url` DƏSTƏKLƏNMİR: uzaq zip yükləmək istifadəçinin maşınında
 * yoxlanılmamış kod işlətməkdir və bunun qərarı bizim deyil. İstifadəçi zip-i
 * özü endirib yolunu verə bilər.
 */
export const pluginSources = sqliteTable('plugin_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Qovluq və ya `.zip` faylının yolu. */
  path: text('path').notNull(),
  createdAt: integer('created_at').notNull(),
})

/**
 * Kontekst → MCP server seçimi.
 *
 * Bağlantı CƏDVƏLİDİR, `contexts`-də JSON massiv YOX: burada SORĞU var —
 * "bu server hansı kontekstlərdə işlədilir?" sualı serveri silməzdən əvvəl
 * lazımdır. `extra_dirs_json` (qayda 65) fərqlidir: o, yalnız bütöv oxunur.
 */
export const contextMcpServers = sqliteTable(
  'context_mcp_servers',
  {
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    mcpServerId: text('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contextId, t.mcpServerId] })],
)

export const contextPlugins = sqliteTable(
  'context_plugins',
  {
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    pluginSourceId: text('plugin_source_id')
      .notNull()
      .references(() => pluginSources.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contextId, t.pluginSourceId] })],
)
