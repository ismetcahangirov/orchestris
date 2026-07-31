import {
  FILE_ACCESS_LEVELS,
  type FileAccess,
  type FileAccessLevel,
} from '@orchestris/shared'

/**
 * Tanınmayan dəyər üçün geri düşülən səviyyə.
 *
 * `'read-only'` DEYİL: bazadakı bir korlanmış sətir bütün icraların səssizcə
 * fayla toxunmamasına səbəb olardı və istifadəçi səbəbini heç yerdə görməzdi.
 * `'workspace'` isə Faza 5A-dan ƏVVƏLKİ faktiki davranışdır (`main.ts`-dəki
 * sabit `acceptEdits`).
 */
const FALLBACK_LEVEL: FileAccessLevel = 'workspace'

function isLevel(v: string): v is FileAccessLevel {
  return (FILE_ACCESS_LEVELS as readonly string[]).includes(v)
}

/**
 * `contexts.extra_dirs_json` sütununu oxuyur.
 *
 * HEÇ VAXT ATMIR: sütun istifadəçinin əl ilə redaktə edə biləcəyi mətndir və
 * bir sınıq sətir bütün taskları dayandırmamalıdır. Səhv məzmun "əlavə qovluq
 * yoxdur" kimi oxunur — bu, səhvin UCUZ istiqamətidir (icazə genişlənmir,
 * daralır).
 */
export function parseExtraDirs(json: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

export interface FileAccessInput {
  /** `contexts.file_access` sütunu — xam mətn, hələ təsdiqlənməmiş. */
  fileAccess: string
  /** `contexts.extra_dirs_json` sütunu. */
  extraDirsJson: string
  /** İcranın FAKTİKİ qovluğu — izolyasiya varsa worktree yolu. */
  cwd: string | undefined
}

/**
 * Kontekstin icazə ayarını runner-dən asılı olmayan formaya çevirir.
 *
 * Model çağırışı yoxdur — **0 token**.
 */
export function resolveFileAccess(input: FileAccessInput): FileAccess {
  const level = isLevel(input.fileAccess) ? input.fileAccess : FALLBACK_LEVEL

  const dirs = new Set<string>()
  if (input.cwd !== undefined) dirs.add(input.cwd)
  // Əlavə qovluqlar YALNIZ `extended`-də oxunur. Səviyyə aşağı salınanda
  // siyahı bazada QALIR (istifadəçi geri qaytaranda yenidən yazmasın), sadəcə
  // tətbiq olunmur.
  if (level === 'extended') {
    for (const d of parseExtraDirs(input.extraDirsJson)) dirs.add(d)
  }

  return { level, dirs: [...dirs].sort() }
}
