import {
  CreateScheduleBody,
  CreateWorkflowBody,
  RunWorkflowBody,
  UpdateScheduleBody,
  UpdateWorkflowBody,
} from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { getContext } from '../db/repo.js'
import {
  createSchedule,
  createWorkflow,
  getSchedule,
  getWorkflow,
  getWorkflowRun,
  listSchedules,
  listStepRuns,
  listWorkflowRuns,
  listWorkflows,
  parseSteps,
  updateSchedule,
  updateWorkflow,
} from '../db/workflow-repo.js'
import type { BudgetLimits } from '../exec/budget.js'
import type { WorkflowEngine } from '../exec/workflow-engine.js'

export interface WorkflowRouteDeps {
  db: Db
  /** Verilməsə icra route-ları 503 qaytarır (motorsuz zəncir redaktə oluna bilər). */
  engine?: WorkflowEngine
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const { db } = deps

  app.get<{ Querystring: { contextId?: string } }>('/api/workflows', async (req) => {
    const rows = listWorkflows(db, req.query.contextId)
    return {
      workflows: rows.map((w) => ({
        ...w,
        // Son icra siyahı ilə birlikdə gedir: istifadəçinin ilk sualı "sonuncu
        // dəfə nə oldu?" olur və ayrıca sorğu N+1 sorğu yaradardı.
        lastRun: listWorkflowRuns(db, w.id, 1)[0] ?? null,
      })),
    }
  })

  app.post('/api/workflows', async (req, reply) => {
    const parsed = CreateWorkflowBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    if (getContext(db, parsed.data.contextId) === undefined) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }
    return reply.code(201).send({ workflow: createWorkflow(db, parsed.data) })
  })

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const workflow = getWorkflow(db, req.params.id)
    if (workflow === undefined) return reply.code(404).send({ error: 'Zəncir tapılmadı' })
    return {
      workflow,
      runs: listWorkflowRuns(db, workflow.id),
    }
  })

  app.patch<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const parsed = UpdateWorkflowBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    if (getWorkflow(db, req.params.id) === undefined) {
      return reply.code(404).send({ error: 'Zəncir tapılmadı' })
    }
    return { workflow: updateWorkflow(db, req.params.id, parsed.data) }
  })

  /**
   * Zənciri işə salır.
   *
   * `202` qaytarılır və icra FON rejimindədir — zəncir onlarla dəqiqə çəkə
   * bilər, HTTP cavabını gözlətmək brauzeri asardı. Vəziyyət
   * `GET /api/workflow-runs/:id` ilə izlənilir.
   */
  app.post<{ Params: { id: string } }>('/api/workflows/:id/run', async (req, reply) => {
    const parsed = RunWorkflowBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const workflow = getWorkflow(db, req.params.id)
    if (workflow === undefined) return reply.code(404).send({ error: 'Zəncir tapılmadı' })
    if (workflow.archivedAt !== null) {
      return reply.code(409).send({ error: 'Arxivləşdirilmiş zəncir işə salına bilmir' })
    }
    if (deps.engine === undefined) {
      return reply.code(503).send({ error: 'Zəncir motoru qurulmayıb' })
    }

    const ctx = getContext(db, workflow.contextId)
    if (ctx === undefined) return reply.code(404).send({ error: 'Kontekst tapılmadı' })

    // Tərif İCRADAN ƏVVƏL validasiya olunur: JSON sütun sxem təminatı vermir və
    // səhv tərif icranın ORTASINDA — yəni pul yandıqdan sonra — üzə çıxardı.
    const steps = parseSteps(workflow)
    if (steps === null) {
      return reply.code(422).send({ error: 'Zəncir tərifi oxunmadı — addımları yenidən yazın' })
    }

    const body = parsed.data
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

    const started = deps.engine.start({
      workflowId: workflow.id,
      steps,
      trigger: 'manual',
      context: {
        id: ctx.id,
        cwd: ctx.cwd,
        verifyCommandsJson: ctx.verifyCommandsJson,
        amplificationProfile: ctx.amplificationProfile,
        defaultWorkerModelId: ctx.defaultWorkerModelId,
        maxParallel: ctx.maxParallel,
        memoryScope: ctx.memoryScope,
        memoryEnabled: ctx.memoryEnabled,
      },
      ...(body.input !== undefined ? { input: body.input } : {}),
      limits,
    })

    // İcra FON rejimindədir; `start()` sətri sinxron yaradıb id-ni dərhal verir.
    void started.done.catch((err: unknown) => {
      app.log.error({ err }, 'workflow.run tutulmamış xəta')
    })

    return reply.code(202).send({ workflowRunId: started.workflowRunId })
  })

  app.get<{ Params: { id: string } }>('/api/workflow-runs/:id', async (req, reply) => {
    const run = getWorkflowRun(db, req.params.id)
    if (run === undefined) return reply.code(404).send({ error: 'İcra tapılmadı' })
    return { run, steps: listStepRuns(db, run.id) }
  })

  // ── Cədvəl üzrə icra ────────────────────────────────────────────────
  app.get<{ Querystring: { workflowId?: string } }>('/api/schedules', async (req) => ({
    schedules: listSchedules(db, req.query.workflowId),
  }))

  /**
   * Cədvəl yaradır.
   *
   * Hər üç limit MƏCBURİDİR və bu, sxemdə (`CreateScheduleBody`) təmin olunur —
   * route-da əlavə yoxlama yoxdur, çünki bir təminatın iki yerdə saxlanması
   * onların ayrılmasının ən qısa yoludur. Səbəb issue #12-dədir: nəzarətsiz
   * cədvəl "$0.50 testdə → $50,000/ay" ssenarisinin ən asan yoludur.
   */
  app.post('/api/schedules', async (req, reply) => {
    const parsed = CreateScheduleBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const workflow = getWorkflow(db, parsed.data.workflowId)
    if (workflow === undefined) return reply.code(404).send({ error: 'Zəncir tapılmadı' })
    if (workflow.archivedAt !== null) {
      return reply.code(409).send({ error: 'Arxivləşdirilmiş zəncirə cədvəl qurulmur' })
    }
    return reply.code(201).send({ schedule: createSchedule(db, parsed.data) })
  })

  app.patch<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
    const parsed = UpdateScheduleBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    if (getSchedule(db, req.params.id) === undefined) {
      return reply.code(404).send({ error: 'Cədvəl tapılmadı' })
    }
    return { schedule: updateSchedule(db, req.params.id, parsed.data) }
  })
}
