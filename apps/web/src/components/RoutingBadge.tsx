import type { RoutingDecisionRow } from '../lib/api.js'

const STRATEGY_LABEL: Record<string, string> = {
  manual: 'Əl ilə seçim',
  rule: 'Qayda routing',
  classifier: 'Klassifikator',
  boss: 'Başçı (boss-only profil)',
  default: 'Kontekstin default işçisi',
  fallback: 'Ehtiyat seçim',
}

/**
 * "Niyə bu model?" — Pillə 1-in qərarı.
 *
 * Qərarın ÖZ XƏRCİ də göstərilir: layihənin iddiası "ucuz orkestrasiya"dır və
 * onu yoxlaya bilmək üçün istifadəçi qayda qərarının 0 token, klassifikator
 * qərarının isə neçə token olduğunu görməlidir.
 */
export default function RoutingBadge({
  decision,
}: {
  decision: RoutingDecisionRow | null
}): React.JSX.Element | null {
  if (decision === null) return null

  const label = STRATEGY_LABEL[decision.strategy] ?? decision.strategy
  const cost =
    decision.decisionTokens === 0
      ? '0 token'
      : decision.decisionCostUsd === null
        ? `${decision.decisionTokens} token, xərc bilinmir`
        : `${decision.decisionTokens} token, $${decision.decisionCostUsd.toFixed(5)}`

  return (
    <div className="rounded border border-white/10 bg-surface-2 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-accent/15 px-2 py-0.5 text-accent">{label}</span>
        <span className="font-mono text-ink">
          {decision.runnerId} · {decision.modelId}
        </span>
        <span className="text-ink-dim">qərarın xərci: {cost}</span>
      </div>
      <p className="mt-1 text-ink-dim">{decision.reason}</p>
    </div>
  )
}
