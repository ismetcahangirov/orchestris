import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'

interface RunnerOption {
  id: string
  label: string
  ready: boolean
  /** Hazır deyilsə səbəb — istifadəçi nə edəcəyini bilməlidir. */
  detail: string
}

export default function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const [contextId, setContextId] = useState('')
  const [runner, setRunner] = useState('cli:claude')
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

  // İşçi siyahısı serverdən gəlir — sabit kodlanmış deyil. CLI runner-ləri
  // PATH-dan aşkarlanır, API runner-ləri isə açarı olan provayderlərdən.
  // ÖLÇÜLMÜŞ FƏRQ (Faza 1A): `claude` CLI hər çağırışda ~21.7k token döşəməsi
  // daşıyır, API-nın döşəməsi ~0-dır — amma API-də real pul çıxır. Seçim
  // istifadəçinindir; avtomatik yönləndirmə ayrı issue-dadır (#7).
  const options: RunnerOption[] = [
    ...(providers?.cli ?? []).map((p) => ({
      id: p.id,
      label: `${p.id} (abunəlik)`,
      ready: p.authenticated,
      detail: p.detail,
    })),
    ...(providers?.api ?? [])
      .filter((p) => p.runnerId !== null)
      .map((p) => ({
        id: p.runnerId as string,
        label: `${p.runnerId} (real pul)`,
        ready: p.authenticated,
        detail: p.hasCredential
          ? 'Açar var, amma anbardan oxunmadı — /providers səhifəsindən yenidən əlavə et'
          : 'API açarı təyin olunmayıb — /providers səhifəsindən əlavə et',
      })),
  ]

  const selected = options.find((o) => o.id === runner)
  const blocked = selected !== undefined && !selected.ready

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
              onChange={(e) => setRunner(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
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
          <p className="text-sm text-warn">{`${runner} hazır deyil: ${selected?.detail ?? ''}`}</p>
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
