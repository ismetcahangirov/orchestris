import { z } from 'zod'
import { RunEventSchema } from './events.js'
import { FILE_ACCESS_LEVELS } from './runner.js'

export const CreateContextBody = z.object({
  name: z.string().min(1).max(200),
  cwd: z.string().optional(),
  verifyCommands: z.array(z.string()).optional(),
  fileAccess: z.enum(FILE_ACCESS_LEVELS).optional(),
  extraDirs: z.array(z.string()).optional(),
})
export type CreateContextBody = z.infer<typeof CreateContextBody>

export const CreateTaskBody = z.object({
  contextId: z.string().min(1),
  prompt: z.string().min(1),
  /**
   * Runner id-si (`cli:claude`, `api:anthropic`, `fake`). Boş buraxılsa server
   * mövcud runner-lərdən birincisini seçir.
   *
   * Sabit enum DEYİL: hansı API provayderlərinin runner-i olduğu DİNAMİKDİR
   * (istifadəçinin açar verdiyi provayderlərdən asılıdır). Enum saxlasaydıq,
   * hər yeni provayder üçün paylaşılan paket dəyişməli olardı. Mövcudluq
   * yoxlaması `POST /api/tasks`-dadır — tanınmayan id üçün mövcudların
   * siyahısı ilə 400 qaytarılır.
   */
  runner: z.string().min(1).optional(),
  /**
   * Model BURAXILA BİLƏR — bu, "Auto" deməkdir: Pillə 1 (qayda routing) işçini
   * özü seçir. Model verilibsə seçim ƏL İLƏdir və router işə düşmür.
   */
  model: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  /**
   * Task dekompozisiyası (Faza 4) — başçı taskı alt-tasklara bölsün.
   *
   * AÇIQ SEÇİMDİR, avtomatik deyil: bölgü BİR başçı icrası + N nərdivan
   * dövrəsi ödəyir, faydası isə hələ ölçülməyib. Avtomatik açsaydıq hər
   * çoxaddımlı task əlavə başçı icrası ödəyərdi — halbuki eyni hal üçün onsuz
   * da Pillə 5 (plan) var və o, CƏMİ bir işçi icrası ödəyir.
   */
  decompose: z.boolean().optional(),
})
export type CreateTaskBody = z.infer<typeof CreateTaskBody>

/** Amplifikasiya profilləri — `docs/.../design.md` §7. */
export const AMPLIFICATION_PROFILES = ['cheap', 'balanced', 'quality', 'boss-only'] as const
export const WORKER_MODES = ['auto', 'manual'] as const

/**
 * Kontekst ayarlarının qismən yenilənməsi.
 *
 * Hər sahə opsionaldır və VERİLMƏYƏN sahə dəyişmir: istifadəçi profil
 * dəyişəndə büdcəsini itirməməlidir.
 */
export const UpdateContextBody = z.object({
  amplificationProfile: z.enum(AMPLIFICATION_PROFILES).optional(),
  workerMode: z.enum(WORKER_MODES).optional(),
  /** `models.id` (`anthropic:claude-haiku-4-5`). `null` = təyinatı sil. */
  defaultWorkerModelId: z.string().min(1).nullable().optional(),
  verifyCommands: z.array(z.string()).optional(),
  /**
   * Eyni anda neçə task icra oluna bilər. `0` = **avtomatik** (`min(4, nüvə-2)`).
   *
   * Yuxarı hədd qəsdən aşağıdır: hər paralel icra ~21.7k token prompt döşəməsi
   * ödəyir (CLAUDE.md qayda 1) və maşında eyni anda 30 CLI prosesi açmaq nə
   * sürət verir, nə də pul qənaət edir.
   */
  maxParallel: z.number().int().min(0).max(16).optional(),
  /**
   * Yaddaş sahəsi (Faza 3). `null` = avtomatik (kontekstin öz `id`-si).
   *
   * Eyni ad verilən iki kontekst yaddaşı PAYLAŞIR — bu, açıq qərardır və
   * default deyil: fərqli layihələrin qeydlərinin qarışması səssiz zərərdir.
   */
  memoryScope: z.string().min(1).max(100).nullable().optional(),
  /** Bu kontekstdə yaddaş işə düşsünmü. */
  memoryEnabled: z.boolean().optional(),
  budgetTokens: z.number().int().positive().nullable().optional(),
  budgetUsd: z.number().positive().nullable().optional(),
  budgetSeconds: z.number().int().positive().nullable().optional(),
  /**
   * İş qovluğu (Faza 5A). `null` = sil.
   *
   * Əvvəl bu sahə YOX İDİ — `cwd` yalnız kontekst yaradılanda verilirdi və
   * səhv yazılmış yolu düzəltmək üçün kontekst yenidən yaradılmalı idi.
   */
  cwd: z.string().nullable().optional(),
  fileAccess: z.enum(FILE_ACCESS_LEVELS).optional(),
  /** YALNIZ `'extended'` səviyyəsində tətbiq olunur (`exec/file-access.ts`). */
  extraDirs: z.array(z.string()).optional(),
  /**
   * İşçi bu kontekstdə istifadəçiyə sual verə bilirmi (Faza 5B).
   *
   * Bayraq AÇIQ olsa belə cədvəl və zəncir icralarında suallar söndürülür —
   * orada cavab verəcək insan yoxdur.
   */
  questionsEnabled: z.boolean().optional(),
  /**
   * Fərdiləşdirmə seçimi (Faza 5C) — TAM ƏVƏZLƏMƏ.
   *
   * UI checkbox siyahısı onsuz da bütöv vəziyyət göndərir; qismən yeniləmə
   * "hansı silindi?" sualını klientə yükləyərdi.
   */
  mcpServerIds: z.array(z.string()).optional(),
  pluginIds: z.array(z.string()).optional(),
  /**
   * CLI-nin DAXİLİ skill dəsti (hamısı-birdən — ədəd-ədəd bayraq YOXDUR).
   * Ölçülmüş qiymət: +3,648 token / icra.
   */
  builtinSkillsEnabled: z.boolean().optional(),
})
export type UpdateContextBody = z.infer<typeof UpdateContextBody>

/**
 * API açarının qəbulu.
 *
 * Açar YALNIZ bu istiqamətdə hərəkət edir: brauzer → server → OS keychain.
 * Heç bir cavab sxemində açar sahəsi YOXDUR və olmamalıdır (CLAUDE.md qayda 13).
 *
 * Minimum 8 simvol: `redactSecret` bundan qısa sətirləri maskalamır (qısa
 * sətir mətnin hər yerinə uyğun gəlib xəta mesajlarını oxunmaz edərdi), ona
 * görə daha qısa "açar" qəbul etsək onu log-dan kəsə bilməzdik.
 */
export const SetCredentialBody = z.object({
  apiKey: z.string().min(8).max(500),
})
export type SetCredentialBody = z.infer<typeof SetCredentialBody>

export const MODEL_ROLES = ['boss', 'worker', 'classifier'] as const

export const SetModelRoleBody = z.object({
  id: z.string().min(1),
  role: z.enum(MODEL_ROLES),
  value: z.boolean(),
  /**
   * YALNIZ `role: 'worker'` üçün: bu model TƏK işçi olsun, qalanlarından rol
   * alınsın.
   *
   * NİYƏ BAYRAQ, NİYƏ AYRICA ROUTE DEYİL: `boss`/`classifier` onsuz da
   * eksklüzivdir, `worker` isə çoxluqdur — fərq rolun ÖZÜNDƏ deyil, çağıranın
   * NİYYƏTİNDƏdir. `/providers`-dəki checkbox "bunu da əlavə et" deyir, idarə
   * panelindəki dropdown "işçi budur" deyir. Bayraq olmasaydı, dropdown köhnə
   * işçiləri təmizləmək üçün N ayrı sorğu göndərməli olardı — yarıda sınsa
   * sistem "işçi yoxdur" vəziyyətində qalardı.
   */
  exclusive: z.boolean().optional(),
})
export type SetModelRoleBody = z.infer<typeof SetModelRoleBody>

/**
 * Kataloqdan yeni provayder əlavə edir (issue #44).
 *
 * YALNIZ `id` — ünvan, ad və model metadatası models.dev-dən oxunur. Ünvanı
 * istifadəçidən istəsəydik, hər provayder üçün onu doğru yazmaq onun işi
 * olardı; ölçülüb ki, OpenAI-uyğun 138 provayderin HAMISININ ünvanı kataloqda
 * var (2026-07-29).
 *
 * `apiKey` OPSİONALDIR: lokal provayderlər (Ollama, LM Studio) açar tələb
 * etmir. Verilibsə dərhal OS anbarına yazılır və model kəşfi qaçır.
 */
export const AddProviderBody = z.object({
  id: z.string().min(1).max(64),
  apiKey: z.string().min(8).max(500).optional(),
})
export type AddProviderBody = z.infer<typeof AddProviderBody>

export const SetModelEnabledBody = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
})
export type SetModelEnabledBody = z.infer<typeof SetModelEnabledBody>

/** Klientdən serverə gedən WebSocket mesajları */
/**
 * Hazırda işləyən bir icranın yığcam təsviri — canlı zolaq üçün (Faza 5A).
 *
 * Hadisə DELTALARI burada YOXDUR və bu, mərkəzi qərardır: qlobal kanal zolaq
 * açıq olan HƏR brauzerə gedir, yəni 5 paralel icrada zolaq — ekranın ən kiçik
 * elementi — ən böyük trafiki yaradardı. Deltalar task səhifəsinin öz
 * abunəliyində qalır.
 */
export const ActiveRun = z.object({
  runId: z.string(),
  taskId: z.string(),
  contextId: z.string(),
  contextName: z.string(),
  /** Taskın ilk sətirləri — zolaqda "nə işlənir" sualının cavabı. */
  promptExcerpt: z.string(),
  modelId: z.string(),
  runnerId: z.string(),
  /** Mənfi dəyər nərdivandan KƏNAR mexanizmdir: -1 distillə, -2 bölgü. */
  ladderRung: z.number().int(),
  attempt: z.number().int(),
  startedAt: z.number().int(),
})
export type ActiveRun = z.infer<typeof ActiveRun>

export const QUESTION_KINDS = ['yes_no', 'single', 'multi'] as const
export const REVIEW_MODES = ['next', 'interrupt'] as const

/**
 * İşçinin sualına cavab (Faza 5B).
 *
 * Cavabın forması `kind`-dan asılıdır: `yes_no` → boolean, `single` → string,
 * `multi` → string[]. UYĞUNLUQ yoxlaması SERVERDƏDİR (`kind` yalnız orada,
 * DB sətrində bilinir) — sxemi `kind`-a bağlı etsəydik klient sualın formasını
 * da göndərməli olardı və uyğunsuz dəyər göndərə bilərdi, yəni yoxlama
 * özü-özünü yoxlayardı.
 */
export const AnswerQuestionBody = z.object({
  answer: z.union([z.boolean(), z.string().min(1), z.array(z.string().min(1)).min(1)]),
})
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBody>

export const CreateReviewBody = z.object({
  text: z.string().min(1).max(2000),
  /**
   * `next` — növbəti icrada nəzərə alınır, heç bir iş atılmır.
   * `interrupt` — cari icra DƏRHAL kəsilir; yarımçıq işin ÇIXIŞ tokenləri
   * ödənilib atılır (çıxış girişdən 3–5x bahadır), əvəzində cavab dərhaldır.
   *
   * Seçim istifadəçinindir: birini "düzgün" sayıb digərini gizlətsəydik, ya
   * səhv yolla gedən işçi bitənə qədər gözlənilərdi, ya da hər rəy token
   * yandırardı.
   */
  mode: z.enum(REVIEW_MODES),
})
export type CreateReviewBody = z.infer<typeof CreateReviewBody>

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const

/**
 * MCP serverinin əlavə edilməsi (Faza 5C).
 *
 * `secretEnv` DƏYƏRLƏRİ daşıyır və onlar YALNIZ bu istiqamətdə hərəkət edir:
 * brauzer → server → OS keychain (qayda 13). Heç bir cavab sxemində sirr
 * sahəsi YOXDUR və olmamalıdır.
 */
export const CreateMcpServerBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      // Ad MCP konfiqurasiyasında AÇAR olur və alət adlarına düşür
      // (`mcp__<ad>__<alət>`) — boşluq və xüsusi simvol orada sınar.
      .regex(/^[a-zA-Z0-9_-]+$/, 'Yalnız hərf, rəqəm, `-` və `_`'),
    transport: z.enum(MCP_TRANSPORTS),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Ad → dəyər. Dəyərlər keychain-ə gedir, DB-yə YOX. */
    secretEnv: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
  })
  .refine(
    (b) => (b.transport === 'stdio' ? b.command !== undefined : b.url !== undefined),
    { message: 'stdio `command`, http/sse isə `url` tələb edir' },
  )
export type CreateMcpServerBody = z.infer<typeof CreateMcpServerBody>

export const CreatePluginBody = z.object({
  name: z.string().min(1).max(80),
  /** Qovluq və ya `.zip` faylının MÜTLƏQ yolu. */
  path: z.string().min(1),
})
export type CreatePluginBody = z.infer<typeof CreatePluginBody>

export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), taskId: z.string() }),
  z.object({ type: z.literal('cancel'), runId: z.string() }),
  /** Qlobal canlı zolaq abunəliyi — task-a bağlı DEYİL. */
  z.object({ type: z.literal('subscribe_activity') }),
  z.object({ type: z.literal('unsubscribe_activity') }),
])
export type WsClientMessage = z.infer<typeof WsClientMessage>

/** Serverdən klientə gedən WebSocket mesajları */
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    taskId: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: z.number().int(),
    event: RunEventSchema,
  }),
  /**
   * Canlı zolaq hadisəsi (Faza 5A).
   *
   * `kind: 'updated'` QƏSDƏN YOXDUR: pillə və cəhd nömrəsi bir icra daxilində
   * DƏYİŞMİR — nərdivan hər pillə/cəhd üçün YENİ `runs` sətri yaradır. Belə
   * bir növ heç vaxt emit oluna bilməzdi.
   */
  z.object({
    type: z.literal('activity'),
    kind: z.enum(['started', 'ended']),
    runId: z.string(),
    /** YALNIZ `'started'`-da olur — `'ended'` üçün `runId` kifayətdir. */
    run: ActiveRun.optional(),
  }),
  /**
   * Sual hadisəsi (Faza 5B) — `activity` ilə eyni prinsip: hadisə, delta yox.
   *
   * HƏM qlobal, HƏM task kanalına yayılır: qlobal — `LiveBar` nişanı üçün,
   * task kanalı — açıq `/tasks/:id` səhifəsi üçün. Birini seçsəydik ya nişan
   * gecikərdi, ya da task səhifəsi qlobal kanala da abunə olmalı olardı.
   */
  z.object({
    type: z.literal('question'),
    kind: z.enum(['asked', 'answered', 'cancelled']),
    taskId: z.string(),
    questionId: z.string(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type WsServerMessage = z.infer<typeof WsServerMessage>
