import { CreateContextBody, UpdateContextBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createContext, getContext, listContexts, updateContext } from '../db/repo.js'

export function registerContextRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/contexts', async () => listContexts(db))

  app.post('/api/contexts', async (req, reply) => {
    const parsed = CreateContextBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues })
    }
    const body = parsed.data
    return reply.code(201).send(
      createContext(db, {
        name: body.name,
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.verifyCommands !== undefined
          ? { verifyCommands: body.verifyCommands }
          : {}),
      }),
    )
  })

  /**
   * Ayarların QİSMƏN yenilənməsi — amplifikasiya profili, işçi rejimi,
   * default işçi, yoxlama əmrləri, büdcələr.
   *
   * Verilməyən sahə DƏYİŞMİR: istifadəçi profil dəyişəndə büdcəsini
   * itirməməlidir.
   */
  app.patch<{ Params: { id: string } }>('/api/contexts/:id', async (req, reply) => {
    const parsed = UpdateContextBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    if (getContext(db, req.params.id) === undefined) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }

    return reply.send(updateContext(db, req.params.id, parsed.data))
  })
}
