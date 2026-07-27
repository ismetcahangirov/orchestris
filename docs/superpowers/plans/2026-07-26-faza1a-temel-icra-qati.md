# Faza 1A — Təməl və İcra Qatı: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bir taskı lokal `claude` CLI ilə işə salıb, hadisələrini SQLite-a yazıb, brauzerdə canlı görmək — və bunun bütün pipeline-ını sıfır token xərcləyən testlərlə örtmək.

**Architecture:** pnpm monorepo. `packages/shared` Zod sxemlərini və `Runner` interfeysini saxlayır (server və web üçün tək həqiqət mənbəyi). `apps/server` Fastify — CLI proseslərini spawn edir, JSONL-i vahid `RunEvent` axınına çevirir, SQLite-a yazır və WebSocket ilə yayımlayır. `apps/web` Vite + React — canlı axını göstərir. `FakeRunner` real fixture-ləri təkrar oynadaraq bütün pipeline-ı token xərcləmədən test edir.

**Tech Stack:** Node 22, TypeScript 5.7, pnpm workspaces, Fastify 5, `@fastify/websocket`, Drizzle ORM + `better-sqlite3`, Zod 3, Vitest 3, Vite 6, React 19, React Router 7, Tailwind CSS 4.

**Bu plan nəyi əhatə etmir (sonrakı planlar):** ApiRunner və API açarı idarəsi (Faza 1B), models.dev model kəşfi (1B), Pillə 0–2 amplifikasiya (1C), `--include-partial-messages` hərf-hərf axını (1B — öz fixture-i tələb edir), paralellik və git worktree (Faza 2), memory (Faza 3).

**Ön şərt sənədlər:**
- Spesifikasiya: `docs/superpowers/specs/2026-07-26-orchestris-design.md`
- Real CLI fixture-ləri: `fixtures/cli/*.jsonl` (təmizlənmiş, repoda mövcud)

---

# ⚠️ DÜZƏLİŞ 1 — sxem müqaviləsi dəyişdi (2026-07-27)

Task 2–4 və Task 7 icra edildikdən sonra keyfiyyət yoxlaması `packages/shared`-də
**4 blocker** tapdı. Hər biri işləyən kodla təkrarlandı və düzəldildi
(commit-lər `661c1cb`, `8172bb7`, `32654b1`).

**Aşağıdaki Task 2, 3, 4 və 7 kod blokları artıq KÖHNƏDİR.** Tarixi qeyd kimi
saxlanılır. Task 8 və sonrakı taskları icra edərkən bu bölmədəki müqaviləyə
əsaslan, yuxarıdaki köhnə kod bloklarına yox. Həqiqət mənbəyi repodaki
`packages/shared/src/*.ts` fayllarıdır.

### Tapılan və düzəldilən blocker-lər

| # | Qüsur | Sübut | Düzəliş |
|---|---|---|---|
| B1 | `classifyErrorText` status kodlarını **substring** kimi tuturdu | Real codex mesajının `cf-ray: a2140175bd9ce8ee` hex-i **"401" ehtiva edir** → təkrarlanabilən 429 xətası təkrarsız `auth` kimi təsnif olunurdu | Söz sərhədi (`\b429\b`) + rate-limit/overload yoxlaması auth-dan **əvvəl** + status kodu yoxlaması **ən sonda** |
| B2 | `class: z.string()` | `class:'rateLimit'` və `class:''` qəbul olunurdu; istehlakçılar `as ErrorClass` cast-a məcbur olurdu | `class: z.enum(ERROR_CLASSES)` |
| B3 | `input: z.unknown()` **açarı opsional edir** | `parse({t:'tool',id,name})` uğurlu olurdu, `input` açarı olmurdu → UI-da `JSON.stringify(undefined).slice()` **TypeError** atırdı | `input: z.record(z.string(), z.unknown())` |
| B4 | `usage`-in kumulyativ/bir-dəfəlik invariantı sənədləşdirilməmişdi | API runner müəllifi addım-addım `usage` emit etsə, `BudgetGuard` (son-dəyər-qalib) yalnız son kiçik addımı görər və **səssizcə yan keçər** | Müqavilə `events.ts`-də açıq yazıldı |

B1-in incə tərəfi: söz sərhədi hex ID-ləri həll edir, amma adi rəqəmləri yox —
`'Request timed out after 401 seconds'` mətnində "401" **həqiqətən müstəqil
sözdür**. Ona görə status kodu yoxlaması bütün spesifik mətn siqnallarından
(`timed out`, `unauthorized`, `permission denied`) **sonra** gəlir.

### Yeni `RunEvent` müqaviləsi — Task 8+ bunu işlətməlidir

```ts
type RunEvent =
  // YENİ variant. İcranın başında, ən çox bir dəfə.
  // sessionId burada verilir, `done`-da gözlənilmir: icra xəta ilə bitsə
  // `done` gəlməz, halbuki `--resume` məhz o halda lazımdır.
  // model FAKTİKİ işlədilən modeldir (CLI fallback model işlədə bilər).
  | { t:'start',  sessionId?: string, model?: string }
  | { t:'text',   delta: string }
  | { t:'think',  delta: string }
  // input MƏCBURİDİR və obyekt olmalıdır (B3)
  | { t:'tool',   id: string, name: string, input: Record<string, unknown> }
  | { t:'result', id: string, ok: boolean, output?: string }
  | { t:'usage',
      inputTokens: number, outputTokens: number,
      cacheReadTokens?: number, cacheWriteTokens?: number,
      // YOXLUĞU "bilinmir"; 0 isə "həqiqətən pulsuz". Codex xərc vermir →
      // sahə BURAXILIR, `0` yazılmır.
      costUsd?: number,
      // MƏCBURİ. 'subscription' → real pul çıxmır, costUsd istinad qiymətidir.
      billed: 'real' | 'subscription' }
  | { t:'rate_limit',
      status: string,          // xam CLI dəyəri, enum deyil
      blocked: boolean,        // YENİ. status === 'rejected'
      limitType: string,
      resetsAtUnixSec?: number } // ADI DƏYİŞDİ (əvvəl `resetsAt`), unix SANİYƏ
  | { t:'done',   sessionId?: string, stopReason: string }
  // `retryable` SAHƏSİ SİLİNDİ — `isRetryable(class)` çağır.
  // sessionId əlavə edildi: uğursuz icranı davam etdirmək üçün.
  | { t:'error',  class: ErrorClass, message: string, sessionId?: string }
```

### Sonrakı taskların hansı hissələri dəyişir

| Task | Nə dəyişir |
|---|---|
| **8** (codex parser) | `retryable` verilmir · `billed: 'subscription'` (codex ChatGPT abunəliyi ilə işləyir) · `costUsd` **buraxılır** (codex xərc vermir), `0` yazılmır · `thread.started` → `start` hadisəsi · `tool.input` obyekt olmalıdır · `turn.completed` → `resetsAtUnixSec` |
| **12** (BudgetGuard) | `event.costUsd` artıq **opsionaldır** — `undefined` halı idarə olunmalıdır (yoxdursa dollar limiti yoxlanmır) |
| **14** (RunSupervisor) | `error` hadisəsində `retryable` yoxdur → lazım olsa `isRetryable(e.class)` · `sessionId` həm `start`, həm `error`, həm `done`-dan gələ bilər — supervisor hər üçündən oxumalıdır |
| **15/17** (UI) | `EventTimeline` `usage` xülasəsi `costUsd` yoxluğunu idarə etməli və `billed`-i göstərməlidir (abunəlik xərcini "$0.0085 xərcləndi" kimi göstərmək yalandır) · `resetsAt` → `resetsAtUnixSec` |

### Əlavə struktur düzəlişi

`packages/shared/tsconfig.json` (typecheck, **testlər daxil**) və
`tsconfig.build.json` (build, testlər xaric) ayrıldı. Səbəb: `exclude` əsas
tsconfig-də olsa, test faylları tip yoxlamasından da çıxır və
`runner.test.ts`-dəki kompilyasiya-vaxtı tamlıq yoxlaması ölü qalır.

---

# ⚠️ DÜZƏLİŞ 2 — Node-un TypeScript dəstəyi bu layihədə işləmir (2026-07-27)

Task 5-də təyin olunan `dev` skripti
`node --watch --experimental-strip-types src/main.ts` **işləmir**. Node
v22.16.0 ilə iki məhdudiyyət real olaraq təsdiqləndi:

1. **`.js` spesifikatoru `.ts` fayla həll olunmur.** Bizim bütün nisbi
   importlarımız `.js` uzantısı ilədir (`moduleResolution: bundler` + ESM
   tələbi), amma fayllar `.ts`-dir. Node `resolve:275`-də "modul tapılmadı"
   verir. Bu, layihədəki **hər** nisbi importa aiddir.
2. **Konstruktor parametr-xassələri** (`constructor(private readonly x: T) {}`)
   strip-only rejimdə dəstəklənmir:
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not
   supported in strip-only mode`.

**Həll:** `tsx` dev runner kimi əlavə edildi.

```
"dev":   "tsx watch src/main.ts"
"start": "node dist/main.js"
```

`tsx` (esbuild əsaslı) həm `.js` → `.ts` həllini, həm parametr-xassələri
düzgün idarə edir — yoxlanılıb.

**Sonrakı tasklar üçün nəticə:** `node --experimental-strip-types` ilə
TypeScript faylı işə salmağa cəhd etməyin — nə `dev` skriptində, nə əl ilə
yoxlamalarda. `npx tsx <fayl>` işlədin.

---

---

## Ölçülmüş faktlar — bu plan onlara əsaslanır

Bunlar bu maşında real işlədilərək təsdiqlənib. Kodu yazarkən bunlara etibar et:

| Fakt | Nəticə |
|---|---|
| `--output-format stream-json` tək işləmir: `requires --verbose` | `--verbose` həmişə əlavə olunur |
| `--bare` OAuth-u söndürür (`apiKeySource: "none"`, `is_error: true`) | `--bare` **heç vaxt** istifadə olunmur |
| `--safe-mode` fərdiləşdirmələri söndürür, auth-u saxlayır | Xərc $0.0251 → $0.0085 |
| Prompt prefiksi dəyişəndə keş sınır və 1.25x ödənilir | Bayraq dəsti **sabit** qalmalıdır |
| `claude` result sətri `type: "result"` sahəsinə malikdir | Tanıma `type` ilə, sətir başlanğıcı ilə yox |
| `codex exec` stdin gözləyir və donur | `stdin: 'ignore'` məcburidir |
| `codex` stderr loglarını JSONL axınına qarışdırır | Parser JSON olmayan sətirləri atlayır |
| `codex login status` → **"Not logged in"** | `detect()` bunu aşkarlayır; success fixture Task 14-də |
| `claude.cmd` shim-i hədəf `.exe` yolunu saxlayır | Resolver `.cmd`-i oxuyur, `shell: true` lazım deyil |

---

## Fayl strukturu

Hər fayl bir məsuliyyət daşıyır. Böyük fayl = çox iş görür.

```
orchestris/
├─ package.json                          workspace root, skriptlər
├─ pnpm-workspace.yaml
├─ tsconfig.base.json                    paylaşılan compiler ayarları
├─ vitest.workspace.ts
├─ .gitattributes                        ✅ mövcud
├─ CLAUDE.md                             Task 16
├─ fixtures/
│  ├─ sanitize.py                        ✅ mövcud
│  └─ cli/*.jsonl                        ✅ mövcud
│
├─ packages/shared/
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/
│     ├─ index.ts                        re-export
│     ├─ events.ts                        RunEvent Zod sxemi + tiplər
│     ├─ errors.ts                        ErrorClass, OrchestrisError
│     ├─ runner.ts                        Runner interfeysi, RunRequest, RunOptions
│     └─ api.ts                           REST/WS mesaj sxemləri
│
├─ apps/server/
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/
│     ├─ main.ts                          giriş nöqtəsi (bootstrap + listen)
│     ├─ app.ts                           Fastify instansiyası qurulması
│     ├─ paths.ts                         ~/.orchestris yolları
│     ├─ db/
│     │  ├─ schema.ts                     Drizzle cədvəllər
│     │  ├─ client.ts                     better-sqlite3 + drizzle + migrate
│     │  └─ repo.ts                       query funksiyaları (tasks, runs, events)
│     ├─ runners/
│     │  ├─ resolve-exe.ts                PATH + .cmd shim resolver
│     │  ├─ fixtures-path.ts              repo kökü (cwd-dən asılı DEYİL)
│     │  ├─ spawn.ts                      spawn + sətir oxuma + tree-kill
│     │  ├─ parse-claude.ts               claude stream-json → RunEvent
│     │  ├─ parse-codex.ts                codex JSONL → RunEvent
│     │  ├─ claude.ts                     ClaudeCliRunner
│     │  ├─ codex.ts                      CodexCliRunner
│     │  └─ fake.ts                       FakeRunner (fixture təkrar oynadır)
│     ├─ exec/
│     │  ├─ budget.ts                     BudgetGuard
│     │  └─ supervisor.ts                 RunSupervisor
│     ├─ routes/
│     │  ├─ contexts.ts
│     │  └─ tasks.ts
│     └─ ws/
│        └─ hub.ts                        abunəlik + yayım
│
└─ apps/web/
   ├─ package.json
   ├─ tsconfig.json
   ├─ vite.config.ts
   ├─ index.html
   └─ src/
      ├─ main.tsx
      ├─ App.tsx                          router + layout
      ├─ index.css                        Tailwind
      ├─ lib/
      │  ├─ api.ts                        REST client
      │  └─ useRunStream.ts               WebSocket hook
      ├─ components/
      │  ├─ Sidebar.tsx
      │  ├─ EventTimeline.tsx
      │  └─ UsageBadge.tsx
      └─ pages/
         ├─ Dashboard.tsx
         ├─ Contexts.tsx
         ├─ TaskView.tsx
         └─ Providers.tsx
```

---

## Task 1: Monorepo skeleti

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`

- [ ] **Step 1: Workspace manifesti yarat**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json`:

```json
{
  "name": "orchestris",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --parallel --filter ./apps/... dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Paylaşılan TypeScript konfiqurasiyası**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`noUncheckedIndexedAccess` vacibdir: JSONL parser-lərində array indeksləməsi çoxdur, bu ayar `undefined` yoxlamasını məcbur edir.

- [ ] **Step 3: Vitest workspace**

`vitest.workspace.ts`:

```ts
export default ['packages/*', 'apps/server']
```

`apps/web` daxil deyil — UI testləri bu planda yoxdur (Faza 1B).

- [ ] **Step 4: .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.env
.env.local
coverage/
```

- [ ] **Step 5: Quraşdır və yoxla**

Run: `pnpm install`
Expected: `Done in ...` — xəta yoxdur.

Run: `pnpm test`
Expected: `No test files found` (hələ test yoxdur) — bu normaldır, exit kodu 1 ola bilər.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore
git commit -m "chore: pnpm monorepo skeleti"
```

---

## Task 2: `packages/shared` — RunEvent sxemi

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/events.ts`
- Test: `packages/shared/src/events.test.ts`

- [ ] **Step 1: Paket manifesti**

`packages/shared/package.json`:

```json
{
  "name": "@orchestris/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Uğursuz testi yaz**

`packages/shared/src/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RunEventSchema } from './events.js'

describe('RunEventSchema', () => {
  it('mətn deltasını qəbul edir', () => {
    const parsed = RunEventSchema.parse({ t: 'text', delta: 'SALAM' })
    expect(parsed).toEqual({ t: 'text', delta: 'SALAM' })
  })

  it('usage hadisəsini bütün keş sahələri ilə qəbul edir', () => {
    const parsed = RunEventSchema.parse({
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
    })
    expect(parsed.t).toBe('usage')
  })

  it('usage hadisəsində keş sahələri opsionaldır', () => {
    const parsed = RunEventSchema.parse({
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0,
    })
    expect(parsed).toMatchObject({ t: 'usage', inputTokens: 1 })
  })

  it('rate_limit hadisəsini qəbul edir', () => {
    const parsed = RunEventSchema.parse({
      t: 'rate_limit',
      status: 'allowed',
      limitType: 'five_hour',
      resetsAt: 1785097800,
    })
    expect(parsed.t).toBe('rate_limit')
  })

  it('tanınmayan `t` dəyərini rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'nonsense' })).toThrow()
  })

  it('mətn deltasında `delta` sahəsi olmadan rədd edir', () => {
    expect(() => RunEventSchema.parse({ t: 'text' })).toThrow()
  })
})
```

- [ ] **Step 3: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run packages/shared/src/events.test.ts`
Expected: FAIL — `Failed to resolve import "./events.js"`

- [ ] **Step 4: Sxemi yaz**

`packages/shared/src/events.ts`:

```ts
import { z } from 'zod'

/**
 * Vahid hadisə axını. Hər Runner (CLI və ya API) çıxışını bu formata
 * çevirir. Router, ledger, WebSocket və UI YALNIZ bunu görür — CLI-a və
 * ya provayderə xas heç bir sahə buradan kənara çıxmır.
 */
export const RunEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), delta: z.string() }),
  z.object({ t: z.literal('think'), delta: z.string() }),
  z.object({
    t: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    t: z.literal('result'),
    id: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
  }),
  z.object({
    t: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative(),
  }),
  /**
   * CLI-dan pulsuz gələn rate-limit siqnalı. Kor-koranə backoff yerinə
   * `resetsAt`-a görə gözləmək üçün istifadə olunur.
   */
  z.object({
    t: z.literal('rate_limit'),
    status: z.string(),
    limitType: z.string(),
    resetsAt: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('done'),
    sessionId: z.string().optional(),
    stopReason: z.string(),
  }),
  z.object({
    t: z.literal('error'),
    class: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
])

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventKind = RunEvent['t']
```

- [ ] **Step 5: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run packages/shared/src/events.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): RunEvent sxemi — vahid hadisə axını"
```

---

## Task 3: `packages/shared` — xəta sinifləri

**Files:**
- Create: `packages/shared/src/errors.ts`
- Test: `packages/shared/src/errors.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`packages/shared/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyErrorText, ERROR_CLASSES, isRetryable } from './errors.js'

describe('classifyErrorText', () => {
  it('401 mesajını auth kimi tanıyır', () => {
    expect(
      classifyErrorText('unexpected status 401 Unauthorized: Missing bearer'),
    ).toBe('auth')
  })

  it('"Not logged in" mesajını auth kimi tanıyır', () => {
    expect(classifyErrorText('Not logged in')).toBe('auth')
  })

  it('429 mesajını rate_limit kimi tanıyır', () => {
    expect(classifyErrorText('HTTP 429 Too Many Requests')).toBe('rate_limit')
  })

  it('overloaded mesajını overloaded kimi tanıyır', () => {
    expect(classifyErrorText('Error: model is overloaded_error')).toBe(
      'overloaded',
    )
  })

  it('tanınmayan mesajı crashed kimi qaytarır', () => {
    expect(classifyErrorText('something weird happened')).toBe('crashed')
  })
})

describe('isRetryable', () => {
  it('auth təkrar edilə bilməz — insan müdaxiləsi lazımdır', () => {
    expect(isRetryable('auth')).toBe(false)
  })

  it('budget_exceeded təkrar edilə bilməz — sərt kəsimdir', () => {
    expect(isRetryable('budget_exceeded')).toBe(false)
  })

  it('rate_limit təkrar edilə bilər', () => {
    expect(isRetryable('rate_limit')).toBe(true)
  })

  it('overloaded təkrar edilə bilər', () => {
    expect(isRetryable('overloaded')).toBe(true)
  })
})

describe('ERROR_CLASSES', () => {
  it('spesifikasiyadaki 8 sinfi ehtiva edir', () => {
    expect([...ERROR_CLASSES].sort()).toEqual([
      'auth',
      'budget_exceeded',
      'crashed',
      'overloaded',
      'parse_error',
      'rate_limit',
      'timeout',
      'tool_denied',
    ])
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run packages/shared/src/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors.js"`

- [ ] **Step 3: Xəta modulunu yaz**

`packages/shared/src/errors.ts`:

```ts
export const ERROR_CLASSES = [
  'auth',
  'rate_limit',
  'overloaded',
  'budget_exceeded',
  'timeout',
  'tool_denied',
  'crashed',
  'parse_error',
] as const

export type ErrorClass = (typeof ERROR_CLASSES)[number]

/**
 * Təkrar edilə BİLMƏYƏN siniflər. `auth` insan müdaxiləsi tələb edir;
 * `budget_exceeded` sərt kəsimdir və təkrar cəhd onun mənasını pozardı;
 * `tool_denied` istifadəçi qərarıdır; `parse_error` deterministdir.
 */
const NON_RETRYABLE = new Set<ErrorClass>([
  'auth',
  'budget_exceeded',
  'tool_denied',
  'parse_error',
])

export function isRetryable(cls: ErrorClass): boolean {
  return !NON_RETRYABLE.has(cls)
}

/**
 * Xam CLI xəta mətnini sinfə çevirir. Sıra vacibdir — daha xüsusi
 * naxışlar əvvəl yoxlanılır.
 */
export function classifyErrorText(text: string): ErrorClass {
  const s = text.toLowerCase()
  if (s.includes('401') || s.includes('unauthorized')) return 'auth'
  if (s.includes('not logged in') || s.includes('please run') && s.includes('login')) {
    return 'auth'
  }
  if (s.includes('403') || s.includes('forbidden')) return 'auth'
  if (s.includes('429') || s.includes('rate limit') || s.includes('rate_limit')) {
    return 'rate_limit'
  }
  if (s.includes('overloaded') || s.includes('529')) return 'overloaded'
  if (s.includes('timed out') || s.includes('timeout')) return 'timeout'
  if (s.includes('permission denied') || s.includes('tool denied')) {
    return 'tool_denied'
  }
  return 'crashed'
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run packages/shared/src/errors.test.ts`
Expected: PASS — 10 test.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/errors.ts packages/shared/src/errors.test.ts
git commit -m "feat(shared): xəta sinifləri və təsnifat"
```

---

## Task 4: `packages/shared` — Runner interfeysi və barrel export

**Files:**
- Create: `packages/shared/src/runner.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/runner.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`packages/shared/src/runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS, canHandle } from './runner.js'
import type { Capabilities } from './runner.js'

const cliCaps: Capabilities = {
  fileAccess: true,
  toolUse: true,
  sessions: true,
  structuredOutput: true,
  subscriptionBilled: true,
}

const apiCaps: Capabilities = {
  fileAccess: false,
  toolUse: true,
  sessions: false,
  structuredOutput: true,
  subscriptionBilled: false,
}

describe('canHandle', () => {
  it('fayl girişi tələb edən task API runner-ə uyğun gəlmir', () => {
    expect(canHandle(apiCaps, { needsFileAccess: true })).toBe(false)
  })

  it('fayl girişi tələb edən task CLI runner-ə uyğun gəlir', () => {
    expect(canHandle(cliCaps, { needsFileAccess: true })).toBe(true)
  })

  it('heç bir tələb yoxdursa hər ikisi uyğun gəlir', () => {
    expect(canHandle(apiCaps, {})).toBe(true)
    expect(canHandle(cliCaps, {})).toBe(true)
  })

  it('struktur çıxış tələbini yoxlayır', () => {
    const noSchema: Capabilities = { ...apiCaps, structuredOutput: false }
    expect(canHandle(noSchema, { needsStructuredOutput: true })).toBe(false)
  })

  it('sessiya davamı tələbini yoxlayır', () => {
    expect(canHandle(apiCaps, { needsSessions: true })).toBe(false)
    expect(canHandle(cliCaps, { needsSessions: true })).toBe(true)
  })
})

describe('CAPABILITY_KEYS', () => {
  it('Capabilities tipinin bütün açarlarını sadalayır', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual([
      'fileAccess',
      'sessions',
      'structuredOutput',
      'subscriptionBilled',
      'toolUse',
    ])
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run packages/shared/src/runner.test.ts`
Expected: FAIL — `Failed to resolve import "./runner.js"`

- [ ] **Step 3: Runner interfeysini yaz**

`packages/shared/src/runner.ts`:

```ts
import type { RunEvent } from './events.js'

export const CAPABILITY_KEYS = [
  'fileAccess',
  'toolUse',
  'sessions',
  'structuredOutput',
  'subscriptionBilled',
] as const

export interface Capabilities {
  /** Fayl sistemi oxuya/yaza bilir (CLI = true, API = false) */
  fileAccess: boolean
  toolUse: boolean
  /** Sessiya davam etdirilə bilir (`--resume`) */
  sessions: boolean
  structuredOutput: boolean
  /** Abunəlikdən ödənilir → real pul çıxmır, xərc istinad qiymətidir */
  subscriptionBilled: boolean
}

/** Task-ın runner-dən tələbləri. Təyin olunmayan sahə "əhəmiyyətsiz" deməkdir. */
export interface TaskRequirements {
  needsFileAccess?: boolean
  needsToolUse?: boolean
  needsSessions?: boolean
  needsStructuredOutput?: boolean
}

export function canHandle(
  caps: Capabilities,
  req: TaskRequirements,
): boolean {
  if (req.needsFileAccess && !caps.fileAccess) return false
  if (req.needsToolUse && !caps.toolUse) return false
  if (req.needsSessions && !caps.sessions) return false
  if (req.needsStructuredOutput && !caps.structuredOutput) return false
  return true
}

export interface DetectResult {
  installed: boolean
  authenticated: boolean
  version?: string
  execPath?: string
  /** İnsan üçün izah — `/providers` səhifəsində göstərilir */
  detail: string
}

export interface RunRequest {
  prompt: string
  model: string
  /** İş qovluğu — CLI runner-lər üçün məcburi */
  cwd?: string
  /** Mövcud sessiyanı davam etdir */
  resumeSessionId?: string
}

export interface RunOptions {
  /** Sərt limitlər. Aşıldıqda proses ağacı öldürülür. */
  maxOutputTokens?: number
  maxSeconds?: number
  maxCostUsd?: number
  signal?: AbortSignal
}

export interface Runner {
  readonly id: string
  readonly kind: 'cli' | 'api' | 'fake'
  readonly capabilities: Capabilities
  detect(): Promise<DetectResult>
  run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent>
}
```

- [ ] **Step 4: Barrel export**

`packages/shared/src/index.ts`:

```ts
export * from './errors.js'
export * from './events.js'
export * from './runner.js'
```

- [ ] **Step 5: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run packages/shared`
Expected: PASS — 3 fayl, 22 test.

Run: `pnpm --filter @orchestris/shared typecheck`
Expected: xəta yoxdur.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): Runner interfeysi və qabiliyyət uyğunluğu"
```

---

## Task 5: `apps/server` skeleti və icra faylı resolver-i

Windows-da `claude` PATH-da `.cmd`/`.ps1` shim kimi görünür, real `.exe` isə
`node_modules/@anthropic-ai/claude-code/bin/claude.exe`-dədir. `shell: true` ilə
spawn etmək işləyir, amma proses ağacı idarəsini çətinləşdirir və arqument
escape riski yaradır. Resolver shim-i oxuyub real `.exe`-ni tapır.

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/runners/resolve-exe.ts`
- Test: `apps/server/src/runners/resolve-exe.test.ts`

- [ ] **Step 1: Server paketini yarat**

`apps/server/package.json`:

```json
{
  "name": "@orchestris/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/main.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.0",
    "@orchestris/shared": "workspace:*",
    "better-sqlite3": "^11.8.0",
    "drizzle-orm": "^0.38.0",
    "fastify": "^5.2.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "drizzle-kit": "^0.30.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Uğursuz testi yaz**

`apps/server/src/runners/resolve-exe.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractExeFromCmdShim, resolveExecutable } from './resolve-exe.js'

describe('extractExeFromCmdShim', () => {
  it('npm .cmd shim-indən hədəf .exe yolunu çıxarır', () => {
    // Real npm shim məzmunu (claude.cmd faylından götürülüb)
    const shim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    ].join('\r\n')

    const got = extractExeFromCmdShim(shim, 'C:\\npm')
    expect(got).toBe(
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    )
  })

  it('.exe istinadı olmayan shim üçün null qaytarır', () => {
    expect(extractExeFromCmdShim('@ECHO off\r\nnode index.js %*', 'C:\\x')).toBeNull()
  })

  it('%~dp0 formasını da qəbul edir', () => {
    const shim = '"%~dp0\\bin\\tool.exe" %*'
    expect(extractExeFromCmdShim(shim, 'D:\\apps')).toBe('D:\\apps\\bin\\tool.exe')
  })
})

describe('resolveExecutable', () => {
  it('PATH-da .exe varsa onu birbaşa qaytarır, shell tələb etmir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-exe-'))
    const exe = join(dir, 'widget.exe')
    writeFileSync(exe, '')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({ command: exe, useShell: false, via: 'direct-exe' })
  })

  it('yalnız .cmd shim varsa onu oxuyub .exe-yə çevirir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-shim-'))
    mkdirSync(join(dir, 'bin'))
    const target = join(dir, 'bin', 'widget.exe')
    writeFileSync(target, '')
    writeFileSync(join(dir, 'widget.cmd'), '"%dp0%\\bin\\widget.exe" %*')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({ command: target, useShell: false, via: 'cmd-shim' })
  })

  it('heç nə tapılmasa null qaytarır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-empty-'))
    expect(resolveExecutable('nosuchtool', [dir])).toBeNull()
  })

  it('shim hədəfi mövcud deyilsə shell fallback-ə keçir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-broken-'))
    writeFileSync(join(dir, 'widget.cmd'), '"%dp0%\\bin\\gone.exe" %*')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({
      command: join(dir, 'widget.cmd'),
      useShell: true,
      via: 'shell-fallback',
    })
  })
})
```

- [ ] **Step 3: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/resolve-exe.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve-exe.js"`

- [ ] **Step 4: Resolver-i yaz**

`apps/server/src/runners/resolve-exe.ts`:

```ts
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export interface ResolvedExecutable {
  /** spawn()-a veriləcək əmr */
  command: string
  /** true olarsa spawn `shell: true` ilə çağırılmalıdır */
  useShell: boolean
  via: 'direct-exe' | 'cmd-shim' | 'shell-fallback' | 'posix'
}

/**
 * npm-in Windows `.cmd` shim-i hədəf `.exe`-nin yolunu `%dp0%`-a nisbətən
 * saxlayır. Onu oxuyub mütləq yola çeviririk — belə olsa `shell: true`
 * lazım gəlmir və proses ağacını `taskkill /T` ilə etibarlı öldürürük.
 */
export function extractExeFromCmdShim(
  content: string,
  shimDir: string,
): string | null {
  // `"%dp0%\path\to\tool.exe"` və ya `"%~dp0\path\to\tool.exe"`
  const m = content.match(/"%~?dp0%?\\?([^"]+\.exe)"/i)
  if (!m?.[1]) return null
  // Shim-dəki `\` ayırıcılarını olduğu kimi saxlayırıq — Windows onları qəbul edir.
  return join(shimDir, m[1])
}

function pathDirs(explicit?: readonly string[]): readonly string[] {
  if (explicit) return explicit
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

/**
 * Verilmiş adı icra edilə bilən fayla çevirir.
 *
 * Prioritet:
 *   1. PATH-da `<ad>.exe` — ən yaxşı hal, shell lazım deyil
 *   2. PATH-da `<ad>.cmd` — shim oxunur, hədəf `.exe` çıxarılır
 *   3. `.cmd` var, amma hədəf tapılmır — shell fallback (xəbərdarlıqla)
 *   4. POSIX: PATH-da uzantısız fayl
 */
export function resolveExecutable(
  name: string,
  explicitDirs?: readonly string[],
): ResolvedExecutable | null {
  const dirs = pathDirs(explicitDirs)

  if (isAbsolute(name) && existsSync(name)) {
    return { command: name, useShell: false, via: 'direct-exe' }
  }

  for (const dir of dirs) {
    const exe = resolve(dir, `${name}.exe`)
    if (existsSync(exe)) {
      return { command: exe, useShell: false, via: 'direct-exe' }
    }
  }

  for (const dir of dirs) {
    const cmd = resolve(dir, `${name}.cmd`)
    if (!existsSync(cmd)) continue
    const target = extractExeFromCmdShim(readFileSync(cmd, 'utf8'), dir)
    if (target && existsSync(target)) {
      return { command: target, useShell: false, via: 'cmd-shim' }
    }
    return { command: cmd, useShell: true, via: 'shell-fallback' }
  }

  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      const p = resolve(dir, name)
      if (existsSync(p)) {
        return { command: p, useShell: false, via: 'posix' }
      }
    }
  }

  return null
}
```

- [ ] **Step 5: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm install && pnpm vitest run apps/server/src/runners/resolve-exe.test.ts`
Expected: PASS — 7 test.

- [ ] **Step 6: Real maşında yoxla (manual sanity check)**

Bu skripti müvəqqəti fayla yaz və qaçır:

```bash
node --experimental-strip-types -e "
import { resolveExecutable } from './apps/server/src/runners/resolve-exe.ts'
console.log('claude:', resolveExecutable('claude'))
console.log('codex :', resolveExecutable('codex'))
"
```

Expected: `claude` üçün `via: 'cmd-shim'` və `...claude-code/bin/claude.exe` yolu;
`codex` üçün `via: 'direct-exe'` və `...Codex/bin/codex.exe` yolu.

Nəticə fərqlidirsə, `resolveExecutable`-i düzəlt — testlər sintetik qovluqlarla
işləyir, bu addım real maşını yoxlayır.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): Windows shim-dən real .exe tapan resolver"
```

---

## Task 6: Proses spawn və tree-kill

Ən vacib təhlükəsizlik detalı: shim və ya valideyn prosesi öldürmək **uşaq
prosesi öldürmür**. Öldürülməmiş `claude.exe` işləməyə davam edir və **token
yandırır**. Windows-da `taskkill /T /F` bütün ağacı öldürür.

**Files:**
- Create: `apps/server/src/runners/spawn.ts`
- Test: `apps/server/src/runners/spawn.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/spawn.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { spawnLines } from './spawn.js'

const NODE = process.execPath

describe('spawnLines', () => {
  it('stdout sətirlərini bir-bir verir', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'console.log("bir");console.log("iki");console.log("uc")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['bir', 'iki', 'uc'])
    expect(await proc.exitCode).toBe(0)
  })

  it('CRLF sətir sonlarını düzgün ayırır', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'process.stdout.write("a\\r\\nb\\r\\n")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['a', 'b'])
  })

  it('stderr-i ayrıca toplayır və stdout ilə qarışdırmır', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'console.error("xeta");console.log("normal")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['normal'])
    expect(proc.stderrText()).toContain('xeta')
  })

  it('stdin bağlıdır — stdin oxuyan proses donmur', async () => {
    // codex exec stdin gözləyir. stdin: 'ignore' olmasa bu test timeout verər.
    const proc = spawnLines({
      command: NODE,
      args: [
        '-e',
        'process.stdin.on("end",()=>{console.log("stdin bitdi")});process.stdin.resume()',
      ],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['stdin bitdi'])
  }, 10_000)

  it('kill() prosesi dayandırır və axın bitir', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'setInterval(()=>console.log("tik"),50)'],
      useShell: false,
    })
    const got: string[] = []
    const reader = (async () => {
      for await (const line of proc.lines) {
        got.push(line)
        if (got.length === 2) await proc.kill()
      }
    })()
    await reader
    expect(got.length).toBeGreaterThanOrEqual(2)
    expect(proc.killed).toBe(true)
  }, 15_000)

  it('mövcud olmayan əmr üçün spawnError verir', async () => {
    const proc = spawnLines({
      command: 'orchestris-nosuchbinary-xyz',
      args: [],
      useShell: false,
    })
    for await (const _ of proc.lines) { /* boş */ }
    expect(await proc.exitCode).not.toBe(0)
    expect(proc.spawnError()?.message).toBeTruthy()
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/spawn.test.ts`
Expected: FAIL — `Failed to resolve import "./spawn.js"`

- [ ] **Step 3: Spawn helper-ini yaz**

`apps/server/src/runners/spawn.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface SpawnLinesInput {
  command: string
  args: readonly string[]
  useShell: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SpawnedLines {
  readonly pid: number | undefined
  /** stdout sətirləri (CRLF və LF hər ikisi düzgün ayrılır) */
  readonly lines: AsyncIterable<string>
  readonly exitCode: Promise<number | null>
  readonly killed: boolean
  stderrText(): string
  spawnError(): Error | null
  /** Bütün proses AĞACINI öldürür. Windows-da `taskkill /T /F`. */
  kill(): Promise<void>
}

/**
 * CLI prosesini spawn edir və stdout-u sətir-sətir verir.
 *
 * Kritik seçimlər:
 *  - `stdin: 'ignore'` — `codex exec` stdin gözləyir və açıq stdin ilə əbədi
 *    donur ("Reading additional input from stdin...").
 *  - stderr AYRICA toplanır — `codex` log sətirlərini stdout-a qarışdırmasın.
 *  - `detached` yalnız POSIX-də — proses qrupu ilə öldürmək üçün.
 */
export function spawnLines(input: SpawnLinesInput): SpawnedLines {
  const isWin = process.platform === 'win32'

  const child: ChildProcess = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    shell: input.useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  })

  let stderr = ''
  let spawnErr: Error | null = null
  let wasKilled = false

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.on('error', (err) => {
    spawnErr = err
  })

  const exitCode = new Promise<number | null>((res) => {
    child.on('close', (code) => res(code))
    child.on('error', () => res(-1))
  })

  async function kill(): Promise<void> {
    if (wasKilled || child.exitCode !== null) return
    wasKilled = true
    const pid = child.pid
    if (pid === undefined) return

    if (isWin) {
      // Shim-i öldürmək uşaq .exe-ni öldürmür. /T bütün ağacı alır.
      await new Promise<void>((res) => {
        const tk = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
        tk.on('close', () => res())
        tk.on('error', () => res())
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch { /* proses artıq ölüb */ }
      }
    }
    await exitCode
  }

  async function* readLines(): AsyncGenerator<string> {
    if (!child.stdout) return
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    try {
      for await (const line of rl) yield line
    } finally {
      rl.close()
    }
    await exitCode
  }

  return {
    get pid() { return child.pid },
    lines: readLines(),
    exitCode,
    get killed() { return wasKilled },
    stderrText: () => stderr,
    spawnError: () => spawnErr,
    kill,
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/spawn.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 5: Yetim proses qalmadığını təsdiqlə (Windows)**

Testlərdən sonra qaçır:

```bash
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"
```

Expected: yalnız gözlənilən proseslər (testdən qalan `setInterval` prosesi
**olmamalıdır**). Əgər artıq proses varsa `kill()` düzgün işləmir — düzəlt.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runners/spawn.ts apps/server/src/runners/spawn.test.ts
git commit -m "feat(server): proses spawn + Windows tree-kill

stdin bağlıdır (codex donmasının qarşısı), stderr ayrıca toplanır,
kill() taskkill /T /F ilə bütün ağacı öldürür — yetim proses token yandırmasın."
```

---

## Task 7: Claude `stream-json` parser-i

Parser **saf funksiyadır**: sətir alır, `RunEvent[]` qaytarır. Proses idarəsindən
tam ayrıdır → fixture ilə determinist test olunur, sıfır token.

**Fixture-dən öyrənilmiş 5 qayda** (koda salınmalıdır):

1. `assistant` hadisələri **kumulyativ** `usage` daşıyır. Onları toplamaq ikiqat
   sayma verər. `usage` YALNIZ `result` sətrindən emit olunur.
2. `result` sətri `type: "result"` ilə tanınır — sətrin `{"is_error"` ilə
   başlaması təsadüfi JSON açar sırasıdır, ona güvənmək olmaz.
3. `content` massivində `thinking`, `text`, `tool_use` blokları olur. `thinking`
   bloku `signature` sahəsi də daşıyır — o, UI-a getməməlidir.
4. `system/thinking_tokens`, `system/hook_started`, `system/hook_response`
   hadisələri atılır — onlar model çıxışı deyil, telemetriyadır.
5. `rate_limit_event` → `rate_limit` hadisəsi. `resetsAt` unix saniyədir.

**Files:**
- Create: `apps/server/src/runners/fixtures-path.ts`
- Create: `apps/server/src/runners/parse-claude.ts`
- Test: `apps/server/src/runners/parse-claude.test.ts`

- [ ] **Step 0: Fixture yolu helper-ini yaz**

`vitest.workspace.ts` `apps/server`-i AYRI proyekt kimi qaçırır, ona görə
`process.cwd()` repo kökü DEYİL — `apps/server` olur. `process.cwd()` ilə
fixture axtarmaq sınar. Bu helper repo kökünü modul yolundan tapır.

`apps/server/src/runners/fixtures-path.ts`:

```ts
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repo kökünü tapır — `pnpm-workspace.yaml` faylının olduğu qovluq.
 *
 * `process.cwd()` işlətmək OLMAZ: vitest `apps/server`-i ayrı proyekt kimi
 * qaçırır və cwd repo kökü olmur.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Repo kökü tapılmadı (pnpm-workspace.yaml axtarıldı)')
}

export function fixturesDir(): string {
  return join(repoRoot(), 'fixtures', 'cli')
}

export function fixturePath(name: string): string {
  return join(fixturesDir(), name)
}
```

Test `apps/server/src/runners/fixtures-path.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath, repoRoot } from './fixtures-path.js'

describe('repoRoot', () => {
  it('pnpm-workspace.yaml olan qovluğu tapır', () => {
    expect(existsSync(`${repoRoot()}/pnpm-workspace.yaml`)).toBe(true)
  })

  it('cwd-dən asılı deyil', () => {
    const before = repoRoot()
    const old = process.cwd()
    try {
      process.chdir('apps/server')
      expect(repoRoot()).toBe(before)
    } finally {
      process.chdir(old)
    }
  })
})

describe('fixturePath', () => {
  it('mövcud fixture faylına işarə edir', () => {
    expect(existsSync(fixturePath('claude-safe-mode.jsonl'))).toBe(true)
  })
})
```

Run: `pnpm vitest run apps/server/src/runners/fixtures-path.test.ts`
Expected: PASS — 3 test.

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/parse-claude.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import { RunEventSchema } from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { ClaudeStreamParser } from './parse-claude.js'

function parseFixture(name: string): { events: RunEvent[]; parser: ClaudeStreamParser } {
  const parser = new ClaudeStreamParser()
  const events: RunEvent[] = []
  const text = readFileSync(fixturePath(name), 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    events.push(...parser.push(line))
  }
  return { events, parser }
}

describe('ClaudeStreamParser — safe-mode fixture', () => {
  it('hər emit olunan hadisə RunEvent sxemini keçir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    for (const e of events) {
      expect(() => RunEventSchema.parse(e)).not.toThrow()
    }
  })

  it('mətn blokunu text hadisəsi kimi verir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const texts = events.filter((e) => e.t === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toEqual({ t: 'text', delta: 'SALAM' })
  })

  it('thinking blokunu think hadisəsi kimi verir, signature-ı sızdırmır', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const thinks = events.filter((e) => e.t === 'think')
    expect(thinks).toHaveLength(1)
    expect(JSON.stringify(thinks[0])).not.toContain('signature')
  })

  it('usage hadisəsini YALNIZ bir dəfə verir — kumulyativ toplama yoxdur', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const usages = events.filter((e) => e.t === 'usage')
    expect(usages).toHaveLength(1)
    expect(usages[0]).toEqual({
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.008450099999999999,
    })
  })

  it('rate_limit hadisəsini çıxarır', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const rl = events.filter((e) => e.t === 'rate_limit')
    expect(rl).toHaveLength(1)
    expect(rl[0]).toEqual({
      t: 'rate_limit',
      status: 'allowed',
      limitType: 'five_hour',
      resetsAt: 1785097800,
    })
  })

  it('done hadisəsini sessionId və stopReason ilə verir', () => {
    const { events } = parseFixture('claude-safe-mode.jsonl')
    const done = events.filter((e) => e.t === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toEqual({
      t: 'done',
      sessionId: '00000000-0000-4000-8000-000000000001',
      stopReason: 'end_turn',
    })
  })

  it('sessionId-i init hadisəsindən dərhal tutur', () => {
    const parser = new ClaudeStreamParser()
    parser.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
        model: 'claude-haiku-4-5-20251001',
      }),
    )
    expect(parser.sessionId).toBe('abc-123')
  })

  it('telemetriya hadisələrini atır', () => {
    const parser = new ClaudeStreamParser()
    const noise = [
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
      { type: 'system', subtype: 'hook_started', hook_name: 'x' },
      { type: 'system', subtype: 'hook_response', hook_name: 'x' },
    ]
    for (const n of noise) {
      expect(parser.push(JSON.stringify(n))).toEqual([])
    }
  })
})

describe('ClaudeStreamParser — tool istifadəsi', () => {
  it('tool_use blokunu tool hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    )
    expect(events).toEqual([
      { t: 'tool', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
    ])
  })

  it('user tool_result blokunu result hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' },
          ],
        },
      }),
    )
    expect(events).toEqual([{ t: 'result', id: 'toolu_1', ok: true, output: 'ok' }])
  })

  it('xətalı tool_result-u ok:false kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'ENOENT' },
          ],
        },
      }),
    )
    expect(events).toEqual([
      { t: 'result', id: 'toolu_2', ok: false, output: 'ENOENT' },
    ])
  })
})

describe('ClaudeStreamParser — xəta halları', () => {
  it('is_error:true olan result-u error hadisəsi kimi verir', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: 'stop_sequence',
        session_id: 's1',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        result: 'Invalid API key',
      }),
    )
    const err = events.find((e) => e.t === 'error')
    expect(err).toEqual({
      t: 'error',
      class: 'auth',
      message: 'Invalid API key',
      retryable: false,
    })
  })

  it('pozuq JSON sətrini parse_error kimi verir, çökmür', () => {
    const parser = new ClaudeStreamParser()
    const events = parser.push('{ bu json deyil')
    expect(events).toEqual([
      {
        t: 'error',
        class: 'parse_error',
        message: 'JSON parse alınmadı: { bu json deyil',
        retryable: false,
      },
    ])
  })

  it('boş sətri sakitcə atır', () => {
    const parser = new ClaudeStreamParser()
    expect(parser.push('   ')).toEqual([])
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/parse-claude.test.ts`
Expected: FAIL — `Failed to resolve import "./parse-claude.js"`

- [ ] **Step 3: Parser-i yaz**

`apps/server/src/runners/parse-claude.ts`:

```ts
import { classifyErrorText, isRetryable, type RunEvent } from '@orchestris/shared'

/** Atılan `system` subtype-ları — bunlar model çıxışı deyil, telemetriyadır. */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'hook_started',
  'hook_response',
])

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

function blockText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'string'
          ? v
          : typeof (v as { text?: unknown })?.text === 'string'
            ? (v as { text: string }).text
            : '',
      )
      .join('')
  }
  return ''
}

/**
 * `claude -p --output-format stream-json --verbose` çıxışını `RunEvent`
 * axınına çevirir.
 *
 * Vəziyyət saxlayır: `sessionId` (init-dən) və `sawResult` (ikiqat `usage`
 * emissiyasının qarşısını almaq üçün).
 */
export class ClaudeStreamParser {
  sessionId: string | undefined
  model: string | undefined
  private sawResult = false

  push(rawLine: string): RunEvent[] {
    const line = rawLine.trim()
    if (!line) return []

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return [
        {
          t: 'error',
          class: 'parse_error',
          message: `JSON parse alınmadı: ${line.slice(0, 200)}`,
          retryable: false,
        },
      ]
    }

    const type = typeof obj['type'] === 'string' ? (obj['type'] as string) : ''

    if (type === 'system') return this.onSystem(obj)
    if (type === 'assistant') return this.onAssistant(obj)
    if (type === 'user') return this.onUser(obj)
    if (type === 'rate_limit_event') return this.onRateLimit(obj)
    if (type === 'result') return this.onResult(obj)

    // Tanınmayan hadisə tipi — səssizcə atılır. CLI yeni tiplər əlavə edə
    // bilər; bu, parser-i sındırmamalıdır.
    return []
  }

  private onSystem(obj: Record<string, unknown>): RunEvent[] {
    const subtype = String(obj['subtype'] ?? '')
    if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return []
    if (subtype === 'init') {
      if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']
      if (typeof obj['model'] === 'string') this.model = obj['model']
    }
    return []
  }

  private onAssistant(obj: Record<string, unknown>): RunEvent[] {
    const message = obj['message'] as { content?: ContentBlock[] } | undefined
    const blocks = message?.content ?? []
    const out: RunEvent[] = []

    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ t: 'text', delta: b.text })
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        // `signature` qəsdən buraxılır — UI-a və DB-yə getməməlidir.
        out.push({ t: 'think', delta: b.thinking })
      } else if (b.type === 'tool_use') {
        out.push({
          t: 'tool',
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          input: b.input,
        })
      }
    }

    // DİQQƏT: `message.usage` kumulyativdir. Burada emit ETMİRİK — yoxsa hər
    // assistant hadisəsi eyni tokenləri yenidən sayardı. `usage` yalnız
    // `result` sətrindən gəlir.
    return out
  }

  private onUser(obj: Record<string, unknown>): RunEvent[] {
    const message = obj['message'] as { content?: ContentBlock[] } | undefined
    const out: RunEvent[] = []
    for (const b of message?.content ?? []) {
      if (b.type !== 'tool_result') continue
      out.push({
        t: 'result',
        id: String(b.tool_use_id ?? ''),
        ok: b.is_error !== true,
        output: blockText(b.content),
      })
    }
    return out
  }

  private onRateLimit(obj: Record<string, unknown>): RunEvent[] {
    const info = obj['rate_limit_info'] as Record<string, unknown> | undefined
    if (!info) return []
    const event: RunEvent = {
      t: 'rate_limit',
      status: String(info['status'] ?? 'unknown'),
      limitType: String(info['rateLimitType'] ?? 'unknown'),
      ...(typeof info['resetsAt'] === 'number'
        ? { resetsAt: info['resetsAt'] }
        : {}),
    }
    return [event]
  }

  private onResult(obj: Record<string, unknown>): RunEvent[] {
    if (this.sawResult) return []
    this.sawResult = true

    const out: RunEvent[] = []
    const usage = (obj['usage'] ?? {}) as Record<string, unknown>
    const num = (k: string): number =>
      typeof usage[k] === 'number' ? (usage[k] as number) : 0
    const cacheRead = num('cache_read_input_tokens')
    const cacheWrite = num('cache_creation_input_tokens')

    out.push({
      t: 'usage',
      inputTokens: num('input_tokens'),
      outputTokens: num('output_tokens'),
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      costUsd:
        typeof obj['total_cost_usd'] === 'number'
          ? (obj['total_cost_usd'] as number)
          : 0,
    })

    if (typeof obj['session_id'] === 'string') this.sessionId = obj['session_id']

    if (obj['is_error'] === true) {
      const text =
        typeof obj['result'] === 'string' && obj['result']
          ? (obj['result'] as string)
          : String(obj['subtype'] ?? 'bilinməyən xəta')
      const cls = classifyErrorText(text)
      out.push({
        t: 'error',
        class: cls,
        message: text,
        retryable: isRetryable(cls),
      })
      return out
    }

    out.push({
      t: 'done',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      stopReason: String(obj['stop_reason'] ?? 'unknown'),
    })
    return out
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/parse-claude.test.ts`
Expected: PASS — 14 test.

- [ ] **Step 5: İkinci fixture ilə də yoxla**

`apps/server/src/runners/parse-claude.test.ts` faylının sonuna əlavə et:

```ts
describe('ClaudeStreamParser — tam fərdiləşdirmə fixture-i', () => {
  it('hook səs-küyü ilə dolu axını da düzgün parse edir', () => {
    const { events } = parseFixture('claude-full-customizations.jsonl')
    // 4 hook_started + 4 hook_response + 34 thinking_tokens = 42 sətir atılır
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'error')).toHaveLength(0)
  })

  it('tam rejimin daha bahalı olduğunu ölçür — safe-mode-un dəyərini sübut edir', () => {
    const full = parseFixture('claude-full-customizations.jsonl')
    const safe = parseFixture('claude-safe-mode.jsonl')
    const cost = (r: ReturnType<typeof parseFixture>): number => {
      const u = r.events.find((e) => e.t === 'usage')
      return u?.t === 'usage' ? u.costUsd : 0
    }
    expect(cost(full)).toBeGreaterThan(cost(safe) * 2)
  })
})
```

Run: `pnpm vitest run apps/server/src/runners/parse-claude.test.ts`
Expected: PASS — 16 test.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runners/parse-claude.ts apps/server/src/runners/parse-claude.test.ts
git commit -m "feat(server): claude stream-json parser

Kumulyativ usage tələsi həll olunub: usage yalnız result sətrindən emit
olunur, assistant hadisələrindən yox. thinking signature-ı UI-a sızmır."
```

---

## Task 8: Codex JSONL parser-i

Codex-in iki fərqi var: stderr log sətirlərini axına qarışdırır (JSON deyil,
atılmalıdır), və hadisə adları nöqtəli (`thread.started`, `turn.failed`).

**Bu maşında codex login olunmayıb** → əlimizdə yalnız xəta fixture-i var.
Uğur yolunun parse edilməsi Task 15-də, login-dən sonra tamamlanır. Bu task
xəta yolunu və JSON-olmayan sətir dözümlülüyünü tam örtür.

**Files:**
- Create: `apps/server/src/runners/parse-codex.ts`
- Test: `apps/server/src/runners/parse-codex.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/parse-codex.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RunEventSchema, type RunEvent } from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { CodexStreamParser } from './parse-codex.js'

function parseFixture(name: string): { events: RunEvent[]; parser: CodexStreamParser } {
  const parser = new CodexStreamParser()
  const events: RunEvent[] = []
  for (const line of readFileSync(fixturePath(name), 'utf8').split('\n')) {
    if (!line.trim()) continue
    events.push(...parser.push(line))
  }
  return { events, parser }
}

describe('CodexStreamParser — auth xətası fixture-i', () => {
  it('hər emit olunan hadisə RunEvent sxemini keçir', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    for (const e of events) expect(() => RunEventSchema.parse(e)).not.toThrow()
  })

  it('JSON olmayan stderr sətirlərini atır, parse_error yaratmır', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    // Fixture-də 8 JSON-olmayan sətir var (stdin qeydi + Rust ERROR logları)
    expect(events.filter((e) => e.t === 'error' && e.class === 'parse_error')).toHaveLength(0)
  })

  it('thread.started-dan sessionId tutur', () => {
    const { parser } = parseFixture('codex-auth-error.jsonl')
    expect(parser.sessionId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('401 mesajını auth xətası kimi təsnif edir və retryable:false qoyur', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    const authErrors = events.filter((e) => e.t === 'error' && e.class === 'auth')
    expect(authErrors.length).toBeGreaterThan(0)
    for (const e of authErrors) {
      if (e.t === 'error') expect(e.retryable).toBe(false)
    }
  })

  it('turn.failed hadisəsindən sonra done vermir', () => {
    const { events } = parseFixture('codex-auth-error.jsonl')
    expect(events.filter((e) => e.t === 'done')).toHaveLength(0)
  })
})

describe('CodexStreamParser — hadisə tipləri', () => {
  it('agent_message item-ini text hadisəsi kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'SALAM' },
      }),
    )
    expect(events).toEqual([{ t: 'text', delta: 'SALAM' }])
  })

  it('reasoning item-ini think hadisəsi kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_2', type: 'reasoning', text: 'düşünürəm' },
      }),
    )
    expect(events).toEqual([{ t: 'think', delta: 'düşünürəm' }])
  })

  it('command_execution item-ini tool hadisəsi kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'command_execution',
          command: 'ls -la',
          exit_code: 0,
        },
      }),
    )
    expect(events).toEqual([
      { t: 'tool', id: 'item_3', name: 'command_execution', input: { command: 'ls -la' } },
      { t: 'result', id: 'item_3', ok: true, output: '' },
    ])
  })

  it('turn.completed hadisəsini usage + done kimi verir', () => {
    const parser = new CodexStreamParser()
    parser.push(JSON.stringify({ type: 'thread.started', thread_id: 'th_9' }))
    const events = parser.push(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30 },
      }),
    )
    expect(events).toEqual([
      {
        t: 'usage',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 100,
        costUsd: 0,
      },
      { t: 'done', sessionId: 'th_9', stopReason: 'end_turn' },
    ])
  })

  it('pozuq JSON obyekt sətrini parse_error kimi verir', () => {
    const parser = new CodexStreamParser()
    const events = parser.push('{"type": "broken"')
    expect(events).toEqual([
      {
        t: 'error',
        class: 'parse_error',
        message: 'JSON parse alınmadı: {"type": "broken"',
        retryable: false,
      },
    ])
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/parse-codex.test.ts`
Expected: FAIL — `Failed to resolve import "./parse-codex.js"`

- [ ] **Step 3: Parser-i yaz**

`apps/server/src/runners/parse-codex.ts`:

```ts
import { classifyErrorText, isRetryable, type RunEvent } from '@orchestris/shared'

interface CodexItem {
  id?: string
  type?: string
  text?: string
  message?: string
  command?: string
  exit_code?: number
  aggregated_output?: string
}

/**
 * `codex exec --json` çıxışını `RunEvent` axınına çevirir.
 *
 * Codex-ə xas iki davranış:
 *  1. stderr Rust logları stdout axınına qarışır və JSON DEYİL. Onlar
 *     səssizcə atılır — `parse_error` yaratmaq yanlış olardı.
 *  2. `codex exec` stdin bağlanmasa donur ("Reading additional input from
 *     stdin...") — bu sətir də JSON deyil və atılır.
 */
export class CodexStreamParser {
  sessionId: string | undefined
  private sawTerminal = false

  push(rawLine: string): RunEvent[] {
    const line = rawLine.trim()
    if (!line) return []

    // JSON olmayan sətirlər (Rust logları, stdin qeydi) — sakitcə atılır.
    if (!line.startsWith('{')) return []

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return [
        {
          t: 'error',
          class: 'parse_error',
          message: `JSON parse alınmadı: ${line.slice(0, 200)}`,
          retryable: false,
        },
      ]
    }

    switch (obj['type']) {
      case 'thread.started':
        if (typeof obj['thread_id'] === 'string') this.sessionId = obj['thread_id']
        return []
      case 'turn.started':
        return []
      case 'item.completed':
        return this.onItem(obj['item'] as CodexItem | undefined)
      case 'error':
        return this.errorEvent(String(obj['message'] ?? 'bilinməyən xəta'))
      case 'turn.failed': {
        this.sawTerminal = true
        const err = obj['error'] as { message?: string } | undefined
        return this.errorEvent(String(err?.message ?? 'turn uğursuz oldu'))
      }
      case 'turn.completed':
        return this.onTurnCompleted(obj)
      default:
        return []
    }
  }

  private errorEvent(message: string): RunEvent[] {
    const cls = classifyErrorText(message)
    return [{ t: 'error', class: cls, message, retryable: isRetryable(cls) }]
  }

  private onItem(item: CodexItem | undefined): RunEvent[] {
    if (!item) return []
    const id = String(item.id ?? '')

    switch (item.type) {
      case 'agent_message':
        return item.text ? [{ t: 'text', delta: item.text }] : []
      case 'reasoning':
        return item.text ? [{ t: 'think', delta: item.text }] : []
      case 'error':
        return this.errorEvent(String(item.message ?? 'bilinməyən xəta'))
      case 'command_execution':
        return [
          {
            t: 'tool',
            id,
            name: 'command_execution',
            input: { command: String(item.command ?? '') },
          },
          {
            t: 'result',
            id,
            ok: (item.exit_code ?? 0) === 0,
            output: item.aggregated_output ?? '',
          },
        ]
      default:
        return []
    }
  }

  private onTurnCompleted(obj: Record<string, unknown>): RunEvent[] {
    if (this.sawTerminal) return []
    this.sawTerminal = true

    const usage = (obj['usage'] ?? {}) as Record<string, unknown>
    const num = (k: string): number =>
      typeof usage[k] === 'number' ? (usage[k] as number) : 0
    const cached = num('cached_input_tokens')

    return [
      {
        t: 'usage',
        inputTokens: num('input_tokens'),
        outputTokens: num('output_tokens'),
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        // Codex xərc verməz — abunəlik/API açarı qiyməti sonradan
        // models.dev metadata ilə hesablanır (Faza 1B).
        costUsd: 0,
      },
      {
        t: 'done',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        stopReason: 'end_turn',
      },
    ]
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/parse-codex.test.ts`
Expected: PASS — 11 test.

- [ ] **Step 5: Bütün paylaşılan testləri qaçır**

Run: `pnpm test`
Expected: PASS — 5 fayl, 60+ test. Heç bir test şəbəkəyə çıxmır, heç bir token
xərclənmir.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runners/parse-codex.ts apps/server/src/runners/parse-codex.test.ts
git commit -m "feat(server): codex JSONL parser

stderr Rust logları JSON axınına qarışır — onlar atılır, parse_error
yaradılmır. thread_id sessionId kimi tutulur."
```

---

## Task 9: `FakeRunner` — layihənin ən vacib test infrastrukturu

`FakeRunner` real fixture-ləri təkrar oynadır. Onun sayəsində bütün pipeline
(supervisor, büdcə, DB, WebSocket, UI) **sıfır token** ilə test olunur. Bu
olmadan hər test qaçırışı pul yandırardı.

**Files:**
- Create: `apps/server/src/runners/fake.ts`
- Test: `apps/server/src/runners/fake.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/fake.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import { FakeRunner } from './fake.js'

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('FakeRunner', () => {
  it('fixture faylını RunEvent axınına çevirir', async () => {
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })
    const events = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(events.filter((e) => e.t === 'text')).toEqual([{ t: 'text', delta: 'SALAM' }])
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
  })

  it('codex fixture-ini codex parser-i ilə oynadır', async () => {
    const runner = new FakeRunner({ fixture: 'codex-auth-error.jsonl', flavor: 'codex' })
    const events = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(events.some((e) => e.t === 'error' && e.class === 'auth')).toBe(true)
  })

  it('detect() konfiqurasiya olunmuş nəticəni qaytarır', async () => {
    const runner = new FakeRunner({
      fixture: 'claude-safe-mode.jsonl',
      flavor: 'claude',
      detect: { installed: true, authenticated: false, detail: 'test' },
    })
    expect(await runner.detect()).toEqual({
      installed: true,
      authenticated: false,
      detail: 'test',
    })
  })

  it('AbortSignal ilə axını yarıda kəsir', async () => {
    const ac = new AbortController()
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })
    const out: RunEvent[] = []
    for await (const e of runner.run({ prompt: 'x', model: 'm' }, { signal: ac.signal })) {
      out.push(e)
      if (out.length === 1) ac.abort()
    }
    expect(out.length).toBeLessThan(4)
  })

  it('birbaşa verilmiş hadisə siyahısını da oynadır', async () => {
    const runner = new FakeRunner({
      events: [
        { t: 'text', delta: 'a' },
        { t: 'done', stopReason: 'end_turn' },
      ],
    })
    const events = await collect(runner.run({ prompt: 'x', model: 'm' }))
    expect(events).toEqual([
      { t: 'text', delta: 'a' },
      { t: 'done', stopReason: 'end_turn' },
    ])
  })

  it('capabilities sahələri override edilə bilir', () => {
    const runner = new FakeRunner({
      events: [],
      capabilities: { fileAccess: false },
    })
    expect(runner.capabilities.fileAccess).toBe(false)
    expect(runner.capabilities.toolUse).toBe(true)
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/fake.test.ts`
Expected: FAIL — `Failed to resolve import "./fake.js"`

- [ ] **Step 3: FakeRunner-i yaz**

`apps/server/src/runners/fake.ts`:

```ts
import { readFileSync } from 'node:fs'
import type {
  Capabilities,
  DetectResult,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { fixturePath } from './fixtures-path.js'
import { ClaudeStreamParser } from './parse-claude.js'
import { CodexStreamParser } from './parse-codex.js'

const DEFAULT_CAPS: Capabilities = {
  fileAccess: true,
  toolUse: true,
  sessions: true,
  structuredOutput: true,
  subscriptionBilled: true,
}

export interface FakeRunnerConfig {
  /** `fixtures/cli/` içindəki fayl adı */
  fixture?: string
  flavor?: 'claude' | 'codex'
  /** Fixture yerinə birbaşa hadisə siyahısı */
  events?: readonly RunEvent[]
  detect?: DetectResult
  capabilities?: Partial<Capabilities>
  /** Hər hadisə arasında gecikmə (ms). Default 0 — testlər sürətli olsun. */
  delayMs?: number
}

/**
 * Real fixture-ləri təkrar oynadan Runner.
 *
 * Bu sinif layihənin test strategiyasının təməlidir: supervisor, büdcə
 * qoruması, DB yazması, WebSocket yayımı və UI — hamısı bunun üzərində
 * SIFIR token xərcləyərək test olunur.
 */
export class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly kind = 'fake' as const
  readonly capabilities: Capabilities

  constructor(private readonly config: FakeRunnerConfig) {
    this.capabilities = { ...DEFAULT_CAPS, ...config.capabilities }
  }

  async detect(): Promise<DetectResult> {
    return (
      this.config.detect ?? {
        installed: true,
        authenticated: true,
        version: 'fake-1.0.0',
        detail: 'FakeRunner — fixture təkrar oynadır',
      }
    )
  }

  async *run(_req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    for (const event of this.materialize()) {
      if (opts?.signal?.aborted) return
      if (this.config.delayMs) {
        await new Promise((r) => setTimeout(r, this.config.delayMs))
      }
      yield event
    }
  }

  private materialize(): RunEvent[] {
    if (this.config.events) return [...this.config.events]

    const { fixture, flavor } = this.config
    if (!fixture) {
      throw new Error('FakeRunner: `fixture` və ya `events` verilməlidir')
    }

    const text = readFileSync(fixturePath(fixture), 'utf8')
    const parser =
      flavor === 'codex' ? new CodexStreamParser() : new ClaudeStreamParser()

    const out: RunEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      out.push(...parser.push(line))
    }
    return out
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/fake.test.ts`
Expected: PASS — 6 test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runners/fake.ts apps/server/src/runners/fake.test.ts
git commit -m "feat(server): FakeRunner — fixture təkrar oynadan test runner

Bütün pipeline-ı sıfır token ilə test etməyə imkan verir."
```

---

## Task 10: `ClaudeCliRunner`

Bayraq dəsti **sabit sabit** kimi saxlanılır. Səbəb ölçülüb: prefiks dəyişəndə
prompt-cache sınır və ~21.7k token 1.25x tarifi ilə yenidən ödənilir.

**Files:**
- Create: `apps/server/src/runners/claude.ts`
- Test: `apps/server/src/runners/claude.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/claude.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, CLAUDE_STABLE_FLAGS } from './claude.js'

describe('CLAUDE_STABLE_FLAGS', () => {
  it('--verbose daxildir — stream-json bunsuz xəta verir', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--verbose')
  })

  it('--safe-mode daxildir — hook/skill/MCP overhead-ini söndürür', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--safe-mode')
  })

  it('--bare DAXİL DEYİL — o, OAuth-u söndürür və abunəliyi sındırır', () => {
    expect(CLAUDE_STABLE_FLAGS).not.toContain('--bare')
  })

  it('--exclude-dynamic-system-prompt-sections daxildir — keş təkrar istifadəsi', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--exclude-dynamic-system-prompt-sections')
  })
})

describe('buildClaudeArgs', () => {
  it('sabit bayraqları həmişə eyni sırada verir', () => {
    const a = buildClaudeArgs({ prompt: 'p1', model: 'm' })
    const b = buildClaudeArgs({ prompt: 'p2', model: 'm' })
    const stripPrompt = (args: string[]): string[] =>
      args.filter((x) => x !== 'p1' && x !== 'p2')
    expect(stripPrompt(a)).toEqual(stripPrompt(b))
  })

  it('promptu -p bayrağından sonra ötürür', () => {
    const args = buildClaudeArgs({ prompt: 'salam', model: 'm' })
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('salam')
  })

  it('model bayrağını əlavə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'claude-haiku-4-5-20251001' })
    const i = args.indexOf('--model')
    expect(args[i + 1]).toBe('claude-haiku-4-5-20251001')
  })

  it('cwd verildikdə --add-dir əlavə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm', cwd: '/work/proj' })
    const i = args.indexOf('--add-dir')
    expect(args[i + 1]).toBe('/work/proj')
  })

  it('cwd verilmədikdə --add-dir əlavə etmir', () => {
    expect(buildClaudeArgs({ prompt: 'x', model: 'm' })).not.toContain('--add-dir')
  })

  it('resumeSessionId verildikdə --resume istifadə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm', resumeSessionId: 's-1' })
    const i = args.indexOf('--resume')
    expect(args[i + 1]).toBe('s-1')
    expect(args).not.toContain('--session-id')
  })

  it('resume yoxdursa --session-id ilə yeni UUID təyin edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' }, { sessionId: 'fixed-uuid' })
    const i = args.indexOf('--session-id')
    expect(args[i + 1]).toBe('fixed-uuid')
  })

  it('promptu heç vaxt sistem promptuna qoymur — keş prefiksi sabit qalsın', () => {
    const args = buildClaudeArgs({ prompt: 'gizli task mətni', model: 'm' })
    expect(args).not.toContain('--system-prompt')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('permissionMode ötürülür', () => {
    const args = buildClaudeArgs(
      { prompt: 'x', model: 'm' },
      { permissionMode: 'acceptEdits' },
    )
    const i = args.indexOf('--permission-mode')
    expect(args[i + 1]).toBe('acceptEdits')
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/claude.test.ts`
Expected: FAIL — `Failed to resolve import "./claude.js"`

- [ ] **Step 3: Runner-i yaz**

`apps/server/src/runners/claude.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type {
  Capabilities,
  DetectResult,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { ClaudeStreamParser } from './parse-claude.js'
import { resolveExecutable, type ResolvedExecutable } from './resolve-exe.js'
import { spawnLines } from './spawn.js'

/**
 * DƏYİŞMƏZ bayraq dəsti.
 *
 * ÖLÇÜLMÜŞ SƏBƏB: prompt prefiksi dəyişəndə Anthropic prompt-cache-i sınır və
 * ~21.7k token `cache_creation` tarifi (1.25x) ilə yenidən ödənilir. Ölçmədə
 * öz `--system-prompt`-unu vermək promptu KİÇİLTDİ, amma xərci 5x ARTIRDI
 * ($0.0085 → $0.0444).
 *
 * Buraya yeni bayraq əlavə etmək = bütün mövcud keşlərin bir dəfəlik sınması.
 * Task-a xas heç nə bura girmir — yalnız istifadəçi mesajına.
 */
export const CLAUDE_STABLE_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  // `stream-json` bunsuz xəta verir:
  // "When using --print, --output-format=stream-json requires --verbose"
  '--verbose',
  // İstifadəçinin CLAUDE.md-si, hook-ları, skill-ləri və MCP serverləri hər
  // çağırışa yüklənir (~6-9k əlavə token). Bu onları söndürür, AUTH qalır.
  '--safe-mode',
  '--strict-mcp-config',
  // Per-maşın bölmələri sistem promptundan çıxarır → keş təkrar istifadəsi artır
  '--exclude-dynamic-system-prompt-sections',
  '--disable-slash-commands',
]

export interface ClaudeArgOptions {
  sessionId?: string
  permissionMode?: 'acceptEdits' | 'plan' | 'dontAsk' | 'manual'
  fallbackModel?: string
}

export function buildClaudeArgs(
  req: RunRequest,
  opts: ClaudeArgOptions = {},
): string[] {
  const args: string[] = ['-p', req.prompt, ...CLAUDE_STABLE_FLAGS]

  args.push('--model', req.model)

  if (req.resumeSessionId) {
    args.push('--resume', req.resumeSessionId)
  } else {
    args.push('--session-id', opts.sessionId ?? randomUUID())
  }

  if (req.cwd) args.push('--add-dir', req.cwd)
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  if (opts.fallbackModel) args.push('--fallback-model', opts.fallbackModel)

  return args
}

export class ClaudeCliRunner implements Runner {
  readonly id = 'cli:claude'
  readonly kind = 'cli' as const
  readonly capabilities: Capabilities = {
    fileAccess: true,
    toolUse: true,
    sessions: true,
    structuredOutput: true,
    // Abunəlikdən ödənilir → real pul çıxmır. `total_cost_usd` istinad qiymətidir.
    subscriptionBilled: true,
  }

  private resolved: ResolvedExecutable | null | undefined

  constructor(private readonly argOptions: ClaudeArgOptions = {}) {}

  private resolve(): ResolvedExecutable | null {
    if (this.resolved === undefined) this.resolved = resolveExecutable('claude')
    return this.resolved
  }

  async detect(): Promise<DetectResult> {
    const exe = this.resolve()
    if (!exe) {
      return {
        installed: false,
        authenticated: false,
        detail: 'claude PATH-da tapılmadı. `npm i -g @anthropic-ai/claude-code`',
      }
    }

    const proc = spawnLines({
      command: exe.command,
      args: ['--version'],
      useShell: exe.useShell,
    })
    const lines: string[] = []
    for await (const l of proc.lines) lines.push(l)
    const code = await proc.exitCode

    if (code !== 0) {
      return {
        installed: true,
        authenticated: false,
        execPath: exe.command,
        detail: `claude --version xəta verdi (kod ${code}): ${proc.stderrText().slice(0, 200)}`,
      }
    }

    // `--version` auth yoxlamır. Auth yalnız ilk real icrada bilinir; onda
    // parser `auth` sinifli xəta emit edir və status yenilənir.
    return {
      installed: true,
      authenticated: true,
      version: (lines[0] ?? '').trim(),
      execPath: exe.command,
      detail: 'Hazırdır (auth ilk icrada təsdiqlənir)',
    }
  }

  async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    const exe = this.resolve()
    if (!exe) {
      yield {
        t: 'error',
        class: 'crashed',
        message: 'claude icra faylı tapılmadı',
        retryable: false,
      }
      return
    }

    const proc = spawnLines({
      command: exe.command,
      args: buildClaudeArgs(req, this.argOptions),
      useShell: exe.useShell,
      cwd: req.cwd,
    })

    const onAbort = (): void => void proc.kill()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const parser = new ClaudeStreamParser()
    try {
      for await (const line of proc.lines) {
        for (const event of parser.push(line)) yield event
        if (opts?.signal?.aborted) break
      }

      const code = await proc.exitCode
      if (code !== 0 && !proc.killed) {
        const stderr = proc.stderrText().trim()
        if (stderr) {
          yield {
            t: 'error',
            class: 'crashed',
            message: `claude çıxış kodu ${code}: ${stderr.slice(0, 500)}`,
            retryable: true,
          }
        }
      }
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort)
      await proc.kill()
    }
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/claude.test.ts`
Expected: PASS — 14 test.

- [ ] **Step 5: Real `detect()`-i yoxla (token xərcləmir)**

`--version` model çağırmır, ona görə pulsuzdur:

```bash
node --experimental-strip-types -e "
import { ClaudeCliRunner } from './apps/server/src/runners/claude.ts'
console.log(await new ClaudeCliRunner().detect())
"
```

Expected: `{ installed: true, authenticated: true, version: '2.1.220 (Claude Code)', execPath: '...claude.exe', ... }`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runners/claude.ts apps/server/src/runners/claude.test.ts
git commit -m "feat(server): ClaudeCliRunner sabit bayraq dəsti ilə

Bayraqlar sabitdir çünki prefiks dəyişməsi prompt-cache-i sındırır və
~21.7k tokeni 1.25x tarifi ilə yenidən ödədir (ölçülüb: 5x baha)."
```

---

## Task 11: `CodexCliRunner`

**Files:**
- Create: `apps/server/src/runners/codex.ts`
- Test: `apps/server/src/runners/codex.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/runners/codex.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildCodexArgs, CODEX_STABLE_FLAGS, parseLoginStatus } from './codex.js'

describe('CODEX_STABLE_FLAGS', () => {
  it('--json daxildir', () => {
    expect(CODEX_STABLE_FLAGS).toContain('--json')
  })

  it('--skip-git-repo-check daxildir — repo olmayan qovluqda da işləsin', () => {
    expect(CODEX_STABLE_FLAGS).toContain('--skip-git-repo-check')
  })
})

describe('buildCodexArgs', () => {
  it('exec subkomandası ilə başlayır', () => {
    expect(buildCodexArgs({ prompt: 'x', model: 'm' })[0]).toBe('exec')
  })

  it('promptu SON arqument kimi verir', () => {
    const args = buildCodexArgs({ prompt: 'salam dunya', model: 'm' })
    expect(args.at(-1)).toBe('salam dunya')
  })

  it('model bayrağını əlavə edir', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'gpt-5.2-codex' })
    const i = args.indexOf('--model')
    expect(args[i + 1]).toBe('gpt-5.2-codex')
  })

  it('default sandbox read-only-dir — təsadüfi fayl dəyişikliyi olmasın', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'm' })
    const i = args.indexOf('--sandbox')
    expect(args[i + 1]).toBe('read-only')
  })

  it('workspace-write açıq şəkildə tələb olunanda ötürülür', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'm' }, { sandbox: 'workspace-write' })
    const i = args.indexOf('--sandbox')
    expect(args[i + 1]).toBe('workspace-write')
  })

  it('resumeSessionId verildikdə exec resume formasını qurur', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'm', resumeSessionId: 'th_5' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'th_5'])
  })
})

describe('parseLoginStatus', () => {
  it('"Not logged in" mətnini authenticated:false kimi oxuyur', () => {
    expect(parseLoginStatus('Not logged in', 0)).toBe(false)
  })

  it('login olunmuş cavabı authenticated:true kimi oxuyur', () => {
    expect(parseLoginStatus('Logged in using ChatGPT account', 0)).toBe(true)
  })

  it('sıfırdan fərqli çıxış kodunu authenticated:false kimi sayır', () => {
    expect(parseLoginStatus('', 1)).toBe(false)
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/codex.test.ts`
Expected: FAIL — `Failed to resolve import "./codex.js"`

- [ ] **Step 3: Runner-i yaz**

`apps/server/src/runners/codex.ts`:

```ts
import type {
  Capabilities,
  DetectResult,
  RunEvent,
  RunOptions,
  RunRequest,
  Runner,
} from '@orchestris/shared'
import { CodexStreamParser } from './parse-codex.js'
import { resolveExecutable, type ResolvedExecutable } from './resolve-exe.js'
import { spawnLines } from './spawn.js'

export const CODEX_STABLE_FLAGS: readonly string[] = [
  '--json',
  '--skip-git-repo-check',
]

export interface CodexArgOptions {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  outputSchemaPath?: string
}

export function buildCodexArgs(
  req: RunRequest,
  opts: CodexArgOptions = {},
): string[] {
  const args: string[] = ['exec']

  if (req.resumeSessionId) args.push('resume', req.resumeSessionId)

  args.push(...CODEX_STABLE_FLAGS)
  args.push('--model', req.model)
  // Default `read-only`: yazma icazəsi yalnız açıq tələb olunanda verilir.
  args.push('--sandbox', opts.sandbox ?? 'read-only')
  if (opts.outputSchemaPath) args.push('--output-schema', opts.outputSchemaPath)

  // Prompt SON arqumentdir — codex pozitional prompt gözləyir.
  args.push(req.prompt)
  return args
}

export function parseLoginStatus(stdout: string, exitCode: number | null): boolean {
  if (exitCode !== 0) return false
  return !/not logged in/i.test(stdout)
}

export class CodexCliRunner implements Runner {
  readonly id = 'cli:codex'
  readonly kind = 'cli' as const
  readonly capabilities: Capabilities = {
    fileAccess: true,
    toolUse: true,
    sessions: true,
    structuredOutput: true,
    subscriptionBilled: true,
  }

  private resolved: ResolvedExecutable | null | undefined

  constructor(private readonly argOptions: CodexArgOptions = {}) {}

  private resolve(): ResolvedExecutable | null {
    if (this.resolved === undefined) this.resolved = resolveExecutable('codex')
    return this.resolved
  }

  async detect(): Promise<DetectResult> {
    const exe = this.resolve()
    if (!exe) {
      return {
        installed: false,
        authenticated: false,
        detail: 'codex PATH-da tapılmadı',
      }
    }

    const versionProc = spawnLines({
      command: exe.command,
      args: ['--version'],
      useShell: exe.useShell,
    })
    const versionLines: string[] = []
    for await (const l of versionProc.lines) versionLines.push(l)
    await versionProc.exitCode

    // Codex-in `login status` subkomandası var — auth-u ÖNCƏDƏN bilirik,
    // claude-dan fərqli olaraq ilk icranı gözləmək lazım deyil.
    const loginProc = spawnLines({
      command: exe.command,
      args: ['login', 'status'],
      useShell: exe.useShell,
    })
    const loginLines: string[] = []
    for await (const l of loginProc.lines) loginLines.push(l)
    const loginCode = await loginProc.exitCode
    const stdout = loginLines.join('\n')
    const authenticated = parseLoginStatus(stdout, loginCode)

    return {
      installed: true,
      authenticated,
      version: (versionLines[0] ?? '').trim(),
      execPath: exe.command,
      detail: authenticated
        ? stdout.trim() || 'Login olunmuş'
        : 'Login olunmayıb — terminalda `codex login` işlət',
    }
  }

  async *run(req: RunRequest, opts?: RunOptions): AsyncIterable<RunEvent> {
    const exe = this.resolve()
    if (!exe) {
      yield {
        t: 'error',
        class: 'crashed',
        message: 'codex icra faylı tapılmadı',
        retryable: false,
      }
      return
    }

    // spawnLines stdin-i `ignore` edir — bu olmadan codex
    // "Reading additional input from stdin..." deyib əbədi donur.
    const proc = spawnLines({
      command: exe.command,
      args: buildCodexArgs(req, this.argOptions),
      useShell: exe.useShell,
      cwd: req.cwd,
    })

    const onAbort = (): void => void proc.kill()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const parser = new CodexStreamParser()
    try {
      for await (const line of proc.lines) {
        for (const event of parser.push(line)) yield event
        if (opts?.signal?.aborted) break
      }
      await proc.exitCode
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort)
      await proc.kill()
    }
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/runners/codex.test.ts`
Expected: PASS — 11 test.

- [ ] **Step 5: Real `detect()`-i yoxla**

```bash
node --experimental-strip-types -e "
import { CodexCliRunner } from './apps/server/src/runners/codex.ts'
console.log(await new CodexCliRunner().detect())
"
```

Expected (bu maşında, login olunmayıb):
`{ installed: true, authenticated: false, version: 'codex-cli 0.145.0', detail: 'Login olunmayıb — terminalda `codex login` işlət' }`

`authenticated: true` gəlirsə istifadəçi arada login olmuşdur — bu da düzgün nəticədir.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runners/codex.ts apps/server/src/runners/codex.test.ts
git commit -m "feat(server): CodexCliRunner

`codex login status` ilə auth öncədən yoxlanılır. Sandbox default read-only.
stdin bağlıdır — açıq stdin ilə codex exec donur."
```

---

## Task 12: `BudgetGuard` — sərt limit

Spesifikasiyanın ən vacib qoruması. Araşdırma xəbərdarlığı: testdə $0.50 olan
axın 100K icrada $50,000/ay-a çıxa bilər. Limit **sərtdir** — aşıldıqda proses
ağacı öldürülür, xahiş edilmir.

**Files:**
- Create: `apps/server/src/exec/budget.ts`
- Test: `apps/server/src/exec/budget.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/exec/budget.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { BudgetGuard } from './budget.js'

describe('BudgetGuard — token limiti', () => {
  it('limit altında icazə verir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check({ t: 'usage', inputTokens: 0, outputTokens: 50, costUsd: 0 })).toBeNull()
  })

  it('limit aşıldıqda budget_exceeded qaytarır', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    const v = g.check({ t: 'usage', inputTokens: 0, outputTokens: 101, costUsd: 0 })
    expect(v?.class).toBe('budget_exceeded')
    expect(v?.retryable).toBe(false)
    expect(v?.message).toContain('101')
    expect(v?.message).toContain('100')
  })

  it('limit dəqiq bərabərdirsə icazə verir (>= yox, > istifadə olunur)', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check({ t: 'usage', inputTokens: 0, outputTokens: 100, costUsd: 0 })).toBeNull()
  })
})

describe('BudgetGuard — xərc limiti', () => {
  it('xərc limiti aşıldıqda budget_exceeded qaytarır', () => {
    const g = new BudgetGuard({ maxCostUsd: 0.01 })
    const v = g.check({ t: 'usage', inputTokens: 0, outputTokens: 0, costUsd: 0.011 })
    expect(v?.class).toBe('budget_exceeded')
  })

  it('abunəlikdən ödənilən icralarda xərc limiti tətbiq edilmir', () => {
    const g = new BudgetGuard({ maxCostUsd: 0.001, subscriptionBilled: true })
    expect(
      g.check({ t: 'usage', inputTokens: 0, outputTokens: 0, costUsd: 0.5 }),
    ).toBeNull()
  })

  it('abunəlikdə də TOKEN limiti tətbiq edilir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 10, subscriptionBilled: true })
    expect(
      g.check({ t: 'usage', inputTokens: 0, outputTokens: 11, costUsd: 0 }),
    )?.class === 'budget_exceeded'
  })
})

describe('BudgetGuard — vaxt limiti', () => {
  it('vaxt limiti aşıldıqda budget_exceeded qaytarır', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))
    const g = new BudgetGuard({ maxSeconds: 30 })
    expect(g.checkClock()).toBeNull()
    vi.advanceTimersByTime(31_000)
    const v = g.checkClock()
    expect(v?.class).toBe('budget_exceeded')
    expect(v?.message).toContain('30')
    vi.useRealTimers()
  })
})

describe('BudgetGuard — limitsiz hal', () => {
  it('heç bir limit verilməyəndə həmişə icazə verir', () => {
    const g = new BudgetGuard({})
    expect(g.check({ t: 'usage', inputTokens: 1e9, outputTokens: 1e9, costUsd: 1e6 })).toBeNull()
    expect(g.checkClock()).toBeNull()
  })

  it('usage olmayan hadisələri sakitcə buraxır', () => {
    const g = new BudgetGuard({ maxOutputTokens: 1 })
    expect(g.check({ t: 'text', delta: 'uzun uzun mətn' })).toBeNull()
  })
})

describe('BudgetGuard — kumulyativ toplama YOXDUR', () => {
  it('usage kumulyativ gəldiyi üçün ən son dəyəri götürür, toplamır', () => {
    // claude hər result-da yekun usage verir. İki dəfə check çağırmaq
    // limiti süni şəkildə aşdırmamalıdır.
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check({ t: 'usage', inputTokens: 0, outputTokens: 60, costUsd: 0 })).toBeNull()
    expect(g.check({ t: 'usage', inputTokens: 0, outputTokens: 60, costUsd: 0 })).toBeNull()
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/budget.test.ts`
Expected: FAIL — `Failed to resolve import "./budget.js"`

- [ ] **Step 3: BudgetGuard-ı yaz**

`apps/server/src/exec/budget.ts`:

```ts
import type { ErrorClass, RunEvent } from '@orchestris/shared'

export interface BudgetLimits {
  maxOutputTokens?: number
  maxCostUsd?: number
  maxSeconds?: number
  /**
   * Abunəlikdən ödənilən icralar (CLI) üçün DOLLAR limiti tətbiq edilmir —
   * `total_cost_usd` orada istinad qiymətidir, real pul çıxmır. Token və vaxt
   * limitləri isə hər halda tətbiq edilir.
   */
  subscriptionBilled?: boolean
}

export interface BudgetViolation {
  class: ErrorClass
  message: string
  retryable: false
}

/**
 * Sərt büdcə qoruması.
 *
 * SƏBƏB: kaskad orkestrasiyada orchestrator hər task üçün əlavə çağırışlar
 * edir. Testdə $0.50 olan axın 100K icrada $50,000/ay-a çıxa bilər. Bu sinif
 * o riski kəsir — pozuntu halında proses AĞACI öldürülür.
 */
export class BudgetGuard {
  private readonly startedAt: number

  constructor(private readonly limits: BudgetLimits) {
    this.startedAt = Date.now()
  }

  /**
   * Hadisə əsasında yoxlama. `usage` hadisələri KUMULYATİVDİR — burada
   * toplama aparılmır, hər dəfə mütləq dəyər müqayisə olunur.
   */
  check(event: RunEvent): BudgetViolation | null {
    if (event.t !== 'usage') return null

    const { maxOutputTokens, maxCostUsd, subscriptionBilled } = this.limits

    if (maxOutputTokens !== undefined && event.outputTokens > maxOutputTokens) {
      return this.violation(
        `Output token limiti aşıldı: ${event.outputTokens} > ${maxOutputTokens}`,
      )
    }

    if (
      maxCostUsd !== undefined &&
      !subscriptionBilled &&
      event.costUsd > maxCostUsd
    ) {
      return this.violation(
        `Xərc limiti aşıldı: $${event.costUsd.toFixed(6)} > $${maxCostUsd.toFixed(6)}`,
      )
    }

    return null
  }

  /** Vaxt yoxlaması — hadisədən asılı deyil, dövri çağırılır. */
  checkClock(): BudgetViolation | null {
    const { maxSeconds } = this.limits
    if (maxSeconds === undefined) return null
    const elapsed = (Date.now() - this.startedAt) / 1000
    if (elapsed > maxSeconds) {
      return this.violation(
        `Vaxt limiti aşıldı: ${elapsed.toFixed(1)}s > ${maxSeconds}s`,
      )
    }
    return null
  }

  private violation(message: string): BudgetViolation {
    return { class: 'budget_exceeded', message, retryable: false }
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/budget.test.ts`
Expected: PASS — 11 test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/exec/budget.ts apps/server/src/exec/budget.test.ts
git commit -m "feat(server): BudgetGuard — sərt token/xərc/vaxt limiti

Abunəlik icralarında dollar limiti tətbiq edilmir (real pul çıxmır),
token və vaxt limitləri isə hər halda tətbiq edilir."
```

---

## Task 13: DB qatı — sxem, klient, repo

**Files:**
- Create: `apps/server/src/paths.ts`
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/repo.ts`
- Test: `apps/server/src/db/repo.test.ts`

Faza 1A yalnız 4 cədvəl istifadə edir: `contexts`, `tasks`, `runs`,
`run_events`. Qalan cədvəllər (`models`, `cache_entries`, `savings_ledger` və s.)
Faza 1B/1C planlarında əlavə olunur — indi yaratmaq YAGNI olardı.

- [ ] **Step 1: Yol modulunu yaz**

`apps/server/src/paths.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Bütün vəziyyət `~/.orchestris/` altındadır. API açarları BURAYA YAZILMIR —
 * onlar OS keychain-də saxlanılır (Faza 1B).
 *
 * `ORCHESTRIS_HOME` testlərdə müvəqqəti qovluğa yönləndirmək üçündür.
 */
export function orchestrisHome(): string {
  return process.env['ORCHESTRIS_HOME'] ?? join(homedir(), '.orchestris')
}

export function dbPath(): string {
  return join(orchestrisHome(), 'orchestris.db')
}

export function worktreesDir(): string {
  return join(orchestrisHome(), 'worktrees')
}
```

- [ ] **Step 2: Drizzle sxemini yaz**

`apps/server/src/db/schema.ts`:

```ts
import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** İş sahəsi — istifadəçinin "yeni kontekst başlat" dediyi şey. */
export const contexts = sqliteTable('contexts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cwd: text('cwd'),
  amplificationProfile: text('amplification_profile')
    .notNull()
    .default('balanced'),
  workerMode: text('worker_mode').notNull().default('auto'),
  autoSubmode: text('auto_submode').notNull().default('cheap'),
  defaultWorkerModelId: text('default_worker_model_id'),
  /** JSON massiv: yoxlama əmrləri, məs. ["pnpm typecheck","pnpm test"] */
  verifyCommandsJson: text('verify_commands_json').notNull().default('[]'),
  budgetTokens: integer('budget_tokens'),
  budgetUsd: real('budget_usd'),
  budgetSeconds: integer('budget_seconds'),
  maxParallel: integer('max_parallel').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
})

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    parentTaskId: text('parent_task_id'),
    prompt: text('prompt').notNull(),
    taskType: text('task_type').notNull().default('unknown'),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [index('tasks_context_idx').on(t.contextId, t.createdAt)],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runnerId: text('runner_id').notNull(),
    modelId: text('model_id').notNull(),
    ladderRung: integer('ladder_rung').notNull().default(7),
    status: text('status').notNull().default('running'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** true → abunəlikdən getdi, real pul çıxmadı */
    subscriptionBilled: integer('subscription_billed', { mode: 'boolean' })
      .notNull()
      .default(false),
    cachedHit: integer('cached_hit', { mode: 'boolean' }).notNull().default(false),
    escalatedFromRunId: text('escalated_from_run_id'),
    sessionId: text('session_id'),
    worktreePath: text('worktree_path'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
  },
  (t) => [index('runs_task_idx').on(t.taskId, t.startedAt)],
)

/** Append-only hadisə jurnalı — "modellərin gördüyü işi görə bilək" budur. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('run_events_seq_idx').on(t.runId, t.seq)],
)

export const contextsRelations = relations(contexts, ({ many }) => ({
  tasks: many(tasks),
}))
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  context: one(contexts, { fields: [tasks.contextId], references: [contexts.id] }),
  runs: many(runs),
}))
export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  events: many(runEvents),
}))
```

- [ ] **Step 3: Klienti yaz**

`apps/server/src/db/client.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dbPath } from '../paths.js'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

/** Cədvəlləri yaradan DDL. drizzle-kit migrasiyaları Faza 1B-də əlavə olunur. */
const DDL = `
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT,
  amplification_profile TEXT NOT NULL DEFAULT 'balanced',
  worker_mode TEXT NOT NULL DEFAULT 'auto',
  auto_submode TEXT NOT NULL DEFAULT 'cheap',
  default_worker_model_id TEXT,
  verify_commands_json TEXT NOT NULL DEFAULT '[]',
  budget_tokens INTEGER,
  budget_usd REAL,
  budget_seconds INTEGER,
  max_parallel INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  parent_task_id TEXT,
  prompt TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_context_idx ON tasks(context_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ladder_rung INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'running',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  subscription_billed INTEGER NOT NULL DEFAULT 0,
  cached_hit INTEGER NOT NULL DEFAULT 0,
  escalated_from_run_id TEXT,
  session_id TEXT,
  worktree_path TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_class TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, started_at);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_events_seq_idx ON run_events(run_id, seq);
`

export function openDb(file = dbPath()): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  // WAL: oxuma yazmanı bloklamır — UI icra zamanı hadisələri oxuyur.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}
```

- [ ] **Step 4: Uğursuz repo testini yaz**

`apps/server/src/db/repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDb } from './client.js'
import {
  appendEvent,
  createContext,
  createRun,
  createTask,
  finishRun,
  listEvents,
  markOrphanedRunsInterrupted,
  applyUsageToRun,
} from './repo.js'

function db() {
  return openDb(':memory:')
}

describe('createContext / createTask / createRun', () => {
  it('kontekst yaradır və default dəyərləri qoyur', () => {
    const d = db()
    const ctx = createContext(d, { name: 'Test' })
    expect(ctx.name).toBe('Test')
    expect(ctx.amplificationProfile).toBe('balanced')
    expect(ctx.workerMode).toBe('auto')
    expect(ctx.maxParallel).toBe(1)
  })

  it('task yaradır və konteksti bağlayır', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'salam' })
    expect(task.contextId).toBe(ctx.id)
    expect(task.status).toBe('pending')
  })

  it('run yaradır və running statusu ilə başlayır', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, {
      taskId: task.id,
      runnerId: 'cli:claude',
      modelId: 'claude-haiku-4-5-20251001',
      subscriptionBilled: true,
    })
    expect(run.status).toBe('running')
    expect(run.subscriptionBilled).toBe(true)
  })
})

describe('appendEvent / listEvents', () => {
  it('hadisələri sıra nömrəsi ilə yazır və eyni sırada oxuyur', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    appendEvent(d, run.id, { t: 'text', delta: 'bir' })
    appendEvent(d, run.id, { t: 'text', delta: 'iki' })
    appendEvent(d, run.id, { t: 'done', stopReason: 'end_turn' })

    const events = listEvents(d, run.id)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(events[0]?.event).toEqual({ t: 'text', delta: 'bir' })
    expect(events[2]?.event).toEqual({ t: 'done', stopReason: 'end_turn' })
  })

  it('offset ilə səhifələmə edir', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    for (let i = 0; i < 5; i++) appendEvent(d, run.id, { t: 'text', delta: String(i) })

    const page = listEvents(d, run.id, { afterSeq: 2, limit: 2 })
    expect(page.map((e) => e.seq)).toEqual([3, 4])
  })
})

describe('applyUsageToRun', () => {
  it('usage hadisəsini run sətrinə yazır (toplamır, əvəz edir)', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })

    applyUsageToRun(d, run.id, {
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
    })
    // İkinci dəfə eyni kumulyativ dəyər gəlsə nəticə dəyişməməlidir
    applyUsageToRun(d, run.id, {
      t: 'usage',
      inputTokens: 10,
      outputTokens: 59,
      cacheReadTokens: 22411,
      cacheWriteTokens: 2655,
      costUsd: 0.00845,
    })

    const updated = finishRun(d, run.id, { status: 'succeeded' })
    expect(updated.tokensOut).toBe(59)
    expect(updated.tokensCacheRead).toBe(22411)
    expect(updated.costUsd).toBeCloseTo(0.00845, 6)
  })
})

describe('finishRun', () => {
  it('statusu və bitmə vaxtını yazır', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    const done = finishRun(d, run.id, { status: 'succeeded', sessionId: 's-9' })
    expect(done.status).toBe('succeeded')
    expect(done.endedAt).toBeGreaterThan(0)
    expect(done.sessionId).toBe('s-9')
  })

  it('xəta sinfini və mesajını yazır', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    const done = finishRun(d, run.id, {
      status: 'failed',
      errorClass: 'auth',
      errorMessage: 'Not logged in',
    })
    expect(done.errorClass).toBe('auth')
    expect(done.errorMessage).toBe('Not logged in')
  })
})

describe('markOrphanedRunsInterrupted', () => {
  it('server yenidən başladıqda yetim running icraları interrupted edir', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    appendEvent(d, run.id, { t: 'text', delta: 'yarımçıq' })

    const count = markOrphanedRunsInterrupted(d)
    expect(count).toBe(1)

    // Hadisə jurnalı İTMİR — spesifikasiyanın tələbi
    expect(listEvents(d, run.id)).toHaveLength(1)
  })

  it('artıq bitmiş icralara toxunmur', () => {
    const d = db()
    const ctx = createContext(d, { name: 'C' })
    const task = createTask(d, { contextId: ctx.id, prompt: 'p' })
    const run = createRun(d, { taskId: task.id, runnerId: 'fake', modelId: 'm' })
    finishRun(d, run.id, { status: 'succeeded' })
    expect(markOrphanedRunsInterrupted(d)).toBe(0)
  })
})
```

- [ ] **Step 5: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/db/repo.test.ts`
Expected: FAIL — `Failed to resolve import "./repo.js"`

- [ ] **Step 6: Repo-nu yaz**

`apps/server/src/db/repo.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { ErrorClass, RunEvent } from '@orchestris/shared'
import type { Db } from './client.js'
import { contexts, runEvents, runs, tasks } from './schema.js'

type Context = typeof contexts.$inferSelect
type Task = typeof tasks.$inferSelect
type Run = typeof runs.$inferSelect

const now = (): number => Date.now()

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} tapılmadı`)
  return row
}

export function createContext(
  db: Db,
  input: { name: string; cwd?: string; verifyCommands?: readonly string[] },
): Context {
  const row = {
    id: randomUUID(),
    name: input.name,
    cwd: input.cwd ?? null,
    verifyCommandsJson: JSON.stringify(input.verifyCommands ?? []),
    createdAt: now(),
  }
  db.insert(contexts).values(row).run()
  return requireRow(
    db.select().from(contexts).where(eq(contexts.id, row.id)).get(),
    'contexts',
  )
}

export function listContexts(db: Db): Context[] {
  return db.select().from(contexts).orderBy(asc(contexts.createdAt)).all()
}

export function getContext(db: Db, id: string): Context | undefined {
  return db.select().from(contexts).where(eq(contexts.id, id)).get()
}

export function createTask(
  db: Db,
  input: { contextId: string; prompt: string; taskType?: string },
): Task {
  const row = {
    id: randomUUID(),
    contextId: input.contextId,
    prompt: input.prompt,
    taskType: input.taskType ?? 'unknown',
    createdAt: now(),
  }
  db.insert(tasks).values(row).run()
  return requireRow(db.select().from(tasks).where(eq(tasks.id, row.id)).get(), 'tasks')
}

export function getTask(db: Db, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get()
}

export function setTaskStatus(db: Db, id: string, status: string): void {
  db.update(tasks)
    .set({ status, ...(status === 'succeeded' || status === 'failed' ? { completedAt: now() } : {}) })
    .where(eq(tasks.id, id))
    .run()
}

export function createRun(
  db: Db,
  input: {
    taskId: string
    runnerId: string
    modelId: string
    ladderRung?: number
    subscriptionBilled?: boolean
    worktreePath?: string
  },
): Run {
  const row = {
    id: randomUUID(),
    taskId: input.taskId,
    runnerId: input.runnerId,
    modelId: input.modelId,
    ladderRung: input.ladderRung ?? 7,
    subscriptionBilled: input.subscriptionBilled ?? false,
    worktreePath: input.worktreePath ?? null,
    startedAt: now(),
  }
  db.insert(runs).values(row).run()
  return requireRow(db.select().from(runs).where(eq(runs.id, row.id)).get(), 'runs')
}

export function listRunsForTask(db: Db, taskId: string): Run[] {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.startedAt)).all()
}

/**
 * `usage` hadisəsini run sətrinə yazır.
 *
 * DİQQƏT: dəyərlər KUMULYATİVDİR — `+=` deyil, `=` istifadə olunur. Toplama
 * eyni tokenləri bir neçə dəfə sayardı.
 */
export function applyUsageToRun(
  db: Db,
  runId: string,
  event: Extract<RunEvent, { t: 'usage' }>,
): void {
  db.update(runs)
    .set({
      tokensIn: event.inputTokens,
      tokensOut: event.outputTokens,
      tokensCacheRead: event.cacheReadTokens ?? 0,
      tokensCacheWrite: event.cacheWriteTokens ?? 0,
      costUsd: event.costUsd,
    })
    .where(eq(runs.id, runId))
    .run()
}

export function finishRun(
  db: Db,
  runId: string,
  input: {
    status: 'succeeded' | 'failed' | 'interrupted' | 'budget_exceeded'
    sessionId?: string
    errorClass?: ErrorClass
    errorMessage?: string
  },
): Run {
  db.update(runs)
    .set({
      status: input.status,
      endedAt: now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 2000) } : {}),
    })
    .where(eq(runs.id, runId))
    .run()
  return requireRow(db.select().from(runs).where(eq(runs.id, runId)).get(), 'runs')
}

export interface StoredEvent {
  seq: number
  at: number
  event: RunEvent
}

export function appendEvent(db: Db, runId: string, event: RunEvent): StoredEvent {
  const maxSeq =
    db
      .select({ v: sql<number>`COALESCE(MAX(${runEvents.seq}), 0)` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get()?.v ?? 0
  const seq = maxSeq + 1
  const at = now()
  db.insert(runEvents)
    .values({ runId, seq, type: event.t, payloadJson: JSON.stringify(event), at })
    .run()
  return { seq, at, event }
}

export function listEvents(
  db: Db,
  runId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): StoredEvent[] {
  const where =
    opts.afterSeq !== undefined
      ? and(eq(runEvents.runId, runId), gt(runEvents.seq, opts.afterSeq))
      : eq(runEvents.runId, runId)

  let q = db.select().from(runEvents).where(where).orderBy(asc(runEvents.seq)).$dynamic()
  if (opts.limit !== undefined) q = q.limit(opts.limit)

  return q.all().map((r) => ({
    seq: r.seq,
    at: r.at,
    event: JSON.parse(r.payloadJson) as RunEvent,
  }))
}

/**
 * Server çökdükdən sonra qalan `running` icraları `interrupted` işarələyir.
 * Hadisə jurnalına TOXUNMUR — spesifikasiya onun itməməsini tələb edir.
 */
export function markOrphanedRunsInterrupted(db: Db): number {
  const orphans = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, ['running', 'pending']))
    .all()
  if (orphans.length === 0) return 0

  db.update(runs)
    .set({ status: 'interrupted', endedAt: now() })
    .where(inArray(runs.status, ['running', 'pending']))
    .run()
  return orphans.length
}
```

- [ ] **Step 7: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/db/repo.test.ts`
Expected: PASS — 10 test.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/paths.ts apps/server/src/db
git commit -m "feat(server): SQLite qatı — contexts, tasks, runs, run_events

Kumulyativ usage tələsi burada da həll olunub: applyUsageToRun toplamır,
əvəz edir. markOrphanedRunsInterrupted hadisə jurnalını itirmir."
```

---

## Task 14: `RunSupervisor` — hər şeyi birləşdirən qat

Supervisor `Runner`, `BudgetGuard`, DB və dinləyiciləri birləşdirir. O, bütün
Faza 1A-nın mərkəzidir və `FakeRunner` ilə tam test olunur.

**Files:**
- Create: `apps/server/src/exec/supervisor.ts`
- Test: `apps/server/src/exec/supervisor.test.ts`

- [ ] **Step 1: Uğursuz testi yaz**

`apps/server/src/exec/supervisor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import { openDb } from '../db/client.js'
import { createContext, createTask, listEvents, listRunsForTask } from '../db/repo.js'
import { FakeRunner } from '../runners/fake.js'
import { RunSupervisor } from './supervisor.js'

function setup() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'salam' })
  return { db, ctx, task }
}

describe('RunSupervisor — uğurlu icra', () => {
  it('fixture axınını DB-yə yazır və run-u succeeded edir', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const runner = new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })

    const result = await sup.execute({
      taskId: task.id,
      runner,
      model: 'claude-haiku-4-5-20251001',
      prompt: 'salam',
    })

    expect(result.status).toBe('succeeded')
    const runsRows = listRunsForTask(db, task.id)
    expect(runsRows).toHaveLength(1)
    expect(runsRows[0]?.status).toBe('succeeded')
    expect(runsRows[0]?.tokensOut).toBe(59)
    expect(runsRows[0]?.sessionId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('bütün hadisələri sıra ilə jurnala yazır', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'm',
      prompt: 'p',
    })
    const events = listEvents(db, result.runId)
    expect(events.length).toBeGreaterThan(3)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events.at(-1)?.event.t).toBe('done')
  })

  it('dinləyiciyə hadisələri canlı ötürür', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const seen: RunEvent[] = []
    sup.onEvent(() => seen.push({ t: 'text', delta: 'x' }))

    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'text', delta: 'a' },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
    })
    expect(seen).toHaveLength(2)
  })
})

describe('RunSupervisor — xəta halları', () => {
  it('auth xətasını failed + errorClass kimi yazır', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'codex-auth-error.jsonl', flavor: 'codex' }),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('failed')
    const row = listRunsForTask(db, task.id)[0]
    expect(row?.errorClass).toBe('auth')
  })

  it('done gəlmədən axın bitərsə failed edir', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'text', delta: 'yarımçıq' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(result.status).toBe('failed')
  })
})

describe('RunSupervisor — büdcə qoruması', () => {
  it('token limiti aşıldıqda icranı kəsir və budget_exceeded yazır', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({
        events: [
          { t: 'text', delta: 'a' },
          { t: 'usage', inputTokens: 0, outputTokens: 500, costUsd: 0 },
          { t: 'done', stopReason: 'end_turn' },
        ],
      }),
      model: 'm',
      prompt: 'p',
      limits: { maxOutputTokens: 10 },
    })

    expect(result.status).toBe('budget_exceeded')
    const row = listRunsForTask(db, task.id)[0]
    expect(row?.errorClass).toBe('budget_exceeded')

    // `done` hadisəsi jurnala DÜŞMƏMƏLİDİR — icra kəsilib
    const events = listEvents(db, result.runId)
    expect(events.some((e) => e.event.t === 'done')).toBe(false)
  })

  it('abunəlik icralarında dollar limiti icranı kəsmir', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const result = await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' }),
      model: 'm',
      prompt: 'p',
      subscriptionBilled: true,
      limits: { maxCostUsd: 0.000001 },
    })
    expect(result.status).toBe('succeeded')
  })
})

describe('RunSupervisor — dayandırma', () => {
  it('cancel() icranı interrupted edir', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    const runner = new FakeRunner({
      events: Array.from({ length: 50 }, (_, i) => ({ t: 'text' as const, delta: String(i) })),
      delayMs: 5,
    })

    const p = sup.execute({ taskId: task.id, runner, model: 'm', prompt: 'p' })
    await new Promise((r) => setTimeout(r, 30))
    const active = sup.activeRunIds()
    expect(active).toHaveLength(1)
    sup.cancel(active[0]!)

    const result = await p
    expect(result.status).toBe('interrupted')
  }, 15_000)

  it('icra bitdikdən sonra aktiv siyahıdan çıxır', async () => {
    const { db, task } = setup()
    const sup = new RunSupervisor(db)
    await sup.execute({
      taskId: task.id,
      runner: new FakeRunner({ events: [{ t: 'done', stopReason: 'end_turn' }] }),
      model: 'm',
      prompt: 'p',
    })
    expect(sup.activeRunIds()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/supervisor.test.ts`
Expected: FAIL — `Failed to resolve import "./supervisor.js"`

- [ ] **Step 3: Supervisor-u yaz**

`apps/server/src/exec/supervisor.ts`:

```ts
import type { ErrorClass, RunEvent, Runner } from '@orchestris/shared'
import type { Db } from '../db/client.js'
import {
  appendEvent,
  applyUsageToRun,
  createRun,
  finishRun,
  setTaskStatus,
  type StoredEvent,
} from '../db/repo.js'
import { BudgetGuard, type BudgetLimits } from './budget.js'

export type RunStatus = 'succeeded' | 'failed' | 'interrupted' | 'budget_exceeded'

export interface ExecuteInput {
  taskId: string
  runner: Runner
  model: string
  prompt: string
  cwd?: string
  resumeSessionId?: string
  subscriptionBilled?: boolean
  ladderRung?: number
  limits?: BudgetLimits
}

export interface ExecuteResult {
  runId: string
  status: RunStatus
  errorClass?: ErrorClass
  errorMessage?: string
}

export type EventListener = (runId: string, stored: StoredEvent) => void

/** Vaxt limiti bu intervalda yoxlanılır (ms). */
const CLOCK_CHECK_INTERVAL_MS = 1000

/**
 * Bir icranı başdan-sona idarə edir: runner-i işə salır, hadisələri DB-yə
 * yazır, dinləyicilərə ötürür, büdcəni yoxlayır və pozuntuda kəsir.
 *
 * `FakeRunner` ilə tam test olunur — sıfır token.
 */
export class RunSupervisor {
  private readonly listeners = new Set<EventListener>()
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly db: Db) {}

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  cancel(runId: string): boolean {
    const ac = this.active.get(runId)
    if (!ac) return false
    ac.abort()
    return true
  }

  cancelAll(): void {
    for (const ac of this.active.values()) ac.abort()
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const subscriptionBilled =
      input.subscriptionBilled ?? input.runner.capabilities.subscriptionBilled

    const run = createRun(this.db, {
      taskId: input.taskId,
      runnerId: input.runner.id,
      modelId: input.model,
      subscriptionBilled,
      ...(input.ladderRung !== undefined ? { ladderRung: input.ladderRung } : {}),
    })
    setTaskStatus(this.db, input.taskId, 'running')

    const ac = new AbortController()
    this.active.set(run.id, ac)

    const guard = new BudgetGuard({ ...input.limits, subscriptionBilled })
    const clock = setInterval(() => {
      if (guard.checkClock()) ac.abort()
    }, CLOCK_CHECK_INTERVAL_MS)

    let sessionId: string | undefined
    let sawDone = false
    let terminal: { status: RunStatus; cls?: ErrorClass; msg?: string } | null = null

    try {
      const stream = input.runner.run(
        {
          prompt: input.prompt,
          model: input.model,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        },
        { signal: ac.signal },
      )

      for await (const event of stream) {
        // Büdcə pozuntusu — hadisəni jurnala YAZMADAN kəsirik.
        const violation = guard.check(event)
        if (violation) {
          terminal = {
            status: 'budget_exceeded',
            cls: violation.class,
            msg: violation.message,
          }
          ac.abort()
          break
        }

        this.record(run.id, event)

        if (event.t === 'usage') applyUsageToRun(this.db, run.id, event)
        if (event.t === 'done') {
          sawDone = true
          sessionId = event.sessionId ?? sessionId
        }
        if (event.t === 'error' && !terminal) {
          terminal = { status: 'failed', cls: event.class as ErrorClass, msg: event.message }
        }

        if (ac.signal.aborted) break
      }

      if (!terminal) {
        if (ac.signal.aborted) {
          terminal = { status: 'interrupted', msg: 'İstifadəçi və ya vaxt limiti kəsdi' }
        } else if (!sawDone) {
          terminal = {
            status: 'failed',
            cls: 'crashed',
            msg: 'Axın `done` hadisəsi olmadan bitdi',
          }
        } else {
          terminal = { status: 'succeeded' }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      terminal = { status: 'failed', cls: 'crashed', msg }
      this.record(run.id, {
        t: 'error',
        class: 'crashed',
        message: msg,
        retryable: false,
      })
    } finally {
      clearInterval(clock)
      this.active.delete(run.id)
    }

    finishRun(this.db, run.id, {
      status: terminal.status,
      ...(sessionId ? { sessionId } : {}),
      ...(terminal.cls ? { errorClass: terminal.cls } : {}),
      ...(terminal.msg ? { errorMessage: terminal.msg } : {}),
    })
    setTaskStatus(
      this.db,
      input.taskId,
      terminal.status === 'succeeded' ? 'succeeded' : 'failed',
    )

    return {
      runId: run.id,
      status: terminal.status,
      ...(terminal.cls ? { errorClass: terminal.cls } : {}),
      ...(terminal.msg ? { errorMessage: terminal.msg } : {}),
    }
  }

  private record(runId: string, event: RunEvent): void {
    const stored = appendEvent(this.db, runId, event)
    for (const l of this.listeners) {
      try {
        l(runId, stored)
      } catch {
        // Bir dinləyicinin xətası icranı dayandırmamalıdır.
      }
    }
  }
}
```

- [ ] **Step 4: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/exec/supervisor.test.ts`
Expected: PASS — 9 test.

- [ ] **Step 5: Bütün server testlərini qaçır**

Run: `pnpm test`
Expected: PASS — 9 fayl, 90+ test. Sıfır token, sıfır şəbəkə sorğusu.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/exec/supervisor.ts apps/server/src/exec/supervisor.test.ts
git commit -m "feat(server): RunSupervisor — runner, büdcə, DB və dinləyiciləri birləşdirir

Büdcə pozuntusunda hadisə jurnala yazılmadan icra kəsilir.
`done` gəlmədən bitən axın failed sayılır — səssiz uğursuzluq olmasın."
```

---

## Task 15: REST route-lar və WebSocket hub

**Files:**
- Create: `packages/shared/src/api.ts`
- Create: `apps/server/src/ws/hub.ts`
- Create: `apps/server/src/routes/contexts.ts`
- Create: `apps/server/src/routes/tasks.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/main.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] **Step 1: Paylaşılan API sxemlərini yaz**

`packages/shared/src/api.ts`:

```ts
import { z } from 'zod'
import { RunEventSchema } from './events.js'

export const CreateContextBody = z.object({
  name: z.string().min(1).max(200),
  cwd: z.string().optional(),
  verifyCommands: z.array(z.string()).optional(),
})
export type CreateContextBody = z.infer<typeof CreateContextBody>

export const CreateTaskBody = z.object({
  contextId: z.string().min(1),
  prompt: z.string().min(1),
  /** `runner` boş buraxılsa server default CLI runner-i seçir */
  runner: z.enum(['cli:claude', 'cli:codex', 'fake']).optional(),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
})
export type CreateTaskBody = z.infer<typeof CreateTaskBody>

/** Klientdən serverə gedən WebSocket mesajları */
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), taskId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), taskId: z.string() }),
  z.object({ type: z.literal('cancel'), runId: z.string() }),
])
export type WsClientMessage = z.infer<typeof WsClientMessage>

/** Serverdən klientə gedən WebSocket mesajları */
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    taskId: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: z.number().int(),
    event: RunEventSchema,
  }),
  z.object({
    type: z.literal('run_status'),
    taskId: z.string(),
    runId: z.string(),
    status: z.string(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type WsServerMessage = z.infer<typeof WsServerMessage>
```

`packages/shared/src/index.ts` faylına əlavə et:

```ts
export * from './api.js'
```

- [ ] **Step 2: WebSocket hub-ı yaz**

`apps/server/src/ws/hub.ts`:

```ts
import type { WsServerMessage } from '@orchestris/shared'

export interface Socket {
  send(data: string): void
}

/**
 * Task-a görə abunəlik idarəsi. Bir socket bir neçə task izləyə bilər.
 *
 * Yayım YALNIZ abunə olan socket-lərə gedir — 50 task açıqdırsa hər hadisəni
 * hər socket-ə göndərmək lazımsız trafikdir.
 */
export class WsHub {
  private readonly byTask = new Map<string, Set<Socket>>()

  subscribe(taskId: string, socket: Socket): void {
    let set = this.byTask.get(taskId)
    if (!set) {
      set = new Set()
      this.byTask.set(taskId, set)
    }
    set.add(socket)
  }

  unsubscribe(taskId: string, socket: Socket): void {
    const set = this.byTask.get(taskId)
    if (!set) return
    set.delete(socket)
    if (set.size === 0) this.byTask.delete(taskId)
  }

  /** Socket bağlandıqda bütün abunəliklərini təmizləyir. */
  removeSocket(socket: Socket): void {
    for (const [taskId, set] of this.byTask) {
      set.delete(socket)
      if (set.size === 0) this.byTask.delete(taskId)
    }
  }

  subscriberCount(taskId: string): number {
    return this.byTask.get(taskId)?.size ?? 0
  }

  broadcast(taskId: string, message: WsServerMessage): void {
    const set = this.byTask.get(taskId)
    if (!set) return
    const payload = JSON.stringify(message)
    for (const socket of set) {
      try {
        socket.send(payload)
      } catch {
        // Bağlanmış socket — növbəti təmizləmədə silinəcək.
      }
    }
  }
}
```

- [ ] **Step 3: Uğursuz app testini yaz**

`apps/server/src/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { openDb } from './db/client.js'
import { FakeRunner } from './runners/fake.js'

function app() {
  const db = openDb(':memory:')
  const runners = new Map([
    ['fake', new FakeRunner({ fixture: 'claude-safe-mode.jsonl', flavor: 'claude' })],
  ])
  return buildApp({ db, runners })
}

describe('GET /api/health', () => {
  it('ok qaytarır', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })
})

describe('POST /api/contexts', () => {
  it('kontekst yaradır', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: 'Layihəm', verifyCommands: ['pnpm typecheck'] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('Layihəm')
    expect(body.id).toBeTruthy()
  })

  it('boş adı 400 ilə rədd edir', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/contexts',
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/contexts', () => {
  it('yaradılmış kontekstləri sadalayır', async () => {
    const a = app()
    await a.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'A' } })
    await a.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'B' } })
    const res = await a.inject({ method: 'GET', url: '/api/contexts' })
    expect(res.json()).toHaveLength(2)
  })
})

describe('POST /api/tasks', () => {
  it('taskı yaradır və icranı başladır', async () => {
    const a = app()
    const ctx = (
      await a.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json()

    const res = await a.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'salam', runner: 'fake', model: 'm' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().taskId).toBeTruthy()
  })

  it('mövcud olmayan kontekst üçün 404 verir', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: 'yoxdur', prompt: 'p', runner: 'fake', model: 'm' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('tanınmayan runner üçün 400 verir', async () => {
    const a = app()
    const ctx = (
      await a.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json()
    const res = await a.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { contextId: ctx.id, prompt: 'p', runner: 'cli:codex', model: 'm' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/tasks/:id', () => {
  it('task, run-lar və hadisələri qaytarır', async () => {
    const a = app()
    const ctx = (
      await a.inject({ method: 'POST', url: '/api/contexts', payload: { name: 'C' } })
    ).json()
    const created = (
      await a.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { contextId: ctx.id, prompt: 'p', runner: 'fake', model: 'm' },
      })
    ).json()

    // İcra fon rejimindədir — bitməsini gözləyirik
    await new Promise((r) => setTimeout(r, 200))

    const res = await a.inject({ method: 'GET', url: `/api/tasks/${created.taskId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.task.prompt).toBe('p')
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].events.length).toBeGreaterThan(2)
  })

  it('mövcud olmayan task üçün 404 verir', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/tasks/yoxdur' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/providers', () => {
  it('runner aşkarlama nəticələrini qaytarır', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/providers' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 'fake', installed: true })
  })
})
```

- [ ] **Step 4: Testi qaçır — uğursuz olduğunu təsdiqlə**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: FAIL — `Failed to resolve import "./app.js"`

- [ ] **Step 5: Route-ları yaz**

`apps/server/src/routes/contexts.ts`:

```ts
import { CreateContextBody } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createContext, listContexts } from '../db/repo.js'

export function registerContextRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/contexts', async () => listContexts(db))

  app.post('/api/contexts', async (req, reply) => {
    const parsed = CreateContextBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues })
    }
    const ctx = createContext(db, parsed.data)
    return reply.code(201).send(ctx)
  })
}
```

`apps/server/src/routes/tasks.ts`:

```ts
import { CreateTaskBody, type Runner } from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import {
  createTask,
  getContext,
  getTask,
  listEvents,
  listRunsForTask,
} from '../db/repo.js'
import type { RunSupervisor } from '../exec/supervisor.js'

export interface TaskRouteDeps {
  db: Db
  supervisor: RunSupervisor
  runners: ReadonlyMap<string, Runner>
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { db, supervisor, runners } = deps

  app.post('/api/tasks', async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    const body = parsed.data

    if (!getContext(db, body.contextId)) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }

    const runnerId = body.runner ?? [...runners.keys()][0]
    const runner = runnerId ? runners.get(runnerId) : undefined
    if (!runner) {
      return reply.code(400).send({
        error: `Runner mövcud deyil: ${runnerId ?? '(yoxdur)'}`,
        available: [...runners.keys()],
      })
    }

    const ctx = getContext(db, body.contextId)!
    const task = createTask(db, { contextId: body.contextId, prompt: body.prompt })

    // İcra fon rejimində gedir — HTTP cavabı gözləmir. Vəziyyət WebSocket
    // və `GET /api/tasks/:id` vasitəsilə izlənilir.
    void supervisor
      .execute({
        taskId: task.id,
        runner,
        model: body.model,
        prompt: body.prompt,
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        limits: {
          ...(body.maxOutputTokens !== undefined
            ? { maxOutputTokens: body.maxOutputTokens }
            : ctx.budgetTokens !== null
              ? { maxOutputTokens: ctx.budgetTokens }
              : {}),
          ...(body.maxSeconds !== undefined
            ? { maxSeconds: body.maxSeconds }
            : ctx.budgetSeconds !== null
              ? { maxSeconds: ctx.budgetSeconds }
              : {}),
          ...(body.maxCostUsd !== undefined
            ? { maxCostUsd: body.maxCostUsd }
            : ctx.budgetUsd !== null
              ? { maxCostUsd: ctx.budgetUsd }
              : {}),
        },
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'supervisor.execute tutulmamış xəta')
      })

    return reply.code(202).send({ taskId: task.id })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (!task) return reply.code(404).send({ error: 'Task tapılmadı' })

    const runRows = listRunsForTask(db, task.id).map((r) => ({
      ...r,
      events: listEvents(db, r.id),
    }))
    return { task, runs: runRows }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (!task) return reply.code(404).send({ error: 'Task tapılmadı' })

    const cancelled = listRunsForTask(db, task.id)
      .filter((r) => r.status === 'running')
      .filter((r) => supervisor.cancel(r.id))
      .map((r) => r.id)

    return { cancelled }
  })

  app.get('/api/providers', async () =>
    Promise.all(
      [...runners.entries()].map(async ([id, runner]) => ({
        id,
        kind: runner.kind,
        capabilities: runner.capabilities,
        ...(await runner.detect()),
      })),
    ),
  )
}
```

- [ ] **Step 6: App-ı yaz**

`apps/server/src/app.ts`:

```ts
import { WsClientMessage, type Runner } from '@orchestris/shared'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { getTask, markOrphanedRunsInterrupted } from './db/repo.js'
import { RunSupervisor } from './exec/supervisor.js'
import { registerContextRoutes } from './routes/contexts.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { WsHub } from './ws/hub.js'

export interface BuildAppInput {
  db: Db
  runners: ReadonlyMap<string, Runner>
  logger?: boolean
}

export function buildApp(input: BuildAppInput): FastifyInstance {
  const app = Fastify({ logger: input.logger ?? false })
  const { db, runners } = input

  // Server çökdükdən sonra qalan yetim icraları təmizlə.
  const orphans = markOrphanedRunsInterrupted(db)
  if (orphans > 0) app.log.warn(`${orphans} yetim icra interrupted işarələndi`)

  const hub = new WsHub()
  const supervisor = new RunSupervisor(db)

  // Hər hadisəni abunə socket-lərə yayımla. runId → taskId çevirməsi üçün
  // run sətrinə baxmaq lazımdır; kiçik keş bunu ucuz saxlayır.
  const runToTask = new Map<string, string>()
  supervisor.onEvent((runId, stored) => {
    let taskId = runToTask.get(runId)
    if (!taskId) {
      const row = db
        .select()
        .from(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (db as any)._.fullSchema.runs,
        )
        .all()
        .find((r: { id: string }) => r.id === runId) as { taskId?: string } | undefined
      taskId = row?.taskId
      if (taskId) runToTask.set(runId, taskId)
    }
    if (!taskId) return
    hub.broadcast(taskId, {
      type: 'event',
      taskId,
      runId,
      seq: stored.seq,
      at: stored.at,
      event: stored.event,
    })
  })

  app.get('/api/health', async () => ({ ok: true, runners: [...runners.keys()] }))

  registerContextRoutes(app, db)
  registerTaskRoutes(app, { db, supervisor, runners })

  void app.register(websocket)
  void app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (conn) => {
      const socket = { send: (data: string) => conn.send(data) }

      conn.on('message', (raw: Buffer) => {
        let msg: WsClientMessage
        try {
          msg = WsClientMessage.parse(JSON.parse(raw.toString('utf8')))
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Yanlış mesaj formatı' }))
          return
        }

        if (msg.type === 'subscribe') {
          if (!getTask(db, msg.taskId)) {
            socket.send(JSON.stringify({ type: 'error', message: 'Task tapılmadı' }))
            return
          }
          hub.subscribe(msg.taskId, socket)
        } else if (msg.type === 'unsubscribe') {
          hub.unsubscribe(msg.taskId, socket)
        } else {
          supervisor.cancel(msg.runId)
        }
      })

      conn.on('close', () => hub.removeSocket(socket))
    })
  })

  app.addHook('onClose', async () => supervisor.cancelAll())

  return app
}
```

**Qeyd:** yuxarıdaki `runToTask` axtarışı Drizzle-ın daxili sxeminə toxunur və
kövrəkdir. Step 7-də onu təmiz repo funksiyası ilə əvəz edirik.

- [ ] **Step 7: `runToTask` axtarışını təmiz repo funksiyası ilə əvəz et**

`apps/server/src/db/repo.ts` faylına əlavə et:

```ts
export function getRunTaskId(db: Db, runId: string): string | undefined {
  return db
    .select({ taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, runId))
    .get()?.taskId
}
```

`apps/server/src/app.ts`-də importu genişləndir və hadisə dinləyicisini sadələşdir:

```ts
import { getRunTaskId, getTask, markOrphanedRunsInterrupted } from './db/repo.js'
```

```ts
  const runToTask = new Map<string, string>()
  supervisor.onEvent((runId, stored) => {
    let taskId = runToTask.get(runId)
    if (!taskId) {
      taskId = getRunTaskId(db, runId)
      if (taskId) runToTask.set(runId, taskId)
    }
    if (!taskId) return
    hub.broadcast(taskId, {
      type: 'event',
      taskId,
      runId,
      seq: stored.seq,
      at: stored.at,
      event: stored.event,
    })
  })
```

- [ ] **Step 8: Giriş nöqtəsini yaz**

`apps/server/src/main.ts`:

```ts
import type { Runner } from '@orchestris/shared'
import { buildApp } from './app.js'
import { openDb } from './db/client.js'
import { ClaudeCliRunner } from './runners/claude.js'
import { CodexCliRunner } from './runners/codex.js'

const PORT = Number(process.env['PORT'] ?? 4319)

const db = openDb()
const runners = new Map<string, Runner>([
  ['cli:claude', new ClaudeCliRunner({ permissionMode: 'acceptEdits' })],
  ['cli:codex', new CodexCliRunner()],
])

const app = buildApp({ db, runners, logger: true })

// Yalnız 127.0.0.1 — xarici şəbəkəyə açılmır (spesifikasiya tələbi).
await app.listen({ port: PORT, host: '127.0.0.1' })
app.log.info(`Orchestris http://127.0.0.1:${PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}
```

- [ ] **Step 9: Testi qaçır — keçdiyini təsdiqlə**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: PASS — 10 test.

Run: `pnpm test`
Expected: PASS — 10 fayl, 100+ test.

- [ ] **Step 10: WebSocket hub üçün ayrıca test yaz**

`apps/server/src/ws/hub.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { WsHub } from './hub.js'

const sock = () => ({ send: vi.fn() })

describe('WsHub', () => {
  it('yalnız abunə socket-lərə yayımlayır', () => {
    const hub = new WsHub()
    const a = sock()
    const b = sock()
    hub.subscribe('task-1', a)
    hub.subscribe('task-2', b)

    hub.broadcast('task-1', { type: 'error', message: 'x' })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(b.send).not.toHaveBeenCalled()
  })

  it('unsubscribe abunəliyi silir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t', a)
    hub.unsubscribe('t', a)
    hub.broadcast('t', { type: 'error', message: 'x' })
    expect(a.send).not.toHaveBeenCalled()
    expect(hub.subscriberCount('t')).toBe(0)
  })

  it('removeSocket bütün abunəlikləri təmizləyir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t1', a)
    hub.subscribe('t2', a)
    hub.removeSocket(a)
    expect(hub.subscriberCount('t1')).toBe(0)
    expect(hub.subscriberCount('t2')).toBe(0)
  })

  it('bir socket-in send xətası digərlərini bloklamır', () => {
    const hub = new WsHub()
    const bad = { send: vi.fn(() => { throw new Error('qırıldı') }) }
    const good = sock()
    hub.subscribe('t', bad)
    hub.subscribe('t', good)
    expect(() => hub.broadcast('t', { type: 'error', message: 'x' })).not.toThrow()
    expect(good.send).toHaveBeenCalledTimes(1)
  })

  it('abunəsi olmayan task üçün yayım heç nə etmir', () => {
    const hub = new WsHub()
    expect(() => hub.broadcast('yoxdur', { type: 'error', message: 'x' })).not.toThrow()
  })
})
```

Run: `pnpm vitest run apps/server/src/ws/hub.test.ts`
Expected: PASS — 5 test.

- [ ] **Step 11: Serveri real işə sal və yoxla**

Terminal 1: `pnpm --filter @orchestris/server dev`
Expected: `Orchestris http://127.0.0.1:4319`

Terminal 2:

```bash
curl -s http://127.0.0.1:4319/api/health
curl -s http://127.0.0.1:4319/api/providers | python -m json.tool
```

Expected: `health` → `{"ok":true,...}`. `providers` → `cli:claude` üçün
`installed: true, authenticated: true`; `cli:codex` üçün `authenticated: false`
və `"Login olunmayıb — terminalda \`codex login\` işlət"`.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/api.ts packages/shared/src/index.ts apps/server/src
git commit -m "feat(server): REST route-lar, WebSocket hub, app bootstrap

Task icrası fon rejimindədir (202 Accepted), vəziyyət WS ilə izlənilir.
Server yalnız 127.0.0.1-ə bind olunur. Start-da yetim icralar təmizlənir."
```

---

## Task 16: Web UI — Vite + React + Tailwind skeleti

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/index.css`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/Sidebar.tsx`
- Create: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Paket və Vite konfiqurasiyası**

`apps/web/package.json`:

```json
{
  "name": "@orchestris/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@orchestris/shared": "workspace:*",
    "@tanstack/react-query": "^5.62.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = 'http://127.0.0.1:4319'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5319,
    // Proxy sayəsində frontend eyni origin-dən danışır — CORS lazım deyil.
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
})
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: HTML və giriş nöqtəsi**

`apps/web/index.html`:

```html
<!doctype html>
<html lang="az" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orchestris</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`:

```css
@import 'tailwindcss';

@theme {
  --color-surface: oklch(0.18 0.01 260);
  --color-surface-2: oklch(0.23 0.012 260);
  --color-ink: oklch(0.93 0.005 260);
  --color-ink-dim: oklch(0.68 0.01 260);
  --color-accent: oklch(0.72 0.14 195);
  --color-warn: oklch(0.75 0.15 70);
  --color-bad: oklch(0.65 0.19 25);
  --color-good: oklch(0.72 0.16 150);
}

body {
  @apply bg-surface text-ink antialiased;
}
```

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.js'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
})

const root = document.getElementById('root')
if (!root) throw new Error('#root tapılmadı')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: REST klienti yaz**

`apps/web/src/lib/api.ts`:

```ts
import type { CreateContextBody, CreateTaskBody, RunEvent } from '@orchestris/shared'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${url}: ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

export interface ContextRow {
  id: string
  name: string
  cwd: string | null
  amplificationProfile: string
  workerMode: string
  maxParallel: number
  createdAt: number
}

export interface ProviderRow {
  id: string
  kind: string
  installed: boolean
  authenticated: boolean
  version?: string
  execPath?: string
  detail: string
}

export interface StoredEventRow {
  seq: number
  at: number
  event: RunEvent
}

export interface RunRow {
  id: string
  runnerId: string
  modelId: string
  status: string
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  costUsd: number
  subscriptionBilled: boolean
  errorClass: string | null
  errorMessage: string | null
  startedAt: number
  endedAt: number | null
  events: StoredEventRow[]
}

export interface TaskDetail {
  task: { id: string; prompt: string; status: string; createdAt: number }
  runs: RunRow[]
}

export const api = {
  health: () => request<{ ok: boolean; runners: string[] }>('/api/health'),
  listContexts: () => request<ContextRow[]>('/api/contexts'),
  createContext: (body: CreateContextBody) =>
    request<ContextRow>('/api/contexts', { method: 'POST', body: JSON.stringify(body) }),
  listProviders: () => request<ProviderRow[]>('/api/providers'),
  createTask: (body: CreateTaskBody) =>
    request<{ taskId: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  getTask: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  cancelTask: (id: string) =>
    request<{ cancelled: string[] }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
}
```

- [ ] **Step 4: Sidebar və App**

`apps/web/src/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom'

const LINKS = [
  { to: '/', label: 'İdarə paneli' },
  { to: '/contexts', label: 'Kontekstlər' },
  { to: '/providers', label: 'Provayderlər' },
] as const

export default function Sidebar(): React.JSX.Element {
  return (
    <nav className="w-56 shrink-0 border-r border-white/10 bg-surface-2 p-4">
      <div className="mb-6 text-lg font-semibold tracking-tight">Orchestris</div>
      <ul className="space-y-1">
        {LINKS.map((l) => (
          <li key={l.to}>
            <NavLink
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm transition ${
                  isActive ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-white/5'
                }`
              }
            >
              {l.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

`apps/web/src/App.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar.js'
import Contexts from './pages/Contexts.js'
import Dashboard from './pages/Dashboard.js'
import Providers from './pages/Providers.js'
import TaskView from './pages/TaskView.js'

export default function App(): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-x-hidden p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contexts" element={<Contexts />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/tasks/:id" element={<TaskView />} />
        </Routes>
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): Vite + React + Tailwind skeleti, REST klienti"
```

---

## Task 17: Canlı icra səhifəsi

**Files:**
- Create: `apps/web/src/lib/useRunStream.ts`
- Create: `apps/web/src/components/EventTimeline.tsx`
- Create: `apps/web/src/components/UsageBadge.tsx`
- Create: `apps/web/src/pages/Dashboard.tsx`
- Create: `apps/web/src/pages/Contexts.tsx`
- Create: `apps/web/src/pages/Providers.tsx`
- Create: `apps/web/src/pages/TaskView.tsx`

- [ ] **Step 1: WebSocket hook-u yaz**

`apps/web/src/lib/useRunStream.ts`:

```ts
import type { WsServerMessage } from '@orchestris/shared'
import { useEffect, useRef, useState } from 'react'
import type { StoredEventRow } from './api.js'

export interface LiveRun {
  runId: string
  events: StoredEventRow[]
}

/**
 * Task-a WebSocket ilə abunə olur və hadisələri run-a görə qruplaşdırır.
 *
 * `seq` unikaldır — təkrar gələn hadisə (yenidən qoşulma halında) atılır.
 */
export function useRunStream(taskId: string | undefined): {
  runs: Map<string, LiveRun>
  connected: boolean
} {
  const [runs, setRuns] = useState<Map<string, LiveRun>>(new Map())
  const [connected, setConnected] = useState(false)
  const seenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!taskId) return
    seenRef.current = new Set()
    setRuns(new Map())

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'subscribe', taskId }))
    }
    ws.onclose = () => setConnected(false)

    ws.onmessage = (raw: MessageEvent<string>) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(raw.data) as WsServerMessage
      } catch {
        return
      }
      if (msg.type !== 'event') return

      const key = `${msg.runId}#${msg.seq}`
      if (seenRef.current.has(key)) return
      seenRef.current.add(key)

      setRuns((prev) => {
        const next = new Map(prev)
        const existing = next.get(msg.runId) ?? { runId: msg.runId, events: [] }
        next.set(msg.runId, {
          runId: msg.runId,
          events: [...existing.events, { seq: msg.seq, at: msg.at, event: msg.event }],
        })
        return next
      })
    }

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', taskId }))
      }
      ws.close()
    }
  }, [taskId])

  return { runs, connected }
}
```

- [ ] **Step 2: Hadisə timeline komponentini yaz**

`apps/web/src/components/EventTimeline.tsx`:

```tsx
import type { RunEvent } from '@orchestris/shared'
import { useState } from 'react'
import type { StoredEventRow } from '../lib/api.js'

const LABEL: Record<RunEvent['t'], string> = {
  text: 'Cavab',
  think: 'Düşünmə',
  tool: 'Alət',
  result: 'Alət nəticəsi',
  usage: 'İstifadə',
  rate_limit: 'Limit',
  done: 'Bitdi',
  error: 'Xəta',
}

const TONE: Record<RunEvent['t'], string> = {
  text: 'text-ink',
  think: 'text-ink-dim italic',
  tool: 'text-accent',
  result: 'text-ink-dim',
  usage: 'text-ink-dim',
  rate_limit: 'text-warn',
  done: 'text-good',
  error: 'text-bad',
}

function summary(e: RunEvent): string {
  switch (e.t) {
    case 'text':
    case 'think':
      return e.delta
    case 'tool':
      return `${e.name}(${JSON.stringify(e.input).slice(0, 120)})`
    case 'result':
      return `${e.ok ? 'OK' : 'XƏTA'} — ${(e.output ?? '').slice(0, 160)}`
    case 'usage':
      return `giriş ${e.inputTokens} · çıxış ${e.outputTokens} · keş oxunuş ${
        e.cacheReadTokens ?? 0
      } · $${e.costUsd.toFixed(5)}`
    case 'rate_limit':
      return `${e.limitType}: ${e.status}`
    case 'done':
      return e.stopReason
    case 'error':
      return `[${e.class}] ${e.message}`
  }
}

export default function EventTimeline({
  events,
}: {
  events: readonly StoredEventRow[]
}): React.JSX.Element {
  const [showThinking, setShowThinking] = useState(false)
  const visible = showThinking ? events : events.filter((r) => r.event.t !== 'think')

  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          checked={showThinking}
          onChange={(e) => setShowThinking(e.target.checked)}
        />
        Düşünmə addımlarını göstər
      </label>

      <ol className="space-y-1 font-mono text-xs">
        {visible.map((row) => (
          <li key={row.seq} className="flex gap-2">
            <span className="w-10 shrink-0 text-right text-ink-dim">{row.seq}</span>
            <span className="w-24 shrink-0 text-ink-dim">{LABEL[row.event.t]}</span>
            <span className={`min-w-0 break-words ${TONE[row.event.t]}`}>
              {summary(row.event)}
            </span>
          </li>
        ))}
      </ol>

      {visible.length === 0 && (
        <p className="text-sm text-ink-dim">Hələ hadisə yoxdur.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: UsageBadge komponentini yaz**

`apps/web/src/components/UsageBadge.tsx`:

```tsx
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
      <span title="Keşdən oxunan nisbət — yüksək olması yaxşıdır (10x ucuzdur)">
        keş effektivliyi {cacheHitPct}%
      </span>
      <span className={run.subscriptionBilled ? 'text-good' : 'text-ink'}>
        {run.subscriptionBilled
          ? `abunəlik (istinad $${run.costUsd.toFixed(5)})`
          : `$${run.costUsd.toFixed(5)}`}
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Providers səhifəsini yaz**

`apps/web/src/pages/Providers.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'

export default function Providers(): React.JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['providers'],
    queryFn: api.listProviders,
  })

  if (isLoading) return <p className="text-ink-dim">Aşkarlanır…</p>
  if (error) return <p className="text-bad">{String(error)}</p>

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Provayderlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Lokal CLI-lar avtomatik aşkarlanır və sənin abunəliyindən istifadə edir.
      </p>

      <div className="space-y-3">
        {data?.map((p) => (
          <div key={p.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="font-medium">{p.id}</div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  p.authenticated
                    ? 'bg-good/15 text-good'
                    : p.installed
                      ? 'bg-warn/15 text-warn'
                      : 'bg-bad/15 text-bad'
                }`}
              >
                {p.authenticated ? 'hazır' : p.installed ? 'login lazımdır' : 'quraşdırılmayıb'}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-dim">{p.detail}</p>
            {p.version && (
              <p className="mt-1 font-mono text-xs text-ink-dim">{p.version}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Contexts səhifəsini yaz**

`apps/web/src/pages/Contexts.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

export default function Contexts(): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')

  const { data } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })

  const create = useMutation({
    mutationFn: () =>
      api.createContext({ name, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }),
    onSuccess: () => {
      setName('')
      setCwd('')
      void qc.invalidateQueries({ queryKey: ['contexts'] })
    },
  })

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Kontekstlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Hər kontekst öz iş qovluğu, büdcəsi və yoxlama əmrləri ilə ayrı iş sahəsidir.
      </p>

      <form
        className="mb-8 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create.mutate()
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Ad
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Layihəm"
            className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          İş qovluğu (opsional)
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\\Users\\me\\proj"
            className="w-80 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {create.isPending ? 'Yaradılır…' : 'Yarat'}
        </button>
      </form>

      {create.error && <p className="mb-4 text-sm text-bad">{String(create.error)}</p>}

      <ul className="space-y-2">
        {data?.map((c) => (
          <li key={c.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
            <div className="font-medium">{c.name}</div>
            <div className="mt-1 font-mono text-xs text-ink-dim">
              {c.cwd ?? '(iş qovluğu yoxdur)'}
            </div>
            <div className="mt-1 text-xs text-ink-dim">
              profil: {c.amplificationProfile} · işçi rejimi: {c.workerMode}
            </div>
          </li>
        ))}
      </ul>

      {data?.length === 0 && (
        <p className="text-sm text-ink-dim">Hələ kontekst yoxdur.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Dashboard səhifəsini yaz**

`apps/web/src/pages/Dashboard.tsx`:

```tsx
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'

export default function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const [contextId, setContextId] = useState('')
  const [runner, setRunner] = useState<'cli:claude' | 'cli:codex'>('cli:claude')
  const [model, setModel] = useState('claude-haiku-4-5-20251001')
  const [prompt, setPrompt] = useState('')

  const { data: contexts } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders })

  const submit = useMutation({
    mutationFn: () =>
      api.createTask({
        contextId,
        prompt,
        runner,
        model,
        // Sərt limit: ilk versiyada hər task ən çox 30k output token və 10 dəqiqə.
        maxOutputTokens: 30_000,
        maxSeconds: 600,
      }),
    onSuccess: (r) => navigate(`/tasks/${r.taskId}`),
  })

  const selectedProvider = providers?.find((p) => p.id === runner)
  const blocked = selectedProvider !== undefined && !selectedProvider.authenticated

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">İdarə paneli</h1>
      <p className="mb-6 text-sm text-ink-dim">Yeni task başlat və canlı izlə.</p>

      <form
        className="space-y-4 rounded-lg border border-white/10 bg-surface-2 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (contextId && prompt.trim() && !blocked) submit.mutate()
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Kontekst
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">— seç —</option>
              {contexts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            İşçi
            <select
              value={runner}
              onChange={(e) => setRunner(e.target.value as typeof runner)}
              className="w-44 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="cli:claude">cli:claude</option>
              <option value="cli:codex">cli:codex</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Model
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-72 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Task
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Bu funksiyaya test yaz…"
            className="w-full rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        {blocked && (
          <p className="text-sm text-warn">
            {runner} hazır deyil: {selectedProvider?.detail}
          </p>
        )}

        <button
          type="submit"
          disabled={!contextId || !prompt.trim() || blocked || submit.isPending}
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {submit.isPending ? 'Başladılır…' : 'İşə sal'}
        </button>

        {submit.error && <p className="text-sm text-bad">{String(submit.error)}</p>}
      </form>
    </div>
  )
}
```

- [ ] **Step 7: TaskView səhifəsini yaz**

`apps/web/src/pages/TaskView.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import EventTimeline from '../components/EventTimeline.js'
import UsageBadge from '../components/UsageBadge.js'
import { api, type StoredEventRow } from '../lib/api.js'
import { useRunStream } from '../lib/useRunStream.js'

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'budget_exceeded'])

export default function TaskView(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const { runs: live, connected } = useRunStream(id)

  const { data, error } = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.getTask(id!),
    enabled: Boolean(id),
    // Fon icrası bitənə qədər qısa interval; sonra dayanır.
    refetchInterval: (q) =>
      q.state.data?.runs.every((r) => TERMINAL.has(r.status)) ? false : 1500,
  })

  if (error) return <p className="text-bad">{String(error)}</p>
  if (!data) return <p className="text-ink-dim">Yüklənir…</p>

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Task</h1>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-dim">
            {data.task.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={`text-xs ${connected ? 'text-good' : 'text-ink-dim'}`}>
            {connected ? '● canlı' : '○ bağlı deyil'}
          </span>
          {!TERMINAL.has(data.task.status) && (
            <button
              onClick={() => void api.cancelTask(data.task.id)}
              className="rounded bg-bad/15 px-3 py-1.5 text-xs text-bad"
            >
              Dayandır
            </button>
          )}
        </div>
      </div>

      <div className="space-y-5">
        {data.runs.map((run) => {
          // DB-dən gələn hadisələr + WS-dən gələn yeni hadisələr birləşdirilir.
          // `seq` unikaldır, ona görə dublikatları asanca atırıq.
          const seen = new Set(run.events.map((e) => e.seq))
          const extra = (live.get(run.id)?.events ?? []).filter((e) => !seen.has(e.seq))
          const merged: StoredEventRow[] = [...run.events, ...extra].sort(
            (a, b) => a.seq - b.seq,
          )

          return (
            <section key={run.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
              <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">{run.runnerId}</span>
                  <span className="text-ink-dim"> · {run.modelId}</span>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    run.status === 'succeeded'
                      ? 'bg-good/15 text-good'
                      : run.status === 'running'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bad/15 text-bad'
                  }`}
                >
                  {run.status}
                </span>
              </header>

              <div className="mb-3">
                <UsageBadge run={run} />
              </div>

              {run.errorMessage && (
                <p className="mb-3 rounded bg-bad/10 p-2 font-mono text-xs text-bad">
                  [{run.errorClass}] {run.errorMessage}
                </p>
              )}

              <EventTimeline events={merged} />
            </section>
          )
        })}
      </div>

      {data.runs.length === 0 && (
        <p className="text-sm text-ink-dim">İcra hələ başlamayıb.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 8: Tipləri yoxla**

Run: `pnpm install && pnpm --filter @orchestris/web typecheck`
Expected: xəta yoxdur.

- [ ] **Step 9: Uçdan-uca əl ilə yoxla**

Terminal 1: `pnpm --filter @orchestris/server dev`
Terminal 2: `pnpm --filter @orchestris/web dev`

Brauzerdə `http://127.0.0.1:5319` aç və bu ardıcıllığı yerinə yetir:

1. `/providers` → `cli:claude` **hazır**, `cli:codex` **login lazımdır** görünür.
2. `/contexts` → "Test" adlı kontekst yarat.
3. `/` → kontekst seç, model `claude-haiku-4-5-20251001`, task:
   `Yalnız bu sözü yaz: SALAM`. "İşə sal" bas.
4. `/tasks/:id` səhifəsinə keçir. `● canlı` görünür, hadisələr axır, sonunda
   `SALAM` mətn hadisəsi və `usage` sətri (`keş effektivliyi %`) görünür.

**Bu addım real token xərcləyir** (Haiku ilə ~$0.01). Faza 1A-nın bitmə
kriteriyası budur.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): canlı icra səhifəsi, dashboard, kontekstlər, provayderlər

WebSocket hadisələri DB-dən gələnlərlə seq üzrə birləşdirilir — dublikat yox.
UsageBadge keş effektivliyini göstərir (keş oxunuşu 10x ucuzdur)."
```

---

## Task 18: Codex uğur fixture-i (istifadəçi hərəkəti tələb edir)

**⚠️ BLOKLANMIŞ:** Bu task `codex login` tələb edir. Onsuz codex-in uğurlu
hadisə formaları bilinmir və parser-in uğur yolu **yoxlanılmamış qalır**.
Task 8 xəta yolunu tam örtür, bu task uğur yolunu tamamlayır.

**Files:**
- Create: `fixtures/cli/codex-success.jsonl`
- Modify: `apps/server/src/runners/parse-codex.ts` (yalnız uyğunsuzluq varsa)
- Modify: `apps/server/src/runners/parse-codex.test.ts`

- [ ] **Step 1: İstifadəçidən login xahiş et**

İstifadəçi terminalda işlətməlidir:

```
codex login
```

Yoxla: `codex login status` → "Not logged in" **olmamalıdır**.

Login mümkün deyilsə bu task atlanır və `CodexCliRunner` `authenticated: false`
qaytarmağa davam edir — sistem `cli:claude` ilə tam işləkdir.

- [ ] **Step 2: Uğur fixture-ini tut**

```bash
codex exec --json --sandbox read-only --skip-git-repo-check \
  'Yalniz bu sozu yaz: SALAM' < /dev/null > /tmp/codex-raw.jsonl 2>&1
python fixtures/sanitize.py /tmp/codex-raw.jsonl fixtures/cli/codex-success.jsonl
```

- [ ] **Step 3: Sızma yoxlaması**

```bash
grep -riE '<istifadəçi-adın>|<email-in>|Users' fixtures/cli/codex-success.jsonl && echo "SIZMA VAR" || echo "OK"
```

Expected: `OK`. Sızma varsa `fixtures/sanitize.py`-də `REDACT_FIELDS`-ə yeni
sahə əlavə et və yenidən təmizlə.

- [ ] **Step 4: Real hadisə tiplərini sadala**

```bash
python - <<'PY'
import json, collections
c = collections.Counter()
for line in open('fixtures/cli/codex-success.jsonl', encoding='utf8'):
    line = line.strip()
    if not line.startswith('{'): c['<non-json>'] += 1; continue
    o = json.loads(line)
    t = o.get('type')
    if t == 'item.completed': t += f":{(o.get('item') or {}).get('type')}"
    c[t] += 1
for k, v in c.most_common(): print(f"{v:>3}  {k}")
PY
```

Bu siyahını Task 8-də yazılmış `CodexStreamParser`-in `onItem` switch-i ilə
müqayisə et. Uyğunsuzluq varsa (məs. `agent_message` əvəzinə başqa ad) parser-i
real adlara uyğunlaşdır.

- [ ] **Step 5: Fixture testi əlavə et**

`apps/server/src/runners/parse-codex.test.ts` faylının sonuna:

```ts
describe('CodexStreamParser — uğur fixture-i', () => {
  it('mətn cavabını çıxarır', () => {
    const { events } = parseFixture('codex-success.jsonl')
    const texts = events.filter((e) => e.t === 'text')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.map((e) => (e.t === 'text' ? e.delta : '')).join('')).toContain('SALAM')
  })

  it('usage və done hadisələrini verir', () => {
    const { events } = parseFixture('codex-success.jsonl')
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
    expect(events.filter((e) => e.t === 'done')).toHaveLength(1)
  })

  it('heç bir xəta hadisəsi vermir', () => {
    const { events } = parseFixture('codex-success.jsonl')
    expect(events.filter((e) => e.t === 'error')).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Testi qaçır**

Run: `pnpm vitest run apps/server/src/runners/parse-codex.test.ts`
Expected: PASS — 14 test.

- [ ] **Step 7: Commit**

```bash
git add fixtures/cli/codex-success.jsonl apps/server/src/runners/parse-codex.ts apps/server/src/runners/parse-codex.test.ts
git commit -m "test(server): codex uğur fixture-i və parser təsdiqi"
```

---

## Task 19: `CLAUDE.md` və yekun yoxlama

**Files:**
- Create: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: `CLAUDE.md` yaz**

````markdown
# Orchestris — Layihə Təlimatı

Lokal AI orkestrasiya sistemi. **Əsas məqsəd:** zəif/ucuz modelləri işlədərək
güclü modelin performansını əldə etmək. Hər qərar buna tabedir.

Dizayn: `docs/superpowers/specs/2026-07-26-orchestris-design.md`

## Quruluş

```
packages/shared/     Zod sxemləri + Runner interfeysi (server və web üçün tək mənbə)
apps/server/         Fastify — CLI spawn, parse, SQLite, WebSocket
apps/web/            Vite + React + Tailwind
fixtures/cli/        Real CLI çıxışları (təmizlənmiş) — parser testləri üçün
```

## Əmrlər

```bash
pnpm install
pnpm test                                  # bütün testlər — SIFIR token xərcləyir
pnpm typecheck
pnpm --filter @orchestris/server dev       # http://127.0.0.1:4319
pnpm --filter @orchestris/web dev          # http://127.0.0.1:5319
```

## Dəyişməz qaydalar

### 1. `CLAUDE_STABLE_FLAGS`-a toxunma

`apps/server/src/runners/claude.ts`-dəki bayraq dəsti **sabitdir**.

Ölçülmüş səbəb: prompt prefiksi dəyişəndə Anthropic prompt-cache-i sınır və
~21.7k token `cache_creation` tarifi (1.25x) ilə yenidən ödənilir. Ölçmədə öz
`--system-prompt`-unu vermək promptu KİÇİLTDİ, amma xərci **5x ARTIRDI**
($0.0085 → $0.0444).

Task-a xas heç nə sistem promptuna girmir — yalnız istifadəçi mesajına.

### 2. `usage` kumulyativdir — heç vaxt toplama

`claude` hər `assistant` hadisəsində və `result` sətrində yekun `usage` verir.
Onları toplamaq tokenləri ikiqat sayar. Qayda:
- Parser `usage`-i YALNIZ `result` sətrindən emit edir
- `applyUsageToRun` `+=` deyil, `=` istifadə edir
- `BudgetGuard.check` mütləq dəyəri müqayisə edir

### 3. `--bare` istifadə etmə

O, OAuth və keychain oxumasını söndürür → abunəlik işləmir
(`apiKeySource: "none"`, `is_error: true`). Fərdiləşdirmə overhead-ini
söndürmək üçün `--safe-mode` işlədilir — o auth-u saxlayır.

### 4. Proses ağacını öldür, prosesi yox

Windows-da shim-i öldürmək uşaq `.exe`-ni öldürmür — o işləməyə davam edir və
**token yandırır**. Hər cancel/timeout yolunda `taskkill /T /F` işlədilir
(`spawn.ts` → `kill()`).

### 5. `codex exec` üçün stdin bağlı olmalıdır

Açıq stdin ilə codex "Reading additional input from stdin..." deyib əbədi
donur. `spawnLines` `stdio: ['ignore', 'pipe', 'pipe']` istifadə edir.

### 6. Codex stderr-i JSON axınına qarışdırır

JSON olmayan sətirlər **atılır**, `parse_error` yaradılmır. Yoxsa hər Rust log
sətri xəta kimi görünərdi.

### 7. Testlər token xərcləməməlidir

Yeni funksionallıq `FakeRunner` + `fixtures/cli/` ilə test olunur. Real CLI
çağırışı yalnız `ORCHESTRIS_E2E=1` bayrağı arxasında ola bilər.

Fixture yeniləyəndə həmişə `fixtures/sanitize.py`-dən keçir — o, şəxsi
konfiqurasiyanı (CLAUDE.md, hook çıxışı, MCP adları, yollar, session ID)
təmizləyir.

### 8. API açarları OS keychain-də saxlanılır

`~/.orchestris/` içinə və ya `.env`-ə **heç vaxt** yazılmır. DB-də yalnız
`credential_ref`.

### 9. Server yalnız 127.0.0.1-ə bind olunur

Xarici şəbəkəyə açılmır.

## Amplification Ladder (Faza 2+)

Pillələr ucuzdan bahaya: cache → qayda routing → **zəif model + alət
yoxlaması** → best-of-N razılaşma → ipucu (10-30% prefiks) → plan güclü/icra
zəif → self-escalation → tam güclü model.

Ən vacib pillə **alət-əsaslı yoxlamadır** (`tsc`/`eslint`/`test`, 0 token):
araşdırma göstərir ki, kiçik modellər öz-özünü yoxlamaqda pisdir, ona görə
yoxlama determinist alətlərə verilir. Bu, 1B modelin 8B-ni üstələməsinə imkan
verir.

## Fazalar

- **1A** (bu) — təməl və icra qatı: Runner, CLI parser-lər, DB, REST/WS, UI
- **1B** — ApiRunner, API açarları, models.dev model kəşfi, hərf-hərf axın
- **1C** — Pillə 0-2 amplifikasiya
- **2** — tam Ladder, paralellik, git worktree
- **3** — memory (claude-mem adapter arxasında)
- **4** — task dekompozisiyası, workflow zəncirləri
````

- [ ] **Step 2: README-ni yenilə**

```markdown
# orchestris

Lokal AI orkestrasiya sistemi — zəif/ucuz modellərdən güclü model performansı.

- Dizayn: [`docs/superpowers/specs/2026-07-26-orchestris-design.md`](docs/superpowers/specs/2026-07-26-orchestris-design.md)
- Faza 1A planı: [`docs/superpowers/plans/2026-07-26-faza1a-temel-icra-qati.md`](docs/superpowers/plans/2026-07-26-faza1a-temel-icra-qati.md)
- İşçi təlimatı: [`CLAUDE.md`](CLAUDE.md)

## Başlamaq

```bash
pnpm install
pnpm test                                  # sıfır token
pnpm --filter @orchestris/server dev       # http://127.0.0.1:4319
pnpm --filter @orchestris/web dev          # http://127.0.0.1:5319
```

`cli:codex` istifadə etmək üçün bir dəfə `codex login` lazımdır.
```

- [ ] **Step 3: Yekun yoxlama — hamısı keçməlidir**

```bash
pnpm install
pnpm typecheck
pnpm test
```

Expected:
- `typecheck` — 3 paketdə xəta yoxdur
- `test` — 11+ fayl, 120+ test, hamısı PASS
- Test müddəti 30 saniyədən az (şəbəkə sorğusu yoxdur)

- [ ] **Step 4: Yetim proses yoxlaması**

```bash
powershell -NoProfile -Command "Get-Process claude,codex -ErrorAction SilentlyContinue | Select-Object Name,Id"
```

Expected: boş nəticə (test/dev prosesləri dayandırıldıqdan sonra). Proses
qalırsa `spawn.ts` → `kill()` düzəldilməlidir.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: CLAUDE.md — dəyişməz qaydalar və ölçülmüş səbəblər

9 qayda sənədləşdirilib, hər biri ölçülmüş və ya sınanmış səbəblə."
```

---

## Faza 1A bitmə kriteriyası

Bunların hamısı doğru olduqda Faza 1A tamamdır:

- [ ] `pnpm test` — 120+ test keçir, **sıfır token** xərclənir
- [ ] `pnpm typecheck` — 3 paketdə xəta yoxdur
- [ ] `/providers` səhifəsi `cli:claude` üçün `hazır`, `cli:codex` üçün doğru
      auth vəziyyətini göstərir
- [ ] Kontekst yaratmaq işləyir
- [ ] Real task `claude` CLI ilə işə düşür, `/tasks/:id`-də canlı axır
- [ ] `usage` sətri keş effektivliyini göstərir
- [ ] Büdcə limiti aşıldıqda icra kəsilir və `budget_exceeded` yazılır
- [ ] Server yenidən başladıqda yetim icralar `interrupted` olur, hadisə
      jurnalı itmir
- [ ] Dayandırmadan sonra yetim `claude.exe` prosesi qalmır
- [ ] `fixtures/cli/`-də şəxsi məlumat sızması yoxdur

## Növbəti plan

Faza 1B: `ApiRunner` (AI SDK 6), API açarlarının keychain-də saxlanması,
`models.dev` ilə model + qiymət kəşfi, `--include-partial-messages` hərf-hərf
axını (öz fixture-i ilə), `/history` səhifəsi.
