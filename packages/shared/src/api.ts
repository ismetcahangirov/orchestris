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
  /** Boş buraxılsa server mövcud runner-lərdən birincisini seçir. */
  runner: z.enum(['cli:claude', 'cli:codex', 'fake']).optional(),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
})
export type CreateTaskBody = z.infer<typeof CreateTaskBody>

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
