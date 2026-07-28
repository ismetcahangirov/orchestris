import { z } from 'zod'
import { RunEventSchema } from './events.js'

export const CreateContextBody = z.object({
  name: z.string().min(1).max(200),
  cwd: z.string().optional(),
  verifyCommands: z.array(z.string()).optional(),
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
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
})
export type CreateTaskBody = z.infer<typeof CreateTaskBody>

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
})
export type SetModelRoleBody = z.infer<typeof SetModelRoleBody>

export const SetModelEnabledBody = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
})
export type SetModelEnabledBody = z.infer<typeof SetModelEnabledBody>

/** Klientdən serverə gedən WebSocket mesajları */
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), taskId: z.string() }),
  z.object({ type: z.literal('cancel'), runId: z.string() }),
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
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type WsServerMessage = z.infer<typeof WsServerMessage>
