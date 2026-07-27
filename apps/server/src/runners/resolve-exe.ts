import { existsSync, readFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export interface ResolvedExecutable {
  /** spawn()-a veriləcək əmr */
  command: string
  /** true olarsa spawn `shell: true` ilə çağırılmalıdır */
  useShell: boolean
  via: 'direct-exe' | 'cmd-shim' | 'shell-fallback' | 'posix'
}

/**
 * npm-in Windows `.cmd` shim-i hədəf `.exe`-nin yolunu `%dp0%`-a nisbətən
 * saxlayır. Onu oxuyub mütləq yola çeviririk — belə olsa `shell: true`
 * lazım gəlmir və proses ağacını `taskkill /T` ilə etibarlı öldürürük.
 */
export function extractExeFromCmdShim(
  content: string,
  shimDir: string,
): string | null {
  // `"%dp0%\path\to\tool.exe"` və ya `"%~dp0\path\to\tool.exe"`
  const m = content.match(/"%~?dp0%?\\?([^"]+\.exe)"/i)
  if (!m?.[1]) return null
  // Shim-dəki `\` ayırıcılarını olduğu kimi saxlayırıq — Windows onları qəbul edir.
  return join(shimDir, m[1])
}

function pathDirs(explicit?: readonly string[]): readonly string[] {
  if (explicit) return explicit
  return (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
}

/**
 * Verilmiş adı icra edilə bilən fayla çevirir.
 *
 * Prioritet:
 *   1. PATH-da `<ad>.exe` — ən yaxşı hal, shell lazım deyil
 *   2. PATH-da `<ad>.cmd` — shim oxunur, hədəf `.exe` çıxarılır
 *   3. `.cmd` var, amma hədəf tapılmır — shell fallback
 *   4. POSIX: PATH-da uzantısız fayl
 */
export function resolveExecutable(
  name: string,
  explicitDirs?: readonly string[],
): ResolvedExecutable | null {
  const dirs = pathDirs(explicitDirs)

  if (isAbsolute(name) && existsSync(name)) {
    return { command: name, useShell: false, via: 'direct-exe' }
  }

  for (const dir of dirs) {
    const exe = resolve(dir, `${name}.exe`)
    if (existsSync(exe)) {
      return { command: exe, useShell: false, via: 'direct-exe' }
    }
  }

  for (const dir of dirs) {
    const cmd = resolve(dir, `${name}.cmd`)
    if (!existsSync(cmd)) continue
    const target = extractExeFromCmdShim(readFileSync(cmd, 'utf8'), dir)
    if (target && existsSync(target)) {
      return { command: target, useShell: false, via: 'cmd-shim' }
    }
    return { command: cmd, useShell: true, via: 'shell-fallback' }
  }

  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      const p = resolve(dir, name)
      if (existsSync(p)) {
        return { command: p, useShell: false, via: 'posix' }
      }
    }
  }

  return null
}
