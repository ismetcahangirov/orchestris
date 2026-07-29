import { saveDiffArtifact } from '../db/artifact-repo.js'
import type { Db } from '../db/client.js'
import type { Worktree, WorktreeManager } from './worktree.js'

/**
 * İzolyasiya edilmiş ağacı yekunlaşdırır: dəyişiklik varsa diff `artifacts`-a
 * yazılır və qovluq QALIR, yoxdursa qovluq dərhal silinir.
 *
 * NİYƏ AYRICA MODUL: ağacı İKİ sahib bağlaya bilər — adi taskda `Ladder`, bölünmüş
 * taskda isə `Decomposer` (alt-tasklar EYNİ ağacda işlədiyi üçün ağac onlardan
 * uzun yaşayır). Məntiqi iki yerdə saxlasaydıq, biri dəyişəndə digəri səssizcə
 * köhnələrdi: məsələn "dəyişiklik yoxdursa sil" qaydası bir yolda unudulsa,
 * istifadəçinin `~/.orchestris/worktrees/` qovluğu boş qovluqlarla dolardı.
 *
 * "Dəyişiklik VARSA qovluq qalır" qaydası CLAUDE.md qayda 42-dəndir: diff-in
 * tətbiqi istifadəçinin qərarıdır və o qərar verilənə qədər işi silmək olmaz.
 */
export async function finalizeWorktree(input: {
  db: Db
  worktrees: WorktreeManager
  /** Diff hansı taskın adına yazılsın. Bölünmüş taskda bu, VALİDEYN taskdır. */
  taskId: string
  worktree: Worktree
}): Promise<void> {
  const { db, worktrees, taskId, worktree } = input
  try {
    const diff = await worktrees.collect(worktree)
    if (diff.files === 0) {
      await worktrees.remove(worktree)
      return
    }
    saveDiffArtifact(db, {
      taskId,
      worktreePath: worktree.path,
      branch: worktree.branch,
      repoPath: worktree.repo,
      content: diff.diff,
      files: diff.files,
      truncated: diff.truncated,
    })
  } catch {
    // Diff toplanmadı (git sındı, disk doldu) — worktree DİSKDƏ SAXLANILIR.
    // Silmək agentin işini geri qaytarılmaz şəkildə məhv etmək olardı;
    // qalan qovluğu isə istifadəçi əl ilə də oxuya bilər.
  }
}
