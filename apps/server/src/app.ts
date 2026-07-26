import { WsClientMessage, type Runner } from '@orchestris/shared'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { getRunTaskId, getTask, markOrphanedRunsInterrupted } from './db/repo.js'
import { RunSupervisor } from './exec/supervisor.js'
import { registerContextRoutes } from './routes/contexts.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { WsHub } from './ws/hub.js'

export interface BuildAppInput {
  db: Db
  runners: ReadonlyMap<string, Runner>
  logger?: boolean
}

export function buildApp(input: BuildAppInput): FastifyInstance {
  const app = Fastify({ logger: input.logger ?? false })
  const { db, runners } = input

  // Server çökdükdən sonra qalan yetim icraları təmizlə. Hadisə jurnalı itmir.
  const orphans = markOrphanedRunsInterrupted(db)
  if (orphans > 0) app.log.warn(`${orphans} yetim icra interrupted işarələndi`)

  const hub = new WsHub()
  const supervisor = new RunSupervisor(db)

  // runId → taskId çevirməsi keşlənir: hər hadisə üçün DB sorğusu artıqdır.
  const runToTask = new Map<string, string>()
  supervisor.onEvent((runId, stored) => {
    let taskId = runToTask.get(runId)
    if (taskId === undefined) {
      taskId = getRunTaskId(db, runId)
      if (taskId !== undefined) runToTask.set(runId, taskId)
    }
    if (taskId === undefined) return
    hub.broadcast(taskId, {
      type: 'event',
      taskId,
      runId,
      seq: stored.seq,
      at: stored.at,
      event: stored.event,
    })
  })

  app.get('/api/health', async () => ({ ok: true, runners: [...runners.keys()] }))

  registerContextRoutes(app, db)
  registerTaskRoutes(app, { db, supervisor, runners })

  void app.register(websocket)
  void app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (conn) => {
      const socket = { send: (data: string) => conn.send(data) }

      conn.on('message', (raw: Buffer) => {
        let msg: WsClientMessage
        try {
          msg = WsClientMessage.parse(JSON.parse(raw.toString('utf8')))
        } catch {
          socket.send(
            JSON.stringify({ type: 'error', message: 'Yanlış mesaj formatı' }),
          )
          return
        }

        if (msg.type === 'subscribe') {
          if (getTask(db, msg.taskId) === undefined) {
            socket.send(JSON.stringify({ type: 'error', message: 'Task tapılmadı' }))
            return
          }
          hub.subscribe(msg.taskId, socket)
        } else if (msg.type === 'unsubscribe') {
          hub.unsubscribe(msg.taskId, socket)
        } else {
          supervisor.cancel(msg.runId)
        }
      })

      conn.on('close', () => hub.removeSocket(socket))
    })
  })

  app.addHook('onClose', async () => {
    supervisor.cancelAll()
  })

  return app
}
