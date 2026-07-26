import type { RunRow } from '../lib/api.js'

export default function UsageBadge({ run }: { run: RunRow }): React.JSX.Element {
  const cacheTotal = run.tokensCacheRead + run.tokensCacheWrite
  const cacheHitPct =
    cacheTotal > 0 ? Math.round((run.tokensCacheRead / cacheTotal) * 100) : 0

  return (
    <div className="flex flex-wrap gap-3 text-xs text-ink-dim">
      <span>giriş {run.tokensIn.toLocaleString('az')}</span>
      <span>çıxış {run.tokensOut.toLocaleString('az')}</span>
      <span>keş oxunuş {run.tokensCacheRead.toLocaleString('az')}</span>
      <span title="Keşdən oxunan nisbət — yüksək olması yaxşıdır, keş oxunuşu 10x ucuzdur">
        keş effektivliyi {cacheHitPct}%
      </span>
      {run.costUsd === null ? (
        <span title="Bu runner xərc bildirmir">xərc bilinmir</span>
      ) : run.subscriptionBilled ? (
        <span className="text-good" title="Abunəlikdən getdi — kartdan real pul çıxmadı">
          abunəlik (istinad ${run.costUsd.toFixed(5)})
        </span>
      ) : (
        <span className="text-ink">${run.costUsd.toFixed(5)}</span>
      )}
    </div>
  )
}
