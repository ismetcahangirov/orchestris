import { z } from 'zod'

/**
 * Vahid hadisə axını. Hər Runner (CLI və ya API) çıxışını bu formata
 * çevirir. Router, ledger, WebSocket və UI YALNIZ bunu görür — CLI-a və
 * ya provayderə xas heç bir sahə buradan kənara çıxmır.
 */
export const RunEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), delta: z.string() }),
  z.object({ t: z.literal('think'), delta: z.string() }),
  z.object({
    t: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    t: z.literal('result'),
    id: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
  }),
  z.object({
    t: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative(),
  }),
  /**
   * CLI-dan pulsuz gələn rate-limit siqnalı. Kor-koranə backoff yerinə
   * `resetsAt`-a görə gözləmək üçün istifadə olunur.
   */
  z.object({
    t: z.literal('rate_limit'),
    status: z.string(),
    limitType: z.string(),
    resetsAt: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('done'),
    sessionId: z.string().optional(),
    stopReason: z.string(),
  }),
  z.object({
    t: z.literal('error'),
    class: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
])

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventKind = RunEvent['t']
