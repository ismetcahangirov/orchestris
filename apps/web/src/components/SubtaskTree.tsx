import { Link } from 'react-router-dom'
import type { SubtaskRow } from '../lib/api.js'

const STATUS_TONE: Record<string, string> = {
  succeeded: 'text-good',
  failed: 'text-bad',
  running: 'text-ink',
  pending: 'text-ink-dim',
}

/**
 * Bölünmüş taskın parçaları (Faza 4).
 *
 * SIRA GÖSTƏRİLİR, çünki bölgünün müqaviləsi məhz sıradır: "sonrakı alt-task
 * əvvəlkinin nəticəsi üzərində işləyir". Nömrəsiz siyahı istifadəçiyə
 * parçaların müstəqil olduğunu deyərdi — halbuki onlar ARDICIL qaçır və
 * biri sınanda sonrakılar yarımçıq iş üzərində işləyir.
 *
 * Hər parça öz task səhifəsinə keçid daşıyır: parçanın öz nərdivanı, öz
 * routing qərarı və öz icra jurnalı var — onları burada təkrarlamaq eyni
 * məlumatın ikinci mənbəyi olardı.
 */
export default function SubtaskTree({
  subtasks,
}: {
  subtasks: readonly SubtaskRow[]
}): React.JSX.Element | null {
  if (subtasks.length === 0) return null

  const done = subtasks.filter((s) => s.status === 'succeeded').length

  return (
    <section className="mb-4 rounded-lg border border-white/10 bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Alt-tasklar</h2>
        <span className="text-xs text-ink-dim">
          {done}/{subtasks.length} hazır
        </span>
      </div>

      <ol className="space-y-2">
        {subtasks.map((sub, i) => (
          <li key={sub.id} className="flex items-start gap-3 text-sm">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-ink-dim">
              {(sub.subtaskIndex ?? i) + 1}.
            </span>
            <Link
              to={`/tasks/${sub.id}`}
              className="min-w-0 flex-1 break-words hover:underline"
            >
              {sub.prompt}
            </Link>
            <span
              className={`shrink-0 text-xs ${STATUS_TONE[sub.status] ?? 'text-ink-dim'}`}
            >
              {sub.status}
            </span>
          </li>
        ))}
      </ol>

      {/*
        Yekun determinist yoxlama VALİDEYNİN bölgü icrasına yazılır — aşağıdakı
        icra jurnalında görünür. Onu burada təkrarlamırıq: yoxlama bir parçanın
        deyil, BÜTÖV nəticənin ölçüsüdür.
      */}
    </section>
  )
}
