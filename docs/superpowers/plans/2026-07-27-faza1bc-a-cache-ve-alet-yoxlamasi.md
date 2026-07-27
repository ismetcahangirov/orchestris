# Faza 1BC-A — Cache və Alət Yoxlaması: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Amplifikasiya nərdivanının ilk iki işlək pilləsini qurmaq — təkrar taskları sıfır tokenə qaytaran cache (Pillə 0) və zəif modelin çıxışını determinist alətlərlə yoxlayıb düzəltdirən dövrə (Pillə 2).

**Architecture:** `RunSupervisor` bir icranı idarə edir və dəyişmir. Onun üzərinə yeni `Ladder` qatı gəlir: cache-ə baxır, lazım olsa supervisor-u çağırır, nəticəni yoxlama əmrləri ilə sınayır, uğursuz olsa xəta mətnini geri ötürüb yenidən cəhd etdirir. Yoxlama tamamilə determinist alətlərlə (`tsc`, `eslint`, test) aparılır və **sıfır token** xərcləyir.

**Tech Stack:** Mövcud stack — Node 22, TypeScript, Fastify, Drizzle + better-sqlite3, Vitest, React 19. Yeni asılılıq yoxdur.

**Bu plan nəyi əhatə etmir:** `ApiRunner`, API açarları, models.dev (Plan B); qayda-əsaslı routing və Auto rejimi (Plan C); best-of-N, ipucu, plan/icra (Faza 2).

---

## Niyə bu ardıcıllıq

Faza 1A-da ölçülən fakt: sistemin hazırda **bir** işlək runner-i var (`cli:claude`; codex login olunmayıb). Ona görə:

| Pillə | İndi mümkündürmü | Səbəb |
|---|---|---|
| **0 — Cache** | ✅ | Heç nədən asılı deyil |
| **2 — Alət yoxlaması** | ✅ | Bir işçi model kifayətdir; yoxlamanı alətlər edir |
| **1 — Routing** | ❌ | Bir hədəf arasında yönləndirmə mənasızdır → Plan C |

Pillə 2 nərdivanın **ən böyük leveridir**: araşdırma göstərir ki, kiçik modellər öz-özünü yoxlamaqda pisdir (yoxlama yaddaş-tələbkardır), ona görə yoxlama determinist alətlərə verilir — bu sayədə 1B parametrli model 8B-ni üstələyir.

## Mövcud vəziyyət (Faza 1A bitib)

- 233 test, 16 fayl. `pnpm typecheck` 3 paketdə təmiz.
- `RunEvent` müqaviləsi: `start | text | think | tool | result | usage | rate_limit | done | error`.
  `usage` kumulyativdir, `costUsd` opsionaldır, `billed` məcburidir, `error`-da `retryable` **yoxdur**.
- `apps/server/src/`: `paths.ts`, `db/{schema,client,repo}.ts`, `exec/{budget,supervisor}.ts`,
  `runners/{resolve-exe,spawn,fixtures-path,parse-claude,parse-codex,fake,claude,codex}.ts`,
  `routes/{contexts,tasks}.ts`, `ws/hub.ts`, `app.ts`, `main.ts`.
- `contexts` cədvəlində artıq `verify_commands_json` sütunu var (default `'[]'`) — bu plan onu nəhayət istifadə edir.
- `runs` cədvəlində `cached_hit` və `ladder_rung` sütunları var — bu plan onları doldurur.
- Testlər `FakeRunner` ilə **sıfır token** xərcləyir. Bu qayda pozulmamalıdır.

tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
Qaydalar: `import type`, nisbi importlarda `.js` uzantısı, opsional sahəyə `undefined` təyin etmək əvəzinə şərti spread, **konstruktor parametr-xassələri yoxdur**.
TypeScript faylı əl ilə işə salmaq: `npx tsx <fayl>` (`node --experimental-strip-types` bu repoda işləmir).

---

## Fayl strukturu

```
apps/server/src/
├─ db/
│  ├─ schema.ts                  ← DƏYİŞİR: cache_entries, verification_runs, runs.attempt
│  ├─ client.ts                  ← DƏYİŞİR: yeni DDL
│  └─ repo.ts                    ← DƏYİŞİR: cache və verification funksiyaları
├─ exec/
│  ├─ budget.ts                  dəyişmir
│  ├─ supervisor.ts              dəyişmir — bir icranı idarə edir
│  ├─ cache-key.ts               YENİ: determinist açar + repo barmaq izi
│  ├─ verify.ts                  YENİ: yoxlama əmrlərini qaçırır
│  └─ ladder.ts                  YENİ: cache → icra → yoxlama dövrəsi
├─ routes/tasks.ts               ← DƏYİŞİR: Ladder işlədir
└─ app.ts                        ← DƏYİŞİR: Ladder qurur

apps/web/src/
├─ lib/api.ts                    ← DƏYİŞİR: yeni sahələr
├─ components/RunHeader.tsx      YENİ: pillə, cəhd, cache nişanı
└─ pages/TaskView.tsx            ← DƏYİŞİR: yoxlama nəticələri
```

---

## Task 1: DB sxemi — cache, yoxlama, cəhd nömrəsi

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/client.ts`
- Test: `apps/server/src/db/repo.test.ts` (mövcud faylın sonuna əlavə)

- [ ] **Step 1: Sxemə iki cədvəl və bir sütun əlavə et**

`apps/server/src/db/schema.ts` faylındaki `runs` tərifinə `attempt` sütununu əlavə et
(`ladderRung`-dan dərhal sonra):

```ts
    /**
     * Yoxlama dövrəsində neçənci cəhddir. 1-dən başlayır. Eyni task üçün
     * bir neçə run olur: hər uğursuz yoxlamadan sonra yenisi yaradılır.
     * `escalatedFromRunId` bundan FƏRQLİDİR — o, pillələr arası keçid üçündür.
     */
    attempt: integer('attempt').notNull().default(1),
```

Faylın sonuna, `runsRelations`-dan əvvəl iki yeni cədvəl əlavə et:

```ts
/**
 * Pillə 0 — hazır nəticə keşi.
 *
 * `hash` açarı `cache-key.ts`-də hesablanır və iş qovluğunun git vəziyyətini
 * də əhatə edir: eyni prompt fərqli kod üzərində fərqli cavab tələb edir.
 */
export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    hash: text('hash').primaryKey(),
    modelId: text('model_id').notNull(),
    runnerId: text('runner_id').notNull(),
    /** Saxlanılan `RunEvent[]` — JSON massiv. */
    eventsJson: text('events_json').notNull(),
    hits: integer('hits').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    lastHitAt: integer('last_hit_at'),
  },
  (t) => [index('cache_model_idx').on(t.modelId)],
)

/** Pillə 2 — hər determinist yoxlama əmrinin nəticəsi. */
export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    exitCode: integer('exit_code'),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    /** Çıxışın ilk hissəsi — modelə geri ötürülən budur. */
    outputExcerpt: text('output_excerpt').notNull(),
    durationMs: integer('duration_ms').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('verification_run_idx').on(t.runId)],
)
```

Və `runsRelations`-a əlavə et:

```ts
export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  events: many(runEvents),
  verifications: many(verificationRuns),
}))
```

- [ ] **Step 2: DDL-i yenilə**

`apps/server/src/db/client.ts`-dəki `DDL` sətrində `runs` cədvəlinə
`ladder_rung`-dan sonra əlavə et:

```
  attempt INTEGER NOT NULL DEFAULT 1,
```

Və `DDL`-in sonuna əlavə et:

```
CREATE TABLE IF NOT EXISTS cache_entries (
  hash TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  events_json TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER
);
CREATE INDEX IF NOT EXISTS cache_model_idx ON cache_entries(model_id);
CREATE TABLE IF NOT EXISTS verification_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  exit_code INTEGER,
  passed INTEGER NOT NULL,
  output_excerpt TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_run_idx ON verification_runs(run_id);
```

**Mövcud DB-lər üçün qeyd:** `DDL` `CREATE TABLE IF NOT EXISTS` işlədir, ona görə
yeni cədvəllər mövcud bazaya əlavə olunacaq. Amma `runs.attempt` sütunu
**əlavə olunmayacaq** — `IF NOT EXISTS` sütunlara aid deyil. `openDb`-yə
idempotent sütun əlavəsi lazımdır. `DDL`-dən sonra bunu yaz:

```ts
  sqlite.exec(DDL)

  // `CREATE TABLE IF NOT EXISTS` mövcud cədvələ yeni SÜTUN əlavə etmir.
  // Faza 1A-dan qalan bazalar üçün `attempt` sütununu idempotent əlavə edirik.
  // (drizzle-kit migrasiyaları sonrakı fazada; indi bu kifayətdir.)
  const cols = sqlite.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'attempt')) {
    sqlite.exec(`ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`)
  }
```

- [ ] **Step 3: Uğursuz testləri yaz**

`apps/server/src/db/repo.test.ts` faylının sonuna əlavə et. İmport sətrinə
yeni funksiyaları da əlavə et: `getCacheEntry`, `putCacheEntry`, `recordCacheHit`,
`appendVerification`, `listVerifications`.

```ts
describe('cache_entries', () => {
  it('mövcud olmayan açar üçün undefined qaytarır', () => {
    expect(getCacheEntry(db(), 'yoxdur')).toBeUndefined()
  })

  it('yazır və eyni hadisə massivini geri oxuyur', () => {
    const d = db()
    const events: RunEvent[] = [
      { t: 'text', delta: 'SALAM' },
      { t: 'done', stopReason: 'end_turn' },
    ]
    putCacheEntry(d, { hash: 'h1', modelId: 'm', runnerId: 'r', events })
    const got = getCacheEntry(d, 'h1')
    expect(got?.events).toEqual(events)
    expect(got?.hits).toBe(0)
  })

  it('eyni açarı təkrar yazmaq üzərinə yazır, dublikat yaratmır', () => {
    const d = db()
    putCacheEntry(d, { hash: 'h1', modelId: 'm', runnerId: 'r', events: [] })
    putCacheEntry(d, {
      hash: 'h1',
      modelId: 'm',
      runnerId: 'r',
      events: [{ t: 'text', delta: 'yeni' }],
    })
    expect(getCacheEntry(d, 'h1')?.events).toEqual([{ t: 'text', delta: 'yeni' }])
  })

  it('recordCacheHit sayğacı artırır və vaxtı yazır', () => {
    const d = db()
    putCacheEntry(d, { hash: 'h1', modelId: 'm', runnerId: 'r', events: [] })
    recordCacheHit(d, 'h1')
    recordCacheHit(d, 'h1')
    const got = getCacheEntry(d, 'h1')
    expect(got?.hits).toBe(2)
    expect(got?.lastHitAt).toBeGreaterThan(0)
  })
})

describe('verification_runs', () => {
  it('yoxlama nəticəsini yazır və oxuyur', () => {
    const { d, run } = seed()
    appendVerification(d, run.id, {
      command: 'pnpm typecheck',
      exitCode: 0,
      passed: true,
      outputExcerpt: '',
      durationMs: 1200,
    })
    const list = listVerifications(d, run.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.command).toBe('pnpm typecheck')
    expect(list[0]?.passed).toBe(true)
  })

  it('uğursuz yoxlamanın çıxışını saxlayır', () => {
    const { d, run } = seed()
    appendVerification(d, run.id, {
      command: 'pnpm test',
      exitCode: 1,
      passed: false,
      outputExcerpt: 'FAIL src/a.test.ts',
      durationMs: 900,
    })
    expect(listVerifications(d, run.id)[0]?.outputExcerpt).toContain('FAIL')
  })

  it('çox uzun çıxışı kəsir', () => {
    const { d, run } = seed()
    appendVerification(d, run.id, {
      command: 'x',
      exitCode: 1,
      passed: false,
      outputExcerpt: 'y'.repeat(10_000),
      durationMs: 1,
    })
    expect(listVerifications(d, run.id)[0]?.outputExcerpt.length).toBe(4000)
  })

  it('yoxlamalar sıra ilə qaytarılır', () => {
    const { d, run } = seed()
    for (const c of ['a', 'b', 'c']) {
      appendVerification(d, run.id, {
        command: c,
        exitCode: 0,
        passed: true,
        outputExcerpt: '',
        durationMs: 1,
      })
    }
    expect(listVerifications(d, run.id).map((v) => v.command)).toEqual(['a', 'b', 'c'])
  })
})

describe('runs.attempt / cachedHit', () => {
  it('default-lar: attempt 1, cachedHit false', () => {
    const { run } = seed()
    expect(run.attempt).toBe(1)
    expect(run.cachedHit).toBe(false)
  })

  it('attempt, ladderRung və cachedHit açıq verilə bilir', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, {
      taskId: task.id,
      runnerId: 'fake',
      modelId: 'm',
      attempt: 3,
      ladderRung: 2,
      cachedHit: true,
    })
    expect(run.attempt).toBe(3)
    expect(run.ladderRung).toBe(2)
    expect(run.cachedHit).toBe(true)
  })
})
```

Test faylının başındaki importa `import type { RunEvent } from '@orchestris/shared'` əlavə et.

- [ ] **Step 4: Testi qaçır, uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/db/repo.test.ts`
Expected: FAIL — `getCacheEntry`, `putCacheEntry` və s. export olunmayıb.

- [ ] **Step 5: Repo funksiyalarını yaz**

`apps/server/src/db/repo.ts`-də importa `cacheEntries, verificationRuns` əlavə et.

`createRun` input-una **iki** yeni opsional sahə əlavə et — hər ikisi bu planda
sonra lazımdır, ona görə indi birlikdə əlavə olunur:

```ts
    attempt?: number
    cachedHit?: boolean
```

və `.values({...})` içinə:

```ts
      attempt: input.attempt ?? 1,
      cachedHit: input.cachedHit ?? false,
```

Sonra faylın sonuna əlavə et:

```ts
type CacheEntry = typeof cacheEntries.$inferSelect
type VerificationRun = typeof verificationRuns.$inferSelect

/** Yoxlama çıxışının maksimum saxlanılan uzunluğu. Modelə geri ötürülür. */
const VERIFY_EXCERPT_LIMIT = 4000

export interface CachedResult {
  hash: string
  modelId: string
  runnerId: string
  events: RunEvent[]
  hits: number
  lastHitAt: number | null
}

export function getCacheEntry(db: Db, hash: string): CachedResult | undefined {
  const row: CacheEntry | undefined = db
    .select()
    .from(cacheEntries)
    .where(eq(cacheEntries.hash, hash))
    .get()
  if (row === undefined) return undefined
  return {
    hash: row.hash,
    modelId: row.modelId,
    runnerId: row.runnerId,
    events: JSON.parse(row.eventsJson) as RunEvent[],
    hits: row.hits,
    lastHitAt: row.lastHitAt,
  }
}

export function putCacheEntry(
  db: Db,
  input: {
    hash: string
    modelId: string
    runnerId: string
    events: readonly RunEvent[]
  },
): void {
  db.insert(cacheEntries)
    .values({
      hash: input.hash,
      modelId: input.modelId,
      runnerId: input.runnerId,
      eventsJson: JSON.stringify(input.events),
      createdAt: now(),
    })
    .onConflictDoUpdate({
      target: cacheEntries.hash,
      set: {
        eventsJson: JSON.stringify(input.events),
        modelId: input.modelId,
        runnerId: input.runnerId,
      },
    })
    .run()
}

export function recordCacheHit(db: Db, hash: string): void {
  db.update(cacheEntries)
    .set({ hits: sql`${cacheEntries.hits} + 1`, lastHitAt: now() })
    .where(eq(cacheEntries.hash, hash))
    .run()
}

export function appendVerification(
  db: Db,
  runId: string,
  input: {
    command: string
    exitCode: number | null
    passed: boolean
    outputExcerpt: string
    durationMs: number
  },
): void {
  db.insert(verificationRuns)
    .values({
      runId,
      command: input.command,
      exitCode: input.exitCode,
      passed: input.passed,
      outputExcerpt: input.outputExcerpt.slice(0, VERIFY_EXCERPT_LIMIT),
      durationMs: input.durationMs,
      at: now(),
    })
    .run()
}

export function listVerifications(db: Db, runId: string): VerificationRun[] {
  return db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.runId, runId))
    .orderBy(asc(verificationRuns.id))
    .all()
}
```

- [ ] **Step 6: Testi qaçır, keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/db/repo.test.ts`
Expected: PASS — 27 mövcud + 11 yeni = 38 test.

Run: `pnpm --filter @orchestris/server typecheck` — təmiz.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db
git commit -m "feat(server): cache_entries, verification_runs cədvəlləri və runs.attempt

Mövcud bazalar üçün attempt sütunu idempotent ALTER ilə əlavə olunur —
CREATE TABLE IF NOT EXISTS sütunlara aid deyil."
```

---

## Task 2: Cache açarı — repo vəziyyəti daxil olmaqla

Bu taskın ən vacib qərarı: **kod tasklarını yalnız prompt-a görə keşləmək yanlışdır.**
Eyni prompt dəyişmiş kod üzərində fərqli cavab tələb edir. Açar iş qovluğunun
git vəziyyətini də əhatə etməlidir; git repo deyilsə, fayl girişi olan icralar
ümumiyyətlə keşlənmir.

**Files:**
- Create: `apps/server/src/exec/cache-key.ts`
- Test: `apps/server/src/exec/cache-key.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/exec/cache-key.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Testi qaçır, uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/cache-key.test.ts`
Expected: FAIL — `./cache-key.js` həll olunmur.

- [ ] **Step 3: İmplementasiyanı yaz**

`apps/server/src/exec/cache-key.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/**
 * İş qovluğunun git vəziyyətinin qısa barmaq izi: HEAD commit + işçi ağacın
 * dəyişiklikləri.
 *
 * `git status --porcelain` izlənilməyən faylları da göstərir, ona görə yeni
 * fayl yaratmaq da barmaq izini dəyişir.
 *
 * Git repo deyilsə və ya git əlçatan deyilsə `null` qaytarır.
 */
export function repoFingerprint(cwd: string | undefined): string | null {
  if (cwd === undefined) return null
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return createHash('sha256').update(head).update('\0').update(dirty).digest('hex')
  } catch {
    return null
  }
}

export interface CacheKeyInput {
  prompt: string
  modelId: string
  runnerId: string
  /** Task fayl sisteminə toxunurmu? Toxunursa repo vəziyyəti açara girir. */
  needsFileAccess: boolean
  cwd?: string
}

/**
 * Determinist keş açarı, və ya keşləmək təhlükəlidirsə `null`.
 *
 * NİYƏ REPO VƏZİYYƏTİ AÇARA GİRİR: eyni prompt dəyişmiş kod üzərində fərqli
 * cavab tələb edir. Yalnız prompt-a görə keşləsək, "bu funksiyanı düzəlt"
 * taskı kod dəyişdikdən sonra köhnə cavabı qaytarardı — səssiz və təhlükəli
 * səhv. Fayl girişi olan task üçün repo vəziyyətini bilə bilmiriksə,
 * ÜMUMİYYƏTLƏ keşləmirik.
 */
export function computeCacheKey(input: CacheKeyInput): string | null {
  const h = createHash('sha256')
  h.update('orchestris-cache-v1\0')
  h.update(input.prompt.trim())
  h.update('\0')
  h.update(input.modelId)
  h.update('\0')
  h.update(input.runnerId)
  h.update('\0')

  if (input.needsFileAccess) {
    const fp = repoFingerprint(input.cwd)
    if (fp === null) return null
    h.update(fp)
  }

  return h.digest('hex')
}
```

- [ ] **Step 4: Testi qaçır, keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/cache-key.test.ts`
Expected: PASS — 16 test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/exec/cache-key.ts apps/server/src/exec/cache-key.test.ts
git commit -m "feat(server): determinist keş açarı — repo vəziyyəti daxil

Kod taskını yalnız prompt-a görə keşləmək yanlışdır: eyni sual dəyişmiş kod
üzərində fərqli cavab tələb edir. Fayl girişi olan icralarda açar git HEAD +
işçi ağac vəziyyətini əhatə edir; git repo deyilsə ümumiyyətlə keşlənmir."
```

---

## Task 3: Yoxlama qaçırıcısı

**Files:**
- Create: `apps/server/src/exec/verify.ts`
- Test: `apps/server/src/exec/verify.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/exec/verify.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

const NODE = process.execPath
const okCmd = `"${NODE}" -e "console.log('hamisi yaxsidir')"`
const failCmd = `"${NODE}" -e "console.error('TS2345: tip uygunsuzlugu');process.exit(2)"`
const slowCmd = `"${NODE}" -e "setTimeout(()=>{},60000)"`

const tmp = (): string => mkdtempSync(join(tmpdir(), 'orch-verify-'))

describe('runVerifications', () => {
  it('boş əmr siyahısı üçün keçmiş sayılır', async () => {
    const r = await runVerifications([], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results).toEqual([])
  })

  it('uğurlu əmri passed:true kimi yazır', async () => {
    const r = await runVerifications([okCmd], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results[0]?.exitCode).toBe(0)
    expect(r.results[0]?.output).toContain('hamisi yaxsidir')
  })

  it('uğursuz əmri passed:false kimi yazır və stderr-i saxlayır', async () => {
    const r = await runVerifications([failCmd], { cwd: tmp() })
    expect(r.passed).toBe(false)
    expect(r.results[0]?.exitCode).toBe(2)
    expect(r.results[0]?.output).toContain('TS2345')
  })

  it('bir əmr uğursuz olsa qalanları QAÇIRMIR — tez dayanır', async () => {
    // Səbəb: tsc sınıbsa test qaçırmaq mənasızdır və vaxt itkisidir.
    const r = await runVerifications([failCmd, okCmd], { cwd: tmp() })
    expect(r.passed).toBe(false)
    expect(r.results).toHaveLength(1)
  })

  it('bütün əmrlər uğurlu olsa hamısını qaçırır', async () => {
    const r = await runVerifications([okCmd, okCmd], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results).toHaveLength(2)
  })

  it('müddəti ölçür', async () => {
    const r = await runVerifications([okCmd], { cwd: tmp() })
    expect(r.results[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('timeout-a düşən əmri uğursuz sayır və prosesi öldürür', async () => {
    const r = await runVerifications([slowCmd], { cwd: tmp(), timeoutMs: 500 })
    expect(r.passed).toBe(false)
    expect(r.results[0]?.output).toMatch(/timeout|vaxt/i)
  }, 15_000)

  it('mövcud olmayan əmr üçün uğursuz qaytarır, çökmür', async () => {
    const r = await runVerifications(['orchestris-nosuchcommand-xyz'], { cwd: tmp() })
    expect(r.passed).toBe(false)
  })

  it('signal ilə yarıda kəsilir', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runVerifications([okCmd], { cwd: tmp(), signal: ac.signal })
    expect(r.results).toHaveLength(0)
  })
})

describe('buildFeedbackPrompt', () => {
  it('uğursuz əmri və çıxışını promptda göstərir', () => {
    const p = buildFeedbackPrompt([
      { command: 'pnpm typecheck', exitCode: 2, passed: false, output: 'TS2345 xəta', durationMs: 1 },
    ])
    expect(p).toContain('pnpm typecheck')
    expect(p).toContain('TS2345 xəta')
  })

  it('yalnız uğursuz əmrləri daxil edir', () => {
    const p = buildFeedbackPrompt([
      { command: 'ok-cmd', exitCode: 0, passed: true, output: 'fine', durationMs: 1 },
      { command: 'bad-cmd', exitCode: 1, passed: false, output: 'boom', durationMs: 1 },
    ])
    expect(p).not.toContain('ok-cmd')
    expect(p).toContain('bad-cmd')
  })

  it('çox uzun çıxışı kəsir ki, kontekst şişməsin', () => {
    const p = buildFeedbackPrompt([
      { command: 'c', exitCode: 1, passed: false, output: 'x'.repeat(20_000), durationMs: 1 },
    ])
    expect(p.length).toBeLessThan(5000)
  })

  it('heç bir uğursuzluq yoxdursa boş sətir qaytarır', () => {
    expect(
      buildFeedbackPrompt([
        { command: 'c', exitCode: 0, passed: true, output: '', durationMs: 1 },
      ]),
    ).toBe('')
  })
})
```

- [ ] **Step 2: Testi qaçır, uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/verify.test.ts`

- [ ] **Step 3: İmplementasiyanı yaz**

`apps/server/src/exec/verify.ts`:

```ts
import { spawnLines } from '../runners/spawn.js'

export interface VerificationResult {
  command: string
  exitCode: number | null
  passed: boolean
  /** stdout + stderr birləşdirilmiş çıxış. */
  output: string
  durationMs: number
}

export interface RunVerificationsOptions {
  cwd: string
  /** Hər əmr üçün ayrıca timeout. Default 5 dəqiqə. */
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
/** Modelə geri ötürülən çıxışın hər əmr üçün limiti. */
const FEEDBACK_OUTPUT_LIMIT = 2000

/**
 * Kontekstin yoxlama əmrlərini ardıcıl qaçırır.
 *
 * NİYƏ BU MEXANİZM: araşdırma göstərir ki, kiçik modellər öz-özünü
 * yoxlamaqda pisdir — yoxlama yaddaş-tələbkar işdir. Ona görə yoxlamanı
 * determinist alətlərə veririk: `tsc`, `eslint`, test dəsti. Onlar SIFIR
 * token xərcləyir və heç vaxt "yaxşı görünür" demirlər.
 *
 * TEZ DAYANMA: bir əmr sınırsa qalanları qaçırılmır. `tsc` sınıbsa testləri
 * qaçırmaq həm mənasızdır, həm də vaxt itkisidir.
 *
 * TƏHLÜKƏSİZLİK: əmrlər shell ilə icra olunur, çünki istifadəçi `pnpm test`
 * kimi sərbəst sətirlər yazır. Onlar istifadəçinin öz konfiqurasiyasıdır,
 * modelin uydurduğu mətn DEYİL — model bu siyahını dəyişə bilmir.
 */
export async function runVerifications(
  commands: readonly string[],
  opts: RunVerificationsOptions,
): Promise<{ passed: boolean; results: VerificationResult[] }> {
  const results: VerificationResult[] = []

  for (const command of commands) {
    if (opts.signal?.aborted === true) break

    const startedAt = Date.now()
    const proc = spawnLines({
      command,
      args: [],
      useShell: true,
      cwd: opts.cwd,
    })

    const timeout = setTimeout(() => {
      void proc.kill()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = (): void => void proc.kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const stdout: string[] = []
    try {
      for await (const line of proc.lines) stdout.push(line)
    } finally {
      clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const exitCode = await proc.exitCode
    const killed = proc.killed
    const output = killed
      ? `Əmr vaxt limitinə görə dayandırıldı (timeout).\n${stdout.join('\n')}\n${proc.stderrText()}`
      : `${stdout.join('\n')}\n${proc.stderrText()}`.trim()

    results.push({
      command,
      exitCode,
      passed: !killed && exitCode === 0,
      output,
      durationMs: Date.now() - startedAt,
    })

    // Tez dayanma: sınmış yoxlamadan sonra qalanları qaçırmaq mənasızdır.
    if (!results[results.length - 1]?.passed) break
  }

  return { passed: results.every((r) => r.passed), results }
}

/**
 * Uğursuz yoxlamalardan modelə geri ötürüləcək düzəliş promptu qurur.
 *
 * Çıxış qəsdən kəsilir: bütün `tsc` çıxışını geri ötürmək kontekst şişirdər
 * və token qənaətini məhv edərdi. İlk sətirlər ən informativ olanlardır.
 */
export function buildFeedbackPrompt(results: readonly VerificationResult[]): string {
  const failed = results.filter((r) => !r.passed)
  if (failed.length === 0) return ''

  const blocks = failed.map(
    (r) =>
      `Əmr: ${r.command}\nÇıxış kodu: ${r.exitCode ?? 'yoxdur'}\nÇıxış:\n${r.output.slice(
        0,
        FEEDBACK_OUTPUT_LIMIT,
      )}`,
  )

  return [
    'Əvvəlki cəhdin avtomatik yoxlamadan keçmədi. Aşağıdaki xətaları düzəlt.',
    'Yalnız xətaları düzəlt — başqa dəyişiklik etmə.',
    '',
    ...blocks,
  ].join('\n')
}
```

- [ ] **Step 4: Testi qaçır, keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/verify.test.ts`
Expected: PASS — 13 test.

- [ ] **Step 5: Yetim proses yoxlaması**

Timeout testi prosesi öldürməlidir. Test qaçışından sonra:

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*setTimeout*60000*' } | Select-Object ProcessId, CommandLine"
```

Expected: boş. Proses qalırsa `runVerifications`-dəki timeout/kill məntiqi sınıqdır.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/exec/verify.ts apps/server/src/exec/verify.test.ts
git commit -m "feat(server): determinist yoxlama qaçırıcısı — Pillə 2-nin təməli

Yoxlama modelə deyil, alətlərə verilir (tsc/eslint/test) — sıfır token.
Tez dayanma: sınmış yoxlamadan sonra qalanlar qaçırılmır.
Geri ötürülən çıxış kəsilir ki, kontekst şişməsin."
```

---

## Task 4: `Ladder` — cache → icra → yoxlama dövrəsi

Bu, planın mərkəzidir. `RunSupervisor` **dəyişmir** — o bir icranı idarə edir.
`Ladder` onun üzərində oturur və bir neçə icranı orkestrləşdirir.

**Files:**
- Create: `apps/server/src/exec/ladder.ts`
- Test: `apps/server/src/exec/ladder.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/exec/ladder.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, Runner } from '@orchestris/shared'
import { openDb } from '../db/client.js'
import {
  createContext,
  createTask,
  getCacheEntry,
  listEvents,
  listRunsForTask,
  listVerifications,
} from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { RunSupervisor } from './supervisor.js'
import { Ladder } from './ladder.js'

const NODE = process.execPath
const okCmd = `"${NODE}" -e "process.exit(0)"`
const failCmd = `"${NODE}" -e "console.error('TS2345 xeta');process.exit(1)"`

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

function setup(verifyCommands: string[] = []) {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C', verifyCommands })
  const sup = new RunSupervisor(db)
  const ladder = new Ladder(db, sup)
  const newTask = (prompt = 'salam') =>
    createTask(db, { contextId: ctx.id, prompt })
  return { db, ctx, sup, ladder, newTask }
}

function runner(events: RunEvent[] = DONE): Runner {
  return new FakeRunner({ events, capabilities: { fileAccess: false } })
}

describe('Ladder — Pillə 0 cache', () => {
  it('ilk icra keşə yazılır', async () => {
    const { db, ctx, ladder, newTask } = setup()
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(r.cached).toBe(false)
    expect(r.cacheKey).not.toBeNull()
    expect(getCacheEntry(db, r.cacheKey as string)?.events).toHaveLength(2)
  })

  it('eyni prompt ikinci dəfə keşdən gəlir — MODEL ÇAĞIRILMIR', async () => {
    const { ctx, ladder, newTask } = setup()
    const spy = runner()
    const runSpy = vi.spyOn(spy, 'run')

    await ladder.run({ task: newTask('eyni'), context: ctx, runner: spy, model: 'm' })
    expect(runSpy).toHaveBeenCalledTimes(1)

    const second = await ladder.run({
      task: newTask('eyni'),
      context: ctx,
      runner: spy,
      model: 'm',
    })
    expect(second.cached).toBe(true)
    expect(runSpy).toHaveBeenCalledTimes(1) // artmadı
  })

  it('keşdən gələn icra da hadisə jurnalına yazılır', async () => {
    const { db, ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('x'), context: ctx, runner: runner(), model: 'm' })
    const second = await ladder.run({
      task: newTask('x'),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(listEvents(db, second.runId)).toHaveLength(2)
  })

  it('keşdən gələn run cachedHit və ladderRung 0 ilə işarələnir', async () => {
    const { db, ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('x'), context: ctx, runner: runner(), model: 'm' })
    const t2 = newTask('x')
    const second = await ladder.run({
      task: t2,
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    const row = listRunsForTask(db, t2.id)[0]
    expect(second.cached).toBe(true)
    expect(row?.cachedHit).toBe(true)
    expect(row?.ladderRung).toBe(0)
    expect(row?.status).toBe('succeeded')
  })

  it('fərqli prompt keşdən gəlmir', async () => {
    const { ctx, ladder, newTask } = setup()
    await ladder.run({ task: newTask('bir'), context: ctx, runner: runner(), model: 'm' })
    const second = await ladder.run({
      task: newTask('iki'),
      context: ctx,
      runner: runner(),
      model: 'm',
    })
    expect(second.cached).toBe(false)
  })

  it('uğursuz icra keşə YAZILMIR', async () => {
    const { db, ctx, ladder, newTask } = setup()
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([{ t: 'error', class: 'crashed', message: 'partladi' }]),
      model: 'm',
    })
    expect(r.status).toBe('failed')
    expect(getCacheEntry(db, r.cacheKey as string)).toBeUndefined()
  })

  it('fayl girişi tələb edən task git olmayan qovluqda keşlənmir', async () => {
    const db = openDb(':memory:')
    const ctx = createContext(db, { name: 'C', cwd: process.env['TEMP'] ?? '/tmp' })
    const ladder = new Ladder(db, new RunSupervisor(db))
    const r = await ladder.run({
      task: createTask(db, { contextId: ctx.id, prompt: 'p' }),
      context: ctx,
      // fileAccess: true → repo barmaq izi lazımdır
      runner: new FakeRunner({ events: DONE }),
      model: 'm',
    })
    expect(r.cacheKey).toBeNull()
    expect(r.cached).toBe(false)
  })
})

describe('Ladder — Pillə 2 alət yoxlaması', () => {
  it('yoxlama əmri yoxdursa dövrə işə düşmür', async () => {
    const { db, ctx, ladder, newTask } = setup([])
    const t = newTask()
    const r = await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('succeeded')
    expect(r.attempts).toBe(1)
    expect(listVerifications(db, r.runId)).toHaveLength(0)
  })

  it('yoxlama keçirsə bir cəhdlə bitir', async () => {
    const { db, ctx, ladder, newTask } = setup([okCmd])
    const t = newTask()
    const r = await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('succeeded')
    expect(r.attempts).toBe(1)
    expect(r.verificationPassed).toBe(true)
    expect(listVerifications(db, r.runId)).toHaveLength(1)
  })

  it('yoxlama sınırsa yenidən cəhd edir və xəta mətnini geri ötürür', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const spy = runner()
    const runSpy = vi.spyOn(spy, 'run')

    const r = await ladder.run({ task: newTask(), context: ctx, runner: spy, model: 'm' })

    expect(r.attempts).toBe(3) // maxAttempts
    expect(runSpy).toHaveBeenCalledTimes(3)
    // 2-ci cəhdin promptu yoxlama xətasını daşımalıdır
    const secondPrompt = runSpy.mock.calls[1]?.[0]?.prompt ?? ''
    expect(secondPrompt).toContain('TS2345 xeta')
    expect(secondPrompt).toContain(failCmd)
  }, 30_000)

  it('3 cəhddən sonra dayanır və verification_failed qaytarır', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({ task: newTask(), context: ctx, runner: runner(), model: 'm' })
    expect(r.status).toBe('verification_failed')
    expect(r.verificationPassed).toBe(false)
  }, 30_000)

  it('yoxlamadan keçməyən nəticə keşə YAZILMIR', async () => {
    const { db, ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({ task: newTask(), context: ctx, runner: runner(), model: 'm' })
    expect(getCacheEntry(db, r.cacheKey as string)).toBeUndefined()
  }, 30_000)

  it('hər cəhd ayrıca run sətri yaradır və attempt artır', async () => {
    const { db, ctx, ladder, newTask } = setup([failCmd])
    const t = newTask()
    await ladder.run({ task: t, context: ctx, runner: runner(), model: 'm' })
    const rows = listRunsForTask(db, t.id)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(rows.every((r) => r.ladderRung === 2)).toBe(true)
  }, 30_000)

  it('icra özü uğursuz olsa yoxlama qaçırılmır', async () => {
    const { db, ctx, ladder, newTask } = setup([okCmd])
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([{ t: 'error', class: 'auth', message: 'Not logged in' }]),
      model: 'm',
    })
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1) // auth xətasında təkrar cəhd mənasızdır
    expect(listVerifications(db, r.runId)).toHaveLength(0)
  })

  it('büdcə pozuntusunda təkrar cəhd etmir', async () => {
    const { ctx, ladder, newTask } = setup([failCmd])
    const r = await ladder.run({
      task: newTask(),
      context: ctx,
      runner: runner([
        { t: 'usage', inputTokens: 0, outputTokens: 999, billed: 'real' },
        { t: 'done', stopReason: 'end_turn' },
      ]),
      model: 'm',
      limits: { maxOutputTokens: 1 },
    })
    expect(r.status).toBe('budget_exceeded')
    expect(r.attempts).toBe(1)
  })
})

describe('Ladder — dayandırma', () => {
  it('cancel bütün cəhdləri dayandırır', async () => {
    const { ctx, ladder, sup, newTask } = setup([failCmd])
    const slow = new FakeRunner({
      events: Array.from({ length: 60 }, (_, i) => ({ t: 'text' as const, delta: String(i) })),
      delayMs: 5,
      capabilities: { fileAccess: false },
    })
    const p = ladder.run({ task: newTask(), context: ctx, runner: slow, model: 'm' })
    await new Promise((r) => setTimeout(r, 40))
    sup.cancelAll()
    const r = await p
    expect(['interrupted', 'failed']).toContain(r.status)
  }, 20_000)
})
```

- [ ] **Step 2: Testi qaçır, uğursuz olduğunu təsdiqlə**

- [ ] **Step 3: Əvvəlcə `RunSupervisor`-a `attempt` dəstəyi əlavə et**

`Ladder` bundan asılıdır, ona görə implementasiyadan ƏVVƏL gəlir.

`apps/server/src/exec/supervisor.ts`-də `ExecuteInput` interfeysinə əlavə et:

```ts
  /** Yoxlama dövrəsində neçənci cəhd. Default 1. */
  attempt?: number
```

Və `execute()` içindəki `createRun` çağırışına əlavə et:

```ts
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
```

(`cachedHit` dəstəyi Task 1-də artıq `createRun`-a əlavə olunub.)

- [ ] **Step 4: `Ladder` implementasiyasını yaz**

`apps/server/src/exec/ladder.ts`:

```ts
import type { RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  appendVerification,
  createRun,
  finishRun,
  getCacheEntry,
  listEvents,
  putCacheEntry,
  recordCacheHit,
  setTaskStatus,
} from '../db/repo.js'
import type { BudgetLimits } from './budget.js'
import { computeCacheKey } from './cache-key.js'
import type { RunSupervisor } from './supervisor.js'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

/** Yoxlama dövrəsinin maksimum cəhd sayı. */
const MAX_ATTEMPTS = 3

export type LadderStatus =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'budget_exceeded'
  | 'verification_failed'

export interface LadderContext {
  id: string
  cwd: string | null
  verifyCommandsJson: string
}

export interface LadderInput {
  task: { id: string; prompt: string }
  context: LadderContext
  runner: Runner
  model: string
  limits?: BudgetLimits
}

export interface LadderResult {
  runId: string
  status: LadderStatus
  /** Nəticə keşdən gəldimi (Pillə 0). */
  cached: boolean
  /** Keşləmək təhlükəlidirsə `null`. */
  cacheKey: string | null
  /** Neçə icra cəhdi edildi (Pillə 2 dövrəsi). */
  attempts: number
  /** Yoxlama əmrləri varsa nəticəsi; yoxdursa `null`. */
  verificationPassed: boolean | null
  errorClass?: string
  errorMessage?: string
}

/**
 * Amplifikasiya nərdivanı — Pillə 0 və Pillə 2.
 *
 * `RunSupervisor` bir icranı idarə edir və bu sinif ona toxunmur. Ladder
 * onun üzərində oturur: keşə baxır, lazım olsa supervisor-u bir neçə dəfə
 * çağırır, hər dəfə determinist yoxlamadan keçirir.
 */
export class Ladder {
  private readonly db: Db
  private readonly supervisor: RunSupervisor

  constructor(db: Db, supervisor: RunSupervisor) {
    this.db = db
    this.supervisor = supervisor
  }

  async run(input: LadderInput): Promise<LadderResult> {
    const cwd = input.context.cwd ?? undefined
    const cacheKey = computeCacheKey({
      prompt: input.task.prompt,
      modelId: input.model,
      runnerId: input.runner.id,
      needsFileAccess: input.runner.capabilities.fileAccess,
      ...(cwd !== undefined ? { cwd } : {}),
    })

    // ── Pillə 0 — cache ────────────────────────────────────────────────
    if (cacheKey !== null) {
      const hit = this.replayFromCache(input, cacheKey)
      if (hit !== null) return hit
    }

    // ── Pillə 2 — zəif model + alət yoxlaması ──────────────────────────
    const verifyCommands = this.parseVerifyCommands(input.context.verifyCommandsJson)
    const hasVerification = verifyCommands.length > 0
    const rung = hasVerification ? 2 : 7

    let prompt = input.task.prompt
    let attempts = 0
    let last: LadderResult | null = null

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1

      const exec = await this.supervisor.execute({
        taskId: input.task.id,
        runner: input.runner,
        model: input.model,
        prompt,
        attempt: attempts,
        ladderRung: rung,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
      })

      const base: LadderResult = {
        runId: exec.runId,
        status: exec.status,
        cached: false,
        cacheKey,
        attempts,
        verificationPassed: null,
        ...(exec.errorClass !== undefined ? { errorClass: exec.errorClass } : {}),
        ...(exec.errorMessage !== undefined ? { errorMessage: exec.errorMessage } : {}),
      }
      last = base

      // İcranın özü uğursuz olubsa yoxlamağa nə isə yoxdur. Təkrar cəhd
      // yalnız təkrarlana bilən xəta siniflərində mənalıdır — `auth` və
      // `budget_exceeded` halında yenidən cəhd etmək pul yandırmaqdır.
      if (exec.status !== 'succeeded') return base

      if (!hasVerification) {
        this.storeInCache(input, cacheKey, exec.runId)
        return base
      }

      const verification = await runVerifications(verifyCommands, { cwd: cwd ?? process.cwd() })
      for (const r of verification.results) {
        appendVerification(this.db, exec.runId, {
          command: r.command,
          exitCode: r.exitCode,
          passed: r.passed,
          outputExcerpt: r.output,
          durationMs: r.durationMs,
        })
      }

      if (verification.passed) {
        this.storeInCache(input, cacheKey, exec.runId)
        return { ...base, verificationPassed: true }
      }

      // Sınıb — xəta mətnini modelə geri ötürüb yenidən cəhd et.
      // Yoxlama SIFIR token xərcləyir; yalnız yeni icra xərcləyir.
      prompt = `${input.task.prompt}\n\n${buildFeedbackPrompt(verification.results)}`
      last = { ...base, status: 'verification_failed', verificationPassed: false }
    }

    const final = last as LadderResult
    setTaskStatus(this.db, input.task.id, 'failed')
    return final
  }

  private parseVerifyCommands(json: string): string[] {
    try {
      const parsed: unknown = JSON.parse(json)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    } catch {
      return []
    }
  }

  /**
   * Keşdən nəticə tapılıbsa, onu YENİ run sətri kimi qeyd edir və hadisələri
   * jurnala yazır. Belə olsa UI heç bir xüsusi hal bilmədən eyni şeyi göstərir,
   * amma sətir `cachedHit: true` və `ladderRung: 0` ilə işarələnir.
   */
  private replayFromCache(input: LadderInput, cacheKey: string): LadderResult | null {
    const entry = getCacheEntry(this.db, cacheKey)
    if (entry === undefined) return null

    const run = createRun(this.db, {
      taskId: input.task.id,
      runnerId: input.runner.id,
      modelId: input.model,
      ladderRung: 0,
      cachedHit: true,
      subscriptionBilled: input.runner.capabilities.subscriptionBilled,
    })
    for (const event of entry.events) appendEvent(this.db, run.id, event)
    recordCacheHit(this.db, cacheKey)
    finishRun(this.db, run.id, { status: 'succeeded' })
    setTaskStatus(this.db, input.task.id, 'succeeded')

    return {
      runId: run.id,
      status: 'succeeded',
      cached: true,
      cacheKey,
      attempts: 0,
      verificationPassed: null,
    }
  }

  /** Yalnız uğurlu VƏ yoxlamadan keçmiş nəticə keşlənir. */
  private storeInCache(input: LadderInput, cacheKey: string | null, runId: string): void {
    if (cacheKey === null) return
    const events: RunEvent[] = listEvents(this.db, runId).map((s) => s.event)
    putCacheEntry(this.db, {
      hash: cacheKey,
      modelId: input.model,
      runnerId: input.runner.id,
      events,
    })
  }
}
```

- [ ] **Step 5: Testi qaçır, keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/ladder.test.ts`
Expected: PASS — 15 test.

Run: `pnpm test` — bütün paket. Mövcud 233 + bu planın yeni testləri.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/exec apps/server/src/db/repo.ts
git commit -m "feat(server): Ladder — Pillə 0 cache və Pillə 2 alət yoxlaması

RunSupervisor dəyişmir (bir icra). Ladder onun üzərində oturur: keşə baxır,
uğursuz yoxlamada xəta mətnini modelə geri ötürüb yenidən cəhd etdirir
(max 3), yalnız yoxlamadan keçmiş nəticəni keşləyir.

Təkrar cəhd YALNIZ yoxlama sınanda olur — auth və budget_exceeded
hallarında yenidən cəhd etmək pul yandırmaqdır."
```

---

## Task 5: Ladder-i REST qatına bağla

**Files:**
- Modify: `apps/server/src/routes/tasks.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/app.test.ts`-ə əlavə et:

```ts
describe('Pillə 0 — cache uçdan-uca', () => {
  it('eyni prompt ikinci dəfə keşdən gəlir', async () => {
    const app = makeApp()
    const ctx = await newContext(app)

    const post = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: { contextId: ctx.id, prompt: 'eyni sual', runner: 'fake', model: 'm' },
        })
      ).json() as { taskId: string }

    const waitDone = async (taskId: string) => {
      await vi.waitFor(
        async () => {
          const r = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })
          expect(r.json().runs[0]?.status).toBe('succeeded')
        },
        { timeout: 5000, interval: 25 },
      )
      return (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    }

    const first = await waitDone((await post()).taskId)
    expect(first.runs[0].cachedHit).toBe(false)

    const second = await waitDone((await post()).taskId)
    expect(second.runs[0].cachedHit).toBe(true)
    expect(second.runs[0].ladderRung).toBe(0)
  })
})

describe('GET /api/tasks/:id — yoxlama nəticələri', () => {
  it('run cavabında verifications massivi var', async () => {
    const app = makeApp()
    const ctx = await newContext(app)
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'p', runner: 'fake', model: 'm' },
      })
    ).json()
    await vi.waitFor(
      async () => {
        const r = await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
        expect(r.json().runs[0]?.status).toBe('succeeded')
      },
      { timeout: 5000, interval: 25 },
    )
    const body = (
      await app.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
    ).json()
    expect(Array.isArray(body.runs[0].verifications)).toBe(true)
  })
})
```

- [ ] **Step 2: `routes/tasks.ts`-i Ladder işlədəcək şəkildə dəyiş**

`TaskRouteDeps`-də `supervisor: RunSupervisor` saxlanılır (cancel üçün lazımdır)
və `ladder: Ladder` əlavə olunur. `POST /api/tasks` içindəki
`void supervisor.execute({...})` bloku bununla əvəz olunur:

```ts
    void deps.ladder
      .run({
        task: { id: task.id, prompt: body.prompt },
        context: {
          id: ctx.id,
          cwd: ctx.cwd,
          verifyCommandsJson: ctx.verifyCommandsJson,
        },
        runner,
        model: body.model,
        limits,
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'ladder.run tutulmamış xəta')
      })
```

`GET /api/tasks/:id`-də hər run-a yoxlama nəticələrini əlavə et:

```ts
      runs: listRunsForTask(db, task.id).map((r) => ({
        ...r,
        events: listEvents(db, r.id),
        verifications: listVerifications(db, r.id),
      })),
```

`listVerifications`-i importa əlavə et.

- [ ] **Step 3: `app.ts`-də Ladder qur**

```ts
  const supervisor = new RunSupervisor(db)
  const ladder = new Ladder(db, supervisor)
  ...
  registerTaskRoutes(app, { db, supervisor, ladder, runners })
```

- [ ] **Step 4: Testləri qaçır**

Run: `pnpm test` — hamısı keçməlidir.
Run: `pnpm typecheck` — təmiz.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(server): task icrası Ladder üzərindən gedir

GET /api/tasks/:id artıq hər run üçün verifications massivi qaytarır."
```

---

## Task 6: UI — pillə, cəhd, keş və yoxlama nişanları

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/RunHeader.tsx`
- Modify: `apps/web/src/pages/TaskView.tsx`

- [ ] **Step 1: `api.ts`-ə yeni sahələr əlavə et**

`RunRow` interfeysinə əlavə et:

```ts
  ladderRung: number
  attempt: number
  cachedHit: boolean
  verifications: VerificationRow[]
```

Və yeni interfeys:

```ts
export interface VerificationRow {
  id: number
  command: string
  exitCode: number | null
  passed: boolean
  outputExcerpt: string
  durationMs: number
  at: number
}
```

- [ ] **Step 2: `RunHeader.tsx` yarat**

```tsx
import type { RunRow } from '../lib/api.js'

const RUNG_LABEL: Record<number, string> = {
  0: 'Pillə 0 — keş',
  1: 'Pillə 1 — qayda',
  2: 'Pillə 2 — alət yoxlaması',
  7: 'Pillə 7 — birbaşa model',
}

// DİQQƏT: bunlar RUN statuslarıdır. `verification_failed` burada YOXDUR,
// çünki o, run-ın deyil, Ladder nəticəsinin statusudur: model çıxışı verib
// (run `succeeded`), amma determinist yoxlama sınıb. Onu ayrıca nişan kimi
// `run.verifications`-dan törədirik — yoxsa "succeeded" yazısı yalan olardı.
const STATUS_TONE: Record<string, string> = {
  succeeded: 'bg-good/15 text-good',
  running: 'bg-accent/15 text-accent',
  interrupted: 'bg-warn/15 text-warn',
  budget_exceeded: 'bg-warn/15 text-warn',
  failed: 'bg-bad/15 text-bad',
}

export default function RunHeader({ run }: { run: RunRow }): React.JSX.Element {
  const verificationFailed =
    run.verifications.length > 0 && run.verifications.some((v) => !v.passed)

  return (
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-medium">{run.runnerId}</span>
        <span className="text-ink-dim">· {run.modelId}</span>
        <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-ink-dim">
          {RUNG_LABEL[run.ladderRung] ?? `Pillə ${run.ladderRung}`}
        </span>
        {run.attempt > 1 && (
          <span
            className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
            title="Yoxlama sındığı üçün təkrar cəhd"
          >
            {run.attempt}. cəhd
          </span>
        )}
        {run.cachedHit && (
          <span
            className="rounded bg-good/15 px-2 py-0.5 text-xs text-good"
            title="Nəticə keşdən gəldi — sıfır token xərcləndi"
          >
            keşdən · 0 token
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {verificationFailed && (
          <span
            className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn"
            title="Model çıxış verdi, amma determinist yoxlama sındı"
          >
            yoxlama sındı
          </span>
        )}
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            STATUS_TONE[run.status] ?? 'bg-white/10 text-ink-dim'
          }`}
        >
          {run.status}
        </span>
      </div>
    </header>
  )
}
```

- [ ] **Step 3: `TaskView.tsx`-də başlığı əvəz et və yoxlamaları göstər**

Mövcud `<header>` blokunu `<RunHeader run={run} />` ilə əvəz et
(`STATUS_TONE` sabiti artıq `RunHeader`-dədir, `TaskView`-dan sil).

`UsageBadge`-dən sonra, `errorMessage`-dan əvvəl əlavə et:

```tsx
              {run.verifications.length > 0 && (
                <ul className="mb-3 space-y-1">
                  {run.verifications.map((v) => (
                    <li key={v.id} className="font-mono text-xs">
                      <span className={v.passed ? 'text-good' : 'text-bad'}>
                        {v.passed ? '✓' : '✗'}
                      </span>{' '}
                      <span className="text-ink-dim">{v.command}</span>{' '}
                      <span className="text-ink-dim">({v.durationMs}ms)</span>
                      {!v.passed && v.outputExcerpt !== '' && (
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-bad/10 p-2 text-bad">
                          {v.outputExcerpt}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
```

- [ ] **Step 4: Yoxla**

Run: `pnpm --filter @orchestris/web typecheck` — təmiz.
Run: `pnpm --filter @orchestris/web build` — uğurlu.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): pillə, cəhd, keş nişanları və yoxlama nəticələri"
```

---

## Task 7: Uçdan-uca real yoxlama

Bu, planın qəbul testidir. **Real token xərcləyir** (~$0.02).

- [ ] **Step 1: Test repo hazırla**

Müvəqqəti git repo yarat, içində qəsdən tip xətası olan bir TypeScript faylı və
`tsc` yoxlama əmri olsun:

```bash
mkdir -p /tmp/orch-e2e && cd /tmp/orch-e2e
git init -q && git config user.email t@e.com && git config user.name T
npm init -y >/dev/null
npm i -D typescript >/dev/null 2>&1
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022" }, "include": ["*.ts"] }
EOF
cat > topla.ts <<'EOF'
export function topla(a: number, b: number): number {
  return a + b
}
EOF
git add -A && git commit -qm ilk
npx tsc --noEmit && echo "BASLANGIC TEMIZDIR"
```

- [ ] **Step 2: Serveri işə sal və kontekst yarat**

```bash
cd <repo kökü>
pnpm --filter @orchestris/server dev &
sleep 6
curl -s -X POST http://127.0.0.1:4319/api/contexts \
  -H 'Content-Type: application/json' \
  -d '{"name":"E2E ladder","cwd":"/tmp/orch-e2e","verifyCommands":["npx tsc --noEmit"]}'
```

- [ ] **Step 3: Yoxlama dövrəsini işə salan task göndər**

Modeldən qəsdən tip xətası ilə nəticələnəcək dəyişiklik istə, sonra yoxlamanın
onu tutub düzəltdirdiyini gör:

```bash
curl -s -X POST http://127.0.0.1:4319/api/tasks -H 'Content-Type: application/json' -d '{
  "contextId":"<yuxarıdaki id>",
  "prompt":"topla.ts faylına `cix` adlı yeni funksiya əlavə et: iki ədədi çıxsın və nəticəni qaytarsın. Tip annotasiyalarını düzgün yaz.",
  "runner":"cli:claude",
  "model":"claude-haiku-4-5-20251001",
  "maxOutputTokens":20000,
  "maxSeconds":300
}'
```

Gözlənilən: `attempt: 1`, `ladderRung: 2`, `verifications` massivində
`npx tsc --noEmit` → `passed: true`, run `succeeded`.

- [ ] **Step 4: Keş vurmasını yoxla**

Eyni promptu **kod dəyişmədən** yenidən göndər.

Gözlənilən: ikinci run `cachedHit: true`, `ladderRung: 0`, hadisələr eynidir,
`usage` hadisəsi keşdən gəlir. Brauzerdə `keşdən · 0 token` nişanı görünür.

- [ ] **Step 5: Keş açarının repo vəziyyətinə həssaslığını yoxla**

```bash
cd /tmp/orch-e2e && echo "// deyisdi" >> topla.ts
```

Eyni promptu yenidən göndər. Gözlənilən: `cachedHit: false` — kod dəyişdiyi
üçün açar dəyişdi. **Bu, planın ən vacib düzgünlük yoxlamasıdır.**

- [ ] **Step 6: Yoxlama dövrəsinin düzəltmə qabiliyyətini yoxla**

Yoxlama əmrini qəsdən sınan bir şeyə dəyiş və taskı yenidən göndər:

```bash
curl -s -X POST http://127.0.0.1:4319/api/contexts -H 'Content-Type: application/json' \
  -d '{"name":"E2E sinan","cwd":"/tmp/orch-e2e","verifyCommands":["node -e \"process.exit(1)\""]}'
```

Gözlənilən: 3 run sətri (`attempt: 1,2,3`), status `verification_failed`,
ikinci və üçüncü cəhdin promptunda yoxlama xətası görünür, nəticə **keşlənmir**.

- [ ] **Step 7: Yetim proses və təmizlik**

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -like '*stream-json*' } | Select-Object ProcessId"
```

Gözlənilən: boş. Sonra serveri dayandır və `/tmp/orch-e2e`-ni sil.

---

## Planın bitmə kriteriyası

- [ ] `pnpm test` — bütün testlər keçir, **sıfır token** xərclənir
- [ ] `pnpm typecheck` — 3 paketdə təmiz
- [ ] Eyni task ikinci dəfə keşdən gəlir və `keşdən · 0 token` nişanı görünür
- [ ] **Kod dəyişəndə keş açarı dəyişir** — köhnə cavab qaytarılmır
- [ ] Yoxlama sınanda model xəta mətnini alır və yenidən cəhd edir (max 3)
- [ ] Yoxlamadan keçməyən nəticə keşlənmir
- [ ] `auth` və `budget_exceeded` hallarında təkrar cəhd edilmir
- [ ] Yetim `claude.exe` prosesi qalmır

## Növbəti planlar

- **Plan B** — `ApiRunner` (AI SDK 7 `streamText` + `fullStream`/`totalUsage`),
  API açarları `@napi-rs/keyring@1.3` ilə OS keychain-də, `models.dev/api.json`
  ilə model + qiymət kəşfi, `/providers` səhifəsinin genişlənməsi.
- **Plan C** — Pillə 1 qayda routing, `Auto (ucuz qərar)` rejimi,
  `routing_decisions` cədvəli, `/ladder` səhifəsi, `savings_ledger`.
