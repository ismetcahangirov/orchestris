import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

export default function Contexts(): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')

  const { data } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })

  const create = useMutation({
    mutationFn: () =>
      api.createContext({
        name: name.trim(),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
      }),
    onSuccess: () => {
      setName('')
      setCwd('')
      void qc.invalidateQueries({ queryKey: ['contexts'] })
    },
  })

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Kontekstlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Hər kontekst öz iş qovluğu, büdcəsi və yoxlama əmrləri ilə ayrı iş sahəsidir.
      </p>

      <form
        className="mb-8 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() !== '') create.mutate()
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Ad
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Layihəm"
            className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          İş qovluğu (opsional)
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\\Users\\me\\proj"
            className="w-80 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={name.trim() === '' || create.isPending}
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {create.isPending ? 'Yaradılır…' : 'Yarat'}
        </button>
      </form>

      {create.error !== null && (
        <p className="mb-4 text-sm text-bad">{String(create.error)}</p>
      )}

      <ul className="space-y-2">
        {data?.map((c) => (
          <li key={c.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
            <div className="font-medium">{c.name}</div>
            <div className="mt-1 font-mono text-xs text-ink-dim">
              {c.cwd ?? '(iş qovluğu yoxdur)'}
            </div>
            <div className="mt-1 text-xs text-ink-dim">
              profil: {c.amplificationProfile} · işçi rejimi: {c.workerMode}
            </div>
          </li>
        ))}
      </ul>

      {data?.length === 0 && <p className="text-sm text-ink-dim">Hələ kontekst yoxdur.</p>}
    </div>
  )
}
