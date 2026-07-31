import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

interface Props {
  open: boolean
  /** Başlanğıc qovluq. Verilməsə server `os.homedir()`-dən başlayır. */
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

/**
 * Qovluq seçici modal.
 *
 * Brauzerin öz seçiciləri BU İŞ ÜÇÜN YARARSIZDIR və bu, komponentin mövcudluq
 * səbəbidir: `showDirectoryPicker()` yalnız qovluğun ADINI verir (mütləq yol
 * qəsdən gizlədilir və yalnız Chromium-da var), `<input webkitdirectory>` isə
 * nisbi yol verir və qovluğun BÜTÜN fayllarını sadalayır (`node_modules` olan
 * repoda donma). Bizə isə `cwd` və `--add-dir` üçün mütləq yol lazımdır.
 */
export default function FolderPicker({
  open,
  initialPath,
  onSelect,
  onClose,
}: Props): React.JSX.Element | null {
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [showHidden, setShowHidden] = useState(false)

  const list = useQuery({
    queryKey: ['fs', 'list', path ?? ''],
    queryFn: () => api.listDir(path),
    enabled: open,
  })

  // Cari yol SERVERDƏN gəlir, `path` state-indən yox: server yolu
  // normallaşdırır (`resolve`) və istifadəçiyə göstərilən mətn faktiki
  // işlədiləcək yolla eyni olmalıdır.
  const current = list.data?.path

  const check = useQuery({
    queryKey: ['fs', 'check', current ?? ''],
    queryFn: () => api.checkDir(current as string),
    enabled: open && current !== undefined,
  })

  if (!open) return null

  const entries = (list.data?.entries ?? []).filter((e) => showHidden || !e.hidden)
  const parent = list.data?.parent ?? null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg border border-white/10 bg-surface-2 p-4">
        <div className="mb-2 truncate font-mono text-sm text-ink-dim">
          {current ?? 'yüklənir…'}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(list.data?.drives ?? []).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPath(d)}
              className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
            >
              {d}
            </button>
          ))}
          {parent !== null && (
            <button
              type="button"
              onClick={() => setPath(parent)}
              className="ml-auto rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
            >
              ↑ Yuxarı
            </button>
          )}
        </div>

        <ul className="mb-3 max-h-72 overflow-y-auto rounded border border-white/10">
          {list.isError && <li className="p-3 text-sm text-red-400">Qovluq oxunmadı</li>}
          {entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => setPath(e.path)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-white/5"
              >
                <span className="truncate">{e.name}</span>
                {e.isRepo && <span className="ml-2 shrink-0 text-xs text-accent">git</span>}
              </button>
            </li>
          ))}
          {!list.isLoading && !list.isError && entries.length === 0 && (
            <li className="p-3 text-sm text-ink-dim">Alt-qovluq yoxdur</li>
          )}
        </ul>

        <label className="mb-3 flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(ev) => setShowHidden(ev.target.checked)}
            aria-label="Gizli qovluqları göstər"
          />
          Gizli qovluqları göstər
        </label>

        {/*
          Yazıla bilmə YALNIZ seçilmiş qovluq üçün göstərilir (real yazma
          probu). Hər sətirdə göstərsəydik, `fs.access(W_OK)` Windows-da ACL
          görmədiyi üçün işarə YALAN olardı.
        */}
        <div className="mb-3 text-xs text-ink-dim">
          {check.data === undefined
            ? 'yoxlanılır…'
            : [
                check.data.isRepo ? '✓ git repo' : '— git repo deyil',
                check.data.writable ? '✓ yazıla bilir' : '⚠ yazıla bilmir',
              ].join('   ')}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Ləğv
          </button>
          <button
            type="button"
            disabled={current === undefined}
            onClick={() => {
              if (current !== undefined) onSelect(current)
            }}
            className="rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Seç
          </button>
        </div>
      </div>
    </div>
  )
}
