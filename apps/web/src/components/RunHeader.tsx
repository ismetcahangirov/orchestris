import type { RunRow } from '../lib/api.js'

const RUNG_LABEL: Record<number, string> = {
  0: 'Pillə 0 — keş',
  1: 'Pillə 1 — qayda',
  2: 'Pillə 2 — alət yoxlaması',
  7: 'Pillə 7 — birbaşa model',
}

// DİQQƏT: bunlar RUN statuslarıdır. `verification_failed` burada YOXDUR,
// çünki o, run-ın deyil, Ladder nəticəsinin statusudur: model çıxışı verib
// (run `succeeded`), amma determinist yoxlama sınıb. Onu ayrıca nişan kimi
// `run.verifications`-dan törədirik — yoxsa "succeeded" yazısı yalan olardı.
const STATUS_TONE: Record<string, string> = {
  succeeded: 'bg-good/15 text-good',
  running: 'bg-accent/15 text-accent',
  interrupted: 'bg-warn/15 text-warn',
  budget_exceeded: 'bg-warn/15 text-warn',
  failed: 'bg-bad/15 text-bad',
}

export default function RunHeader({ run }: { run: RunRow }): React.JSX.Element {
  const verificationFailed =
    run.verifications.length > 0 && run.verifications.some((v) => !v.passed)

  return (
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-medium">{run.runnerId}</span>
        <span className="text-ink-dim">· {run.modelId}</span>
        <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-ink-dim">
          {RUNG_LABEL[run.ladderRung] ?? `Pillə ${run.ladderRung}`}
        </span>
        {run.attempt > 1 && (
          <span
            className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
            title="Yoxlama sındığı üçün təkrar cəhd"
          >
            {run.attempt}. cəhd
          </span>
        )}
        {run.cachedHit && (
          <span
            className="rounded bg-good/15 px-2 py-0.5 text-xs text-good"
            title="Nəticə keşdən gəldi — sıfır token xərcləndi"
          >
            keşdən · 0 token
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {verificationFailed && (
          <span
            className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
            title="Model çıxış verdi, amma determinist yoxlama sındı"
          >
            yoxlama sındı
          </span>
        )}
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            STATUS_TONE[run.status] ?? 'bg-white/10 text-ink-dim'
          }`}
        >
          {run.status}
        </span>
      </div>
    </header>
  )
}
