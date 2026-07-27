import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/**
 * İş qovluğunun git vəziyyətinin qısa barmaq izi: HEAD commit + işçi ağacın
 * dəyişiklikləri.
 *
 * `git status --porcelain` izlənilməyən faylları da göstərir, ona görə yeni
 * fayl yaratmaq da barmaq izini dəyişir.
 *
 * Git repo deyilsə və ya git əlçatan deyilsə `null` qaytarır.
 */
export function repoFingerprint(cwd: string | undefined): string | null {
  if (cwd === undefined) return null
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return createHash('sha256').update(head).update('\0').update(dirty).digest('hex')
  } catch {
    return null
  }
}

export interface CacheKeyInput {
  prompt: string
  modelId: string
  runnerId: string
  /** Task fayl sisteminə toxunurmu? Toxunursa repo vəziyyəti açara girir. */
  needsFileAccess: boolean
  cwd?: string
}

/**
 * Determinist keş açarı, və ya keşləmək təhlükəlidirsə `null`.
 *
 * NİYƏ REPO VƏZİYYƏTİ AÇARA GİRİR: eyni prompt dəyişmiş kod üzərində fərqli
 * cavab tələb edir. Yalnız prompt-a görə keşləsək, "bu funksiyanı düzəlt"
 * taskı kod dəyişdikdən sonra köhnə cavabı qaytarardı — səssiz və təhlükəli
 * səhv. Fayl girişi olan task üçün repo vəziyyətini bilə bilmiriksə,
 * ÜMUMİYYƏTLƏ keşləmirik.
 */
export function computeCacheKey(input: CacheKeyInput): string | null {
  const h = createHash('sha256')
  h.update('orchestris-cache-v1\0')
  h.update(input.prompt.trim())
  h.update('\0')
  h.update(input.modelId)
  h.update('\0')
  h.update(input.runnerId)
  h.update('\0')

  if (input.needsFileAccess) {
    const fp = repoFingerprint(input.cwd)
    if (fp === null) return null
    h.update(fp)
  }

  return h.digest('hex')
}
