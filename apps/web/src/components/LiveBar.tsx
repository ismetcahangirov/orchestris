import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useActivity } from '../lib/useActivity.js'

/**
 * Mənfi pillə nömrələri nərdivandan KƏNAR mexanizmlərdir (CLAUDE.md qayda 37,
 * 51). "Pillə -1" heç nə demir — ad işlədilir.
 */
const RUNG_LABEL: Record<number, string> = {
  [-1]: 'distillə',
  [-2]: 'bölgü',
}

function rungLabel(rung: number): string {
  return RUNG_LABEL[rung] ?? `P${rung}`
}

function elapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Canlı zolaq — Sidebar-ın başında, hər səhifədə.
 *
 * Keçən vaxt BRAUZERDƏ hesablanır: hər saniyə server mesajı göndərmək eyni
 * məlumatı şəbəkədən keçirməkdir və sayğac serverin yayımından daha hamar
 * işləyir.
 *
 * Orkestrasiya icraları (klassifikator, distillə, bölgü) da GÖRÜNÜR — onlar da
 * pul yandırır və "niyə hələ gözləyirəm?" sualının cavabı çox vaxt məhz
 * onlardır.
 */
export default function LiveBar(): React.JSX.Element | null {
  const { runs, pendingQuestions } = useActivity()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Heç nə işləmirsə taymer QURULMUR — zolaq görünmür, sayğac da lazım deyil.
    if (runs.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [runs.length])

  // Zolaq gözləyən sual olanda da görünür (Faza 5B): sualı verən icra ARTIQ
  // bitib, yəni `runs` boşdur — amma task cavab gözləyir və istifadəçi bunu
  // görməsə, task səssizcə dayanmış kimi qalardı.
  if (runs.length === 0 && pendingQuestions === 0) return null

  return (
    <div className="mb-4 rounded border border-accent/30 bg-accent/5 p-2">
      {pendingQuestions > 0 && (
        <div className="mb-2 rounded bg-accent/15 px-2 py-1 text-xs font-semibold text-accent">
          ⚠ {pendingQuestions} sual cavab gözləyir
        </div>
      )}
      {runs.length > 0 && (
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-accent">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        CANLI — {runs.length} icra
      </div>
      )}
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.runId}>
            <Link to={`/tasks/${r.taskId}`} className="block hover:opacity-80">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-mono">{r.modelId}</span>
                <span className="shrink-0 text-ink-dim">
                  {rungLabel(r.ladderRung)} · {elapsed(r.startedAt, now)}
                </span>
              </div>
              <div className="truncate text-xs text-ink-dim">{r.promptExcerpt}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
