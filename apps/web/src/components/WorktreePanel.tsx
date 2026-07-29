import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ArtifactRow } from '../lib/api.js'

const STATUS_LABEL: Record<string, string> = {
  pending: 'baxılmayıb',
  accepted: 'qəbul edildi',
  rejected: 'rədd edildi',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-warn/15 text-warn',
  accepted: 'bg-good/15 text-good',
  rejected: 'bg-white/10 text-ink-dim',
}

/**
 * İzolyasiya edilmiş worktree-dəki dəyişiklik və onun qəbulu.
 *
 * NİYƏ İSTİFADƏÇİ QƏRAR VERİR: paralel agentlər eyni faylı fərqli cür dəyişə
 * bilər. Avtomatik merge etsəydik, ikinci taskın nəticəsi birincini səssizcə
 * üstələyərdi — məhz izolyasiyanın qarşısını almaq istədiyi hal.
 */
export default function WorktreePanel({
  artifact,
}: {
  artifact: ArtifactRow
}): React.JSX.Element {
  const qc = useQueryClient()
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['task', artifact.taskId] })
  }

  const accept = useMutation({
    mutationFn: () => api.acceptDiff(artifact.taskId),
    onSuccess: invalidate,
  })
  const reject = useMutation({
    mutationFn: () => api.rejectDiff(artifact.taskId),
    onSuccess: invalidate,
  })

  const busy = accept.isPending || reject.isPending
  const error = accept.error ?? reject.error
  // İki ayrı səbəb, EYNİ nəticə: diff baxış üçün qalır, tətbiq isə mümkün deyil.
  // Hər ikisi qəbul yolunda serverdə də yoxlanılır — UI yalnız düyməni boş yerə
  // basmağın qarşısını alır, təminatı yox (təminat qaydası: server sondur).
  const binary = artifact.binaryFiles ?? []
  const applicable = !artifact.truncated && binary.length === 0

  return (
    <section className="mb-5 rounded-lg border border-white/10 bg-surface-2 p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">İzolyasiya edilmiş dəyişiklik</span>
          <span className="text-ink-dim">· {artifact.files} fayl</span>
          <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-ink-dim">
            {artifact.branch}
          </span>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            STATUS_TONE[artifact.status] ?? 'bg-white/10 text-ink-dim'
          }`}
        >
          {STATUS_LABEL[artifact.status] ?? artifact.status}
        </span>
      </header>

      <p className="mb-3 font-mono text-xs break-all text-ink-dim">{artifact.worktreePath}</p>

      {artifact.truncated && (
        // Kəsilmiş diff yalnız BAXIŞ üçündür: `git apply` yarımçıq patch-i
        // qəbul etmir. Bunu gizlətsək istifadəçi "qəbul et" düyməsinin niyə
        // işləmədiyini anlamazdı.
        <p className="mb-3 rounded bg-warn/10 p-2 text-xs text-warn">
          Diff çox böyük olduğu üçün kəsilib — avtomatik tətbiq oluna bilməz.
          Dəyişikliyi yuxarıdaki worktree qovluğundan əl ilə götürün.
        </p>
      )}

      {binary.length > 0 && (
        // İkili fayl (issue #41). Ölçülmüş: `git apply` patch-i BÜTÖV rədd edir,
        // yəni mətn dəyişiklikləri də tətbiq olunmur. Bunu yazmasaq istifadəçi
        // xam git xətasını görər və dəyişikliyin hələ də worktree qovluğunda
        // olduğunu bilməzdi.
        <div className="mb-3 rounded bg-warn/10 p-2 text-xs text-warn">
          <p>
            Diff ikili (binary) fayl daşıyır — <code>git apply</code> belə patch-i
            tətbiq edə bilmir və <strong>patch-in mətn hissəsi də</strong> tətbiq
            olunmazdı. Faylları yuxarıdaki worktree qovluğundan əl ilə götürün.
          </p>
          <ul className="mt-1 list-inside list-disc font-mono break-all">
            {binary.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <pre className="mb-3 max-h-96 overflow-auto rounded bg-surface p-3 font-mono text-xs text-ink-dim">
        {artifact.content}
      </pre>

      {artifact.status === 'pending' && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => accept.mutate()}
            disabled={busy || !applicable}
            className="rounded bg-good/15 px-3 py-1.5 text-xs text-good disabled:opacity-40"
          >
            {accept.isPending ? 'Tətbiq olunur…' : 'Qəbul et (repoya tətbiq et)'}
          </button>
          <button
            onClick={() => reject.mutate()}
            disabled={busy}
            className="rounded bg-bad/15 px-3 py-1.5 text-xs text-bad disabled:opacity-40"
          >
            {reject.isPending ? 'Silinir…' : 'Rədd et'}
          </button>
        </div>
      )}

      {error != null && (
        <p className="mt-3 rounded bg-bad/10 p-2 font-mono text-xs break-all text-bad">
          {String(error)}
        </p>
      )}
    </section>
  )
}
