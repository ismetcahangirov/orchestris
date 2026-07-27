import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ModelRow } from '../lib/api.js'

/** `null` qiyməti "$0" kimi göstərmək yalan olardı (CLAUDE.md qayda 4). */
function priceLabel(m: ModelRow): string {
  if (!m.priceKnown) return 'qiymət bilinmir'
  return `$${m.priceIn?.toFixed(2)} / $${m.priceOut?.toFixed(2)} per 1M`
}

function Badge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-ink-dim">{children}</span>
}

export default function ModelList({ providerId }: { providerId: string }): React.JSX.Element {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['models', providerId],
    queryFn: () => api.listModels(providerId),
  })

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['models'] })
  }
  const setRole = useMutation({
    mutationFn: (v: { id: string; role: 'boss' | 'worker' | 'classifier'; value: boolean }) =>
      api.setModelRole(v.id, v.role, v.value),
    onSuccess: invalidate,
  })
  const setEnabled = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.setModelEnabled(v.id, v.enabled),
    onSuccess: invalidate,
  })

  if (isLoading) return <p className="mt-3 text-xs text-ink-dim">Modellər yüklənir…</p>
  if (data === undefined || data.length === 0) {
    return <p className="mt-3 text-xs text-ink-dim">Model tapılmadı.</p>
  }

  return (
    <ul className="mt-3 space-y-1">
      {data.map((m) => (
        <li
          key={m.id}
          className={`rounded border border-white/5 px-2 py-1.5 text-xs ${
            m.enabled ? '' : 'opacity-40'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{m.modelId}</span>
            <span className={m.priceKnown ? 'text-ink-dim' : 'text-warn'}>{priceLabel(m)}</span>
            {m.contextLimit !== null && <Badge>{(m.contextLimit / 1000).toFixed(0)}k kontekst</Badge>}
            {m.toolCall && <Badge>alət</Badge>}
            {m.structuredOutput && <Badge>struktur</Badge>}
            {m.reasoning && <Badge>düşünmə</Badge>}
            {m.source === 'api' && <Badge>models.dev-də yoxdur</Badge>}
          </div>

          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-dim">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => setEnabled.mutate({ id: m.id, enabled: e.target.checked })}
              />
              aktiv
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={m.roleWorker}
                onChange={(e) =>
                  setRole.mutate({ id: m.id, role: 'worker', value: e.target.checked })
                }
              />
              işçi
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="boss"
                checked={m.roleBoss}
                onChange={() => setRole.mutate({ id: m.id, role: 'boss', value: true })}
              />
              başçı
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="classifier"
                checked={m.roleClassifier}
                onChange={() => setRole.mutate({ id: m.id, role: 'classifier', value: true })}
              />
              klassifikator
            </label>
          </div>
        </li>
      ))}
    </ul>
  )
}
