import type { RunRow } from '../lib/api.js'

const RUNG_LABEL: Record<number, string> = {
  0: 'Pillə 0 — keş',
  1: 'Pillə 1 — qayda',
  2: 'Pillə 2 — alət yoxlaması',
  3: 'Pillə 3 — best-of-N nüsxəsi',
  // Bu nişan HƏM başçının qısa ipucu icrasına, HƏM işçinin ipuculu icrasına
  // düşür — modelin adı ikisini onsuz da ayırır. Başçının ipucusunu "Pillə 7"
  // kimi göstərsək, istifadəçi tam başçı icrasının xərcini gözləyərdi.
  4: 'Pillə 4 — ipucu (shepherding)',
  6: 'Pillə 6 — self-escalation',
  7: 'Pillə 7 — başçı',
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
          // Pillə 3-də `attempt` "neçənci NÜSXƏ" deməkdir, təkrar cəhd yox —
          // ikisini eyni sözlə adlandırmaq istifadəçiyə "yoxlama sındı"
          // təəssüratı verərdi.
          <span
            className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
            title={
              run.ladderRung === 3
                ? 'Razılaşma üçün qaçırılan əlavə nüsxə'
                : 'Yoxlama sındığı üçün təkrar cəhd'
            }
          >
            {run.attempt}. {run.ladderRung === 3 ? 'nüsxə' : 'cəhd'}
          </span>
        )}
        {run.escalatedFromRunId !== null && (
          <span
            className="rounded bg-accent/15 px-2 py-0.5 text-xs text-accent"
            title="İşçi bu taskı həll edə bilmədi — nərdivan yuxarı pilləyə qalxdı"
          >
            eskalasiya
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
