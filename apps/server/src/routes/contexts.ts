import { CreateContextBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createContext, listContexts } from '../db/repo.js'

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
}
