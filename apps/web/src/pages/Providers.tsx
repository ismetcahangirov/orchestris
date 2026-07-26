import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'

export default function Providers(): React.JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['providers'],
    queryFn: api.listProviders,
  })

  if (isLoading) return <p className="text-ink-dim">Aşkarlanır…</p>
  if (error !== null) return <p className="text-bad">{String(error)}</p>

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Provayderlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Lokal CLI-lar avtomatik aşkarlanır və sənin abunəliyindən istifadə edir.
      </p>

      <div className="space-y-3">
        {data?.map((p) => (
          <div key={p.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="font-mono text-sm font-medium">{p.id}</div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  p.authenticated
                    ? 'bg-good/15 text-good'
                    : p.installed
                      ? 'bg-warn/15 text-warn'
                      : 'bg-bad/15 text-bad'
                }`}
              >
                {p.authenticated
                  ? 'hazır'
                  : p.installed
                    ? 'login lazımdır'
                    : 'quraşdırılmayıb'}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-dim">{p.detail}</p>
            {p.version !== undefined && (
              <p className="mt-1 font-mono text-xs text-ink-dim">{p.version}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
