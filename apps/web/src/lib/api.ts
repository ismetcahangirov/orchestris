import type { CreateContextBody, CreateTaskBody, RunEvent } from '@orchestris/shared'

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

export interface ProviderRow {
  id: string
  kind: string
  installed: boolean
  authenticated: boolean
  version?: string
  execPath?: string
  detail: string
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

export interface TaskDetail {
  task: { id: string; prompt: string; status: string; createdAt: number }
  runs: RunRow[]
}

export const api = {
  health: () => request<{ ok: boolean; runners: string[] }>('/api/health'),
  listContexts: () => request<ContextRow[]>('/api/contexts'),
  createContext: (body: CreateContextBody) =>
    request<ContextRow>('/api/contexts', { method: 'POST', body: JSON.stringify(body) }),
  listProviders: () => request<ProviderRow[]>('/api/providers'),
  createTask: (body: CreateTaskBody) =>
    request<{ taskId: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  getTask: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  cancelTask: (id: string) =>
    request<{ cancelled: string[] }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
}
