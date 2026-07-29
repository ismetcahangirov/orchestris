import { MIN_SCHEDULE_INTERVAL_SECONDS } from '@orchestris/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type ScheduleRow } from '../lib/api.js'

/**
 * Cədvəl paneli (Faza 4).
 *
 * UI-ın ƏSAS İŞİ LİMİTLƏRİ GÖRÜNƏN ETMƏKDİR. Issue #12 xəbərdarlığı belədir:
 * *"nəzarətsiz cədvəl `$0.50 testdə → $50,000/ay` ssenarisinin ən asan
 * yoludur"*. Ona görə burada hər üç limit AÇIQ sahədir (gizli default yoxdur)
 * və sərf olunmuş məbləğ tavanla YANAŞI göstərilir — istifadəçi "nə qədər
 * qaldı?" sualının cavabını hesablamamalıdır.
 */

function fmtInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} gündə bir`
  if (seconds % 3600 === 0) return `${seconds / 3600} saatda bir`
  return `${Math.round(seconds / 60)} dəqiqədə bir`
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleString()
}

export default function SchedulePanel({
  workflowId,
}: {
  workflowId: string
}): React.JSX.Element {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['schedules'], queryFn: api.listSchedules })

  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [perRun, setPerRun] = useState(0.5)
  const [total, setTotal] = useState(10)
  const [maxRuns, setMaxRuns] = useState(20)

  const create = useMutation({
    mutationFn: () =>
      api.createSchedule({
        workflowId,
        intervalSeconds: Math.max(
          MIN_SCHEDULE_INTERVAL_SECONDS,
          Math.round(intervalMinutes * 60),
        ),
        budgetUsdPerRun: perRun,
        budgetUsdTotal: total,
        maxRuns,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const toggle = useMutation({
    mutationFn: (s: ScheduleRow) => api.updateSchedule(s.id, { enabled: !s.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const mine = (data?.schedules ?? []).filter((s) => s.workflowId === workflowId)

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <h3 className="mb-2 text-xs font-medium text-ink-dim">Cədvəl üzrə icra</h3>

      {mine.map((s) => (
        <div key={s.id} className="mb-3 rounded border border-white/10 bg-surface p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={s.enabled ? 'text-good' : 'text-ink-dim'}>
              {s.enabled ? '● aktiv' : '○ söndürülüb'} — {fmtInterval(s.intervalSeconds)}
            </span>
            <button
              onClick={() => toggle.mutate(s)}
              className="rounded bg-white/5 px-2 py-1 text-ink-dim"
            >
              {s.enabled ? 'Söndür' : 'Aç'}
            </button>
          </div>

          {/* Sərf olunan tavanla YANAŞI göstərilir: istifadəçi "nə qədər
              qaldı?" sualını hesablamamalıdır. */}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink-dim">
            <dt>İcra sayı</dt>
            <dd className={s.runs >= s.maxRuns ? 'text-warn' : ''}>
              {s.runs} / {s.maxRuns}
            </dd>
            <dt>Ümumi xərc</dt>
            <dd className={s.spentUsd >= s.budgetUsdTotal ? 'text-warn' : ''}>
              ${s.spentUsd.toFixed(4)} / ${s.budgetUsdTotal}
            </dd>
            <dt>Bir icraya limit</dt>
            <dd>${s.budgetUsdPerRun}</dd>
            <dt>Növbəti icra</dt>
            <dd>{s.enabled ? fmtTime(s.nextRunAt) : '—'}</dd>
          </dl>

          {/* Söndürülmə SƏBƏBİ göstərilir: avtomatik icranın səssizcə dayanması
              ən pis haldır — adam işin getdiyini zənn edir. */}
          {s.disabledReason !== null && (
            <p className="mt-2 rounded bg-warn/10 p-2 text-warn">{s.disabledReason}</p>
          )}
        </div>
      ))}

      {mine.length === 0 && (
        <form
          className="space-y-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <p className="text-ink-dim">
            Avtomatik icra <span className="text-ink">sərt limit</span> tələb edir —
            hər üçü məcburidir.
          </p>
          <div className="flex flex-wrap gap-3">
            <NumberField
              label="Hər (dəqiqə)"
              value={intervalMinutes}
              min={1}
              step={1}
              onChange={setIntervalMinutes}
            />
            <NumberField
              label="Bir icraya $"
              value={perRun}
              min={0.01}
              step={0.01}
              onChange={setPerRun}
            />
            <NumberField
              label="Ümumi $"
              value={total}
              min={0.01}
              step={0.5}
              onChange={setTotal}
            />
            <NumberField
              label="Maks. icra"
              value={maxRuns}
              min={1}
              step={1}
              onChange={setMaxRuns}
            />
          </div>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded bg-accent/20 px-3 py-1.5 text-accent disabled:opacity-40"
          >
            Cədvəl qur
          </button>
          {create.error !== null && <p className="text-bad">{String(create.error)}</p>}
        </form>
      )}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-ink-dim">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 rounded border border-white/15 bg-surface px-2 py-1 text-ink"
      />
    </label>
  )
}
