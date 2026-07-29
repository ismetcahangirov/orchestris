import { and, asc, eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { artifacts } from './schema.js'

export type Artifact = typeof artifacts.$inferSelect

/** Hazırda yalnız bir növ var; sabit burada saxlanılır ki, sətir yazılışı bir yerdən getsin. */
export const DIFF_KIND = 'diff'

export type ArtifactStatus = 'pending' | 'accepted' | 'rejected'

export interface SaveDiffInput {
  taskId: string
  worktreePath: string
  branch: string
  repoPath: string
  content: string
  files: number
  truncated: boolean
}

/**
 * Taskın diff artefaktını yazır və ya ƏVƏZ EDİR.
 *
 * ƏVƏZETMƏ QƏSDƏNDİR: nərdivan eyni taskda bir neçə icra qaçırır və hamısı eyni
 * worktree-dədir — sonuncu diff bütün işin CƏMİDİR, əvvəlkilər onun yarımçıq
 * anlıq şəkilləridir. Hamısını saxlasaydıq UI-da "hansı düzgündür?" sualı
 * yaranardı.
 *
 * `status` sıfırlanır: məzmun dəyişibsə istifadəçinin köhnə məzmuna verdiyi
 * qərar artıq keçərli deyil.
 */
export function saveDiffArtifact(db: Db, input: SaveDiffInput): Artifact {
  const now = Date.now()
  db.insert(artifacts)
    .values({
      taskId: input.taskId,
      kind: DIFF_KIND,
      worktreePath: input.worktreePath,
      branch: input.branch,
      repoPath: input.repoPath,
      content: input.content,
      files: input.files,
      truncated: input.truncated,
      status: 'pending',
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [artifacts.taskId, artifacts.kind],
      set: {
        worktreePath: input.worktreePath,
        branch: input.branch,
        repoPath: input.repoPath,
        content: input.content,
        files: input.files,
        truncated: input.truncated,
        status: 'pending',
        resolvedAt: null,
        createdAt: now,
      },
    })
    .run()

  const row = getDiffArtifact(db, input.taskId)
  if (row === undefined) throw new Error('artifacts sətri yazıldıqdan sonra tapılmadı')
  return row
}

export function getDiffArtifact(db: Db, taskId: string): Artifact | undefined {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, DIFF_KIND)))
    .get()
}

export function listArtifacts(db: Db, taskId: string): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(asc(artifacts.id))
    .all()
}

/**
 * İstifadəçinin baxmadığı diff-lər.
 *
 * Server başlanğıcındakı yetim təmizləyicisi bunlara TOXUNMUR: `pending`
 * worktree "server çökdü" demək deyil, "istifadəçi hələ qərar verməyib"
 * deməkdir. Onları silsəydik, agentin bütün işi bir yenidən başlatma ilə
 * itərdi.
 */
export function listPendingArtifacts(db: Db): Artifact[] {
  return db.select().from(artifacts).where(eq(artifacts.status, 'pending')).all()
}

export function resolveArtifact(db: Db, id: number, status: ArtifactStatus): void {
  db.update(artifacts)
    .set({ status, resolvedAt: Date.now() })
    .where(eq(artifacts.id, id))
    .run()
}
