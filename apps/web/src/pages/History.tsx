import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import SavingsPanel from '../components/SavingsPanel.js'
import { api, type SavingsTaskRow, type StatsPeriod } from '../lib/api.js'

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: 'day', label: 'Son 24 saat' },
  { value: 'week', label: 'Son həftə' },
  { value: 'month', label: 'Son ay' },
  { value: 'all', label: 'Hamısı' },
]

/** `null` = BİLİNMİR. `$0.0000` yazmaq onu pulsuz kimi göstərərdi (qayda 4). */
function money(value: number | null): string {
  return value === null ? 'bilinmir' : `$${value.toFixed(4)}`
}

function TaskRow({ row }: { row: SavingsTaskRow }): React.JSX.Element {
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-2 pr-3">
        <Link to={`/tasks/${row.taskId}`} className="text-accent hover:underline">
          {row.prompt.slice(0, 70)}
          {row.prompt.length > 70 ? '…' : ''}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-ink-dim">
          <span className="rounded bg-white/5 px-1.5 py-0.5">{row.taskType}</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5">{row.status}</span>
          {row.cachedHit && <span className="rounded bg-good/15 px-1.5 py-0.5 text-good">keş</span>}
          {row.baselineSubscription && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-warn">
              baseline abunəlik — istinad
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-3 font-mono text-ink-dim">{money(row.actualCostUsd)}</td>
      <td className="py-2 pr-3 font-mono text-ink-dim">{money(row.orchestrationCostUsd)}</td>
      <td className="py-2 pr-3 font-mono text-ink-dim">{money(row.baselineCostUsd)}</td>
      <td
        className={`py-2 font-mono ${row.netSavingUsd === null ? 'text-warn' : 'text-good'}`}
      >
        {money(row.netSavingUsd)}
      </td>
    </tr>
  )
}

export default function History(): React.JSX.Element {
  const [period, setPeriod] = useState<StatsPeriod>('month')
  const { data, error } = useQuery({
    queryKey: ['savings', period],
    queryFn: () => api.getSavings(period),
  })

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="mb-1 text-xl font-semibold">Tarixçə</h1>
          <p className="text-sm text-ink-dim">
            Keçmiş tasklar və hər birinin qənaəti. Baseline — eyni tokenlərin başçı modelin
            qiymətləri ilə dəyəri.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Dövr
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as StatsPeriod)}
            className="w-40 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== null && <p className="text-bad">{String(error)}</p>}

      {data !== undefined && (
        <>
          <div className="mb-5">
            <SavingsPanel summary={data.summary} />
          </div>

          {data.tasks.length === 0 ? (
            <p className="text-sm text-ink-dim">Bu dövrdə task yoxdur.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-ink-dim">
                <tr>
                  <th className="pb-2 font-normal">Task</th>
                  <th className="pb-2 font-normal">Real xərc</th>
                  <th className="pb-2 font-normal">Orkestrasiya</th>
                  <th className="pb-2 font-normal">Baseline</th>
                  <th className="pb-2 font-normal">Qənaət</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks.map((t) => (
                  <TaskRow key={t.taskId} row={t} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
