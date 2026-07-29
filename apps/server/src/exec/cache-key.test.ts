import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeCacheKey, repoFingerprint } from './cache-key.js'

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git-'))
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'bir\n')
  run('add', '.')
  run('commit', '-q', '-m', 'ilk')
  return dir
}

describe('repoFingerprint', () => {
  it('git repo olmayan qovluq üçün null qaytarır', () => {
    expect(repoFingerprint(mkdtempSync(join(tmpdir(), 'orch-nogit-')))).toBeNull()
  })

  it('undefined cwd üçün null qaytarır', () => {
    expect(repoFingerprint(undefined)).toBeNull()
  })

  it('təmiz repo üçün sabit dəyər qaytarır', () => {
    const dir = gitRepo()
    expect(repoFingerprint(dir)).toBe(repoFingerprint(dir))
  })

  it('fayl dəyişdikdə barmaq izi DƏYİŞİR', () => {
    const dir = gitRepo()
    const before = repoFingerprint(dir)
    writeFileSync(join(dir, 'a.txt'), 'iki\n')
    expect(repoFingerprint(dir)).not.toBe(before)
  })

  it('yeni izlənilməyən fayl da barmaq izini dəyişir', () => {
    const dir = gitRepo()
    const before = repoFingerprint(dir)
    writeFileSync(join(dir, 'yeni.txt'), 'x')
    expect(repoFingerprint(dir)).not.toBe(before)
  })
})

describe('computeCacheKey', () => {
  const base = {
    prompt: 'salam',
    modelId: 'haiku',
    runnerId: 'cli:claude',
    needsFileAccess: false,
  }

  it('eyni giriş üçün eyni açar', () => {
    expect(computeCacheKey(base)).toBe(computeCacheKey(base))
  })

  it('prompt dəyişəndə açar dəyişir', () => {
    expect(computeCacheKey({ ...base, prompt: 'başqa' })).not.toBe(computeCacheKey(base))
  })

  it('model dəyişəndə açar dəyişir', () => {
    expect(computeCacheKey({ ...base, modelId: 'sonnet' })).not.toBe(computeCacheKey(base))
  })

  it('runner dəyişəndə açar dəyişir', () => {
    expect(computeCacheKey({ ...base, runnerId: 'cli:codex' })).not.toBe(
      computeCacheKey(base),
    )
  })

  it('prompt-un baş və son boşluğu əhəmiyyətsizdir', () => {
    expect(computeCacheKey({ ...base, prompt: '  salam  ' })).toBe(computeCacheKey(base))
  })

  it('prompt-un içindəki fərq əhəmiyyətlidir', () => {
    expect(computeCacheKey({ ...base, prompt: 'sa lam' })).not.toBe(computeCacheKey(base))
  })

  it('64 simvollu hex sha256 qaytarır', () => {
    expect(computeCacheKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fayl girişi tələb olunanda və repo git deyilsə null qaytarır', () => {
    // Keşləmək təhlükəlidir: kod vəziyyətini müəyyən edə bilmirik.
    const dir = mkdtempSync(join(tmpdir(), 'orch-nogit2-'))
    expect(
      computeCacheKey({ ...base, needsFileAccess: true, cwd: dir }),
    ).toBeNull()
  })

  it('fayl girişi tələb olunanda cwd verilməyibsə null qaytarır', () => {
    expect(computeCacheKey({ ...base, needsFileAccess: true })).toBeNull()
  })

  it('fayl girişi tələb olunanda git repo üçün açar verir', () => {
    const dir = gitRepo()
    expect(computeCacheKey({ ...base, needsFileAccess: true, cwd: dir })).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it('kod dəyişəndə eyni prompt üçün açar DƏYİŞİR', () => {
    // Bu, planın ən vacib testidir: eyni sual dəyişmiş kod üzərində fərqli
    // cavab tələb edir. Açar bunu əks etdirməsə keş yanlış nəticə qaytarardı.
    const dir = gitRepo()
    const withArgs = { ...base, needsFileAccess: true, cwd: dir }
    const before = computeCacheKey(withArgs)
    writeFileSync(join(dir, 'a.txt'), 'deyisdi\n')
    expect(computeCacheKey(withArgs)).not.toBe(before)
  })

  it('fayl girişi tələb olunmayanda cwd açara təsir etmir', () => {
    // Saf mətn taskı üçün iş qovluğu əhəmiyyətsizdir.
    const dir = gitRepo()
    expect(computeCacheKey({ ...base, cwd: dir })).toBe(computeCacheKey(base))
  })

  it('yaddaş barmaq izi açarı DƏYİŞDİRİR', () => {
    // Yaddaş işçinin promptunu dəyişir — girməsəydi yaddaşsız cavab yaddaşlı
    // icraya səssizcə qaytarılardı (`templateId` ilə eyni səbəb).
    expect(computeCacheKey({ ...base, memoryDigest: 'abc' })).not.toBe(
      computeCacheKey(base),
    )
    expect(computeCacheKey({ ...base, memoryDigest: 'abc' })).not.toBe(
      computeCacheKey({ ...base, memoryDigest: 'def' }),
    )
  })

  it('yaddaşsız halda açar HEÇ DƏYİŞMİR — mövcud keşlər sınmır', () => {
    // Sahə ÜMUMİYYƏTLƏ verilmir (`exactOptionalPropertyTypes`) — yaddaşsız
    // quraşdırmada hash-in girişinə bir bayt belə əlavə olunmur.
    expect(computeCacheKey({ ...base })).toBe(computeCacheKey(base))
  })
})
