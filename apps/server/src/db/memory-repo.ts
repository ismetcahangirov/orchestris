import { asc, eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { memoryOps } from './schema.js'

export type MemoryOp = typeof memoryOps.$inferSelect

export interface MemoryOpInput {
  taskId: string
  provider: string
  kind: 'recall' | 'remember'
  scope: string
  items: number
  tokens: number
  /** NULL = xərc BİLİNMİR (qayda 4). */
  costUsd: number | null
  ok: boolean
  detail?: string
  /** Test üçün — sabit vaxt. */
  at?: number
}

/**
 * Yaddaş əməliyyatını jurnala yazır.
 *
 * UĞURSUZ əməliyyat da yazılır: yaddaş sınıbsa task davam edir (yaddaş
 * optimallaşdırmadır), amma bunun izsiz qalması "yaddaş işləyir" illüziyası
 * yaradardı — istifadəçi cavabların niyə pisləşdiyini heç vaxt tapa bilməzdi.
 */
export function recordMemoryOp(db: Db, input: MemoryOpInput): void {
  db.insert(memoryOps)
    .values({
      taskId: input.taskId,
      provider: input.provider,
      kind: input.kind,
      scope: input.scope,
      items: input.items,
      tokens: input.tokens,
      costUsd: input.costUsd,
      ok: input.ok,
      detail: input.detail ?? null,
      at: input.at ?? Date.now(),
    })
    .run()
}

export function listMemoryOps(db: Db, taskId: string): MemoryOp[] {
  return db
    .select()
    .from(memoryOps)
    .where(eq(memoryOps.taskId, taskId))
    .orderBy(asc(memoryOps.at), asc(memoryOps.id))
    .all()
}

export interface MemoryCost {
  /** `null` = ən azı bir əməliyyatın xərci BİLİNMİR. */
  costUsd: number | null
  ops: number
}

/**
 * Taskın yaddaş xərci.
 *
 * NAMƏLUM XƏRC CƏMİ NAMƏLUM EDİR — `0` kimi keçmir. `summarizeSavings` eyni
 * prinsiplə işləyir (qayda 23): bir sətrin naməlumluğu bütün cəmi şübhəli
 * edir və bunu gizlətmək qənaət rəqəmini şişirdərdi.
 *
 * Heç bir əməliyyat olmayıbsa `0` qaytarılır və bu, "bilinmir" DEYİL: yaddaş
 * işə düşməyibsə xərci həqiqətən sıfırdır.
 */
export function memoryCostForTask(db: Db, taskId: string): MemoryCost {
  const ops = listMemoryOps(db, taskId)
  let total = 0
  let known = true

  for (const op of ops) {
    if (op.costUsd === null) {
      known = false
      continue
    }
    total += op.costUsd
  }

  return { costUsd: known ? total : null, ops: ops.length }
}
