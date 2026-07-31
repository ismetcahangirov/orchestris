import { useState } from 'react'

interface Props {
  onSubmit: (text: string, mode: 'next' | 'interrupt') => void
  pending?: boolean
  /** İcra işləmirsə "İndi kəs" mənasızdır — kəsiləcək heç nə yoxdur. */
  running?: boolean
}

/**
 * İşləyən icraya canlı rəy (Faza 5B).
 *
 * İKİ düymə var və bu, şüurlu qərardır: birini "düzgün" sayıb digərini
 * gizlətsəydik, ya səhv yolla gedən işçi bitənə qədər gözlənilərdi, ya da hər
 * rəy yarımçıq işin çıxış tokenlərini yandırardı. Seçim istifadəçinindir və
 * qiyməti GİZLƏDİLMİR.
 */
export default function ReviewBox({
  onSubmit,
  pending,
  running,
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const empty = text.trim() === ''

  const send = (mode: 'next' | 'interrupt'): void => {
    if (empty) return
    onSubmit(text.trim(), mode)
    setText('')
  }

  return (
    <div className="rounded border border-white/10 bg-surface-2 p-3">
      <div className="mb-2 text-sm font-medium">Canlı rəy</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Rəy mətni"
        placeholder="token-i localStorage-ə yazma, httpOnly cookie işlət"
        rows={3}
        className="mb-2 w-full rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending === true || empty}
          onClick={() => send('next')}
          className="rounded bg-accent/20 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >
          Növbəti icrada
        </button>
        <button
          type="button"
          disabled={pending === true || empty || running !== true}
          onClick={() => send('interrupt')}
          className="rounded border border-white/15 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          İndi kəs
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-dim">
        «İndi kəs» cari icranı dayandırır — yarımçıq işin çıxış tokenləri itir
        (çıxış girişdən 3–5x bahadır). «Növbəti icrada» heç nə atmır.
      </p>
    </div>
  )
}
