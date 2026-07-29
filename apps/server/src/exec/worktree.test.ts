import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  branchName,
  cleanupOrphanWorktrees,
  GitWorktrees,
  readWorktreeRepo,
  resolveMaxParallel,
  shouldIsolate,
} from './worktree.js'

/**
 * BU TEST REAL `git` ÇAĞIRIR — və bu, qayda 11-ə (testlər token xərcləməməlidir)
 * ZİDD DEYİL: `git` pulsuzdur, lokaldır və CI onsuz da onunla checkout edir.
 * Saxta git yazsaydıq, testlər yalnız ÖZ uydurmamızı yoxlayardı — halbuki
 * burada bütün risk məhz git-in real davranışındadır (`worktree add` HEAD-i
 * alır, `diff` izlənilməyən faylı görmür, `apply --check` münaqişəni tutur).
 */
const roots: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/**
 * Sətir sonluğu NORMALLAŞDIRILIR: Windows-da git `core.autocrlf` ilə checkout
 * zamanı LF-i CRLF-ə çevirir. Bu, izolyasiyanın deyil, istifadəçinin git
 * konfiqurasiyasının davranışıdır (worktree əsas repo ilə eyni konfiqurasiyanı
 * miras alır) — testin ondan asılı olması düzgün olmazdı.
 */
async function readText(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Bir commit-li təmiz repo — worktree-nin bağlanacağı nöqtə. */
async function makeRepo(): Promise<string> {
  const repo = await tempDir('orchestris-repo-')
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  await writeFile(join(repo, 'a.txt'), 'birinci\n', 'utf8')
  git(['add', '.'], repo)
  git(['commit', '-m', 'init'], repo)
  return repo
}

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

describe('shouldIsolate', () => {
  const base = { maxParallel: 4, taskType: 'code', cwd: 'C:/repo', fileAccess: true }

  it('paralel kod taskı üçün worktree açılır', () => {
    expect(shouldIsolate(base)).toBe(true)
    expect(shouldIsolate({ ...base, taskType: 'test' })).toBe(true)
  })

  it('ardıcıl rejimdə açılmır — izolyasiya ediləcək heç nə yoxdur', () => {
    expect(shouldIsolate({ ...base, maxParallel: 1 })).toBe(false)
  })

  it('mətn taskı repoya toxunmur', () => {
    expect(shouldIsolate({ ...base, taskType: 'explain' })).toBe(false)
    expect(shouldIsolate({ ...base, taskType: 'chat' })).toBe(false)
  })

  it('fayl girişi olmayan runner üçün worktree boş qovluqdur', () => {
    expect(shouldIsolate({ ...base, fileAccess: false })).toBe(false)
  })

  it('cwd yoxdursa git də yoxdur', () => {
    expect(shouldIsolate({ ...base, cwd: null })).toBe(false)
  })
})

describe('resolveMaxParallel', () => {
  it('açıq dəyər olduğu kimi qalır', () => {
    expect(resolveMaxParallel(3)).toBe(3)
  })

  it('0 = avtomatik və heç vaxt 1-dən kiçik, 4-dən böyük olmur', () => {
    const auto = resolveMaxParallel(0)
    expect(auto).toBeGreaterThanOrEqual(1)
    expect(auto).toBeLessThanOrEqual(4)
  })
})

/**
 * REAL `git` bir testdə 5–8 proses spawn edir (`init`, `config`, `commit`,
 * `worktree add`, `diff`, `apply`) və hər biri Windows-da ~200–600 ms çəkir.
 * Vitest-in 5 s default-u paralel yüklə (bütün paket birlikdə qaçanda) ölçülmüş
 * halda 3–5 s-ə çatan bu testləri təsadüfən kəsirdi — yəni sınma kodun deyil,
 * maşının yüklənməsinin funksiyası idi. Belə test "flaky" olur və ən pis
 * nəticəni verir: adamlar qırmızı CI-ı görməzdən gəlməyə öyrəşir.
 */
const GIT_TEST_TIMEOUT_MS = 30_000

describe('GitWorktrees', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('git repo olmayan qovluqda null qaytarır — icra əsas cwd-də davam edir', async () => {
    const plain = await tempDir('orchestris-plain-')
    const root = await tempDir('orchestris-wt-')
    const wt = await new GitWorktrees(root).create({ repo: plain, taskId: 't1' })
    expect(wt).toBeNull()
  })

  it('commit-siz repoda null qaytarır — bağlanacaq HEAD yoxdur', async () => {
    const repo = await tempDir('orchestris-empty-')
    git(['init', '-b', 'main'], repo)
    const root = await tempDir('orchestris-wt-')
    expect(await new GitWorktrees(root).create({ repo, taskId: 't1' })).toBeNull()
  })

  it('worktree açır və commit edilmiş faylları daşıyır', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const wt = await new GitWorktrees(root).create({ repo, taskId: 't1' })

    expect(wt).not.toBeNull()
    expect(wt?.branch).toBe(branchName('t1'))
    expect(await readText(join(wt?.path as string, 'a.txt'))).toBe('birinci\n')
  })

  it('COMMIT EDİLMƏMİŞ işi də daşıyır — agent köhnə kod görməməlidir', async () => {
    const repo = await makeRepo()
    // İstifadəçinin yarımçıq işi: dəyişdirilmiş fayl + hələ `git add` edilməmiş fayl.
    await writeFile(join(repo, 'a.txt'), 'birinci\ndəyişdi\n', 'utf8')
    await writeFile(join(repo, 'yeni.txt'), 'izlənilməyən\n', 'utf8')

    const root = await tempDir('orchestris-wt-')
    const wt = await new GitWorktrees(root).create({ repo, taskId: 't2' })
    const path = wt?.path as string

    expect(await readText(join(path, 'a.txt'))).toBe('birinci\ndəyişdi\n')
    expect(await readText(join(path, 'yeni.txt'))).toBe('izlənilməyən\n')
  })

  it('dəyişiklik yoxdursa diff boşdur', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const manager = new GitWorktrees(root)
    const wt = await manager.create({ repo, taskId: 't3' })

    const diff = await manager.collect(wt as never)
    expect(diff.files).toBe(0)
    expect(diff.diff).toBe('')
  })

  it('YENİ fayl da diff-ə düşür — `git diff` təkbaşına onu göstərmir', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const manager = new GitWorktrees(root)
    const wt = await manager.create({ repo, taskId: 't4' })
    await writeFile(join(wt?.path as string, 'agent.txt'), 'agentin işi\n', 'utf8')

    const diff = await manager.collect(wt as never)
    expect(diff.files).toBe(1)
    expect(diff.diff).toContain('agent.txt')
    expect(diff.truncated).toBe(false)
  })

  it('diff əsas repoya tətbiq olunur və worktree silinir', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const manager = new GitWorktrees(root)
    const wt = await manager.create({ repo, taskId: 't5' })
    await writeFile(join(wt?.path as string, 'agent.txt'), 'agentin işi\n', 'utf8')
    const diff = await manager.collect(wt as never)

    const applied = await manager.apply({ repo, diff: diff.diff })
    expect(applied.ok).toBe(true)
    expect(await readText(join(repo, 'agent.txt'))).toBe('agentin işi\n')

    await manager.remove(wt as never)
    expect(existsSync(wt?.path as string)).toBe(false)
    // Branch də gedir — yoxsa hər task repoda əbədi qalan bir branch qoyardı.
    expect(git(['branch', '--list', branchName('t5')], repo).trim()).toBe('')
  })

  it('münaqişəli diff TƏTBİQ OLUNMUR və repo toxunulmaz qalır', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const manager = new GitWorktrees(root)
    const wt = await manager.create({ repo, taskId: 't6' })
    await writeFile(join(wt?.path as string, 'a.txt'), 'agent versiyası\n', 'utf8')
    const diff = await manager.collect(wt as never)

    // İstifadəçi bu arada eyni faylı özü dəyişdi — patch artıq oturmur.
    await writeFile(join(repo, 'a.txt'), 'istifadəçi versiyası\n', 'utf8')

    const applied = await manager.apply({ repo, diff: diff.diff })
    expect(applied.ok).toBe(false)
    expect(await readText(join(repo, 'a.txt'))).toBe('istifadəçi versiyası\n')
  })
})

describe('yetim təmizləyicisi', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('worktree-nin .git faylından repo yolunu oxuyur', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const wt = await new GitWorktrees(root).create({ repo, taskId: 't7' })

    // `mkdtemp` macOS-da `/private` prefiksi əlavə edə bilir, ona görə
    // müqayisə sonluq üzrədir.
    const found = await readWorktreeRepo(wt?.path as string)
    expect(found).not.toBeNull()
    expect(existsSync(join(found as string, '.git'))).toBe(true)
  })

  it('yetimləri silir, gözləyən diff-lərə TOXUNMUR', async () => {
    const repo = await makeRepo()
    const root = await tempDir('orchestris-wt-')
    const manager = new GitWorktrees(root)
    const orphan = await manager.create({ repo, taskId: 'orphan' })
    const pending = await manager.create({ repo, taskId: 'pending' })

    const scan = await cleanupOrphanWorktrees(manager, {
      root,
      keep: [pending?.path as string],
    })

    expect(scan.removed).toEqual([orphan?.path])
    expect(scan.kept).toEqual([pending?.path])
    expect(existsSync(orphan?.path as string)).toBe(false)
    expect(existsSync(pending?.path as string)).toBe(true)
  })

  it('qovluq yoxdursa səssizcə boş nəticə qaytarır', async () => {
    const root = join(await tempDir('orchestris-wt-'), 'yoxdur')
    const scan = await cleanupOrphanWorktrees(new GitWorktrees(root), { root, keep: [] })
    expect(scan.removed).toEqual([])
  })
})
