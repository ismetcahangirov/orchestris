import type {
  CreateContextBody,
  CreateTaskBody,
  RunEvent,
  UpdateContextBody,
} from '@orchestris/shared'

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
  createdAt: number
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

export interface TaskDetail {
  task: { id: string; prompt: string; status: string; createdAt: number }
  routing: RoutingDecisionRow | null
  routingHistory: RoutingDecisionRow[]
  runs: RunRow[]
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
    request<{ rules: RoutingRuleRow[]; profiles: string[] }>('/api/routing/rules'),

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
}
