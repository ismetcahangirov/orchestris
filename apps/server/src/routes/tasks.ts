import { CreateTaskBody, type Runner } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import {
  createTask,
  getContext,
  getTask,
  listEvents,
  listRunsForTask,
  listVerifications,
} from '../db/repo.js'
import type { BudgetLimits } from '../exec/budget.js'
import type { Ladder } from '../exec/ladder.js'
import type { RunSupervisor } from '../exec/supervisor.js'

export interface TaskRouteDeps {
  db: Db
  supervisor: RunSupervisor
  ladder: Ladder
  runners: ReadonlyMap<string, Runner>
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { db, supervisor, runners } = deps

  app.post('/api/tasks', async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    const body = parsed.data

    const ctx = getContext(db, body.contextId)
    if (ctx === undefined) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }

    const runnerId = body.runner ?? [...runners.keys()][0]
    const runner = runnerId !== undefined ? runners.get(runnerId) : undefined
    if (runner === undefined) {
      return reply.code(400).send({
        error: `Runner mövcud deyil: ${runnerId ?? '(yoxdur)'}`,
        available: [...runners.keys()],
      })
    }

    const task = createTask(db, { contextId: body.contextId, prompt: body.prompt })

    // Sorğuda verilən limit kontekstin default-unu üstələyir.
    const limits: BudgetLimits = {
      ...(body.maxOutputTokens !== undefined
        ? { maxOutputTokens: body.maxOutputTokens }
        : ctx.budgetTokens !== null
          ? { maxOutputTokens: ctx.budgetTokens }
          : {}),
      ...(body.maxSeconds !== undefined
        ? { maxSeconds: body.maxSeconds }
        : ctx.budgetSeconds !== null
          ? { maxSeconds: ctx.budgetSeconds }
          : {}),
      ...(body.maxCostUsd !== undefined
        ? { maxCostUsd: body.maxCostUsd }
        : ctx.budgetUsd !== null
          ? { maxCostUsd: ctx.budgetUsd }
          : {}),
    }

    // İcra fon rejimində gedir — HTTP cavabı onu gözləmir. Vəziyyət WebSocket
    // və `GET /api/tasks/:id` vasitəsilə izlənilir.
    void deps.ladder
      .run({
        task: { id: task.id, prompt: body.prompt },
        context: {
          id: ctx.id,
          cwd: ctx.cwd,
          verifyCommandsJson: ctx.verifyCommandsJson,
        },
        runner,
        model: body.model,
        limits,
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'ladder.run tutulmamış xəta')
      })

    return reply.code(202).send({ taskId: task.id })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })

    return {
      task,
      runs: listRunsForTask(db, task.id).map((r) => ({
        ...r,
        events: listEvents(db, r.id),
        verifications: listVerifications(db, r.id),
      })),
    }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })

    const cancelled = listRunsForTask(db, task.id)
      .filter((r) => r.status === 'running')
      .filter((r) => supervisor.cancel(r.id))
      .map((r) => r.id)

    return { cancelled }
  })

  app.get('/api/providers', async () =>
    Promise.all(
      [...runners.entries()].map(async ([id, runner]) => ({
        id,
        kind: runner.kind,
        capabilities: runner.capabilities,
        ...(await runner.detect()),
      })),
    ),
  )
}
