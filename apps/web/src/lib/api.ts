import type {
  CreateContextBody,
  CreateTaskBody,
  CreateScheduleBody,
  CreateWorkflowBody,
  RunEvent,
  RunWorkflowBody,
  UpdateContextBody,
  UpdateScheduleBody,
  UpdateWorkflowBody,
} from '@orchestris/shared'

/** Faza 4 — cədvəl. Hər üç limit MƏCBURİDİR (issue #12). */
export interface ScheduleRow {
  id: string
  workflowId: string
  intervalSeconds: number
  enabled: boolean
  budgetUsdPerRun: number
  budgetUsdTotal: number
  maxRuns: number
  spentUsd: number
  runs: number
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
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
  /** `null` = avtomatik (kontekstin öz `id`-si). */
  memoryScope: string | null
  memoryEnabled: boolean
  createdAt: number
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

  setModelRole: (id: string, role: 'boss' | 'worker' | 'classifier', value: boolean) =>
    request<ModelRow>('/api/models/role', {
      method: 'POST',
      body: JSON.stringify({ id, role, value }),
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
