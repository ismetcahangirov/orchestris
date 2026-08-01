import type {
  CreateContextBody,
  CreateMcpServerBody,
  CreatePluginBody,
  CreateReviewBody,
  CreateTaskBody,
  CreateScheduleBody,
  CreateWorkflowBody,
  RunEvent,
  RunWorkflowBody,
  UpdateContextBody,
  UpdateScheduleBody,
  UpdateWorkflowBody,
} from '@orchestris/shared'

/** Faza 4 — cədvəl. Hər dörd limit MƏCBURİDİR (issue #12, #38). */
export interface ScheduleRow {
  id: string
  workflowId: string
  intervalSeconds: number
  enabled: boolean
  budgetUsdPerRun: number
  budgetUsdTotal: number
  maxRuns: number
  /** Disk tavanı: cədvəlin yığa biləcəyi ən çox baxılmamış diff (issue #38). */
  maxPendingDiffs: number
  spentUsd: number
  runs: number
  /**
   * Hazırda baxılmamış diff sayı — sütunda SAXLANILMIR, cavabda CANLI hesablanır.
   * Diff qəbul/rədd ediləndə dərhal azalır, yəni tavan geri açıla bilir.
   */
  pendingDiffs: number
  nextRunAt: number
  lastRunAt: number | null
  /** Cədvəl NİYƏ söndürüldü — səssiz dayanma ən pis haldır. */
  disabledReason: string | null
  createdAt: number
}

/** Faza 4 — zəncir tərifi. `stepsJson` sxemi `@orchestris/shared`-dədir. */
export interface WorkflowRow {
  id: string
  contextId: string
  name: string
  description: string | null
  stepsJson: string
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  /** Siyahı cavabında gəlir — ayrıca sorğu N+1 yaradardı. */
  lastRun?: WorkflowRunRow | null
}

export interface WorkflowRunRow {
  id: string
  workflowId: string
  trigger: string
  status: string
  stepsJson: string
  /**
   * Zəncirin sintetik valideyn taskı (issue #36) — addımların ORTAQ worktree-si
   * onun adına açılır və diff onun `artifacts` sətrinə `pending` yazılır.
   * Yalnız `http` addımlarından ibarət zəncirdə `null`.
   */
  rootTaskId: string | null
  startedAt: number
  endedAt: number | null
  error: string | null
}

export interface WorkflowStepRunRow {
  id: number
  workflowRunId: string
  stepId: string
  stepIndex: number
  kind: string
  attempt: number
  taskId: string | null
  status: string
  output: string
  outputTruncated: boolean
  detail: string | null
  startedAt: number
  endedAt: number | null
}

/**
 * Başlıq YALNIZ gövdə olanda qoyulur (issue #50).
 *
 * Ölçülmüş (Chrome, 2026-07-30): boş gövdə + `Content-Type: application/json`
 * Fastify-da `FST_ERR_CTP_EMPTY_JSON_BODY` → **400** verir və route-un kodu HEÇ
 * VAXT çağırılmır. Yəni gövdəsiz hər düymə (kataloq yeniləməsi, "Yenidən kəşf
 * et", "Açarı sil", task ləğvi, **diff qəbulu/rəddi**) səssizcə işləmirdi.
 *
 * Səhv məhz burada idi: işlətmədiyimiz content-type-ı bildirirdik. Serverin
 * 400-ü DOĞRUDUR və orada maskalanmır — əks halda gələcək klient səhvi səssizcə
 * keçərdi. Terminaldakı `curl -X POST` bu başlığı göndərmədiyi üçün işləyirdi;
 * issue #46-daki ziddiyyətin izahı da budur.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as T
}

export interface ContextRow {
  id: string
  name: string
  cwd: string | null
  amplificationProfile: string
  workerMode: string
  autoSubmode: string
  verifyCommandsJson: string
  maxParallel: number
  /**
   * Task büdcəsi. `null` = LİMİTSİZ (istifadəçi sahəni boşaldıb).
   *
   * `budgetSeconds` İCRA BAŞINADIR, task başına yox: uzun task normaldır,
   * anormal olan ilişmiş bir icradır. Token və xərc isə taskın bütün icraları
   * boyu yığılır; bölünmüş taskda hər parça tam limiti alır.
   */
  budgetTokens: number | null
  budgetUsd: number | null
  budgetSeconds: number | null
  /** `null` = avtomatik (kontekstin öz `id`-si). */
  memoryScope: string | null
  memoryEnabled: boolean
  /** İşçi bu kontekstdə sual verə bilirmi (Faza 5B). */
  questionsEnabled: boolean
  /** CLI-nin daxili skill dəsti açıqdırmı (Faza 5C) — +3,648 token, ölçülmüş. */
  builtinSkillsEnabled: boolean
  /** `'read-only'` | `'workspace'` | `'extended'` (Faza 5A). */
  fileAccess: string
  /** YALNIZ `'extended'` səviyyəsində tətbiq olunur. */
  extraDirsJson: string
  createdAt: number
}

export interface FsEntry {
  name: string
  path: string
  /** `.git` FAYL və ya QOVLUQ kimi mövcuddur (worktree halı — qayda 44). */
  isRepo: boolean
  hidden: boolean
}

export interface FsListResponse {
  path: string
  parent: string | null
  drives: string[]
  entries: FsEntry[]
}

/**
 * Yazıla bilmə YALNIZ burada gəlir, siyahıda yox: `fs.access(W_OK)` Windows-da
 * ACL görmür, ona görə server real yazma probu edir və onu hər sətrə tətbiq
 * etmək bir naviqasiyada onlarla disk əməliyyatı deməkdi.
 */
export interface FsCheckResponse {
  path: string
  exists: boolean
  isDirectory: boolean
  isRepo: boolean
  writable: boolean
}

/** İşçinin istifadəçiyə verdiyi sual (Faza 5B). */
export interface QuestionRow {
  id: string
  taskId: string
  runId: string
  question: string
  /** `yes_no` | `single` | `multi` */
  kind: string
  /** Serverdə `options_json`-dan AÇILIR — UI xam JSON oxumamalıdır. */
  options: string[]
  answerJson: string | null
  /** `pending` | `answered` | `cancelled` */
  status: string
  askedAt: number
  answeredAt: number | null
}

/** İstifadəçinin işləyən icraya yazdığı rəy (Faza 5B). */
export interface ReviewRow {
  id: string
  taskId: string
  runId: string | null
  text: string
  /** `next` | `interrupt` */
  mode: string
  appliedAt: number | null
  createdAt: number
}

/**
 * MCP serveri (Faza 5C).
 *
 * SİRR YOXDUR və olmamalıdır: yalnız `secretEnvNames` (adlar) və `hasSecret`
 * gəlir — dəyərlər OS keychain-dədir (qayda 13).
 */
export interface McpServerRow {
  id: string
  name: string
  transport: string
  command: string | null
  args: string[]
  env: Record<string, string>
  secretEnvNames: string[]
  hasSecret: boolean
  url: string | null
  enabled: boolean
  createdAt: number
}

export interface PluginRow {
  id: string
  name: string
  path: string
  createdAt: number
}

/** `~/.claude.json`-dan OXUNAN mövcud server — sirlər daxil deyil. */
export interface AvailableMcpRow {
  name: string
  transport: string
  command: string | null
  url: string | null
  added: boolean
}

/** Canlı zolaqdakı bir icra (Faza 5A). */
export interface ActiveRunRow {
  runId: string
  taskId: string
  contextId: string
  contextName: string
  promptExcerpt: string
  modelId: string
  runnerId: string
  /** Mənfi dəyər nərdivandan KƏNAR mexanizmdir: -1 distillə, -2 bölgü. */
  ladderRung: number
  attempt: number
  startedAt: number
}

/**
 * Yaddaşın vəziyyəti (Faza 3).
 *
 * `active` "nərdivana qoşulub" deməkdir; `health.ok` isə "işləyir". İkisi
 * FƏRQLİDİR: provayder qoşula, amma worker əlçatmaz ola bilər — istifadəçi
 * bunu görməlidir, yoxsa yaddaşın sınıq olduğunu heç vaxt bilməz.
 */
export interface MemoryStatus {
  provider: string
  active: boolean
  tokenBudget: number
  health: { ok: boolean; detail?: string }
}

/** PATH-dan aşkarlanan lokal CLI — açar tələb etmir, abunəlikdən işləyir. */
export interface CliProviderRow {
  id: string
  kind: string
  installed: boolean
  authenticated: boolean
  version?: string
  execPath?: string
  detail: string
}

/** Kataloqda mövcud, amma hələ əlavə edilməmiş provayder (issue #44). */
export interface AvailableProviderRow {
  id: string
  name: string
  /**
   * `native` = öz kəşf adapteri var (anthropic/openai/google),
   * `openai-compatible` = models.dev-in bildirdiyi ünvana OpenAI protokolu ilə
   * bağlanılır (DeepSeek, Groq, OpenRouter, Ollama…).
   */
  support: 'native' | 'openai-compatible'
  modelCount: number
  /** Açarı daşıyan env dəyişənləri — istifadəçi açarı harada tapacağını bilsin. */
  envVars: string[]
  doc?: string
}

/**
 * API provayderi. DİQQƏT: burada açarın ÖZÜ yoxdur və olmamalıdır — yalnız
 * `hasCredential` (CLAUDE.md qayda 13).
 */
export interface ApiProviderRow {
  id: string
  displayName: string
  hasCredential: boolean
  enabled: boolean
  modelCount: number
  lastDiscoveryAt: number | null
  lastDiscoveryError: string | null
  envVars: string[]
  /**
   * Task göndərişində işlədiləcək runner id-si (`api:anthropic`). `null` =
   * server bu provayder üçün runner qeydiyyatdan keçirməyib — UI onu seçilə
   * bilən göstərməməlidir.
   */
  runnerId: string | null
  /** Açar OS anbarındadırmı. Açarın ÖZÜ heç vaxt bura gəlmir (qayda 13). */
  authenticated: boolean
  doc?: string
}

export interface ProvidersResponse {
  cli: CliProviderRow[]
  api: ApiProviderRow[]
  keychain: { ok: boolean; detail: string }
  catalog: { source: 'bundled' | 'cache'; fetchedAt?: number; providerCount: number }
}

export interface ModelRow {
  id: string
  providerId: string
  modelId: string
  displayName: string
  contextLimit: number | null
  outputLimit: number | null
  /** null = qiymət BİLİNMİR (0 deyil). USD / 1M token. */
  priceIn: number | null
  priceOut: number | null
  priceCacheRead: number | null
  priceCacheWrite: number | null
  toolCall: boolean
  structuredOutput: boolean
  reasoning: boolean
  source: string
  enabled: boolean
  roleBoss: boolean
  roleWorker: boolean
  roleClassifier: boolean
  priceKnown: boolean
  /**
   * `false` = model task icra EDƏ BİLMƏZ (embedding, şəkil, audio, whisper…) —
   * issue #47. Sütunda saxlanılmır, `GET /api/models` cavabında kataloqun
   * modalitlərindən hesablanır (`registry/capability.ts`).
   *
   * Model seçicisi belə modelləri GÖSTƏRMİR, `/providers` siyahısı isə göstərir:
   * orada istifadəçi hər şeyi görməli və əl ilə söndürə bilməlidir.
   */
  taskCapable: boolean
}

export interface DiscoveryResult {
  ok: boolean
  modelCount?: number
  error?: string
}

export interface StoredEventRow {
  seq: number
  at: number
  event: RunEvent
}

export interface VerificationRow {
  id: number
  command: string
  exitCode: number | null
  passed: boolean
  outputExcerpt: string
  durationMs: number
  at: number
}

export interface RunRow {
  id: string
  runnerId: string
  modelId: string
  status: string
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  /** null = xərc BİLİNMİR (codex xərc bildirmir). 0 = həqiqətən pulsuz. */
  costUsd: number | null
  subscriptionBilled: boolean
  sessionId: string | null
  errorClass: string | null
  errorMessage: string | null
  startedAt: number
  endedAt: number | null
  events: StoredEventRow[]
  ladderRung: number
  attempt: number
  cachedHit: boolean
  /**
   * Bu icra hansı icradan sonra, PİLLƏ QALXARAQ başladı. `attempt`-dən
   * fərqlidir: o, eyni pillədə təkrar cəhddir.
   */
  escalatedFromRunId: string | null
  /** İcra izolyasiya edilmiş worktree-də işlədisə onun yolu. `null` = əsas `cwd`. */
  worktreePath: string | null
  verifications: VerificationRow[]
}

/**
 * Pillə 1-in qərarı. `decisionCostUsd: null` = qərarın xərci BİLİNMİR;
 * `0` = həqiqətən pulsuz (qayda routing).
 */
export interface RoutingDecisionRow {
  id: number
  taskId: string
  strategy: string
  chosenModelId: string | null
  runnerId: string
  modelId: string
  confidence: number
  decisionTokens: number
  decisionCostUsd: number | null
  ruleId: string | null
  reason: string
  at: number
}

/**
 * Qənaət yekunu. Sahələrin ayrılığı qəsdəndir: abunəlik real pula
 * qarışdırılmır, orkestrasiya xərci gizlədilmir, naməlum xərcli tasklar
 * cəmə girmir və ayrıca sayılır.
 */
export interface SavingsSummary {
  taskCount: number
  actualCostUsd: number
  actualSubscriptionUsd: number
  baselineCostUsd: number
  orchestrationCostUsd: number
  memoryCostUsd: number
  netSavingUsd: number
  cacheHits: number
  cacheSavingUsd: number
  unknownCostTasks: number
  subscriptionBaselineTasks: number
  byTaskType: { taskType: string; tasks: number; netSavingUsd: number; actualCostUsd: number }[]
  tokensIn: number
  tokensOut: number
}

export interface SavingsTaskRow {
  taskId: string
  taskType: string
  /** null = xərc BİLİNMİR. */
  actualCostUsd: number | null
  actualSubscriptionUsd: number | null
  baselineCostUsd: number | null
  baselineModelId: string | null
  baselineSubscription: boolean
  orchestrationCostUsd: number | null
  netSavingUsd: number | null
  cachedHit: boolean
  tokensIn: number
  tokensOut: number
  at: number
  prompt: string
  status: string
}

export type StatsPeriod = 'day' | 'week' | 'month' | 'all'

export interface RoutingRuleRow {
  id: string
  description: string
  prefer: string
}

/**
 * Prompt distilləsi — task tipi başına bir dəfə yazılan işçi promptu.
 *
 * `uses` və `escalationsAfter` yanaşı durur: şablon tətbiq olunub, task yenə
 * başçıya qalxa bilər — yalnız istifadə sayı göstərilsəydi mexanizm həmişə
 * uğurlu görünərdi.
 */
export interface TaskTemplateRow {
  id: string
  taskType: string
  workerPrompt: string
  rubric: string
  authoredByModelId: string
  /** `null` = bir dəfəlik investisiyanın xərci bilinmir. */
  authoringCostUsd: number | null
  uses: number
  escalationsAfter: number
  createdAt: number
  lastUsedAt: number | null
}

/**
 * İzolyasiya edilmiş worktree-dəki dəyişiklik.
 *
 * `status: 'pending'` = diff DİSKDƏ gözləyir və əsas repoya HEÇ NƏ yazılmayıb.
 * Qəbul/rədd istifadəçinin qərarıdır: paralel agentlər eyni faylı fərqli cür
 * dəyişə bilər və hansının qalacağını yalnız insan bilir.
 */
export interface ArtifactRow {
  id: number
  taskId: string
  kind: string
  worktreePath: string
  branch: string
  repoPath: string
  content: string
  files: number
  /** `true` = diff hədd aşıb kəsilib və TƏTBİQ EDİLƏ BİLMƏZ, yalnız baxış üçündür. */
  truncated: boolean
  /**
   * Diff-dəki ikili (binary) fayllar — boş massiv = yoxdur (issue #41).
   *
   * `truncated` kimi TƏTBİQİ BLOKLAYIR: `git apply` `Binary files … differ`
   * sətrini tətbiq edə bilmir və patch-i BÜTÖV rədd edir, yəni bir PNG yanındakı
   * mətn dəyişikliklərini də itirər. Sütunda saxlanılmır, cavabda hesablanır.
   */
  binaryFiles: string[]
  status: string
  createdAt: number
  resolvedAt: number | null
}

/** Faza 4 — bölünmüş taskın parçası. */
export interface SubtaskRow {
  id: string
  prompt: string
  status: string
  taskType: string
  /** Sıra nömrəsi, 0-dan. Bölgü müqaviləsi məhz SIRADIR. */
  subtaskIndex: number | null
  /** Statusun izahı — icra OLMAYAN hallar üçün (məs. büdcə bitib başlamayıb). */
  statusReason: string | null
  createdAt: number
  completedAt: number | null
}

export interface TaskDetail {
  task: {
    id: string
    prompt: string
    status: string
    /** Bu task başqa taskın parçasıdırsa valideynin id-si (Faza 4). */
    parentTaskId: string | null
    /**
     * Statusun izahı — `null` = izah yoxdur.
     *
     * `runs[].errorMessage` YALNIZ icra olan taskda mövcuddur; bu sahə isə icra
     * OLMAYAN halları izah edir (bölünmüş taskda büdcə bitəndə qalan parçalar).
     */
    statusReason: string | null
    createdAt: number
    completedAt: number | null
  }
  routing: RoutingDecisionRow | null
  routingHistory: RoutingDecisionRow[]
  artifacts: ArtifactRow[]
  /** Faza 3 — bu taskda yaddaşın etdiyi işlər (boş massiv = yaddaş işə düşməyib). */
  memory: MemoryOpRow[]
  /** Faza 4 — alt-task ağacı. Bölünməmiş taskda boş massiv. */
  subtasks: SubtaskRow[]
  /** Faza 5B — işçinin verdiyi suallar (cavablanmışlar da daxil). */
  questions: QuestionRow[]
  /** Faza 5B — istifadəçinin yazdığı rəylər. */
  reviews: ReviewRow[]
  runs: RunRow[]
}

export interface MemoryOpRow {
  id: number
  provider: string
  /** `recall` | `remember` */
  kind: string
  scope: string
  items: number
  tokens: number
  /** `null` = xərc BİLİNMİR (qayda 4). */
  costUsd: number | null
  ok: boolean
  detail: string | null
  at: number
}

export const api = {
  health: () => request<{ ok: boolean; runners: string[] }>('/api/health'),
  listContexts: () => request<ContextRow[]>('/api/contexts'),
  createContext: (body: CreateContextBody) =>
    request<ContextRow>('/api/contexts', { method: 'POST', body: JSON.stringify(body) }),
  listProviders: () => request<ProvidersResponse>('/api/providers'),

  /**
   * Qovluq brauzeri (Faza 5A) — bir səviyyə, yalnız qovluqlar.
   *
   * Brauzerin öz seçiciləri bu iş üçün yararsızdır: `showDirectoryPicker()`
   * mütləq yolu QƏSDƏN gizlədir, `<input webkitdirectory>` isə nisbi yol verir.
   */
  listDir: (path?: string) =>
    request<FsListResponse>(
      path === undefined ? '/api/fs/list' : `/api/fs/list?path=${encodeURIComponent(path)}`,
    ),

  checkDir: (path: string) =>
    request<FsCheckResponse>(`/api/fs/check?path=${encodeURIComponent(path)}`),

  listMcpServers: () => request<{ servers: McpServerRow[] }>('/api/mcp-servers'),
  listAvailableMcpServers: () =>
    request<{ servers: AvailableMcpRow[] }>('/api/mcp-servers/available'),
  createMcpServer: (body: CreateMcpServerBody) =>
    request<McpServerRow>('/api/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteMcpServer: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),

  listPlugins: () => request<{ plugins: PluginRow[] }>('/api/plugins'),

  /**
   * Bütün kontekstlərin fərdiləşdirmə seçimi — BİR sorğuda.
   * Kontekst başına sorğu `/contexts` səhifəsində N+1 olardı.
   */
  listContextCustomizations: () =>
    request<Record<string, { mcpServerIds: string[]; pluginIds: string[] }>>(
      '/api/contexts/customizations',
    ),
  createPlugin: (body: CreatePluginBody) =>
    request<PluginRow>('/api/plugins', { method: 'POST', body: JSON.stringify(body) }),
  deletePlugin: (id: string) =>
    request<{ ok: boolean }>(`/api/plugins/${id}`, { method: 'DELETE' }),

  /** Canlı zolağın başlanğıc anlıq şəkli — WS yalnız dəyişiklikləri yayır. */
  listActiveRuns: () => request<{ runs: ActiveRunRow[] }>('/api/runs/active'),

  /**
   * Gözləyən suallar (Faza 5B) — `LiveBar` nişanı üçün.
   *
   * `/api/runs/active`-dən HESABLANA BİLMƏZ: sualı verən icra artıq bitib.
   */
  listPendingQuestions: () =>
    request<{ questions: QuestionRow[] }>('/api/questions/pending'),

  answerQuestion: (
    taskId: string,
    questionId: string,
    answer: boolean | string | string[],
  ) =>
    request<{ ok: boolean; delivered: boolean }>(
      `/api/tasks/${taskId}/questions/${questionId}/answer`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),

  createReview: (taskId: string, body: CreateReviewBody) =>
    request<{ ok: boolean; applied: string }>(`/api/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listModels: (providerId?: string) =>
    request<ModelRow[]>(
      providerId === undefined ? '/api/models' : `/api/models?provider=${providerId}`,
    ),

  /**
   * Açar YALNIZ bu istiqamətdə hərəkət edir. Cavabda açar qaytarılmır və
   * heç bir yerdə keşlənmir — çağıran onu göndərdikdən sonra unutmalıdır.
   */
  setCredential: (providerId: string, apiKey: string) =>
    request<DiscoveryResult>(`/api/providers/${providerId}/credential`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  deleteCredential: (providerId: string) =>
    request<{ ok: boolean }>(`/api/providers/${providerId}/credential`, {
      method: 'DELETE',
    }),

  discoverModels: (providerId: string) =>
    request<DiscoveryResult>(`/api/providers/${providerId}/discover`, { method: 'POST' }),

  /**
   * `exclusive` yalnız `worker` üçün: bu model TƏK işçi olsun.
   *
   * İdarə panelindəki dropdown bunu işlədir (tək seçim), `/providers`-dəki
   * checkbox isə işlətmir (çoxlu işçi qanunidir).
   */
  setModelRole: (
    id: string,
    role: 'boss' | 'worker' | 'classifier',
    value: boolean,
    exclusive?: boolean,
  ) =>
    request<ModelRow>('/api/models/role', {
      method: 'POST',
      body: JSON.stringify({ id, role, value, ...(exclusive === true ? { exclusive } : {}) }),
    }),

  setModelEnabled: (id: string, enabled: boolean) =>
    request<ModelRow>('/api/models/enabled', {
      method: 'POST',
      body: JSON.stringify({ id, enabled }),
    }),

  refreshCatalog: () =>
    request<{ ok: boolean; providerCount: number }>('/api/registry/refresh', {
      method: 'POST',
    }),

  /** Kataloqda olan, amma hələ əlavə edilməmiş provayderlər (issue #44). */
  availableProviders: () =>
    request<{ providers: AvailableProviderRow[]; catalogSource: string }>(
      '/api/providers/available',
    ),

  /**
   * Kataloqdan provayder əlavə edir.
   *
   * `apiKey` OPSİONALDIR — lokal provayderlər (Ollama, LM Studio) onu tələb
   * etmir. Açar cavabda QAYTARILMIR və yalnız bu istiqamətdə hərəkət edir.
   */
  addProvider: (id: string, apiKey?: string) =>
    request<DiscoveryResult>('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id, ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}) }),
    }),
  getSavings: (period: StatsPeriod = 'month') =>
    request<{ period: StatsPeriod; since?: number; summary: SavingsSummary; tasks: SavingsTaskRow[] }>(
      `/api/stats/savings?period=${period}`,
    ),

  getRoutingRules: () =>
    request<{
      rules: RoutingRuleRow[]
      profiles: string[]
      /** Profil → aktiv pillə nömrələri. Həqiqət mənbəyi serverdədir. */
      profileRungs: Record<string, number[]>
    }>('/api/routing/rules'),

  listTemplates: () => request<{ templates: TaskTemplateRow[] }>('/api/templates'),

  getMemoryStatus: () => request<MemoryStatus>('/api/memory'),

  updateContext: (id: string, body: UpdateContextBody) =>
    request<ContextRow>(`/api/contexts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  createTask: (body: CreateTaskBody) =>
    request<{ taskId: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  getTask: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  cancelTask: (id: string) =>
    request<{ cancelled: string[] }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),

  /** Diff-i əsas repoya tətbiq edir. Münaqişədə 409 → `request` throw edir. */
  acceptDiff: (taskId: string) =>
    request<{ ok: boolean; files: number }>(`/api/tasks/${taskId}/diff/accept`, {
      method: 'POST',
    }),

  /** Diff-i atır və worktree-ni silir. Əsas repoya heç nə yazılmır. */
  rejectDiff: (taskId: string) =>
    request<{ ok: boolean }>(`/api/tasks/${taskId}/diff/reject`, { method: 'POST' }),

  // ── Workflow zəncirləri (Faza 4) ─────────────────────────────────────
  listWorkflows: () => request<{ workflows: WorkflowRow[] }>('/api/workflows'),
  getWorkflow: (id: string) =>
    request<{ workflow: WorkflowRow; runs: WorkflowRunRow[] }>(`/api/workflows/${id}`),
  createWorkflow: (body: CreateWorkflowBody) =>
    request<{ workflow: WorkflowRow }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWorkflow: (id: string, body: UpdateWorkflowBody) =>
    request<{ workflow: WorkflowRow }>(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  runWorkflow: (id: string, body: RunWorkflowBody = {}) =>
    request<{ workflowRunId: string }>(`/api/workflows/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getWorkflowRun: (id: string) =>
    request<{ run: WorkflowRunRow; steps: WorkflowStepRunRow[] }>(
      `/api/workflow-runs/${id}`,
    ),

  listSchedules: () => request<{ schedules: ScheduleRow[] }>('/api/schedules'),
  createSchedule: (body: CreateScheduleBody) =>
    request<{ schedule: ScheduleRow }>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSchedule: (id: string, body: UpdateScheduleBody) =>
    request<{ schedule: ScheduleRow }>(`/api/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
}
