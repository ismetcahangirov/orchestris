import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'

const TERMINAL = new Set(['succeeded', 'failed', 'budget_exceeded'])

const STATUS_TONE: Record<string, string> = {
  succeeded: 'text-good',
  failed: 'text-bad',
  budget_exceeded: 'text-warn',
  // ATLANAN addım uğursuzluq DEYİL — onu qırmızı göstərmək istifadəçini
  // olmayan səhvi axtarmağa göndərərdi (şərt sadəcə ödənməyib).
  skipped: 'text-ink-dim',
  running: 'text-ink',
}

/**
 * Canlı icra paneli.
 *
 * Sorğu icra bitəndə DAYANIR: zəncir onlarla dəqiqə çəkə bilər, amma bitmiş
 * icra dəyişmir — sonsuz sorğu serveri boş yerə yükləyərdi.
 */
export default function WorkflowRunPanel({
  runId,
  onClose,
}: {
  runId: string
  onClose: () => void
}): React.JSX.Element {
  const { data, error } = useQuery({
    queryKey: ['workflow-run', runId],
    queryFn: () => api.getWorkflowRun(runId),
    refetchInterval: (q) =>
      q.state.data !== undefined && TERMINAL.has(q.state.data.run.status) ? false : 1500,
  })

  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          İcra{' '}
          {data !== undefined && (
            <span className={STATUS_TONE[data.run.status] ?? 'text-ink-dim'}>
              — {data.run.status}
            </span>
          )}
        </h2>
        <button onClick={onClose} className="text-xs text-ink-dim hover:text-ink">
          bağla
        </button>
      </div>

      {error !== null && <p className="text-sm text-bad">{String(error)}</p>}
      {data === undefined && <p className="text-sm text-ink-dim">Yüklənir…</p>}

      {data !== undefined && (
        <>
          {data.run.error !== null && (
            <p className="mb-3 rounded bg-bad/10 p-2 text-xs text-bad">{data.run.error}</p>
          )}

          {/* Zəncirin bütün addımları BİR ağacda işləyir və dəyişiklik valideyn
              taskın `pending` diff-inə yazılır (issue #36). Keçid olmasaydı,
              istifadəçi baxılası dəyişikliyi yalnız `/history` səhifəsində
              təsadüfən tapardı. */}
          {data.run.rootTaskId !== null && (
            <p className="mb-3 text-xs text-ink-dim">
              Zəncir taskı:{' '}
              <Link
                to={`/tasks/${data.run.rootTaskId}`}
                className="underline hover:text-ink"
              >
                nəticə və dəyişiklik →
              </Link>
            </p>
          )}

          <ol className="space-y-2">
            {data.steps.map((s) => (
              <li key={s.id} className="text-xs">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-ink-dim">#{s.stepIndex + 1}</span>
                  <span className="font-mono text-ink">{s.stepId}</span>
                  {s.attempt > 1 && (
                    <span className="text-ink-dim">cəhd {s.attempt}</span>
                  )}
                  <span className={STATUS_TONE[s.status] ?? 'text-ink-dim'}>{s.status}</span>
                  {s.taskId !== null && (
                    <Link
                      to={`/tasks/${s.taskId}`}
                      className="text-ink-dim underline hover:text-ink"
                    >
                      task →
                    </Link>
                  )}
                </div>
                {/* Atlanan addımın SƏBƏBİ göstərilir: yoxsa istifadəçi
                    "niyə işləmədi?" sualının cavabını heç yerdə tapa bilməzdi. */}
                {s.detail !== null && s.detail !== '' && (
                  <p className="mt-0.5 font-mono text-[11px] text-ink-dim">{s.detail}</p>
                )}
                {s.output !== '' && (
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/20 p-2 text-[11px] whitespace-pre-wrap text-ink-dim">
                    {s.output}
                    {s.outputTruncated && '\n\n[kəsilib — tam mətn taskın jurnalındadır]'}
                  </pre>
                )}
              </li>
            ))}
          </ol>

          {data.steps.length === 0 && (
            <p className="text-sm text-ink-dim">Addım hələ başlamayıb.</p>
          )}
        </>
      )}
    </section>
  )
}
