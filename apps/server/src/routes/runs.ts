import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { listActiveRuns } from '../db/repo.js'

/**
 * Canlı zolağın BAŞLANĞIC vəziyyəti (Faza 5A).
 *
 * WS yalnız DƏYİŞİKLİKLƏRİ yayır — səhifə açılanda artıq işləyən icralar
 * barədə heç bir mesaj gəlməzdi. Anlıq şəkil olmasaydı, zolaq yalnız növbəti
 * icra başlayanda dolardı və istifadəçi işləyən taskı görməzdi.
 */
export function registerRunRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/runs/active', async () => ({ runs: listActiveRuns(db) }))
}
