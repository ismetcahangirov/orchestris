import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { worktreesDir } from '../paths.js'

/**
 * Bir icranın izolyasiya edilmiş iş sahəsi.
 *
 * `repo` HƏMİŞƏ saxlanılır: `git worktree remove` və diff-in tətbiqi ƏSAS
 * repodan icra olunur — worktree-nin öz qovluğu silindikdən sonra oradan heç
 * bir git əmri qaçmaz.
 */
export interface Worktree {
  /** Əsas reponun kökü (`git rev-parse --show-toplevel`). */
  repo: string
  /** `~/.orchestris/worktrees/<taskId>` */
  path: string
  /** `orchestris/<taskId>` */
  branch: string
}

export interface WorktreeDiff {
  /** `git diff --cached` mətni. Boş sətir = dəyişiklik yoxdur. */
  diff: string
  files: number
  /**
   * Diff hədd aşıb KƏSİLİBSƏ `true`.
   *
   * Belə diff yalnız BAXMAQ üçündür — `git apply` yarımçıq patch-i qəbul
   * etməz. Qəbul yolu bunu yoxlamalıdır, yoxsa istifadəçi "qəbul etdim"
   * düyməsindən sonra dəyişikliyin yalnız bir hissəsini alardı.
   */
  truncated: boolean
}

export interface ApplyResult {
  ok: boolean
  error?: string
}

/**
 * Worktree əməliyyatları — `Ladder` və route-lar YALNIZ bu interfeysi görür.
 *
 * Səbəb testlərdir: nərdivanın izolyasiya yolu saxta implementasiya ilə sıfır
 * proses spawn edərək yoxlanıla bilir. Real git yolu isə `GitWorktrees`-in öz
 * testində müvəqqəti repo üzərində qaçırılır (yenə sıfır token).
 */
export interface WorktreeManager {
  /** Yarada bilmədikdə `null` — çağıran əsas `cwd`-də davam etməlidir. */
  create(input: { repo: string; taskId: string }): Promise<Worktree | null>
  collect(wt: Worktree): Promise<WorktreeDiff>
  remove(wt: Worktree): Promise<void>
  apply(input: { repo: string; diff: string }): Promise<ApplyResult>
}

/**
 * Saxlanılan diff-in simvol həddi.
 *
 * Hədd LAZIMDIR: diff SQLite sətrinə yazılır və WebSocket/REST ilə brauzerə
 * gedir — 50 MB-lıq `pnpm-lock.yaml` dəyişikliyi UI-ı dondurardı. Kəsilmiş
 * diff `truncated` ilə işarələnir və QƏBUL EDİLƏ BİLMİR (bax `WorktreeDiff`).
 */
export const DIFF_CHAR_LIMIT = 400_000

/** `git` çıxışı üçün bufer — böyük diff-lər üçün Node-un 1 MB default-u azdır. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** Paralel `worktree add` kilidə düşəndə gözləmə. */
const WORKTREE_RETRY_MS = 150

/**
 * İzolyasiya TƏLƏB EDƏN task tipləri.
 *
 * `explain`/`summarize`/`chat` fayl yazmır — onlara worktree açmaq hər task
 * üçün ~200–500 ms və disk yeri ödəmək olardı, heç bir toqquşma qarşısını
 * almadan (issue #10-dakı xəbərdarlıq).
 */
const ISOLATED_TASK_TYPES = new Set(['code', 'test'])

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * `git` çağırışı — XƏTA ATMIR, çıxış kodunu qaytarır.
 *
 * `execFile`-ın promise variantı sıfırdan fərqli kodda throw edir; bizə isə
 * demək olar hər yerdə "alınmadısa nəzakətlə geri çəkil" davranışı lazımdır
 * (git yoxdur, repo deyil, commit yoxdur). Hər çağırışı `try/catch`-a bükmək
 * o qərarı beş yerə yayardı.
 */
function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/**
 * Paralellik hovuzunun effektiv limiti.
 *
 * `0` = **avtomatik**. Sütunun default-u məhz `0`-dır, çünki "neçə paralel"
 * sualının cavabı MAŞINDAN asılıdır və bazaya sabit yazıla bilməz.
 *
 * `cores - 2`: bir nüvə serverin özünə, biri istifadəçinin redaktoruna qalır —
 * agentlər maşını tam yükləsə UI cavab verməz. Yuxarı hədd `4`-dür: hər paralel
 * icra ~21.7k token prompt döşəməsi ödəyir (CLAUDE.md qayda 1), ona görə
 * paralelliyi nüvə sayına görə sonsuz artırmaq pul yandırmaqdır.
 */
export function resolveMaxParallel(value: number): number {
  if (value > 0) return value
  return Math.max(1, Math.min(4, cpus().length - 2))
}

export interface IsolateInput {
  /** Kontekstin XAM `max_parallel` dəyəri (0 = avtomatik). */
  maxParallel: number
  taskType: string
  cwd: string | null
  /** Runner ümumiyyətlə fayla toxunurmu (API runner-i toxunmur). */
  fileAccess: boolean
}

/**
 * Bu task üçün ayrıca worktree açılmalıdırmı — **sıfır token**, saf funksiya.
 *
 * Üç şərt BİRLİKDƏ tələb olunur və hər biri bir israfın qarşısını alır:
 *
 *  - `maxParallel > 1` — izolyasiya YALNIZ eyni anda iki task eyni fayllara
 *    toxuna biləndə məna daşıyır. Ardıcıl rejimdə worktree hər taska ~200–500 ms
 *    və disk yeri əlavə edərdi, qarşısını aldığı heç bir toqquşma olmadan.
 *  - `fileAccess` — API runner-i fayl yazmır; onun üçün worktree boş qovluqdur.
 *  - kod/test tipi — mətn taskı repoya toxunmur.
 *
 * `cwd` yoxdursa git ümumiyyətlə yoxdur.
 */
export function shouldIsolate(input: IsolateInput): boolean {
  if (input.cwd === null) return false
  if (!input.fileAccess) return false
  if (resolveMaxParallel(input.maxParallel) <= 1) return false
  return ISOLATED_TASK_TYPES.has(input.taskType)
}

/** `orchestris/<taskId>` — repodakı digər branch-larla toqquşmasın deyə prefiksli. */
export function branchName(taskId: string): string {
  return `orchestris/${taskId}`
}

/**
 * Real git implementasiyası.
 *
 * WINDOWS UZUN YOL: worktree qovluğunun adı taskın UUID-sidir (36 simvol), tam
 * yol `~/.orchestris/worktrees/<uuid>` ≈ 60 simvol. Repo adını və ya task
 * mətnini ora qatsaydıq dərin qovluqlu layihələrdə 260 simvol limitini aşmaq
 * asan olardı və `git worktree add` anlaşılmaz xəta ilə sınardı.
 */
export class GitWorktrees implements WorktreeManager {
  private readonly root: string

  constructor(root: string = worktreesDir()) {
    this.root = root
  }

  /**
   * Yeni worktree açır və İSTİFADƏÇİNİN COMMIT EDİLMƏMİŞ İŞİNİ ora köçürür.
   *
   * NİYƏ KÖÇÜRMƏ VACİBDİR: `git worktree add … HEAD` yalnız son commit-i alır.
   * Köçürməsək, istifadəçinin yarımçıq işi olan repoda agent KÖHNƏ kodu görər —
   * "bu funksiyanı düzəlt" taskı artıq mövcud olmayan kodu düzəldərdi və nəticə
   * diff-i əsas repoya heç vaxt təmiz tətbiq olunmazdı.
   *
   * Köçürmə alınmasa worktree SİLİNİR və `null` qaytarılır: izolyasiyasız,
   * amma DÜZGÜN kod üzərində işləmək — səssizcə köhnə kod üzərində işləməkdən
   * yaxşıdır.
   */
  async create(input: { repo: string; taskId: string }): Promise<Worktree | null> {
    const top = await git(['rev-parse', '--show-toplevel'], input.repo)
    if (top.code !== 0) return null // git yoxdur və ya repo deyil
    const repo = top.stdout.trim()
    if (repo === '') return null

    // Commit-siz repoda `HEAD` yoxdur — worktree bağlaya biləcəyimiz nöqtə də.
    if ((await git(['rev-parse', '--verify', 'HEAD'], repo)).code !== 0) return null

    const path = join(this.root, input.taskId)
    const branch = branchName(input.taskId)
    await mkdir(this.root, { recursive: true })

    // BİR TƏKRAR CƏHD: `worktree add` reponun git qeydlərinə yazır və İKİ task
    // eyni anda başlayanda (hovuz onlara icazə verir) biri kilidə düşüb sına
    // bilər. Təkrar cəhd etməsək, həmin task səssizcə izolyasiyasız — yəni
    // istifadəçinin ƏSL repo-sunda — işləyərdi; iki belə task isə məhz bir-birinin
    // fayllarını korlayardı.
    let add = await git(['worktree', 'add', path, '-b', branch, 'HEAD'], repo)
    if (add.code !== 0) {
      await new Promise((r) => setTimeout(r, WORKTREE_RETRY_MS))
      add = await git(['worktree', 'add', path, '-b', branch, 'HEAD'], repo)
    }
    if (add.code !== 0) return null

    const wt: Worktree = { repo, path, branch }
    if (await this.carryUncommitted(wt)) return wt

    await this.remove(wt)
    return null
  }

  /**
   * Worktree-dəki bütün dəyişikliyi diff kimi toplayır.
   *
   * `git add -A` QƏSDƏNDİR: `git diff` izlənilməyən faylları GÖSTƏRMİR, halbuki
   * agentin yaratdığı yeni fayl dəyişikliyin ən vacib hissəsi ola bilər. Worktree
   * onsuz da birdəfəlikdir — onun indeksini "çirkləndirmək" heç nəyə zərər vurmur.
   */
  async collect(wt: Worktree): Promise<WorktreeDiff> {
    await git(['add', '-A'], wt.path)
    const names = await git(['diff', '--cached', '--name-only'], wt.path)
    const files = names.stdout.split('\n').filter((l) => l.trim() !== '').length
    if (files === 0) return { diff: '', files: 0, truncated: false }

    const out = await git(['diff', '--cached'], wt.path)
    const diff = out.stdout
    return diff.length > DIFF_CHAR_LIMIT
      ? { diff: diff.slice(0, DIFF_CHAR_LIMIT), files, truncated: true }
      : { diff, files, truncated: false }
  }

  /**
   * Worktree-ni və onun branch-ını silir.
   *
   * `--force` lazımdır: worktree QƏSDƏN çirklidir (agentin işi orada qalıb) və
   * git təmiz olmayan worktree-ni silməkdən imtina edərdi. Qovluq əl ilə
   * silinibsə `worktree remove` sınır — o halda `prune` git-in daxili qeydini
   * təmizləyir, yoxsa növbəti `worktree add` "already registered" deyərdi.
   */
  async remove(wt: Worktree): Promise<void> {
    const removed = await git(['worktree', 'remove', '--force', wt.path], wt.repo)
    if (removed.code !== 0) {
      await rm(wt.path, { recursive: true, force: true })
      await git(['worktree', 'prune'], wt.repo)
    }
    await git(['branch', '-D', wt.branch], wt.repo)
  }

  /**
   * Diff-i ƏSAS repoya tətbiq edir — istifadəçinin "qəbul et" qərarı.
   *
   * NİYƏ `git apply`, NİYƏ `git merge` DEYİL: merge istifadəçinin branch-ına və
   * commit tarixçəsinə toxunur və münaqişədə repo yarımçıq merge vəziyyətində
   * qalır. `apply` isə yalnız işçi ağacı dəyişir — nəticəni istifadəçi öz adi
   * axını ilə (`git add`/`git commit`) idarə edir və heç nə "qarışıq" vəziyyətdə
   * qalmır.
   *
   * `--check` ƏVVƏLCƏ qaçır: yarım tətbiq olunmuş patch istifadəçinin iş
   * ağacını sındırardı və geri qaytarmaq üçün əlimizdə heç nə olmazdı.
   */
  async apply(input: { repo: string; diff: string }): Promise<ApplyResult> {
    if (input.diff.trim() === '') return { ok: false, error: 'Diff boşdur' }

    const dir = await mkdtemp(join(tmpdir(), 'orchestris-patch-'))
    const file = join(dir, 'change.patch')
    try {
      await writeFile(file, input.diff, 'utf8')
      const check = await git(['apply', '--check', file], input.repo)
      if (check.code !== 0) {
        return { ok: false, error: errorText(check) }
      }
      const applied = await git(['apply', file], input.repo)
      if (applied.code !== 0) return { ok: false, error: errorText(applied) }
      return { ok: true }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * İzlənilən dəyişiklikləri patch ilə, izlənilməyən faylları kopyalayaraq
   * yeni worktree-yə köçürür.
   *
   * İki mexanizm lazımdır, çünki `git diff HEAD` izlənilməyən faylı GÖRMÜR —
   * yalnız patch işlətsək, istifadəçinin hələ `git add` etmədiyi yeni faylları
   * agent görməzdi.
   *
   * `--exclude-standard` qeyd: `.gitignore`-dakılar kopyalanmır — `node_modules`
   * və `dist` köçürülsəydi hər worktree gigabaytlarla disk yeyərdi.
   */
  private async carryUncommitted(wt: Worktree): Promise<boolean> {
    const tracked = await git(['diff', 'HEAD', '--binary'], wt.repo)
    if (tracked.code !== 0) return false

    if (tracked.stdout.trim() !== '') {
      const dir = await mkdtemp(join(tmpdir(), 'orchestris-carry-'))
      const file = join(dir, 'carry.patch')
      try {
        await writeFile(file, tracked.stdout, 'utf8')
        const applied = await git(['apply', '--whitespace=nowarn', file], wt.path)
        if (applied.code !== 0) return false
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    const others = await git(['ls-files', '--others', '--exclude-standard'], wt.repo)
    if (others.code !== 0) return false
    for (const rel of others.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')) {
      const target = join(wt.path, rel)
      try {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(wt.repo, rel), target)
      } catch {
        // Kopyalana bilməyən tək fayl (icazə, silinmiş, simvolik keçid)
        // izolyasiyanı tamamilə ləğv etməməlidir — patch onsuz da tətbiq olunub.
      }
    }
    return true
  }
}

/**
 * Worktree-nin `.git` faylından ƏSAS reponun yolunu oxuyur.
 *
 * `git worktree add` alt qovluğa qovluq deyil, FAYL qoyur:
 * `gitdir: C:/repo/.git/worktrees/<ad>`. Bu, yetim təmizləyicisi üçün yeganə
 * etibarlı mənbədir: server çökəndə heç bir DB sətri yazılmır, yəni qovluğun
 * hansı repodan doğduğunu ondan BAŞQA heç nə bilmir. Repo tapılmasa `git`
 * əmrini haradan qaçıracağımız yoxdur və qovluq sadəcə silinir.
 */
export async function readWorktreeRepo(path: string): Promise<string | null> {
  try {
    const text = await readFile(join(path, '.git'), 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (m?.[1] === undefined) return null
    const gitdir = resolve(m[1].trim())
    const marker = `${sep}.git${sep}worktrees${sep}`
    const idx = gitdir.indexOf(marker)
    return idx === -1 ? null : gitdir.slice(0, idx)
  } catch {
    return null
  }
}

export interface OrphanCleanup {
  removed: string[]
  kept: string[]
}

/**
 * Server başlanğıcında qalan yetim worktree-ləri silir.
 *
 * NİYƏ LAZIMDIR: server çökəndə (və ya `kill -9` ilə dayandırılanda) nərdivanın
 * `finally` bloku qaçmır — diff toplanmır, qovluq isə diskdə qalır. Bir neçə
 * çökmədən sonra `~/.orchestris/worktrees/` reponun onlarla nüsxəsini saxlayardı.
 *
 * `keep` — istifadəçinin hələ qərar vermədiyi (`pending`) diff-lərin yolları.
 * Onlara TOXUNULMUR: o qovluqlar yetim deyil, agentin bitmiş və gözləyən işidir.
 * Silsəydik, bir yenidən başlatma bütün baxılmamış nəticələri məhv edərdi.
 */
export async function cleanupOrphanWorktrees(
  manager: WorktreeManager,
  opts: { keep: readonly string[]; root?: string },
): Promise<OrphanCleanup> {
  const root = opts.root ?? worktreesDir()
  const keep = new Set(opts.keep.map((p) => resolve(p)))
  const result: OrphanCleanup = { removed: [], kept: [] }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result // qovluq hələ yaradılmayıb — təmizləyəcək heç nə yoxdur
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (keep.has(resolve(path))) {
      result.kept.push(path)
      continue
    }

    const repo = await readWorktreeRepo(path)
    if (repo === null) {
      await rm(path, { recursive: true, force: true })
    } else {
      await manager.remove({ repo, path, branch: branchName(entry.name) })
    }
    result.removed.push(path)
  }

  return result
}

function errorText(r: GitResult): string {
  const text = `${r.stderr}\n${r.stdout}`.trim()
  return text === '' ? `git ${r.code} kodu ilə bitdi` : text.slice(0, 2000)
}
