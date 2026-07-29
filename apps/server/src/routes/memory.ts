import type { FastifyInstance } from 'fastify'
import { MEMORY_TOKEN_BUDGET } from '../memory/budget.js'
import type { MemoryProvider } from '../memory/provider.js'

export interface MemoryRouteDeps {
  provider: MemoryProvider
  /** Yaddaş nərdivana QOŞULUBMU. Provayder olsa da qoşulmaya bilər (testlər). */
  active: boolean
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  /**
   * Yaddaşın vəziyyəti.
   *
   * `health()` hər sorğuda YENİDƏN çağırılır, keşlənmir: bu route yalnız
   * istifadəçi `/ladder` səhifəsini açanda işləyir və "yaddaş işləyir" cavabı
   * KÖHNƏ olsa, istifadəçi sınmış yaddaşla işlədiyini bilməzdi. Sorğu lokal
   * worker-ə gedir və timeout ilə məhdudlaşıb (`claude-mem.ts`).
   */
  app.get('/api/memory', async () => ({
    provider: deps.provider.id,
    active: deps.active,
    // Hədd konteksdən ASILI DEYİL (bax `memory/budget.ts`) — UI onu tək
    // mənbədən götürür ki, səhifə öz rəqəmini uydurmasın.
    tokenBudget: MEMORY_TOKEN_BUDGET,
    health: await deps.provider.health(),
  }))

}
