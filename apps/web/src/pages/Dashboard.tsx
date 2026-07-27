import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'

type RunnerId = 'cli:claude' | 'cli:codex'

export default function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const [contextId, setContextId] = useState('')
  const [runner, setRunner] = useState<RunnerId>('cli:claude')
  const [model, setModel] = useState('claude-haiku-4-5-20251001')
  const [prompt, setPrompt] = useState('')

  const { data: contexts } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders })

  const submit = useMutation({
    mutationFn: () =>
      api.createTask({
        contextId,
        prompt,
        runner,
        model,
        // Sərt limit: ilk versiyada hər task ən çox 30k output token və 10 dəqiqə.
        maxOutputTokens: 30_000,
        maxSeconds: 600,
      }),
    onSuccess: (r) => navigate(`/tasks/${r.taskId}`),
  })

  // `runner` CLI runner id-sidir (`cli:claude`, `fake`) — API provayderləri
  // ayrı siyahıdadır və task göndərişində hələ iştirak etmir (Faza 1B-B).
  const selected = providers?.cli.find((p) => p.id === runner)
  const blocked = selected !== undefined && !selected.authenticated

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">İdarə paneli</h1>
      <p className="mb-6 text-sm text-ink-dim">Yeni task başlat və canlı izlə.</p>

      <form
        className="space-y-4 rounded-lg border border-white/10 bg-surface-2 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (contextId !== '' && prompt.trim() !== '' && !blocked) submit.mutate()
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Kontekst
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">— seç —</option>
              {contexts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            İşçi
            <select
              value={runner}
              onChange={(e) => setRunner(e.target.value as RunnerId)}
              className="w-44 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
            >
              <option value="cli:claude">cli:claude</option>
              <option value="cli:codex">cli:codex</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Model
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-72 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Task
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Bu funksiyaya test yaz…"
            className="w-full rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        {blocked && (
          <p className="text-sm text-warn">
            {runner} hazır deyil: {selected?.detail}
          </p>
        )}

        {contexts?.length === 0 && (
          <p className="text-sm text-warn">
            Əvvəlcə Kontekstlər səhifəsində bir kontekst yarat.
          </p>
        )}

        <button
          type="submit"
          disabled={contextId === '' || prompt.trim() === '' || blocked || submit.isPending}
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {submit.isPending ? 'Başladılır…' : 'İşə sal'}
        </button>

        {submit.error !== null && <p className="text-sm text-bad">{String(submit.error)}</p>}
      </form>
    </div>
  )
}
