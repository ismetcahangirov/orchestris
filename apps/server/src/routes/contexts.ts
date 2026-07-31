import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CreateContextBody, UpdateContextBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createContext, getContext, listContexts, updateContext } from '../db/repo.js'

/**
 * Yolun MÖVCUD QOVLUQ olduğunu təsdiqləyir.
 *
 * Yoxlamasaydıq, səhv yazılmış (və ya artıq silinmiş) qovluq yalnız İLK TASK
 * İCRASINDA üzə çıxardı — o an istifadəçi artıq gözləyir və pul ödəyib.
 *
 * Boolean yox, xəta MƏTNİ qaytarır: "qovluq yoxdur" ilə "bu, fayldır" fərqli
 * səhvlərdir və istifadəçi hansını düzəldəcəyini bilməlidir.
 */
async function dirProblem(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return `Yol mütləq olmalıdır: ${path}`
  try {
    if (!(await stat(path)).isDirectory()) return `Bu, qovluq deyil: ${path}`
    return null
  } catch {
    return `Qovluq tapılmadı: ${path}`
  }
}

async function firstDirProblem(paths: readonly string[]): Promise<string | null> {
  for (const p of paths) {
    const problem = await dirProblem(p)
    if (problem !== null) return problem
  }
  return null
}

export function registerContextRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/contexts', async () => listContexts(db))

  app.post('/api/contexts', async (req, reply) => {
    const parsed = CreateContextBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues })
    }
    const body = parsed.data

    const problem = await firstDirProblem([
      ...(body.cwd !== undefined ? [body.cwd] : []),
      ...(body.extraDirs ?? []),
    ])
    if (problem !== null) return reply.code(400).send({ error: problem })

    return reply.code(201).send(
      createContext(db, {
        name: body.name,
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.verifyCommands !== undefined
          ? { verifyCommands: body.verifyCommands }
          : {}),
        ...(body.fileAccess !== undefined ? { fileAccess: body.fileAccess } : {}),
        ...(body.extraDirs !== undefined ? { extraDirs: body.extraDirs } : {}),
      }),
    )
  })

  /**
   * Ayarların QİSMƏN yenilənməsi — amplifikasiya profili, işçi rejimi,
   * default işçi, yoxlama əmrləri, büdcələr, iş qovluğu, fayl icazəsi.
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

    const body = parsed.data
    // `null` YOXLANILMIR: o, "iş qovluğunu sil" deməkdir və silinən yolun
    // mövcudluğu əhəmiyyətsizdir.
    const problem = await firstDirProblem([
      ...(typeof body.cwd === 'string' ? [body.cwd] : []),
      ...(body.extraDirs ?? []),
    ])
    if (problem !== null) return reply.code(400).send({ error: problem })

    return reply.send(updateContext(db, req.params.id, body))
  })
}
