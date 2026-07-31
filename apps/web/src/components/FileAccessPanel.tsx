import type { FileAccessLevel } from '@orchestris/shared'
import { useState } from 'react'
import FolderPicker from './FolderPicker.js'

/**
 * Səviyyələr paylaşılan tipdən gəlir — `string` YOX.
 *
 * `string` yazsaydıq, panel `updateContext`-in gözlədiyi birləşməyə uyğun
 * gəlməzdi və uyğunlaşdırmaq üçün `as` lazım olardı; o zaman panelə səhv
 * səviyyə yazmaq tip yoxlamasından səssizcə keçərdi.
 */
const LEVELS: readonly { value: FileAccessLevel; label: string; hint: string }[] = [
  {
    value: 'read-only',
    label: 'Yalnız-oxu',
    hint: 'Agent oxuyur və izah edir, fayla toxunmur',
  },
  { value: 'workspace', label: 'İş qovluğuna yaz', hint: 'Yalnız iş qovluğu' },
  {
    value: 'extended',
    label: 'İş qovluğu + əlavə qovluqlar',
    hint: 'Seçilmiş qovluqlar da yazıla bilir',
  },
]

export interface FileAccessContext {
  id: string
  cwd: string | null
  fileAccess: string
  extraDirsJson: string
}

interface Props {
  context: FileAccessContext
  onSave: (patch: { fileAccess?: FileAccessLevel; extraDirs?: string[] }) => void
}

function parseDirs(json: string): string[] {
  try {
    const raw: unknown = JSON.parse(json)
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Kontekstin fayl icazəsi (Faza 5A).
 *
 * Səviyyə HƏR İKİ CLI-ya EYNİ mənanı verir (`exec/file-access.ts`): əvvəl
 * claude yazırdı (`acceptEdits`), codex isə arqumentsiz qurulduğu üçün səssizcə
 * yazmırdı (`read-only`) — və bu fərq heç yerdə görünmürdü.
 */
export default function FileAccessPanel({ context, onSave }: Props): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const dirs = parseDirs(context.extraDirsJson)

  return (
    <div className="mt-3 space-y-1 border-t border-white/10 pt-3">
      <div className="text-xs font-medium text-ink-dim">Fayl icazəsi</div>

      {LEVELS.map((l) => (
        <label key={l.value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`file-access-${context.id}`}
            aria-label={l.label}
            checked={context.fileAccess === l.value}
            onChange={() => onSave({ fileAccess: l.value })}
          />
          <span>
            {l.label}
            <span className="ml-2 text-xs text-ink-dim">{l.hint}</span>
          </span>
        </label>
      ))}

      {context.fileAccess === 'extended' && (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-medium text-ink-dim">Əlavə qovluqlar</div>
          {dirs.length === 0 && <div className="text-xs text-ink-dim">(yoxdur)</div>}
          <ul className="space-y-1">
            {dirs.map((d) => (
              <li key={d} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{d}</span>
                <button
                  type="button"
                  onClick={() => onSave({ extraDirs: dirs.filter((x) => x !== d) })}
                  className="shrink-0 text-ink-dim hover:text-bad"
                >
                  sil
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
          >
            + Əlavə et
          </button>
        </div>
      )}

      <FolderPicker
        open={pickerOpen}
        {...(context.cwd !== null ? { initialPath: context.cwd } : {})}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          setPickerOpen(false)
          if (!dirs.includes(p)) onSave({ extraDirs: [...dirs, p] })
        }}
      />
    </div>
  )
}
