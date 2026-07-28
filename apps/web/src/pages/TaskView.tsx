import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import EventTimeline from '../components/EventTimeline.js'
import RoutingBadge from '../components/RoutingBadge.js'
import RunHeader from '../components/RunHeader.js'
import UsageBadge from '../components/UsageBadge.js'
import { api, type StoredEventRow } from '../lib/api.js'
import { useRunStream } from '../lib/useRunStream.js'

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'budget_exceeded'])

export default function TaskView(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const { runs: live, connected } = useRunStream(id)

  const { data, error } = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.getTask(id as string),
    enabled: id !== undefined,
    // Fon icrası bitənə qədər qısa interval; sonra dayanır.
    refetchInterval: (q) =>
      q.state.data !== undefined && TERMINAL.has(q.state.data.task.status) ? false : 1500,
  })

  if (error !== null) return <p className="text-bad">{String(error)}</p>
  if (data === undefined) return <p className="text-ink-dim">Yüklənir…</p>

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Task</h1>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-dim">
            {data.task.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={`text-xs ${connected ? 'text-good' : 'text-ink-dim'}`}>
            {connected ? '● canlı' : '○ bağlı deyil'}
          </span>
          {!TERMINAL.has(data.task.status) && (
            <button
              onClick={() => void api.cancelTask(data.task.id)}
              className="rounded bg-bad/15 px-3 py-1.5 text-xs text-bad"
            >
              Dayandır
            </button>
          )}
        </div>
      </div>

      <div className="mb-4">
        <RoutingBadge decision={data.routing} />
      </div>

      <div className="space-y-5">
        {data.runs.map((run) => {
          // DB-dən gələn hadisələr + WS-dən gələn yeni hadisələr birləşdirilir.
          // `seq` run daxilində unikaldır, ona görə dublikatları asanca atırıq.
          const seen = new Set(run.events.map((e) => e.seq))
          const extra = (live.get(run.id)?.events ?? []).filter((e) => !seen.has(e.seq))
          const merged: StoredEventRow[] = [...run.events, ...extra].sort(
            (a, b) => a.seq - b.seq,
          )

          return (
            <section
              key={run.id}
              className="rounded-lg border border-white/10 bg-surface-2 p-4"
            >
              <RunHeader run={run} />

              <div className="mb-3">
                <UsageBadge run={run} />
              </div>

              {run.verifications.length > 0 && (
                <ul className="mb-3 space-y-1">
                  {run.verifications.map((v) => (
                    <li key={v.id} className="font-mono text-xs">
                      <span className={v.passed ? 'text-good' : 'text-bad'}>
                        {v.passed ? '✓' : '✗'}
                      </span>{' '}
                      <span className="text-ink-dim">{v.command}</span>{' '}
                      <span className="text-ink-dim">({v.durationMs}ms)</span>
                      {!v.passed && v.outputExcerpt !== '' && (
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-bad/10 p-2 text-bad">
                          {v.outputExcerpt}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {run.errorMessage !== null && (
                <p className="mb-3 rounded bg-bad/10 p-2 font-mono text-xs break-all text-bad">
                  [{run.errorClass}] {run.errorMessage}
                </p>
              )}

              <EventTimeline events={merged} />
            </section>
          )
        })}
      </div>

      {data.runs.length === 0 && <p className="text-sm text-ink-dim">İcra hələ başlamayıb.</p>}
    </div>
  )
}
