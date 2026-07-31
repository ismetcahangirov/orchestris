import { randomUUID } from 'node:crypto'
import { access, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

export interface FsEntry {
  name: string
  path: string
  /** `.git` FAYL və ya QOVLUQ kimi mövcuddur (CLAUDE.md qayda 44). */
  isRepo: boolean
  /** Nöqtə ilə başlayır — UI onu default gizlədir, server SİLMİR. */
  hidden: boolean
}

/**
 * Windows disk hərfləri.
 *
 * `A:` və `B:` QƏSDƏN yoxlanılmır: onlar tarixən disket sürücüləridir və
 * mövcud olmayan sürücüyə müraciət bəzi sistemlərdə aparat gözləməsinə səbəb
 * ola bilir. Layihə qovluğunun disketdə olma ehtimalı sıfırdır — yəni bu
 * yoxlamanın qiyməti var, faydası yoxdur.
 */
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function listDrives(): Promise<string[]> {
  if (platform() !== 'win32') return ['/']
  const found = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`
      return (await exists(root)) ? root : null
    }),
  )
  return found.filter((d): d is string => d !== null)
}

/**
 * Qovluq yolunu təsdiqləyir.
 *
 * Ağ siyahı QOYULMUR və bu qəsdəndir: seçicinin bütün mənası istifadəçinin
 * maşınındakı istənilən qovluğu seçə bilməsidir — ağ siyahı seçiciyə ehtiyacı
 * elə özü aradan qaldırardı. Yeganə qoruma serverin `127.0.0.1`-ə bind
 * olunmasıdır (CLAUDE.md qayda 16); sızma səthi isə qəsdən dardır: fayl ADLARI
 * yox (yalnız qovluqlar), fayl MƏZMUNU heç vaxt, rekursiya heç vaxt.
 */
function normalizePath(raw: string | undefined): string | null {
  const value = raw ?? homedir()
  if (value.trim() === '' || !isAbsolute(value)) return null
  return resolve(value)
}

/** Kök qovluqda `dirname` özünü qaytarır — "yuxarı yoxdur" deməkdir. */
function parentOf(p: string): string | null {
  const up = dirname(p)
  return up === p ? null : up
}

async function isDirectoryEntry(
  full: string,
  isDir: boolean,
  isLink: boolean,
): Promise<boolean> {
  if (isDir) return true
  // Symlink / junction: `readdir` `withFileTypes` `lstat` nəticəsini verir,
  // yəni qovluğa işarə edən keçid `isDirectory()` DEYİL. Windows-da
  // `node_modules/.pnpm` və oxşar junction-lar məhz belədir — filtrləsəydik
  // istifadəçinin real qovluqları siyahıdan səssizcə düşərdi. Sınıq keçid
  // atılır (rekursiya olmadığı üçün dövrə riski yoxdur).
  if (!isLink) return false
  try {
    return (await stat(full)).isDirectory()
  } catch {
    return false
  }
}

/**
 * REAL yazma probu.
 *
 * `fs.access(dir, W_OK)` İŞLƏDİLMİR: Node sənədi açıq yazır ki, Windows-da o,
 * qovluq ACL-lərini görmür — praktiki olaraq həmişə "yazılır" deyir. Yəni
 * cavab yalan olardı.
 *
 * Prob YALNIZ seçilmiş qovluq üçün qaçır. Siyahıdakı hər sətrə tətbiq
 * etsəydik, bir naviqasiya 50 disk əməliyyatı deməkdi.
 */
async function probeWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.orchestris-write-test-${randomUUID()}`)
  try {
    await writeFile(probe, '')
    return true
  } catch {
    return false
  } finally {
    // `force: true` — yazma alınmayıbsa fayl onsuz da yoxdur.
    await rm(probe, { force: true }).catch(() => undefined)
  }
}

export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req, reply) => {
    const path = normalizePath(req.query.path)
    if (path === null) {
      return reply.code(400).send({ error: 'Yol mütləq olmalıdır' })
    }

    let info
    try {
      info = await stat(path)
    } catch {
      return reply.code(404).send({ error: `Qovluq tapılmadı: ${path}` })
    }
    if (!info.isDirectory()) {
      return reply.code(400).send({ error: `Bu, qovluq deyil: ${path}` })
    }

    let raw
    try {
      raw = await readdir(path, { withFileTypes: true })
    } catch {
      return reply.code(403).send({ error: `Qovluq oxunmur: ${path}` })
    }

    const entries: FsEntry[] = []
    await Promise.all(
      raw.map(async (d) => {
        const full = join(path, d.name)
        if (!(await isDirectoryEntry(full, d.isDirectory(), d.isSymbolicLink()))) return
        entries.push({
          name: d.name,
          path: full,
          isRepo: await exists(join(full, '.git')),
          hidden: d.name.startsWith('.'),
        })
      }),
    )
    // `Promise.all` tamamlanma sırası ilə doldurur — siyahı ad üzrə sıralanır.
    entries.sort((a, b) => a.name.localeCompare(b.name))

    return { path, parent: parentOf(path), drives: await listDrives(), entries }
  })

  app.get<{ Querystring: { path?: string } }>('/api/fs/check', async (req, reply) => {
    if (req.query.path === undefined || req.query.path.trim() === '') {
      return reply.code(400).send({ error: 'path parametri məcburidir' })
    }
    const path = normalizePath(req.query.path)
    if (path === null) {
      return reply.code(400).send({ error: 'Yol mütləq olmalıdır' })
    }

    let info
    try {
      info = await stat(path)
    } catch {
      // 404 DEYİL: seçicidə hələ yazılmaqda olan yol da yoxlanılır və 404 UI-da
      // xəta kimi görünərdi, halbuki cavab sadəcə "hələ yoxdur"dur.
      return { path, exists: false, isDirectory: false, isRepo: false, writable: false }
    }
    if (!info.isDirectory()) {
      return { path, exists: true, isDirectory: false, isRepo: false, writable: false }
    }

    return {
      path,
      exists: true,
      isDirectory: true,
      isRepo: await exists(join(path, '.git')),
      writable: await probeWritable(path),
    }
  })
}
