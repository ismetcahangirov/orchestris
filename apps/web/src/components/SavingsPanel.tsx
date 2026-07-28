import type { SavingsSummary } from '../lib/api.js'

function usd(value: number, digits = 4): string {
  return `$${value.toFixed(digits)}`
}

function Row({
  label,
  value,
  hint,
  testId,
  tone,
}: {
  label: string
  value: string
  hint?: string
  testId?: string
  tone?: 'good' | 'dim'
}): React.JSX.Element {
  return (
    <div
      className="flex items-baseline justify-between gap-4 border-t border-white/5 py-1.5 text-xs"
      data-testid={testId}
    >
      <span className="text-ink-dim">
        {label}
        {hint !== undefined && <span className="ml-1 text-ink-dim/70">({hint})</span>}
      </span>
      <span className={`font-mono ${tone === 'good' ? 'text-good' : 'text-ink'}`}>{value}</span>
    </div>
  )
}

/**
 * Qənaət paneli — layihənin əsas iddiasının GÖRÜNƏN yeri.
 *
 * Panelin dizaynı iddianı şişirtməmək üzərində qurulub:
 *  - orkestrasiya xərci AYRICA sətirdir (net qənaətdən onsuz da çıxılıb)
 *  - abunəlik "xərcləndi" yox, "istinad" kimi göstərilir (qayda 5)
 *  - xərci bilinməyən tasklar gizlədilmir, sayı yazılır (qayda 4)
 *  - task tipinə görə bölgü göstərilir: mətn tasklarında qənaət kod
 *    tasklarından az olur və bunu gizlətmək yanıltma olardı
 */
export default function SavingsPanel({
  summary,
}: {
  summary: SavingsSummary
}): React.JSX.Element {
  if (summary.taskCount === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-surface-2 p-5 text-sm text-ink-dim">
        Hələ ölçüləcək task yoxdur. Bir neçə task icra ediləndən sonra qənaət burada
        görünəcək.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-white/10 bg-surface-2 p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs text-ink-dim">Net qənaət</div>
          <div className="font-mono text-2xl text-good">{usd(summary.netSavingUsd, 2)}</div>
        </div>
        <div className="text-right text-xs text-ink-dim">
          {summary.taskCount} task
          <div className="font-mono">
            {(summary.tokensIn / 1000).toFixed(0)}k giriş / {(summary.tokensOut / 1000).toFixed(0)}k
            çıxış token
          </div>
        </div>
      </div>

      <div className="mt-3">
        <Row label="Baseline (başçı ilə olsaydı)" value={usd(summary.baselineCostUsd)} />
        <Row label="Real xərc" value={usd(summary.actualCostUsd)} />
        <Row
          label="Orkestrasiya xərci"
          hint="routing + klassifikator"
          value={usd(summary.orchestrationCostUsd)}
        />
        {summary.memoryCostUsd > 0 && (
          <Row label="Yaddaş xərci" value={usd(summary.memoryCostUsd)} />
        )}
        {summary.actualSubscriptionUsd > 0 && (
          <Row
            testId="subscription-line"
            label="Abunəlik istifadəsi"
            hint="istinad qiyməti — kartdan pul çıxmır"
            value={usd(summary.actualSubscriptionUsd)}
            tone="dim"
          />
        )}
        {summary.cacheHits > 0 && (
          <Row
            testId="cache-line"
            label={`Keşdən gələn ${summary.cacheHits} task`}
            value={usd(summary.cacheSavingUsd)}
            tone="good"
          />
        )}
      </div>

      {summary.unknownCostTasks > 0 && (
        <p className="mt-3 text-xs text-warn">
          {summary.unknownCostTasks} taskın xərci bilinmir — onlar yuxarıdakı cəmə DAXİL
          DEYİL.
        </p>
      )}
      {summary.subscriptionBaselineTasks > 0 && (
        <p className="mt-2 text-xs text-warn">
          {summary.subscriptionBaselineTasks} taskda baseline abunəlik modelidir — o
          müqayisə istinad qiyməti üzərindədir, real pul qənaəti deyil.
        </p>
      )}

      <div className="mt-4">
        <div className="mb-1 text-xs text-ink-dim">Task tipinə görə</div>
        <table className="w-full text-left text-xs">
          <thead className="text-ink-dim">
            <tr>
              <th className="pb-1 font-normal">Tip</th>
              <th className="pb-1 font-normal">Task</th>
              <th className="pb-1 font-normal">Real xərc</th>
              <th className="pb-1 font-normal">Qənaət</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {summary.byTaskType.map((t) => (
              <tr key={t.taskType} className="border-t border-white/5">
                <td className="py-1">{t.taskType}</td>
                <td className="py-1">{t.tasks}</td>
                <td className="py-1">{usd(t.actualCostUsd)}</td>
                <td className="py-1 text-good">{usd(t.netSavingUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
