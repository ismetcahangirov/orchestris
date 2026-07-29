import { ClaudeMemProvider, type ClaudeMemConfig } from './claude-mem.js'
import type { MemoryProvider } from './provider.js'

/**
 * Yaddaş provayderinin env ilə qurulması (yalnız `main.ts`).
 *
 * NİYƏ ENV, NİYƏ UI DEYİL: provayderin seçimi bir dəfəlik quraşdırma
 * qərarıdır və XARİCİ prosesə (claude-mem worker-i) qoşulur. UI-dan bir
 * kliklə açılan xüsusiyyət olsaydı, istifadəçi taskların mətninin hara
 * getdiyini bilmədən onu aça bilərdi. Kontekst səviyyəsindəki opt-out isə
 * UI-dadır (`contexts.memory_enabled`) — o, artıq verilmiş razılığı geri
 * götürməkdir, yeni razılıq vermək yox.
 *
 * Verilməyəndə `undefined` qaytarır: yaddaş SÖNDÜRÜLÜB, davranış Faza 2 ilə
 * eynidir.
 */
export function memoryFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryProvider | undefined {
  const kind = env['ORCHESTRIS_MEMORY']?.trim()
  if (kind === undefined || kind === '' || kind === 'off' || kind === 'null') return undefined
  if (kind !== 'claude-mem') {
    throw new Error(`ORCHESTRIS_MEMORY: naməlum provayder "${kind}" (gözlənilən: claude-mem)`)
  }

  const config: Partial<ClaudeMemConfig> = {
    ...(env['ORCHESTRIS_CLAUDE_MEM_URL'] !== undefined
      ? { baseUrl: env['ORCHESTRIS_CLAUDE_MEM_URL'] }
      : {}),
    // Minimum versiya TƏLƏB OLUNUR (bax `claude-mem.ts`): verilməsə `health()`
    // `ok: false` qaytarır və yaddaş praktiki olaraq söndürülü qalır. Burada
    // xəta atmırıq — server yaddaşsız da tam işləkdir.
    ...(env['ORCHESTRIS_CLAUDE_MEM_MIN_VERSION'] !== undefined
      ? { minVersion: env['ORCHESTRIS_CLAUDE_MEM_MIN_VERSION'] }
      : {}),
    ...(env['ORCHESTRIS_MEMORY_WRITE_COST_USD'] !== undefined
      ? { declaredWriteCostUsd: Number(env['ORCHESTRIS_MEMORY_WRITE_COST_USD']) }
      : {}),
  }

  return new ClaudeMemProvider({ config })
}
