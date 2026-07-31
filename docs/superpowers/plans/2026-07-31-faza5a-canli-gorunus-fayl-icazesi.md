# Faza 5A — Canlı görünüş, fayl icazəsi və qovluq seçicisi — İcra Planı

> **Agent işçilər üçün:** TƏLƏB OLUNAN ALT-SKILL: bu planı task-task icra etmək
> üçün `superpowers:executing-plans` (bu sessiyada seçilmiş) və ya
> `superpowers:subagent-driven-development` işlədin. Addımlar checkbox
> (`- [ ]`) sintaksisindədir.

**Məqsəd:** Kontekst başına fayl icazəsi, hər səhifədə görünən canlı icra zolağı
və server əsaslı qovluq seçicisi əlavə etmək.

**Arxitektura:** İcazə səviyyəsi (`read-only` / `workspace` / `extended`)
`contexts` cədvəlində saxlanılır, saf funksiya ilə `{ level, dirs }` formasına
çevrilir və `RunRequest` vasitəsilə runner-lərə ötürülür — bayraq tərcüməsi hər
runner-in öz `build*Args` funksiyasındadır. Canlı zolaq `GET /api/runs/active`
anlıq şəkli + `WsHub`-ın yeni qlobal kanalındakı `activity` mesajları ilə
işləyir. Qovluq seçicisi `GET /api/fs/list` (bir səviyyə, yalnız qovluqlar) və
`GET /api/fs/check` (real yazma probu) üzərində qurulur.

**Texnologiya:** TypeScript (ESM, `.js` spesifikatorları), Fastify 5, drizzle-orm
(SQLite), zod 3, React 19 + TanStack Query 5, vitest 3, `@testing-library/react`.

**Spesifikasiya:** `docs/superpowers/specs/2026-07-31-faza5a-canli-gorunus-fayl-icazesi-design.md`

---

## Ümumi qaydalar (hər taskda keçərlidir)

- Bütün nisbi importlar `.js` uzantısı ilə yazılır (layihə ESM-dir).
- Testlər **sıfır token** xərcləməlidir — real model çağırışı YOXDUR (qayda 11).
- `pnpm test` bütün paketləri qaçırır (kök `vitest run`).
- `schema.ts` dəyişəndən sonra **mütləq**
  `pnpm --filter @orchestris/server db:generate`.
- `CLAUDE_STABLE_FLAGS`-a **heç nə əlavə edilmir** (qayda 1).
- Şərhlər Azərbaycan dilində, layihənin mövcud üslubunda: "niyə" yazılır, "nə"
  yox.

---

## Fayl quruluşu

| Fayl | Məsuliyyət | Vəziyyət |
|---|---|---|
| `packages/shared/src/runner.ts` | `FILE_ACCESS_LEVELS`, `FileAccess`, `RunRequest.fileAccess` | dəyişir |
| `packages/shared/src/api.ts` | `UpdateContextBody.cwd/fileAccess/extraDirs`, `ActiveRun`, WS mesajları | dəyişir |
| `apps/server/src/exec/file-access.ts` | **YENİ** — saf funksiya: kontekst → `{ level, dirs }` |
| `apps/server/src/db/schema.ts` | `contexts.file_access`, `contexts.extra_dirs_json` | dəyişir |
| `apps/server/src/db/repo.ts` | `ContextUpdate` genişlənir, `listActiveRuns`, `getActiveRun` | dəyişir |
| `apps/server/src/runners/claude.ts` | səviyyə → `--permission-mode`, `dirs` → çoxlu `--add-dir` | dəyişir |
| `apps/server/src/runners/codex.ts` | səviyyə → `--sandbox` | dəyişir |
| `apps/server/src/exec/supervisor.ts` | `ExecuteInput.fileAccess`, `onActivity` | dəyişir |
| `apps/server/src/exec/ladder.ts` | `where()` icazəni də verir | dəyişir |
| `apps/server/src/exec/decomposer.ts` | bölgü icrası da icazə alır | dəyişir |
| `apps/server/src/routes/fs.ts` | **YENİ** — `/api/fs/list`, `/api/fs/check` |
| `apps/server/src/routes/runs.ts` | **YENİ** — `/api/runs/active` |
| `apps/server/src/routes/contexts.ts` | yol yoxlaması | dəyişir |
| `apps/server/src/ws/hub.ts` | qlobal abunəlik | dəyişir |
| `apps/server/src/app.ts` | yeni route-lar, WS mesajları, activity yayımı | dəyişir |
| `apps/web/src/lib/api.ts` | yeni endpoint-lər və tiplər | dəyişir |
| `apps/web/src/lib/useActivity.ts` | **YENİ** — REST + WS birləşməsi |
| `apps/web/src/components/FolderPicker.tsx` | **YENİ** — qovluq seçici modal |
| `apps/web/src/components/LiveBar.tsx` | **YENİ** — canlı zolaq |
| `apps/web/src/components/FileAccessPanel.tsx` | **YENİ** — icazə seçimi |
| `apps/web/src/components/Sidebar.tsx` | `LiveBar` qoşulur | dəyişir |
| `apps/web/src/pages/Contexts.tsx` | seçici + icazə paneli | dəyişir |

---

## Spesifikasiyadan İKİ kənarlaşma (səbəbi ilə)

**1. `activity` mesajında `kind: 'updated'` YOXDUR.**
Spesifikasiya §6.3 üç növ nəzərdə tuturdu. Kodu oxuyanda məlum oldu ki, pillə və
cəhd nömrəsi bir icra daxilində DƏYİŞMİR — nərdivan hər pillə/cəhd üçün YENİ
`runs` sətri yaradır (`supervisor.execute` → `createRun`). Yəni `'updated'` heç
vaxt emit oluna bilməzdi. Yalnız `'started'` və `'ended'` qalır.

**2. codex-in `extended` səviyyəsi — ÖLÇÜLDÜ, bayraq MÖVCUDDUR.**
Plan yazılarkən `codex exec`-in əlavə yazıla bilən qovluq bayrağı BİLİNMİRDİ və
Task 3 Addım 1-də `codex exec --help` ilə ölçülməsi nəzərdə tutulmuşdu.

Nəticə (ölçülmüş, `codex exec --help`):

```
--add-dir <DIR>
    Additional directories that should be writable alongside the primary workspace
```

Yəni bayraq VAR və adı da, mənası da claude ilə eynidir. Buradan iki dəyişiklik:

- `extended` səviyyəsi hər iki CLI-da EYNİ işləyir — planda ehtimal edilən
  asimmetriya yaranmadı.
- `FileAccessPanel`-dəki «əlavə qovluqlar yalnız claude-da tətbiq olunur»
  xəbərdarlığı LAZIM DEYİL və yazılmadı (Task 13-dəki müvafiq test də silindi).

İki incəlik tətbiqdə qeyd olunub: `cwd` codex-ə ÖTÜRÜLMÜR (onun üçün o, onsuz
da "primary workspace"-dir) və `read-only` sandbox-da bayraq ümumiyyətlə
verilmir (mənası "yazıla bilən qovluq"dur — yalnız-oxu ilə ziddiyyət).

---

## Task 1: `resolveFileAccess` — saf funksiya

**Fayllar:**
- Dəyişir: `packages/shared/src/runner.ts`
- Dəyişir: `packages/shared/src/index.ts`
- Yaradılır: `apps/server/src/exec/file-access.ts`
- Test: `apps/server/src/exec/file-access.test.ts`

- [ ] **Addım 1: Paylaşılan tipləri əlavə et**

`packages/shared/src/runner.ts` faylında `RunRequest` interfeysindən ƏVVƏL:

```ts
/**
 * Kontekstin fayl icazə səviyyəsi.
 *
 * Runner-ə xas bayraq adları BURADA YOXDUR və bu qəsdəndir: `RunRequest`
 * `ApiRunner` tərəfindən də işlədilir və orada `--permission-mode` anlayışı
 * ümumiyyətlə yoxdur. Paylaşılan müqavilə NİYYƏTİ daşıyır, tərcüməni isə hər
 * runner öz `build*Args` funksiyasında edir.
 */
export const FILE_ACCESS_LEVELS = ['read-only', 'workspace', 'extended'] as const
export type FileAccessLevel = (typeof FILE_ACCESS_LEVELS)[number]

export interface FileAccess {
  level: FileAccessLevel
  /**
   * Agentin toxuna biləcəyi qovluqlar — DETERMİNİST sıralanmış.
   *
   * Sıralamasaydıq, eyni qovluq dəsti fərqli sıra ilə fərqli əmr sətri verər
   * və Anthropic prompt-cache-i lazımsız yerə sınardı (CLAUDE.md qayda 1).
   */
  dirs: readonly string[]
}
```

`RunRequest` interfeysinə sahə əlavə et:

```ts
export interface RunRequest {
  prompt: string
  model: string
  /** İş qovluğu — CLI runner-lər üçün məcburi */
  cwd?: string
  /** Mövcud sessiyanı davam etdir */
  resumeSessionId?: string
  /**
   * Fayl icazəsi. Verilməsə runner öz konstruktor default-una düşür —
   * mövcud testlər və çağırışlar sınmır.
   */
  fileAccess?: FileAccess
}
```

- [ ] **Addım 2: `index.ts`-də ixracı yoxla**

`packages/shared/src/index.ts` faylını oxu. `runner.js`-dən `export *` varsa
əlavə iş lazım deyil; adbaad ixrac edilirsə `FILE_ACCESS_LEVELS`, `FileAccess`,
`FileAccessLevel` siyahıya əlavə et.

- [ ] **Addım 3: Uğursuz testi yaz**

`apps/server/src/exec/file-access.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseExtraDirs, resolveFileAccess } from './file-access.js'

describe('resolveFileAccess', () => {
  it('workspace səviyyəsində yalnız cwd verilir', () => {
    const r = resolveFileAccess({
      fileAccess: 'workspace',
      extraDirsJson: '["/tmp/başqa"]',
      cwd: '/repo',
    })
    expect(r).toEqual({ level: 'workspace', dirs: ['/repo'] })
  })

  it('extended səviyyəsində əlavə qovluqlar da daxil olur', () => {
    const r = resolveFileAccess({
      fileAccess: 'extended',
      extraDirsJson: '["/b","/a"]',
      cwd: '/repo',
    })
    // Sıra DETERMİNİSTDİR — keşin sınmaması bundan asılıdır.
    expect(r.dirs).toEqual(['/a', '/b', '/repo'])
  })

  it('təkrarlanan qovluq bir dəfə verilir', () => {
    const r = resolveFileAccess({
      fileAccess: 'extended',
      extraDirsJson: '["/repo","/repo"]',
      cwd: '/repo',
    })
    expect(r.dirs).toEqual(['/repo'])
  })

  it('read-only səviyyəsi qovluğu yenə verir — oxumaq üçün lazımdır', () => {
    const r = resolveFileAccess({
      fileAccess: 'read-only',
      extraDirsJson: '[]',
      cwd: '/repo',
    })
    expect(r).toEqual({ level: 'read-only', dirs: ['/repo'] })
  })

  it('cwd yoxdursa dirs boş qalır', () => {
    const r = resolveFileAccess({
      fileAccess: 'workspace',
      extraDirsJson: '[]',
      cwd: undefined,
    })
    expect(r.dirs).toEqual([])
  })

  it('tanınmayan səviyyə workspace sayılır — icra dayanmır', () => {
    const r = resolveFileAccess({
      fileAccess: 'zibil',
      extraDirsJson: '[]',
      cwd: '/repo',
    })
    expect(r.level).toBe('workspace')
  })
})

describe('parseExtraDirs', () => {
  it('sınıq JSON boş massiv verir', () => {
    expect(parseExtraDirs('{{{')).toEqual([])
  })

  it('massiv olmayan JSON boş massiv verir', () => {
    expect(parseExtraDirs('"/tmp"')).toEqual([])
  })

  it('sətir olmayan elementlər atılır', () => {
    expect(parseExtraDirs('["/a",5,null,"/b"]')).toEqual(['/a', '/b'])
  })

  it('boş sətirlər atılır', () => {
    expect(parseExtraDirs('["/a","","  "]')).toEqual(['/a'])
  })
})
```

- [ ] **Addım 4: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/exec/file-access.test.ts`
Gözlənilən: `Failed to resolve import "./file-access.js"`

- [ ] **Addım 5: Tətbiqi yaz**

`apps/server/src/exec/file-access.ts`:

```ts
import {
  FILE_ACCESS_LEVELS,
  type FileAccess,
  type FileAccessLevel,
} from '@orchestris/shared'

/**
 * Tanınmayan dəyər üçün geri düşülən səviyyə.
 *
 * `'read-only'` DEYİL: bazadakı bir korlanmış sətir bütün icraların səssizcə
 * fayla toxunmamasına səbəb olardı və istifadəçi səbəbini heç yerdə görməzdi.
 * `'workspace'` mövcud davranışdır (CLAUDE.md qayda 1-dən əvvəlki `acceptEdits`).
 */
const FALLBACK_LEVEL: FileAccessLevel = 'workspace'

function isLevel(v: string): v is FileAccessLevel {
  return (FILE_ACCESS_LEVELS as readonly string[]).includes(v)
}

/**
 * `contexts.extra_dirs_json` sütununu oxuyur.
 *
 * HEÇ VAXT ATMIR: sütun istifadəçinin əl ilə redaktə edə biləcəyi mətndir və
 * bir sınıq sətir bütün taskları dayandırmamalıdır. Səhv məzmun "əlavə qovluq
 * yoxdur" kimi oxunur — bu, səhvin UCUZ istiqamətidir (icazə genişlənmir,
 * daralır).
 */
export function parseExtraDirs(json: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

export interface FileAccessInput {
  /** `contexts.file_access` sütunu — xam mətn, hələ təsdiqlənməmiş. */
  fileAccess: string
  /** `contexts.extra_dirs_json` sütunu. */
  extraDirsJson: string
  /** İcranın FAKTİKİ qovluğu — izolyasiya varsa worktree yolu. */
  cwd: string | undefined
}

/**
 * Kontekstin icazə ayarını runner-dən asılı olmayan formaya çevirir.
 *
 * Model çağırışı yoxdur — **0 token**.
 */
export function resolveFileAccess(input: FileAccessInput): FileAccess {
  const level = isLevel(input.fileAccess) ? input.fileAccess : FALLBACK_LEVEL

  const dirs = new Set<string>()
  if (input.cwd !== undefined) dirs.add(input.cwd)
  // Əlavə qovluqlar YALNIZ `extended`-də oxunur. Səviyyə aşağı salınanda
  // siyahı bazada QALIR (istifadəçi geri qaytaranda yenidən yazmasın), sadəcə
  // tətbiq olunmur.
  if (level === 'extended') {
    for (const d of parseExtraDirs(input.extraDirsJson)) dirs.add(d)
  }

  return { level, dirs: [...dirs].sort() }
}
```

- [ ] **Addım 6: Testi qaçır — KEÇMƏLİDİR**

Əmr: `pnpm vitest run apps/server/src/exec/file-access.test.ts`
Gözlənilən: 10 test PASS

- [ ] **Addım 7: Commit**

```bash
git add packages/shared/src/runner.ts packages/shared/src/index.ts apps/server/src/exec/file-access.ts apps/server/src/exec/file-access.test.ts
git commit -m "feat(shared,server): fayl icazəsinin runner-dən asılı olmayan modeli"
```

---

## Task 2: Sxem — `file_access` və `extra_dirs_json`

**Fayllar:**
- Dəyişir: `apps/server/src/db/schema.ts`
- Yaradılır: `apps/server/drizzle/0010_*.sql` (generasiya ilə)
- Dəyişir: `apps/server/src/db/repo.ts`
- Test: `apps/server/src/db/repo.test.ts`

- [ ] **Addım 1: Sxemə sütunları əlavə et**

`apps/server/src/db/schema.ts`, `contexts` cədvəlində `memoryEnabled`-dan SONRA,
`createdAt`-dan ƏVVƏL:

```ts
  /**
   * Bu kontekstdə agentin fayl sisteminə icazəsi.
   *
   * `'read-only'` | `'workspace'` | `'extended'`
   *
   * Default `'workspace'`-dir, `'read-only'` DEYİL — və bu, qayda 43-ün ƏKS
   * istiqamətidir. Orada köhnə `max_parallel = 1` istifadəçinin seçimi deyildi
   * (dəyişdirmək üçün API ümumiyyətlə yox idi). Burada isə `acceptEdits`
   * FAKTİKİ davranışdır: istifadəçi ona güvənərək task göndərib. Miqrasiyada
   * `'read-only'` yazsaydıq, işləyən qurulum bir gecədə səssizcə yazmağı
   * dayandırardı.
   */
  fileAccess: text('file_access').notNull().default('workspace'),
  /**
   * `'extended'` səviyyəsində icazəli ƏLAVƏ qovluqların JSON massivi.
   *
   * Ayrıca cədvəl DEYİL: siyahı yalnız bütöv oxunur (icra anında `--add-dir`
   * arqumentlərinə çevrilir), üzərində sorğu və ya birləşdirmə yoxdur —
   * `verify_commands_json` ilə eyni formadır.
   */
  extraDirsJson: text('extra_dirs_json').notNull().default('[]'),
```

- [ ] **Addım 2: Miqrasiyanı generasiya et**

Əmr: `pnpm --filter @orchestris/server db:generate`
Gözlənilən: `apps/server/drizzle/0010_<ad>.sql` yaranır, içində iki
`ALTER TABLE contexts ADD COLUMN`.

Yaranan faylı OXU və təsdiq et ki, hər iki sütun `NOT NULL DEFAULT` daşıyır —
SQLite `ADD COLUMN … NOT NULL` əmrini DEFAULT olmadan qəbul etmir (qayda 59-da
eyni məhdudiyyət qeyd olunub).

- [ ] **Addım 3: `ContextUpdate`-ə sahələri əlavə et**

`apps/server/src/db/repo.ts`, `ContextUpdate` interfeysinə:

```ts
  /** `null` = iş qovluğunu sil. */
  cwd?: string | null | undefined
  fileAccess?: string | undefined
  extraDirs?: readonly string[] | undefined
```

`updateContext` funksiyasındakı `values` obyektinə (mövcud sətirlərin yanına):

```ts
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
    ...(input.extraDirs !== undefined
      ? { extraDirsJson: JSON.stringify(input.extraDirs) }
      : {}),
```

- [ ] **Addım 4: Testi yaz**

`apps/server/src/db/repo.test.ts` faylının importuna `updateContext` əlavə et
(hazırda siyahıda YOXDUR), sonra faylın sonuna. `db()` faylın başında artıq
təyin olunub: `const db = () => openDb(':memory:')`.

```ts
describe('kontekstin fayl icazəsi', () => {
  it('default workspace-dir', () => {
    const ctx = createContext(db(), { name: 'a' })
    expect(ctx.fileAccess).toBe('workspace')
    expect(ctx.extraDirsJson).toBe('[]')
  })

  it('səviyyə və əlavə qovluqlar yenilənir', () => {
    const d = db()
    const ctx = createContext(d, { name: 'a' })
    const up = updateContext(d, ctx.id, {
      fileAccess: 'extended',
      extraDirs: ['/tmp/x'],
    })
    expect(up.fileAccess).toBe('extended')
    expect(JSON.parse(up.extraDirsJson)).toEqual(['/tmp/x'])
  })

  it('cwd null ilə silinir', () => {
    const d = db()
    const ctx = createContext(d, { name: 'a', cwd: '/repo' })
    expect(updateContext(d, ctx.id, { cwd: null }).cwd).toBeNull()
  })

  it('səviyyə aşağı salınanda əlavə qovluqlar SİLİNMİR', () => {
    const d = db()
    const ctx = createContext(d, { name: 'a' })
    updateContext(d, ctx.id, { fileAccess: 'extended', extraDirs: ['/tmp/x'] })
    const down = updateContext(d, ctx.id, { fileAccess: 'workspace' })
    expect(JSON.parse(down.extraDirsJson)).toEqual(['/tmp/x'])
  })
})
```

- [ ] **Addım 5: Testləri qaçır**

Əmr: `pnpm vitest run apps/server/src/db/repo.test.ts`
Gözlənilən: bütün testlər PASS (yeni 4 daxil)

- [ ] **Addım 6: Miqrasiya testini qaçır**

Əmr: `pnpm vitest run apps/server/src/db/migrate.test.ts`
Gözlənilən: PASS — köhnə bazaların möhürlənməsi (qayda 26) sınmamalıdır.

- [ ] **Addım 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/db/repo.ts apps/server/src/db/repo.test.ts
git commit -m "feat(server): contexts.file_access və extra_dirs_json (miqrasiya 0010)"
```

---

## Task 3: Runner-lərdə bayraq tərcüməsi

**Fayllar:**
- Dəyişir: `apps/server/src/runners/claude.ts`
- Dəyişir: `apps/server/src/runners/codex.ts`
- Test: `apps/server/src/runners/claude.test.ts`
- Test: `apps/server/src/runners/codex.test.ts`

- [ ] **Addım 1: codex-in əlavə qovluq bayrağını ÖLÇ**

Əmr: `codex exec --help`
(pulsuz əmr — model çağırmır, qayda 11-ə uyğundur)

Çıxışda `writable`, `writable-root`, `--add-dir` və ya buna bənzər bayraq
axtar. Nəticəni bu addımın altına QEYD kimi yaz — ölçmə sənədləşdirilməlidir.

- Bayraq **VARSA**: Addım 5-də onu işlət.
- Bayraq **YOXDURSA** (və ya `codex` PATH-da yoxdursa): `extended` səviyyəsi
  codex-də `workspace-write` kimi davranır, əlavə qovluqlar tətbiq olunmur.
  Uydurma bayraq YAZILMIR (qayda 50).

- [ ] **Addım 2: claude testini yaz**

`apps/server/src/runners/claude.test.ts` faylının sonuna:

```ts
describe('fayl icazəsi arqumentləri', () => {
  it('read-only səviyyəsi plan rejimi verir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'read-only', dirs: ['/repo'] },
    })
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('workspace səviyyəsi acceptEdits verir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'workspace', dirs: ['/repo'] },
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('hər qovluq üçün ayrıca --add-dir verilir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'extended', dirs: ['/a', '/repo'] },
    })
    const dirs = args.filter((a, i) => args[i - 1] === '--add-dir')
    expect(dirs).toEqual(['/a', '/repo'])
  })

  it('fileAccess verilməsə köhnə davranış qalır', () => {
    const args = buildClaudeArgs(
      { prompt: 'p', model: 'm', cwd: '/repo' },
      { permissionMode: 'acceptEdits' },
    )
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/repo')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('CLAUDE_STABLE_FLAGS DƏYİŞMİR — qayda 1', () => {
    // Bu test qəsdən sərtdir: dəstə bir bayraq əlavə etmək bütün mövcud
    // prompt keşlərini bir dəfəlik sındırır ($0.0085 → $0.0444 ölçülmüş).
    expect([...CLAUDE_STABLE_FLAGS]).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--safe-mode',
      '--strict-mcp-config',
      '--exclude-dynamic-system-prompt-sections',
      '--disable-slash-commands',
    ])
  })
})
```

Faylın başındakı importa `CLAUDE_STABLE_FLAGS` əlavə et.

- [ ] **Addım 3: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/runners/claude.test.ts`
Gözlənilən: yeni testlərdən 3-ü FAIL (`--permission-mode` yoxdur / `--add-dir`
yalnız bir dəfə). `CLAUDE_STABLE_FLAGS` testi PASS olmalıdır.

- [ ] **Addım 4: claude tətbiqini yaz**

`apps/server/src/runners/claude.ts`, importa əlavə et:

```ts
import type { FileAccessLevel } from '@orchestris/shared'
```

`CLAUDE_STABLE_FLAGS`-dan SONRA:

```ts
/**
 * Səviyyə → `claude --permission-mode`.
 *
 * `'read-only'` üçün `manual` DEYİL, `plan`: `-p` (print) rejimində interaktiv
 * icazə pəncərəsi göstərilə bilmir, yəni `manual` praktikada "hər alət sorğusu
 * rədd edilir" deməkdir — model faylı OXUYA da bilməzdi və nəticə mənasız
 * olardı. `plan` oxumağa icazə verir, yazmağa yox.
 */
const PERMISSION_BY_LEVEL: Record<FileAccessLevel, 'plan' | 'acceptEdits'> = {
  'read-only': 'plan',
  workspace: 'acceptEdits',
  extended: 'acceptEdits',
}
```

`buildClaudeArgs` funksiyasında `--add-dir` və `--permission-mode` hissəsini
əvəz et:

```ts
  // İcazə `RunRequest`-dən gəlirsə O ÜSTÜNDÜR; konstruktor seçimi yalnız
  // default-dur (mövcud çağırışlar və testlər sınmasın deyə).
  if (req.fileAccess !== undefined) {
    // Sıra `resolveFileAccess`-də bir dəfə determinist edilib — burada
    // yenidən sıralamırıq, yoxsa iki yerdə iki fərqli qayda yaranardı.
    for (const dir of req.fileAccess.dirs) args.push('--add-dir', dir)
    args.push('--permission-mode', PERMISSION_BY_LEVEL[req.fileAccess.level])
  } else {
    if (req.cwd !== undefined) args.push('--add-dir', req.cwd)
    if (opts.permissionMode !== undefined) {
      args.push('--permission-mode', opts.permissionMode)
    }
  }
```

`--fallback-model` bloku olduğu kimi qalır.

- [ ] **Addım 5: codex tətbiqini yaz**

`apps/server/src/runners/codex.ts`, importa `FileAccessLevel` əlavə et və
`CODEX_STABLE_FLAGS`-dan sonra:

```ts
/**
 * Səviyyə → `codex --sandbox`.
 *
 * `danger-full-access` XƏRİTƏDƏ YOXDUR: bizim `'extended'` səviyyəmiz
 * SEÇİLMİŞ qovluqlar deməkdir, `danger-full-access` isə bütün diski açır və
 * claude tərəfində qarşılığı yoxdur — qoysaydıq eyni səviyyə iki runner-də
 * fərqli şey ifadə edərdi. Məhz o asimmetriya aradan qaldırılır.
 */
const SANDBOX_BY_LEVEL: Record<FileAccessLevel, 'read-only' | 'workspace-write'> = {
  'read-only': 'read-only',
  workspace: 'workspace-write',
  extended: 'workspace-write',
}
```

`buildCodexArgs`-da sandbox sətrini əvəz et:

```ts
  // Default `read-only`: yazma icazəsi yalnız açıq tələb olunanda verilir.
  const sandbox =
    req.fileAccess !== undefined
      ? SANDBOX_BY_LEVEL[req.fileAccess.level]
      : (opts.sandbox ?? 'read-only')
  args.push('--sandbox', sandbox)
```

Addım 1-də bayraq TAPILIBSA, ondan sonra `extended` üçün əlavə qovluqları da
ötür və bunu şərhdə ölçmə kimi qeyd et. TAPILMAYIBSA aşağıdakı şərhi əlavə et:

```ts
  // ÖLÇÜLDÜ (`codex exec --help`): əlavə yazıla bilən qovluq üçün bayraq
  // TAPILMADI. `extended` səviyyəsinin əlavə qovluqları yalnız claude-a
  // tətbiq olunur; UI bunu açıq yazır. Uydurma bayraq YAZILMIR (qayda 50).
```

- [ ] **Addım 6: codex testini yaz**

`apps/server/src/runners/codex.test.ts` faylının sonuna:

```ts
describe('fayl icazəsi sandbox-a çevrilir', () => {
  it('read-only', () => {
    const args = buildCodexArgs({
      prompt: 'p',
      model: 'm',
      fileAccess: { level: 'read-only', dirs: [] },
    })
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  it('workspace', () => {
    const args = buildCodexArgs({
      prompt: 'p',
      model: 'm',
      fileAccess: { level: 'workspace', dirs: ['/repo'] },
    })
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
  })

  it('fileAccess verilməsə default read-only qalır', () => {
    const args = buildCodexArgs({ prompt: 'p', model: 'm' })
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  it('prompt SON arqument olaraq qalır', () => {
    const args = buildCodexArgs({
      prompt: 'salam',
      model: 'm',
      fileAccess: { level: 'workspace', dirs: ['/repo'] },
    })
    expect(args[args.length - 1]).toBe('salam')
  })
})
```

- [ ] **Addım 7: Testləri qaçır**

Əmr: `pnpm vitest run apps/server/src/runners/`
Gözlənilən: hamısı PASS

- [ ] **Addım 8: Commit**

```bash
git add apps/server/src/runners/
git commit -m "feat(server): fayl icazəsi CLI bayraqlarına tərcümə olunur"
```

---

## Task 4: İcazənin icra yoluna qoşulması

**Fayllar:**
- Dəyişir: `apps/server/src/exec/supervisor.ts`
- Dəyişir: `apps/server/src/exec/ladder.ts`
- Dəyişir: `apps/server/src/exec/decomposer.ts`
- Dəyişir: `apps/server/src/main.ts`
- Test: `apps/server/src/exec/ladder-file-access.test.ts` (yeni)

- [ ] **Addım 1: `ExecuteInput`-a sahə əlavə et**

`apps/server/src/exec/supervisor.ts`, importa:

```ts
import type { ErrorClass, FileAccess, RunEvent, Runner } from '@orchestris/shared'
```

`ExecuteInput` interfeysinə (`resumeSessionId`-dən sonra):

```ts
  /** Kontekstin fayl icazəsi — `resolveFileAccess` nəticəsi. */
  fileAccess?: FileAccess
```

`execute` daxilində `input.runner.run({...})` çağırışına əlavə et:

```ts
          ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
```

- [ ] **Addım 2: `Ladder.where()`-i genişləndir**

`apps/server/src/exec/ladder.ts`, importa:

```ts
import { resolveFileAccess } from './file-access.js'
import type { FileAccess } from '@orchestris/shared'
```

`where` metodunu əvəz et:

```ts
  /**
   * Hər icranın "harada və hansı icazə ilə işlədi" hissəsi — BİR yerdən verilir.
   *
   * Nərdivan `supervisor.execute`-i dörd yerdən çağırır (işçi/nüsxə, ipucu-plan,
   * başçı, distillə). Qovluğu və icazəni hər çağırış yerində əl ilə yazsaydıq,
   * biri unudulanda həmin icra izolyasiyadan KƏNARDA — istifadəçinin əsl
   * repo-sunda — və ya səhv icazə ilə işləyərdi. Belə səhv yalnız real fayl
   * korlanmasında görünərdi.
   */
  private where(phase: Phase): {
    cwd?: string
    worktreePath?: string
    fileAccess: FileAccess
  } {
    return {
      ...(phase.cwd !== undefined ? { cwd: phase.cwd } : {}),
      ...(phase.worktree !== undefined ? { worktreePath: phase.worktree.path } : {}),
      // İcazə FAKTİKİ qovluğa görə hesablanır: izolyasiya varsa `phase.cwd`
      // worktree yoludur, yəni agent `--add-dir` ilə məhz orada işləyir.
      fileAccess: resolveFileAccess({
        fileAccess: phase.input.context.fileAccess,
        extraDirsJson: phase.input.context.extraDirsJson,
        cwd: phase.cwd,
      }),
    }
  }
```

- [ ] **Addım 3: Dekompozisiya icrasına da icazə ver**

`apps/server/src/exec/decomposer.ts`, importa `resolveFileAccess` əlavə et və
`supervisor.execute({...})` çağırışında `cwd` sətrindən sonra:

```ts
      fileAccess: resolveFileAccess({
        fileAccess: input.context.fileAccess,
        extraDirsJson: input.context.extraDirsJson,
        cwd: input.context.cwd ?? undefined,
      }),
```

- [ ] **Addım 4: `main.ts`-dəki sabit icazəni sil**

`apps/server/src/main.ts:20` sətrini əvəz et:

```ts
  // İcazə artıq KONTEKST BAŞINADIR (`contexts.file_access`) və hər icrada
  // `RunRequest.fileAccess` ilə ötürülür. Konstruktorda sabit dəyər saxlamaq
  // onu bütün kontekstlər üçün donduraradı.
  ['cli:claude', new ClaudeCliRunner()],
```

- [ ] **Addım 5: Testi yaz**

`apps/server/src/exec/ladder-file-access.test.ts`:

```ts
import type { RunEvent, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client.js'
import { createContext, createTask } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'

const DONE: RunEvent[] = [
  { t: 'text', delta: 'cavab' },
  { t: 'done', stopReason: 'end_turn' },
]

/**
 * Runner-ə gələn `RunRequest`-i tutan sarğı.
 *
 * `FakeRunner` sorğunu saxlamır — bizə isə məhz icazənin ORAYA çatması lazımdır.
 */
function recording(inner: Runner, sink: RunRequest[]): Runner {
  return {
    id: inner.id,
    kind: inner.kind,
    capabilities: inner.capabilities,
    detect: () => inner.detect(),
    run: (req, opts) => {
      sink.push(req)
      return inner.run(req, opts)
    },
  }
}

function setup(over: { fileAccess?: string; extraDirsJson?: string; cwd?: string } = {}) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: over.cwd ?? 'C:/repo',
    // `cheap` — tək işçi icrası, eskalasiya yoxdur. İcazə pillələrdən asılı
    // deyil, ona görə ən sadə profil seçilir.
    amplificationProfile: 'cheap',
    // İzolyasiya söndürülür (`worktrees` verilmir), yəni `cwd` kontekstinkidir.
    maxParallel: 1,
    fileAccess: over.fileAccess ?? 'workspace',
    extraDirsJson: over.extraDirsJson ?? '[]',
  }
  const seen: RunRequest[] = []
  const runner = recording(
    new FakeRunner({ events: DONE, capabilities: { fileAccess: true } }),
    seen,
  )
  const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined)
  const run = async (prompt = 'salam') => {
    const task = createTask(db, { contextId: ctx.id, prompt })
    await ladder.run({ task, context: ctx, runner, model: 'm' })
  }
  return { seen, run }
}

describe('Ladder — fayl icazəsi hər icraya ötürülür', () => {
  it('icazə HEÇ BİR icrada boş qalmır', async () => {
    const { seen, run } = setup()
    await run()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((r) => r.fileAccess !== undefined)).toBe(true)
  })

  it('read-only kontekstdə səviyyə read-only-dur', async () => {
    const { seen, run } = setup({ fileAccess: 'read-only' })
    await run()
    expect(seen.every((r) => r.fileAccess?.level === 'read-only')).toBe(true)
  })

  it('workspace səviyyəsində yalnız cwd verilir', async () => {
    const { seen, run } = setup({ extraDirsJson: '["C:/başqa"]' })
    await run()
    expect(seen[0]?.fileAccess?.dirs).toEqual(['C:/repo'])
  })

  it('extended səviyyəsində əlavə qovluq da verilir', async () => {
    const { seen, run } = setup({
      fileAccess: 'extended',
      extraDirsJson: '["C:/başqa"]',
    })
    await run()
    expect(seen[0]?.fileAccess?.dirs).toEqual(['C:/başqa', 'C:/repo'])
  })
})
```

- [ ] **Addım 6: Bütün server testlərini qaçır**

Əmr: `pnpm vitest run apps/server`
Gözlənilən: hamısı PASS. `main.ts` dəyişikliyi testlərə toxunmur (`buildApp`
runner-ləri kənardan alır).

- [ ] **Addım 7: Tip yoxlaması**

Əmr: `pnpm typecheck`
Gözlənilən: xəta yoxdur

- [ ] **Addım 8: Commit**

```bash
git add apps/server/src/exec apps/server/src/main.ts
git commit -m "feat(server): icazə nərdivanın hər icrasına ötürülür"
```

---

## Task 5: Paylaşılan API sxemi

**Fayllar:**
- Dəyişir: `packages/shared/src/api.ts`
- Test: `packages/shared/src/api.test.ts`

- [ ] **Addım 1: Testi yaz**

`packages/shared/src/api.test.ts` faylının sonuna:

```ts
describe('UpdateContextBody — fayl icazəsi', () => {
  it('cwd null qəbul edir', () => {
    expect(UpdateContextBody.parse({ cwd: null }).cwd).toBeNull()
  })

  it('tanınmayan səviyyə rədd edilir', () => {
    expect(UpdateContextBody.safeParse({ fileAccess: 'zibil' }).success).toBe(false)
  })

  it('extraDirs massivi qəbul edir', () => {
    expect(UpdateContextBody.parse({ extraDirs: ['/a'] }).extraDirs).toEqual(['/a'])
  })
})

describe('WsServerMessage — activity', () => {
  it('started run daşıyır', () => {
    const msg = WsServerMessage.parse({
      type: 'activity',
      kind: 'started',
      runId: 'r1',
      run: {
        runId: 'r1',
        taskId: 't1',
        contextId: 'c1',
        contextName: 'repo',
        promptExcerpt: 'salam',
        modelId: 'm',
        runnerId: 'cli:claude',
        ladderRung: 2,
        attempt: 1,
        startedAt: 1,
      },
    })
    expect(msg.type).toBe('activity')
  })

  it('ended yalnız runId ilə keçir', () => {
    expect(
      WsServerMessage.safeParse({ type: 'activity', kind: 'ended', runId: 'r1' })
        .success,
    ).toBe(true)
  })
})

describe('WsClientMessage — activity abunəliyi', () => {
  it('subscribe_activity qəbul edilir', () => {
    expect(WsClientMessage.safeParse({ type: 'subscribe_activity' }).success).toBe(true)
  })
})
```

Faylın importuna `WsServerMessage`, `WsClientMessage`, `UpdateContextBody`
əlavə olunduğuna əmin ol.

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run packages/shared/src/api.test.ts`
Gözlənilən: yeni testlər FAIL

- [ ] **Addım 3: Sxemləri yaz**

`packages/shared/src/api.ts`, faylın başındakı importa:

```ts
import { FILE_ACCESS_LEVELS } from './runner.js'
```

`CreateContextBody`-yə əlavə et:

```ts
export const CreateContextBody = z.object({
  name: z.string().min(1).max(200),
  cwd: z.string().optional(),
  verifyCommands: z.array(z.string()).optional(),
  fileAccess: z.enum(FILE_ACCESS_LEVELS).optional(),
  extraDirs: z.array(z.string()).optional(),
})
```

`UpdateContextBody`-yə əlavə et:

```ts
  /**
   * İş qovluğu. `null` = sil.
   *
   * Əvvəl bu sahə YOX İDİ — `cwd` yalnız kontekst yaradılanda verilirdi və
   * səhv yazılmış yolu düzəltmək üçün kontekst yenidən yaradılmalı idi.
   */
  cwd: z.string().nullable().optional(),
  fileAccess: z.enum(FILE_ACCESS_LEVELS).optional(),
  /** YALNIZ `'extended'` səviyyəsində tətbiq olunur (`exec/file-access.ts`). */
  extraDirs: z.array(z.string()).optional(),
```

Faylın sonuna, `WsClientMessage`-dan ƏVVƏL:

```ts
/**
 * Hazırda işləyən bir icranın yığcam təsviri — canlı zolaq üçün.
 *
 * Hadisə DELTALARI burada YOXDUR və bu, mərkəzi qərardır: qlobal kanal hər
 * abunə olan brauzerə gedir, yəni 5 paralel icrada zolaq — ekranın ən kiçik
 * elementi — ən böyük trafiki yaradardı. Deltalar task səhifəsinin öz
 * abunəliyində qalır.
 */
export const ActiveRun = z.object({
  runId: z.string(),
  taskId: z.string(),
  contextId: z.string(),
  contextName: z.string(),
  /** Taskın ilk sətirləri — zolaqda "nə işlənir" sualının cavabı. */
  promptExcerpt: z.string(),
  modelId: z.string(),
  runnerId: z.string(),
  /** Mənfi dəyər nərdivandan KƏNAR mexanizmdir: -1 distillə, -2 bölgü. */
  ladderRung: z.number().int(),
  attempt: z.number().int(),
  startedAt: z.number().int(),
})
export type ActiveRun = z.infer<typeof ActiveRun>
```

`WsClientMessage`-a iki üzv əlavə et:

```ts
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), taskId: z.string() }),
  z.object({ type: z.literal('cancel'), runId: z.string() }),
  /** Qlobal canlı zolaq abunəliyi — task-a bağlı DEYİL. */
  z.object({ type: z.literal('subscribe_activity') }),
  z.object({ type: z.literal('unsubscribe_activity') }),
])
```

`WsServerMessage`-a bir üzv əlavə et:

```ts
  /**
   * Canlı zolaq hadisəsi.
   *
   * `kind: 'updated'` QƏSDƏN YOXDUR: pillə və cəhd nömrəsi bir icra daxilində
   * dəyişmir — nərdivan hər pillə/cəhd üçün YENİ `runs` sətri yaradır. Belə
   * bir növ heç vaxt emit oluna bilməzdi.
   */
  z.object({
    type: z.literal('activity'),
    kind: z.enum(['started', 'ended']),
    runId: z.string(),
    /** YALNIZ `'started'`-da olur — `'ended'` üçün `runId` kifayətdir. */
    run: ActiveRun.optional(),
  }),
```

- [ ] **Addım 4: Testi qaçır**

Əmr: `pnpm vitest run packages/shared`
Gözlənilən: hamısı PASS

- [ ] **Addım 5: Commit**

```bash
git add packages/shared/src/api.ts packages/shared/src/api.test.ts
git commit -m "feat(shared): fayl icazəsi sxemi və activity WS mesajı"
```

---

## Task 6: `WsHub` qlobal kanalı

**Fayllar:**
- Dəyişir: `apps/server/src/ws/hub.ts`
- Test: `apps/server/src/ws/hub.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/ws/hub.test.ts` faylının sonuna:

```ts
describe('qlobal kanal', () => {
  it('yalnız qlobal abunələr activity alır', () => {
    const hub = new WsHub()
    const globalSent: string[] = []
    const taskSent: string[] = []
    const g = { send: (d: string) => globalSent.push(d) }
    const t = { send: (d: string) => taskSent.push(d) }

    hub.subscribeGlobal(g)
    hub.subscribe('task-1', t)
    hub.broadcastGlobal({ type: 'activity', kind: 'ended', runId: 'r1' })

    expect(globalSent).toHaveLength(1)
    expect(taskSent).toHaveLength(0)
  })

  it('task yayımı qlobal abunəyə GETMİR — deltalar zolağa düşməməlidir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    const g = { send: (d: string) => sent.push(d) }
    hub.subscribeGlobal(g)
    hub.broadcast('task-1', {
      type: 'event',
      taskId: 'task-1',
      runId: 'r1',
      seq: 1,
      at: 1,
      event: { t: 'text', delta: 'salam' },
    })
    expect(sent).toHaveLength(0)
  })

  it('unsubscribeGlobal abunəliyi kəsir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    const g = { send: (d: string) => sent.push(d) }
    hub.subscribeGlobal(g)
    hub.unsubscribeGlobal(g)
    hub.broadcastGlobal({ type: 'activity', kind: 'ended', runId: 'r1' })
    expect(sent).toHaveLength(0)
  })

  it('removeSocket qlobal dəsti də təmizləyir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    const g = { send: (d: string) => sent.push(d) }
    hub.subscribeGlobal(g)
    hub.removeSocket(g)
    hub.broadcastGlobal({ type: 'activity', kind: 'ended', runId: 'r1' })
    expect(sent).toHaveLength(0)
    expect(hub.globalCount()).toBe(0)
  })

  it('sınıq socket digərlərini dayandırmır', () => {
    const hub = new WsHub()
    const ok: string[] = []
    hub.subscribeGlobal({
      send: () => {
        throw new Error('bağlı')
      },
    })
    hub.subscribeGlobal({ send: (d: string) => ok.push(d) })
    hub.broadcastGlobal({ type: 'activity', kind: 'ended', runId: 'r1' })
    expect(ok).toHaveLength(1)
  })
})
```

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/ws/hub.test.ts`
Gözlənilən: `hub.subscribeGlobal is not a function`

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/ws/hub.ts`, `WsHub` sinfinə:

```ts
  /**
   * Qlobal abunələr — canlı zolaq (Faza 5A).
   *
   * Task abunəliklərindən AYRIDIR: bura yalnız `activity` mesajları gedir,
   * hadisə deltaları YOX. Bir kanalda birləşdirsəydik, zolaq açıq olan hər
   * brauzer bütün icraların hərf-hərf axınını alardı.
   */
  private readonly globalSockets = new Set<Socket>()

  subscribeGlobal(socket: Socket): void {
    this.globalSockets.add(socket)
  }

  unsubscribeGlobal(socket: Socket): void {
    this.globalSockets.delete(socket)
  }

  globalCount(): number {
    return this.globalSockets.size
  }

  broadcastGlobal(message: WsServerMessage): void {
    const payload = JSON.stringify(message)
    for (const socket of this.globalSockets) {
      try {
        socket.send(payload)
      } catch {
        // Bağlanmış socket — növbəti təmizləmədə silinəcək.
      }
    }
  }
```

`removeSocket` metoduna əlavə et (metodun sonunda):

```ts
    this.globalSockets.delete(socket)
```

- [ ] **Addım 4: Testi qaçır**

Əmr: `pnpm vitest run apps/server/src/ws/hub.test.ts`
Gözlənilən: hamısı PASS

- [ ] **Addım 5: Commit**

```bash
git add apps/server/src/ws/
git commit -m "feat(server): WsHub qlobal kanalı — canlı zolaq üçün"
```

---

## Task 7: Aktiv icraların oxunması və `activity` yayımı

**Fayllar:**
- Dəyişir: `apps/server/src/db/repo.ts`
- Dəyişir: `apps/server/src/exec/supervisor.ts`
- Yaradılır: `apps/server/src/routes/runs.ts`
- Dəyişir: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/runs-routes.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/routes/runs-routes.test.ts`:

```ts
import type { Runner } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import { createContext, createRun, createTask, finishRun } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'orchestris' })
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, ctx, app }
}

describe('GET /api/runs/active', () => {
  it('icra yoxdursa boş siyahı verir', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ runs: [] })
  })

  it('işləyən icra görünür, bitmiş icra görünmür', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'auth bug' })
    const live = createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm1' })
    const done = createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm2' })
    finishRun(db, done.id, { status: 'succeeded' })

    const rows = app
      .inject({ method: 'GET', url: '/api/runs/active' })
      .then((r) => r.json().runs as { runId: string }[])
    expect((await rows).map((r) => r.runId)).toEqual([live.id])
  })

  it('kontekst adı və prompt parçası cavabdadır', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'auth bug-ı düzəlt' })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.json().runs[0]).toMatchObject({
      contextName: 'orchestris',
      promptExcerpt: 'auth bug-ı düzəlt',
    })
  })

  it('uzun prompt kəsilir və çoxnöqtə alır', async () => {
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'a'.repeat(80) })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    const got = res.json().runs[0].promptExcerpt as string
    expect(got).toHaveLength(61)
    expect(got.endsWith('…')).toBe(true)
  })

  it('mənfi pillələr (distillə/bölgü) də görünür', async () => {
    // Onlar da pul yandırır və "niyə hələ gözləyirəm?" sualının cavabı çox vaxt
    // məhz onlardır — gizlətsək istifadəçi sistemi donmuş sayardı.
    const { db, ctx, app } = setup()
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    createRun(db, { taskId: task.id, runnerId: 'fake', modelId: 'm', ladderRung: -1 })

    const res = await app.inject({ method: 'GET', url: '/api/runs/active' })
    expect(res.json().runs[0].ladderRung).toBe(-1)
  })
})
```

**QEYD:** `createRun`-un `ladderRung` parametrini qəbul etdiyini `repo.ts`-də
təsdiq et; qəbul etmirsə testi `supervisor.execute` üzərindən qur.

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/routes/runs-routes.test.ts`
Gözlənilən: 404 (route yoxdur)

- [ ] **Addım 3: `repo.ts`-ə sorğuları əlavə et**

`apps/server/src/db/repo.ts`, faylın sonuna:

```ts
/** Zolaqda göstərilən prompt parçasının uzunluğu. */
const PROMPT_EXCERPT_CHARS = 60

function excerpt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > PROMPT_EXCERPT_CHARS
    ? `${oneLine.slice(0, PROMPT_EXCERPT_CHARS)}…`
    : oneLine
}

/**
 * Hazırda işləyən icralar — canlı zolaq üçün.
 *
 * `status = 'running'` filtri kifayətdir: `finishRun` hər terminal halda
 * statusu dəyişir, server çökməsindən sonra qalanları isə başlanğıcdakı
 * `markOrphanedRunsInterrupted` təmizləyir.
 */
export function listActiveRuns(db: Db): ActiveRun[] {
  const rows = db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      contextId: tasks.contextId,
      contextName: contexts.name,
      prompt: tasks.prompt,
      modelId: runs.modelId,
      runnerId: runs.runnerId,
      ladderRung: runs.ladderRung,
      attempt: runs.attempt,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(contexts, eq(tasks.contextId, contexts.id))
    .where(eq(runs.status, 'running'))
    .orderBy(asc(runs.startedAt))
    .all()

  return rows.map(({ prompt, ...r }) => ({ ...r, promptExcerpt: excerpt(prompt) }))
}

/** Tək icra — `activity` yayımında `'started'` yükü üçün. */
export function getActiveRun(db: Db, runId: string): ActiveRun | undefined {
  return listActiveRuns(db).find((r) => r.runId === runId)
}
```

Faylın başındakı importa `ActiveRun` tipini əlavə et:

```ts
import type { ActiveRun, ErrorClass, RunEvent } from '@orchestris/shared'
```

- [ ] **Addım 4: `RunSupervisor`-a activity yayımını əlavə et**

`apps/server/src/exec/supervisor.ts`, importa `getActiveRun` əlavə et və sinfə:

```ts
export type ActivityListener = (
  msg: { kind: 'started' | 'ended'; runId: string; run?: ActiveRun },
) => void
```

Sinif daxilində, `listeners` yanına:

```ts
  private readonly activityListeners = new Set<ActivityListener>()

  /**
   * Canlı zolaq üçün icra HƏYAT DÖVRÜ hadisələri.
   *
   * `onEvent`-dən AYRIDIR: ora hər delta düşür və onları qlobal kanala
   * yaysaydıq, zolaq açıq olan hər brauzer bütün icraların hərf-hərf axınını
   * alardı.
   */
  onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener)
    return () => {
      this.activityListeners.delete(listener)
    }
  }

  private emitActivity(msg: Parameters<ActivityListener>[0]): void {
    for (const l of this.activityListeners) {
      try {
        l(msg)
      } catch {
        // Bir dinləyicinin xətası icranı dayandırmamalıdır.
      }
    }
  }
```

`execute` metodunda, `setTaskStatus(this.db, input.taskId, 'running')`
sətrindən SONRA:

```ts
    const active = getActiveRun(this.db, run.id)
    if (active !== undefined) {
      this.emitActivity({ kind: 'started', runId: run.id, run: active })
    }
```

`finishRun(...)` çağırışından SONRA (funksiyanın `return`-undan əvvəl):

```ts
    this.emitActivity({ kind: 'ended', runId: run.id })
```

- [ ] **Addım 5: Route-u yaz**

`apps/server/src/routes/runs.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { listActiveRuns } from '../db/repo.js'

/**
 * Canlı zolağın BAŞLANĞIC vəziyyəti.
 *
 * WS yalnız dəyişiklikləri yayır — səhifə açılanda artıq işləyən icralar
 * barədə heç bir mesaj gəlməzdi. Anlıq şəkil olmasaydı, zolaq yalnız növbəti
 * icra başlayanda dolardı.
 */
export function registerRunRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/runs/active', async () => ({ runs: listActiveRuns(db) }))
}
```

- [ ] **Addım 6: `app.ts`-də qoş**

`apps/server/src/app.ts`, importa:

```ts
import { registerRunRoutes } from './routes/runs.js'
```

`registerContextRoutes(app, db)` sətrinin yanına:

```ts
  registerRunRoutes(app, db)
```

`supervisor.onEvent(...)` blokundan SONRA:

```ts
  // Canlı zolaq — YALNIZ həyat dövrü, delta yox (bax `WsHub.broadcastGlobal`).
  supervisor.onActivity((msg) => {
    hub.broadcastGlobal({
      type: 'activity',
      kind: msg.kind,
      runId: msg.runId,
      ...(msg.run !== undefined ? { run: msg.run } : {}),
    })
  })
```

WS mesaj idarəçisini `if/else` zəncirindən `switch`-ə çevir (mövcud `else`
budağı bütün naməlum mesajları `cancel` sayır — yeni mesaj tipləri əlavə
olunandan sonra bu, səhv olardı):

```ts
        switch (msg.type) {
          case 'subscribe': {
            if (getTask(db, msg.taskId) === undefined) {
              socket.send(JSON.stringify({ type: 'error', message: 'Task tapılmadı' }))
              return
            }
            hub.subscribe(msg.taskId, socket)
            return
          }
          case 'unsubscribe':
            hub.unsubscribe(msg.taskId, socket)
            return
          case 'subscribe_activity':
            hub.subscribeGlobal(socket)
            return
          case 'unsubscribe_activity':
            hub.unsubscribeGlobal(socket)
            return
          case 'cancel':
            supervisor.cancel(msg.runId)
            return
        }
```

- [ ] **Addım 7: Testləri qaçır**

Əmr: `pnpm vitest run apps/server`
Gözlənilən: hamısı PASS

- [ ] **Addım 8: Commit**

```bash
git add apps/server/src/db/repo.ts apps/server/src/exec/supervisor.ts apps/server/src/routes/runs.ts apps/server/src/routes/runs-routes.test.ts apps/server/src/app.ts
git commit -m "feat(server): /api/runs/active və activity yayımı"
```

---

## Task 8: Qovluq brauzeri route-ları

**Fayllar:**
- Yaradılır: `apps/server/src/routes/fs.ts`
- Dəyişir: `apps/server/src/app.ts`
- Test: `apps/server/src/routes/fs-routes.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/routes/fs-routes.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerFsRoutes } from './fs.js'

let root: string
let app: FastifyInstance

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orchestris-fs-'))
  mkdirSync(join(root, 'repo-qovluq'))
  // `.git` QOVLUQ kimi — adi repo
  mkdirSync(join(root, 'repo-qovluq', '.git'))
  mkdirSync(join(root, 'worktree-repo'))
  // `.git` FAYL kimi — git worktree (CLAUDE.md qayda 44)
  writeFileSync(join(root, 'worktree-repo', '.git'), 'gitdir: /başqa/yer\n')
  mkdirSync(join(root, 'adi-qovluq'))
  mkdirSync(join(root, '.gizli'))
  writeFileSync(join(root, 'fayl.txt'), 'mən qovluq deyiləm')

  app = Fastify()
  registerFsRoutes(app)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('GET /api/fs/list', () => {
  it('yalnız qovluqlar qaytarılır, fayllar yox', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    expect(res.statusCode).toBe(200)
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names).not.toContain('fayl.txt')
    expect(names).toContain('adi-qovluq')
  })

  it('.git QOVLUQ olan qovluq repo sayılır', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    const e = res.json().entries.find((x: { name: string }) => x.name === 'repo-qovluq')
    expect(e.isRepo).toBe(true)
  })

  it('.git FAYL olan qovluq da repo sayılır — worktree halı', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    const e = res.json().entries.find((x: { name: string }) => x.name === 'worktree-repo')
    expect(e.isRepo).toBe(true)
  })

  it('nöqtə ilə başlayan qovluq hidden işarələnir — SİLİNMİR', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    const e = res.json().entries.find((x: { name: string }) => x.name === '.gizli')
    expect(e.hidden).toBe(true)
  })

  it('nisbi yol 400 verir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=nisbi/yol' })
    expect(res.statusCode).toBe(400)
  })

  it('mövcud olmayan yol 404 verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(join(root, 'yoxdur'))}`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('fayl yolu 400 verir — qovluq gözlənilir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(join(root, 'fayl.txt'))}`,
    })
    expect(res.statusCode).toBe(400)
  })

  it('parent bir səviyyə yuxarını verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(join(root, 'adi-qovluq'))}`,
    })
    expect(res.json().parent).toBe(root)
  })

  it('drives boş deyil', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    expect(res.json().drives.length).toBeGreaterThan(0)
  })
})

describe('GET /api/fs/check', () => {
  it('yazıla bilən qovluq üçün writable true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/check?path=${encodeURIComponent(root)}`,
    })
    expect(res.json()).toMatchObject({ exists: true, isDirectory: true, writable: true })
  })

  it('repo qovluğu isRepo true verir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/check?path=${encodeURIComponent(join(root, 'repo-qovluq'))}`,
    })
    expect(res.json().isRepo).toBe(true)
  })

  it('mövcud olmayan yol üçün exists false — 404 DEYİL', async () => {
    // Seçici hələ yazılmaqda olan yolu yoxlaya bilər; 404 UI-da xəta kimi
    // görünərdi, halbuki cavab sadəcə "hələ yoxdur"dur.
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/check?path=${encodeURIComponent(join(root, 'yoxdur'))}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().exists).toBe(false)
  })

  it('prob faylı QALMIR', async () => {
    await app.inject({ method: 'GET', url: `/api/fs/check?path=${encodeURIComponent(root)}` })
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(root)}` })
    const names = res.json().entries.map((e: { name: string }) => e.name)
    expect(names.some((n: string) => n.startsWith('.orchestris-write-test'))).toBe(false)
  })

  it('path verilməsə 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/check' })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/routes/fs-routes.test.ts`
Gözlənilən: `Failed to resolve import "./fs.js"`

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/routes/fs.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { access, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

export interface FsEntry {
  name: string
  path: string
  /** `.git` FAYL və ya QOVLUQ kimi mövcuddur (CLAUDE.md qayda 44). */
  isRepo: boolean
  /** Nöqtə ilə başlayır — UI onu default gizlədir, server SİLMİR. */
  hidden: boolean
}

/**
 * Windows disk hərfləri.
 *
 * `A:` və `B:` QƏSDƏN yoxlanılmır: onlar tarixən disket sürücüləridir və
 * mövcud olmayan sürücüyə müraciət bəzi sistemlərdə aparat gözləməsinə səbəb
 * ola bilir. Layihə qovluğunun disketdə olma ehtimalı sıfırdır — yəni bu
 * yoxlamanın qiyməti var, faydası yoxdur.
 */
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

async function listDrives(): Promise<string[]> {
  if (platform() !== 'win32') return ['/']
  const found = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`
      try {
        await access(root)
        return root
      } catch {
        return null
      }
    }),
  )
  return found.filter((d): d is string => d !== null)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Qovluq yolunu təsdiqləyir.
 *
 * Ağ siyahı QOYULMUR və bu qəsdəndir: seçicinin bütün mənası istifadəçinin
 * maşınındakı istənilən qovluğu seçə bilməsidir. Yeganə qoruma serverin
 * `127.0.0.1`-ə bind olunmasıdır (CLAUDE.md qayda 16) — fayl MƏZMUNU heç vaxt
 * qaytarılmır və rekursiya yoxdur.
 */
function normalizePath(raw: string | undefined): string | null {
  const value = raw ?? homedir()
  if (value.trim() === '' || !isAbsolute(value)) return null
  return resolve(value)
}

/** Kök qovluqda `dirname` özünü qaytarır — "yuxarı yoxdur" deməkdir. */
function parentOf(p: string): string | null {
  const up = dirname(p)
  return up === p ? null : up
}

async function isDirectoryEntry(full: string, isDir: boolean, isLink: boolean): Promise<boolean> {
  if (isDir) return true
  // Symlink / junction: `readdir` `withFileTypes` `lstat` nəticəsini verir,
  // yəni qovluğa işarə edən keçid `isDirectory()` DEYİL. Windows-da
  // `node_modules/.pnpm` və oxşar junction-lar məhz belədir — filtrləsəydik
  // istifadəçinin real qovluqları siyahıdan düşərdi. Sınıq keçid atılır.
  if (!isLink) return false
  try {
    return (await stat(full)).isDirectory()
  } catch {
    return false
  }
}

export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req, reply) => {
    const path = normalizePath(req.query.path)
    if (path === null) {
      return reply.code(400).send({ error: 'Yol mütləq olmalıdır' })
    }

    let info
    try {
      info = await stat(path)
    } catch {
      return reply.code(404).send({ error: `Qovluq tapılmadı: ${path}` })
    }
    if (!info.isDirectory()) {
      return reply.code(400).send({ error: `Bu, qovluq deyil: ${path}` })
    }

    let raw
    try {
      raw = await readdir(path, { withFileTypes: true })
    } catch {
      return reply.code(403).send({ error: `Qovluq oxunmur: ${path}` })
    }

    const entries: FsEntry[] = []
    await Promise.all(
      raw.map(async (d) => {
        const full = join(path, d.name)
        if (!(await isDirectoryEntry(full, d.isDirectory(), d.isSymbolicLink()))) return
        entries.push({
          name: d.name,
          path: full,
          isRepo: await exists(join(full, '.git')),
          hidden: d.name.startsWith('.'),
        })
      }),
    )
    // `Promise.all` sırası qorumur — siyahı ad üzrə sıralanır.
    entries.sort((a, b) => a.name.localeCompare(b.name))

    return {
      path,
      parent: parentOf(path),
      drives: await listDrives(),
      entries,
    }
  })

  app.get<{ Querystring: { path?: string } }>('/api/fs/check', async (req, reply) => {
    if (req.query.path === undefined || req.query.path.trim() === '') {
      return reply.code(400).send({ error: 'path parametri məcburidir' })
    }
    const path = normalizePath(req.query.path)
    if (path === null) {
      return reply.code(400).send({ error: 'Yol mütləq olmalıdır' })
    }

    let info
    try {
      info = await stat(path)
    } catch {
      // 404 DEYİL: seçicidə hələ yazılmaqda olan yol da yoxlanılır və 404
      // UI-da xəta kimi görünərdi, halbuki cavab sadəcə "hələ yoxdur"dur.
      return { path, exists: false, isDirectory: false, isRepo: false, writable: false }
    }
    if (!info.isDirectory()) {
      return { path, exists: true, isDirectory: false, isRepo: false, writable: false }
    }

    return {
      path,
      exists: true,
      isDirectory: true,
      isRepo: await exists(join(path, '.git')),
      writable: await probeWritable(path),
    }
  })
}

/**
 * REAL yazma probu.
 *
 * `fs.access(dir, W_OK)` İŞLƏDİLMİR: Node sənədi açıq yazır ki, Windows-da o,
 * qovluq ACL-lərini görmür — praktiki olaraq həmişə "yazılır" deyir. Yəni
 * cavab yalan olardı.
 *
 * Prob YALNIZ seçilmiş qovluq üçün qaçır. Siyahıdakı hər sətrə tətbiq
 * etsəydik, bir naviqasiya 50 disk əməliyyatı deməkdi.
 */
async function probeWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.orchestris-write-test-${randomUUID()}`)
  try {
    await writeFile(probe, '')
    return true
  } catch {
    return false
  } finally {
    // `force: true` — yazma alınmayıbsa fayl onsuz da yoxdur.
    await rm(probe, { force: true }).catch(() => undefined)
  }
}
```

**QEYD:** `parse` importu işlədilmirsə sil — `eslint` istifadə olunmayan import
üçün xəta verir.

- [ ] **Addım 4: `app.ts`-də qoş**

```ts
import { registerFsRoutes } from './routes/fs.js'
```

```ts
  registerFsRoutes(app)
```

- [ ] **Addım 5: Testi qaçır**

Əmr: `pnpm vitest run apps/server/src/routes/fs-routes.test.ts`
Gözlənilən: 15 test PASS

- [ ] **Addım 6: Commit**

```bash
git add apps/server/src/routes/fs.ts apps/server/src/routes/fs-routes.test.ts apps/server/src/app.ts
git commit -m "feat(server): qovluq brauzeri route-ları (/api/fs/list, /api/fs/check)"
```

---

## Task 9: Kontekst route-unda yol yoxlaması

**Fayllar:**
- Dəyişir: `apps/server/src/routes/contexts.ts`
- Test: `apps/server/src/routes/contexts-routes.test.ts` (yeni)

- [ ] **Addım 1: Testi yaz**

`apps/server/src/routes/contexts-routes.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from '@orchestris/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { openDb } from '../db/client.js'
import { createContext } from '../db/repo.js'
import type { Catalog } from '../registry/models-dev.js'
import { FakeRunner } from '../runners/fake.js'
import { MemoryStore } from '../secrets/keychain.js'

const CATALOG: Catalog = { source: 'bundled', providers: [] }

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orchestris-ctx-'))
  writeFileSync(join(root, 'fayl.txt'), 'x')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const db = openDb(':memory:')
  const runners = new Map<string, Runner>([['fake', new FakeRunner({ events: [] })]])
  const app = buildApp({ db, runners, credentials: new MemoryStore(), catalog: CATALOG })
  return { db, app }
}

describe('POST /api/contexts — cwd yoxlanması', () => {
  it('mövcud qovluq qəbul edilir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: root },
    })
    expect(res.statusCode).toBe(201)
  })

  it('mövcud olmayan yol 400 verir', async () => {
    // Yoxlamasaq, səhv yol yalnız İLK TASK İCRASINDA üzə çıxardı — istifadəçi
    // artıq gözləyir və pul ödəyib.
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: join(root, 'yoxdur') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('fayl yolu 400 verir', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'a', cwd: join(root, 'fayl.txt') },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/contexts/:id — cwd və icazə', () => {
  it('cwd dəyişdirilə bilir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { cwd: root },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cwd).toBe(root)
  })

  it('cwd null ilə silinir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a', cwd: root })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { cwd: null },
    })
    expect(res.json().cwd).toBeNull()
  })

  it('mövcud olmayan əlavə qovluq 400 verir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { fileAccess: 'extended', extraDirs: [join(root, 'yoxdur')] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('tanınmayan səviyyə 400 verir', async () => {
    const { db, app } = setup()
    const ctx = createContext(db, { name: 'a' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contexts/${ctx.id}`,
      payload: { fileAccess: 'zibil' },
    })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/server/src/routes/contexts-routes.test.ts`

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/routes/contexts.ts`-i tamamilə əvəz et:

```ts
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CreateContextBody, UpdateContextBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createContext, getContext, listContexts, updateContext } from '../db/repo.js'

/**
 * Yolun MÖVCUD QOVLUQ olduğunu təsdiqləyir.
 *
 * Yoxlamasaydıq, səhv yazılmış (və ya artıq silinmiş) qovluq yalnız İLK TASK
 * İCRASINDA üzə çıxardı — istifadəçi artıq gözləyir və pul ödəyib.
 *
 * Xəta MƏTNİ qaytarır, boolean yox: "qovluq yoxdur" ilə "bu, fayldır" fərqli
 * səhvlərdir və istifadəçi hansını düzəldəcəyini bilməlidir.
 */
async function dirProblem(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return `Yol mütləq olmalıdır: ${path}`
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return `Bu, qovluq deyil: ${path}`
    return null
  } catch {
    return `Qovluq tapılmadı: ${path}`
  }
}

async function firstDirProblem(paths: readonly string[]): Promise<string | null> {
  for (const p of paths) {
    const problem = await dirProblem(p)
    if (problem !== null) return problem
  }
  return null
}

export function registerContextRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/contexts', async () => listContexts(db))

  app.post('/api/contexts', async (req, reply) => {
    const parsed = CreateContextBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues })
    }
    const body = parsed.data

    const problem = await firstDirProblem([
      ...(body.cwd !== undefined ? [body.cwd] : []),
      ...(body.extraDirs ?? []),
    ])
    if (problem !== null) return reply.code(400).send({ error: problem })

    return reply.code(201).send(
      createContext(db, {
        name: body.name,
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.verifyCommands !== undefined
          ? { verifyCommands: body.verifyCommands }
          : {}),
        ...(body.fileAccess !== undefined ? { fileAccess: body.fileAccess } : {}),
        ...(body.extraDirs !== undefined ? { extraDirs: body.extraDirs } : {}),
      }),
    )
  })

  /**
   * Ayarların QİSMƏN yenilənməsi — amplifikasiya profili, işçi rejimi,
   * default işçi, yoxlama əmrləri, büdcələr, iş qovluğu, fayl icazəsi.
   *
   * Verilməyən sahə DƏYİŞMİR: istifadəçi profil dəyişəndə büdcəsini
   * itirməməlidir.
   */
  app.patch<{ Params: { id: string } }>('/api/contexts/:id', async (req, reply) => {
    const parsed = UpdateContextBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    if (getContext(db, req.params.id) === undefined) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }

    const body = parsed.data
    // `null` = "sil" deməkdir və yoxlanmır — silinən yolun mövcudluğu
    // əhəmiyyətsizdir.
    const problem = await firstDirProblem([
      ...(typeof body.cwd === 'string' ? [body.cwd] : []),
      ...(body.extraDirs ?? []),
    ])
    if (problem !== null) return reply.code(400).send({ error: problem })

    return reply.send(updateContext(db, req.params.id, body))
  })
}
```

`createContext`-in `fileAccess` / `extraDirs` qəbul etməsi üçün
`apps/server/src/db/repo.ts`-də `createContext` imzasını genişləndir:

```ts
export function createContext(
  db: Db,
  input: {
    name: string
    cwd?: string
    verifyCommands?: readonly string[]
    fileAccess?: string
    extraDirs?: readonly string[]
  },
): Context {
  const id = randomUUID()
  db.insert(contexts)
    .values({
      id,
      name: input.name,
      cwd: input.cwd ?? null,
      verifyCommandsJson: JSON.stringify(input.verifyCommands ?? []),
      ...(input.fileAccess !== undefined ? { fileAccess: input.fileAccess } : {}),
      ...(input.extraDirs !== undefined
        ? { extraDirsJson: JSON.stringify(input.extraDirs) }
        : {}),
      createdAt: now(),
    })
    .run()
  return required(db.select().from(contexts).where(eq(contexts.id, id)).get(), 'contexts')
}
```

- [ ] **Addım 4: Testləri qaçır**

Əmr: `pnpm vitest run apps/server`
Gözlənilən: hamısı PASS

- [ ] **Addım 5: Commit**

```bash
git add apps/server/src/routes/contexts.ts apps/server/src/routes/contexts-routes.test.ts apps/server/src/db/repo.ts
git commit -m "feat(server): kontekst yollarının yoxlanması və icazə sahələri"
```

---

## Task 10: Web API klienti

**Fayllar:**
- Dəyişir: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/web/src/lib/api.test.ts` faylının sonuna:

```ts
describe('fs endpoint-ləri', () => {
  it('listDir GET-dir və content-type QOYMUR — qayda 64', async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ path: '/', parent: null, drives: ['/'], entries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await api.listDir('/repo')
    const headers = (calls[0]?.headers ?? {}) as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('listDir yolu sorğu parametrinə kodlayır', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ path: '/', parent: null, drives: [], entries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await api.listDir('C:\\Users\\a b')
    expect(urls[0]).toContain(encodeURIComponent('C:\\Users\\a b'))
  })
})
```

- [ ] **Addım 2: Tətbiqi yaz**

`apps/web/src/lib/api.ts`, `ContextRow` interfeysinə iki sahə:

```ts
  /** `'read-only'` | `'workspace'` | `'extended'` */
  fileAccess: string
  extraDirsJson: string
```

Faylın uyğun yerinə tiplər:

```ts
export interface FsEntry {
  name: string
  path: string
  isRepo: boolean
  hidden: boolean
}

export interface FsListResponse {
  path: string
  parent: string | null
  drives: string[]
  entries: FsEntry[]
}

export interface FsCheckResponse {
  path: string
  exists: boolean
  isDirectory: boolean
  isRepo: boolean
  writable: boolean
}

export interface ActiveRunRow {
  runId: string
  taskId: string
  contextId: string
  contextName: string
  promptExcerpt: string
  modelId: string
  runnerId: string
  ladderRung: number
  attempt: number
  startedAt: number
}
```

`api` obyektinə metodlar:

```ts
  listDir: (path?: string): Promise<FsListResponse> =>
    request(
      path === undefined
        ? '/api/fs/list'
        : `/api/fs/list?path=${encodeURIComponent(path)}`,
    ),

  checkDir: (path: string): Promise<FsCheckResponse> =>
    request(`/api/fs/check?path=${encodeURIComponent(path)}`),

  listActiveRuns: (): Promise<{ runs: ActiveRunRow[] }> => request('/api/runs/active'),
```

- [ ] **Addım 3: Testi qaçır**

Əmr: `pnpm vitest run apps/web/src/lib/api.test.ts`
Gözlənilən: PASS

- [ ] **Addım 4: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "feat(web): fs və aktiv icra endpoint-ləri"
```

---

## Task 11: `FolderPicker` komponenti

**Fayllar:**
- Yaradılır: `apps/web/src/components/FolderPicker.tsx`
- Test: `apps/web/src/components/FolderPicker.test.tsx`

- [ ] **Addım 1: Testi yaz**

`apps/web/src/components/FolderPicker.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FolderPicker from './FolderPicker.js'

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

const LIST = {
  path: '/projects',
  parent: '/',
  drives: ['/'],
  entries: [
    { name: 'orchestris', path: '/projects/orchestris', isRepo: true, hidden: false },
    { name: '.gizli', path: '/projects/.gizli', isRepo: false, hidden: true },
  ],
}

const CHECK = {
  path: '/projects',
  exists: true,
  isDirectory: true,
  isRepo: false,
  writable: true,
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const body = url.includes('/api/fs/check') ? CHECK : LIST
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

describe('FolderPicker', () => {
  it('qovluqları sadalayır və repo işarəsi göstərir', async () => {
    render(wrap(<FolderPicker open onSelect={() => undefined} onClose={() => undefined} />))
    expect(await screen.findByText('orchestris')).toBeInTheDocument()
    expect(screen.getByText('git')).toBeInTheDocument()
  })

  it('gizli qovluq default GİZLİDİR', async () => {
    render(wrap(<FolderPicker open onSelect={() => undefined} onClose={() => undefined} />))
    await screen.findByText('orchestris')
    expect(screen.queryByText('.gizli')).not.toBeInTheDocument()
  })

  it('keçid açılanda gizli qovluq görünür', async () => {
    render(wrap(<FolderPicker open onSelect={() => undefined} onClose={() => undefined} />))
    await screen.findByText('orchestris')
    await userEvent.click(screen.getByLabelText('Gizli qovluqları göstər'))
    expect(await screen.findByText('.gizli')).toBeInTheDocument()
  })

  it('Seç düyməsi cari yolu qaytarır', async () => {
    const onSelect = vi.fn()
    render(wrap(<FolderPicker open onSelect={onSelect} onClose={() => undefined} />))
    await screen.findByText('orchestris')
    await userEvent.click(screen.getByRole('button', { name: 'Seç' }))
    expect(onSelect).toHaveBeenCalledWith('/projects')
  })

  it('yazıla bilmə vəziyyəti göstərilir', async () => {
    render(wrap(<FolderPicker open onSelect={() => undefined} onClose={() => undefined} />))
    expect(await screen.findByText(/yazıla bilir/i)).toBeInTheDocument()
  })

  it('open false olanda heç nə render olunmur', () => {
    const { container } = render(
      wrap(<FolderPicker open={false} onSelect={() => undefined} onClose={() => undefined} />),
    )
    expect(container).toBeEmptyDOMElement()
  })
})
```

**QEYD:** `@testing-library/user-event` `package.json`-da yoxdursa əlavə et:
`pnpm --filter @orchestris/web add -D @testing-library/user-event`

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `pnpm vitest run apps/web/src/components/FolderPicker.test.tsx`

- [ ] **Addım 3: Tətbiqi yaz**

`apps/web/src/components/FolderPicker.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

interface Props {
  open: boolean
  /** Başlanğıc qovluq. Verilməsə server `os.homedir()`-dən başlayır. */
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

/**
 * Qovluq seçici.
 *
 * Brauzerin öz seçiciləri BU İŞ ÜÇÜN YARARSIZDIR və bu, komponentin mövcudluq
 * səbəbidir: `showDirectoryPicker()` yalnız qovluğun ADINI verir (mütləq yol
 * qəsdən gizlədilir), `<input webkitdirectory>` isə nisbi yol verir və
 * qovluğun BÜTÜN fayllarını sadalayır. Bizə isə `cwd` və `--add-dir` üçün
 * mütləq yol lazımdır.
 */
export default function FolderPicker({
  open,
  initialPath,
  onSelect,
  onClose,
}: Props): React.JSX.Element | null {
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [showHidden, setShowHidden] = useState(false)

  const list = useQuery({
    queryKey: ['fs', 'list', path ?? ''],
    queryFn: () => api.listDir(path),
    enabled: open,
  })

  const current = list.data?.path

  const check = useQuery({
    queryKey: ['fs', 'check', current ?? ''],
    queryFn: () => api.checkDir(current as string),
    enabled: open && current !== undefined,
  })

  if (!open) return null

  const entries = (list.data?.entries ?? []).filter((e) => showHidden || !e.hidden)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg border border-white/10 bg-surface-2 p-4">
        <div className="mb-2 truncate font-mono text-sm text-ink-dim">
          {current ?? 'yüklənir…'}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(list.data?.drives ?? []).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPath(d)}
              className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
            >
              {d}
            </button>
          ))}
          {list.data?.parent !== null && list.data?.parent !== undefined && (
            <button
              type="button"
              onClick={() => setPath(list.data.parent as string)}
              className="ml-auto rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
            >
              ↑ Yuxarı
            </button>
          )}
        </div>

        <ul className="mb-3 max-h-72 overflow-y-auto rounded border border-white/10">
          {list.isError && (
            <li className="p-3 text-sm text-red-400">Qovluq oxunmadı</li>
          )}
          {entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => setPath(e.path)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-white/5"
              >
                <span className="truncate">{e.name}</span>
                {e.isRepo && <span className="ml-2 text-xs text-accent">git</span>}
              </button>
            </li>
          ))}
          {!list.isLoading && entries.length === 0 && (
            <li className="p-3 text-sm text-ink-dim">Alt-qovluq yoxdur</li>
          )}
        </ul>

        <label className="mb-3 flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(ev) => setShowHidden(ev.target.checked)}
            aria-label="Gizli qovluqları göstər"
          />
          Gizli qovluqları göstər
        </label>

        {/*
          Yazıla bilmə YALNIZ seçilmiş qovluq üçün yoxlanılır (real yazma
          probu). Hər sətirdə göstərsəydik, `fs.access(W_OK)` Windows-da ACL
          görmədiyi üçün işarə YALAN olardı.
        */}
        <div className="mb-3 text-xs text-ink-dim">
          {check.data === undefined
            ? 'yoxlanılır…'
            : [
                check.data.isRepo ? '✓ git repo' : '— git repo deyil',
                check.data.writable ? '✓ yazıla bilir' : '⚠ yazıla bilmir',
              ].join('   ')}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Ləğv
          </button>
          <button
            type="button"
            disabled={current === undefined}
            onClick={() => {
              if (current !== undefined) onSelect(current)
            }}
            className="rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Seç
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Addım 4: Testi qaçır**

Əmr: `pnpm vitest run apps/web/src/components/FolderPicker.test.tsx`
Gözlənilən: 6 test PASS

- [ ] **Addım 5: Commit**

```bash
git add apps/web/src/components/FolderPicker.tsx apps/web/src/components/FolderPicker.test.tsx apps/web/package.json
git commit -m "feat(web): qovluq seçici modal"
```

---

## Task 12: Canlı zolaq

**Fayllar:**
- Yaradılır: `apps/web/src/lib/useActivity.ts`
- Yaradılır: `apps/web/src/components/LiveBar.tsx`
- Dəyişir: `apps/web/src/components/Sidebar.tsx`
- Test: `apps/web/src/components/LiveBar.test.tsx`

- [ ] **Addım 1: Hook-u yaz**

`apps/web/src/lib/useActivity.ts`:

```ts
import type { WsServerMessage } from '@orchestris/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ActiveRunRow } from './api.js'

/**
 * Canlı zolağın məlumat yolu: REST ANLIQ ŞƏKİL + qlobal WS.
 *
 * Polling seçilmədi: zolaq HƏR səhifədə mount olunur, yəni heç nə
 * işləməyəndə də daimi sorğu gedərdi. WS isə boş vaxtda sıfır trafik verir.
 *
 * Anlıq şəkil MƏCBURİDİR: WS yalnız dəyişiklikləri yayır, yəni səhifə
 * açılanda artıq işləyən icralar barədə heç bir mesaj gəlməzdi.
 */
export function useActivity(): { runs: ActiveRunRow[]; connected: boolean } {
  const [runs, setRuns] = useState<ActiveRunRow[]>([])
  const [connected, setConnected] = useState(false)

  const snapshot = useQuery({ queryKey: ['runs', 'active'], queryFn: api.listActiveRuns })

  useEffect(() => {
    if (snapshot.data !== undefined) setRuns(snapshot.data.runs)
  }, [snapshot.data])

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'subscribe_activity' }))
    }
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    ws.onmessage = (raw: MessageEvent<string>) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(raw.data) as WsServerMessage
      } catch {
        return
      }
      if (msg.type !== 'activity') return

      setRuns((prev) => {
        if (msg.kind === 'ended') return prev.filter((r) => r.runId !== msg.runId)
        if (msg.run === undefined) return prev
        // Təkrar `started` (yenidən qoşulma) sətri ikiləşdirməməlidir.
        if (prev.some((r) => r.runId === msg.runId)) return prev
        return [...prev, msg.run]
      })
    }

    return () => ws.close()
  }, [])

  return { runs, connected }
}
```

- [ ] **Addım 2: Testi yaz**

`apps/web/src/components/LiveBar.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LiveBar from './LiveBar.js'

class FakeWs {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  send = vi.fn()
  close = vi.fn()
}

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

const RUN = {
  runId: 'r1',
  taskId: 't1',
  contextId: 'c1',
  contextName: 'orchestris',
  promptExcerpt: 'auth bug-ı düzəlt',
  modelId: 'claude-haiku-4-5',
  runnerId: 'cli:claude',
  ladderRung: 2,
  attempt: 1,
  startedAt: Date.now(),
}

beforeEach(() => {
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket
})

describe('LiveBar', () => {
  it('icra yoxdursa zolaq görünmür', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const { container } = render(wrap(<LiveBar />))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).not.toContain('CANLI')
  })

  it('işləyən icranın modelini və prompt parçasını göstərir', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runs: [RUN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    render(wrap(<LiveBar />))
    expect(await screen.findByText('claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByText(/auth bug/)).toBeInTheDocument()
  })

  it('mənfi pillə RƏQƏM kimi göstərilmir — ad işlədilir', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runs: [{ ...RUN, ladderRung: -1 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    render(wrap(<LiveBar />))
    expect(await screen.findByText('distillə')).toBeInTheDocument()
    expect(screen.queryByText('P-1')).not.toBeInTheDocument()
  })
})
```

- [ ] **Addım 3: Komponenti yaz**

`apps/web/src/components/LiveBar.tsx`:

```tsx
import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useActivity } from '../lib/useActivity.js'

/**
 * Mənfi pillə nömrələri nərdivandan KƏNAR mexanizmlərdir (CLAUDE.md qayda 37,
 * 51). "Pillə -1" heç nə demir — ad işlədilir.
 */
const RUNG_LABEL: Record<number, string> = {
  [-1]: 'distillə',
  [-2]: 'bölgü',
}

function rungLabel(rung: number): string {
  return RUNG_LABEL[rung] ?? `P${rung}`
}

function elapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Canlı zolaq — Sidebar-ın başında, hər səhifədə.
 *
 * Keçən vaxt BRAUZERDƏ hesablanır: hər saniyə server mesajı göndərmək eyni
 * məlumatı şəbəkədən keçirməkdir və sayğac serverin yayımından daha hamar
 * işləyir.
 */
export default function LiveBar(): React.JSX.Element | null {
  const { runs } = useActivity()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (runs.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [runs.length])

  if (runs.length === 0) return null

  return (
    <div className="mb-4 rounded border border-accent/30 bg-accent/5 p-2">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-accent">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        CANLI — {runs.length} icra
      </div>
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.runId}>
            <Link to={`/tasks/${r.taskId}`} className="block hover:opacity-80">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-mono">{r.modelId}</span>
                <span className="shrink-0 text-ink-dim">
                  {rungLabel(r.ladderRung)} · {elapsed(r.startedAt, now)}
                </span>
              </div>
              <div className="truncate text-xs text-ink-dim">{r.promptExcerpt}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Addım 4: Sidebar-a qoş**

`apps/web/src/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom'
import LiveBar from './LiveBar.js'
```

`<div className="mb-6 …">Orchestris</div>` sətrindən SONRA:

```tsx
      <LiveBar />
```

- [ ] **Addım 5: Testləri qaçır**

Əmr: `pnpm vitest run apps/web`
Gözlənilən: hamısı PASS

- [ ] **Addım 6: Commit**

```bash
git add apps/web/src/lib/useActivity.ts apps/web/src/components/LiveBar.tsx apps/web/src/components/LiveBar.test.tsx apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): canlı icra zolağı"
```

---

## Task 13: Fayl icazəsi paneli və Kontekstlər səhifəsi

**Fayllar:**
- Yaradılır: `apps/web/src/components/FileAccessPanel.tsx`
- Dəyişir: `apps/web/src/pages/Contexts.tsx`
- Test: `apps/web/src/components/FileAccessPanel.test.tsx`

- [ ] **Addım 1: Testi yaz**

`apps/web/src/components/FileAccessPanel.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import FileAccessPanel from './FileAccessPanel.js'

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

const CTX = {
  id: 'c1',
  cwd: '/repo',
  fileAccess: 'workspace',
  extraDirsJson: '[]',
}

describe('FileAccessPanel', () => {
  it('cari səviyyə seçili göstərilir', () => {
    render(wrap(<FileAccessPanel context={CTX} onSave={vi.fn()} />))
    expect(screen.getByLabelText('İş qovluğuna yaz')).toBeChecked()
  })

  it('səviyyə dəyişəndə onSave çağırılır', async () => {
    const onSave = vi.fn()
    render(wrap(<FileAccessPanel context={CTX} onSave={onSave} />))
    await userEvent.click(screen.getByLabelText('Yalnız-oxu'))
    expect(onSave).toHaveBeenCalledWith({ fileAccess: 'read-only' })
  })

  it('əlavə qovluqlar YALNIZ extended səviyyəsində görünür', async () => {
    const { rerender } = render(wrap(<FileAccessPanel context={CTX} onSave={vi.fn()} />))
    expect(screen.queryByText('Əlavə qovluqlar')).not.toBeInTheDocument()

    rerender(
      wrap(
        <FileAccessPanel
          context={{ ...CTX, fileAccess: 'extended', extraDirsJson: '["/a"]' }}
          onSave={vi.fn()}
        />,
      ),
    )
    expect(screen.getByText('Əlavə qovluqlar')).toBeInTheDocument()
    expect(screen.getByText('/a')).toBeInTheDocument()
  })

  it('codex məhdudiyyəti açıq yazılır', () => {
    render(
      wrap(
        <FileAccessPanel
          context={{ ...CTX, fileAccess: 'extended' }}
          onSave={vi.fn()}
        />,
      ),
    )
    expect(screen.getByText(/codex/i)).toBeInTheDocument()
  })
})
```

**QEYD:** Task 3 Addım 1-də codex-in əlavə qovluq bayrağı TAPILIBSA, sonuncu
testi silin və panelin xəbərdarlıq mətnini çıxarın — o xəbərdarlıq yalnız
bayraq YOXDURSA doğrudur.

- [ ] **Addım 2: Komponenti yaz**

`apps/web/src/components/FileAccessPanel.tsx`:

```tsx
import { useState } from 'react'
import FolderPicker from './FolderPicker.js'

const LEVELS = [
  { value: 'read-only', label: 'Yalnız-oxu', hint: 'Agent oxuyur, fayla toxunmur' },
  { value: 'workspace', label: 'İş qovluğuna yaz', hint: 'Yalnız iş qovluğu' },
  { value: 'extended', label: 'İş qovluğu + əlavə qovluqlar', hint: 'Seçilmiş qovluqlar' },
] as const

interface ContextLike {
  id: string
  cwd: string | null
  fileAccess: string
  extraDirsJson: string
}

interface Props {
  context: ContextLike
  onSave: (patch: { fileAccess?: string; extraDirs?: string[] }) => void
}

function parseDirs(json: string): string[] {
  try {
    const raw: unknown = JSON.parse(json)
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Kontekstin fayl icazəsi.
 *
 * Səviyyə HƏR İKİ CLI-ya eyni mənanı verir (`exec/file-access.ts`) — əvvəl
 * claude yazır, codex isə səssizcə yazmırdı və bu fərq heç yerdə görünmürdü.
 */
export default function FileAccessPanel({ context, onSave }: Props): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const dirs = parseDirs(context.extraDirsJson)

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Fayl icazəsi</div>

      {LEVELS.map((l) => (
        <label key={l.value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`file-access-${context.id}`}
            aria-label={l.label}
            checked={context.fileAccess === l.value}
            onChange={() => onSave({ fileAccess: l.value })}
          />
          <span>
            {l.label}
            <span className="ml-2 text-xs text-ink-dim">{l.hint}</span>
          </span>
        </label>
      ))}

      {context.fileAccess === 'extended' && (
        <div className="mt-2 space-y-1">
          <div className="text-sm font-medium">Əlavə qovluqlar</div>
          {dirs.length === 0 && <div className="text-xs text-ink-dim">(yoxdur)</div>}
          <ul className="space-y-1">
            {dirs.map((d) => (
              <li key={d} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{d}</span>
                <button
                  type="button"
                  onClick={() => onSave({ extraDirs: dirs.filter((x) => x !== d) })}
                  className="shrink-0 text-ink-dim hover:text-red-400"
                >
                  sil
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/5"
          >
            + Əlavə et
          </button>
          {/*
            ÖLÇÜLDÜ (`codex exec --help`): əlavə yazıla bilən qovluq üçün
            bayraq tapılmadı. Bunu gizlətmək istifadəçiyə yalan demək olardı.
          */}
          <p className="text-xs text-ink-dim">
            Qeyd: əlavə qovluqlar yalnız <code>cli:claude</code> icralarında
            tətbiq olunur — <code>codex</code> yalnız iş qovluğuna yazır.
          </p>
        </div>
      )}

      <FolderPicker
        open={pickerOpen}
        {...(context.cwd !== null ? { initialPath: context.cwd } : {})}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          setPickerOpen(false)
          if (!dirs.includes(p)) onSave({ extraDirs: [...dirs, p] })
        }}
      />
    </div>
  )
}
```

- [ ] **Addım 3: Kontekstlər səhifəsinə qoş**

`apps/web/src/pages/Contexts.tsx`:

1. İmportlara `FileAccessPanel` və `FolderPicker` əlavə et.
2. Yaratma formasındakı `cwd` mətn sahəsinin yanına «Seç…» düyməsi qoy; düymə
   `FolderPicker`-i açır, `onSelect` isə `setCwd(path)` edir. Mətn sahəsi
   QALIR — yolu yapışdırmaq istəyən istifadəçi seçicidən keçməyə məcbur
   olmamalıdır.
3. Hər kontekst sətrinin ayarlar hissəsinə `FileAccessPanel` əlavə et.
   `onSave` mövcud `updateContext` mutasiyasını çağırır (səhifədə artıq
   profil/işçi rejimi üçün belə bir mutasiya var — onu oxu və eyni üsulla
   işlət).
4. İş qovluğunu dəyişmək üçün hər sətrə «İş qovluğu: … [Dəyiş]» sətri əlavə
   et; `onSelect` → `updateContext({ cwd: path })`.

- [ ] **Addım 4: Testləri qaçır**

Əmr: `pnpm vitest run apps/web`
Gözlənilən: hamısı PASS

- [ ] **Addım 5: Tip yoxlaması**

Əmr: `pnpm typecheck`
Gözlənilən: xəta yoxdur

- [ ] **Addım 6: Commit**

```bash
git add apps/web/src/components/FileAccessPanel.tsx apps/web/src/components/FileAccessPanel.test.tsx apps/web/src/pages/Contexts.tsx
git commit -m "feat(web): fayl icazəsi paneli və qovluq seçicisi Kontekstlərdə"
```

---

## Task 14: Sənədləşmə və yekun yoxlama

**Fayllar:**
- Dəyişir: `CLAUDE.md`

- [ ] **Addım 1: Yeni qaydaları yaz**

`CLAUDE.md`-də «Dəyişməz qaydalar» bölməsinin sonuna dörd qayda əlavə et
(65–68), mövcud üslubda — hər biri ölçülmüş və ya struktur səbəblə:

- **65. Fayl icazəsi kontekst başınadır və hər iki CLI-ya EYNİ mənanı verir.**
  Əvvəl `main.ts` `permissionMode: 'acceptEdits'`-i dondururdu, codex isə
  arqumentsiz qurulub `read-only` qalırdı — eyni task hansı runner-ə düşdüyünə
  görə faylı dəyişir və ya dəyişmirdi, fərq isə heç yerdə görünmürdü.
  `RunRequest.fileAccess` NİYYƏT daşıyır (`{ level, dirs }`), bayraq adları
  paylaşılan müqaviləyə girmir. `CLAUDE_STABLE_FLAGS` toxunulmur —
  `--permission-mode` və `--add-dir` onsuz da o dəstin xaricindədir.

- **66. Qlobal WS kanalına DELTA düşmür.** Canlı zolaq hər səhifədə mount
  olunur; hadisə deltalarını ora yaysaydıq, 5 paralel icrada zolaq ekranın ən
  kiçik elementi olduğu halda ən böyük trafiki yaradardı. `activity` mesajı
  yalnız `started` / `ended` daşıyır. `updated` YOXDUR: pillə və cəhd bir icra
  daxilində dəyişmir — nərdivan hər addım üçün yeni `runs` sətri yaradır.

- **67. Brauzer qovluğun mütləq yolunu vermir.** `showDirectoryPicker()` yalnız
  `.name` verir (qəsdən), `<input webkitdirectory>` isə nisbi yol verir və
  qovluğun bütün fayllarını sadalayır. Ona görə seçici SERVERDƏN qurulur:
  `GET /api/fs/list` bir səviyyə, yalnız qovluq adları, fayl məzmunu heç vaxt,
  rekursiya heç vaxt. Endpoint autentifikasiyasızdır — yeganə qoruma
  `127.0.0.1` bind-ıdır (qayda 16).

- **68. Yazıla bilmə HƏR SƏTİRDƏ göstərilmir.** Node-un `fs.access(dir, W_OK)`
  yoxlaması Windows-da ACL-ləri görmür — praktiki olaraq həmişə "yazılır"
  deyir, yəni sətirdəki işarə yalan olardı. Dürüst yoxlama real yazma probudur
  və o, YALNIZ seçilmiş qovluq üçün qaçır (`GET /api/fs/check`); 50 sətrin
  hamısına tətbiq etmək bir naviqasiyada 50 disk əməliyyatı deməkdi. `isRepo`
  isə hər sətirdədir — o, bir ucuz `stat`-dır və `.git` FAYL da ola bilər
  (worktree, qayda 44).

- [ ] **Addım 2: Fazalar bölməsini yenilə**

`CLAUDE.md`-də «Fazalar» siyahısına:

```
- **5A** (bitdi) — kontekst başına fayl icazəsi (`contexts.file_access`,
  `extra_dirs_json`), canlı icra zolağı (`GET /api/runs/active`, qlobal WS
  `activity`) və server əsaslı qovluq seçicisi (`GET /api/fs/list`,
  `/api/fs/check`)
```

- [ ] **Addım 3: Bilinən boşluqları əlavə et**

«Bilinən boşluqlar» bölməsinə spesifikasiyanın §11-dəki beş bəndi köçür:
yazma probunun qiyməti, çoxlu `--add-dir`-in keşə təsiri, `read-only`
səviyyəsinin faydası, zolağın çoxlu paralel icrada davranışı, qlobal WS-in
tab sayına həssaslığı.

- [ ] **Addım 4: Bütün testləri qaçır**

Əmr: `pnpm test`
Gözlənilən: HAMISI PASS. Sayı qeyd et.

- [ ] **Addım 5: Tip yoxlaması**

Əmr: `pnpm typecheck`
Gözlənilən: xəta yoxdur

- [ ] **Addım 6: Lint**

Əmr: `pnpm lint`
Gözlənilən: xəta yoxdur

- [ ] **Addım 7: Miqrasiya dreyfi yoxlaması**

Əmr: `pnpm --filter @orchestris/server db:generate`
Gözlənilən: **yeni fayl YARANMIR** («No schema changes»). Yaranırsa, `schema.ts`
ilə miqrasiya arasında fərq var — CI bunu sındırır (qayda 26).

- [ ] **Addım 8: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Faza 5A qaydaları (65-68) və bilinən boşluqlar"
```

---

## Yekun yoxlama siyahısı

- [ ] `pnpm test` — hamısı yaşıl
- [ ] `pnpm typecheck` — təmiz
- [ ] `pnpm lint` — təmiz
- [ ] `pnpm --filter @orchestris/server db:generate` — yeni fayl yaratmır
- [ ] `CLAUDE_STABLE_FLAGS` dəyişməyib (Task 3-dəki test bunu qoruyur)
- [ ] Mövcud kontekstlər miqrasiyadan sonra `'workspace'` alır
- [ ] Zolaq boş vaxtda HEÇ NƏ render etmir (boş `div` də yox)
