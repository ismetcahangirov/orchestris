# Faza 5C — MCP, skill və plugin — İcra Planı

> **Agent işçilər üçün:** TƏLƏB OLUNAN ALT-SKILL: `superpowers:executing-plans`.

**Məqsəd:** İstifadəçi MCP serverlərini və plugin/skill-ləri UI-dan əlavə edib
kontekst başına ədəd-ədəd seçsin; qoşulmayan kontekstlərin əmr sətri bayt-bayt
dəyişməsin.

**Arxitektura:** İki DONDURULMUŞ bayraq dəsti — `CLAUDE_STABLE_FLAGS` (default,
toxunulmur) və `CLAUDE_CUSTOM_FLAGS` (`--safe-mode` yerinə
`--setting-sources ''`). Seçim `RunRequest.customizations` ilə ötürülür; bayraq
adları paylaşılan müqaviləyə girmir. MCP konfiqurasiyası hər icradan əvvəl
FAYLA yazılır (argv-də açar görünməməlidir), sirlər isə keychain-dədir.

**Spesifikasiya:** `docs/superpowers/specs/2026-07-31-faza5c-mcp-skill-plugin-design.md`
— bütün ölçmələr oradadır və planın hər qərarı onlara istinad edir.

---

## Ümumi qaydalar

- ESM `.js` spesifikatorları; testlər sıfır token (qayda 11).
- `schema.ts` dəyişəndən sonra `db:generate`.
- **`CLAUDE_STABLE_FLAGS` MASSİVİ DƏYİŞMİR** — Task 3-dəki test bunu qoruyur.

---

## Task 1: Sxem və repo

**Fayllar:** `db/schema.ts`, `drizzle/0012_*.sql`, `db/customization-repo.ts` (YENİ),
test: `db/customization-repo.test.ts`

- [ ] **Addım 1: Cədvəlləri əlavə et** (spesifikasiya §7 — sütunlar orada tam)

`mcp_servers`, `plugin_sources`, `context_mcp_servers`, `context_plugins`;
`contexts.builtin_skills_enabled` `integer NOT NULL DEFAULT 0`.

Bağlantı cədvəllərində PK ikisi birlikdə (`primaryKey({ columns: […] })`) və
hər ikisi `onDelete: 'cascade'`.

Şərhlərdə YAZILMALIDIR: default `0`-dır, çünki daxili skill-lər heç vaxt açıq
olmayıb və default açsaydıq hər mövcud kontekst bir dəfə **+3,648 token**
(ölçülmüş) ödəyərdi.

- [ ] **Addım 2: `db:generate`** → `0012_*.sql`; faylı oxu, iki `CREATE TABLE`
      + iki bağlantı cədvəli + `ALTER TABLE contexts` olduğunu təsdiq et.

- [ ] **Addım 3: `db/customization-repo.ts`**

```ts
export function createMcpServer(db, input: {
  name: string; transport: string; command?: string; args?: readonly string[]
  env?: Record<string, string>; secretEnv?: readonly string[]; url?: string
}): McpServer
export function listMcpServers(db): McpServer[]
export function getMcpServer(db, id): McpServer | undefined
export function deleteMcpServer(db, id): void
export function createPluginSource(db, input: { name: string; path: string }): PluginSource
export function listPluginSources(db): PluginSource[]
export function deletePluginSource(db, id): void

/** Kontekstin seçdiyi serverlər/plugin-lər — SIRALANMIŞ (keş üçün, qayda 65). */
export function listContextMcpServers(db, contextId): McpServer[]
export function listContextPlugins(db, contextId): PluginSource[]
export function setContextMcpServers(db, contextId, ids: readonly string[]): void
export function setContextPlugins(db, contextId, ids: readonly string[]): void
/** "Bu server hansı kontekstlərdə işlədilir?" — silmədən ƏVVƏL lazımdır. */
export function contextsUsingMcpServer(db, id): string[]
export function contextsUsingPlugin(db, id): string[]
```

`set*` funksiyaları ƏVVƏLCƏ silir, sonra yazır (tam əvəzləmə): qismən
yeniləmə «hansı silindi?» sualını çağırana yükləyərdi.

- [ ] **Addım 4: Testlər**

- server yaradılır, `secretEnv` yalnız ADLARI saxlayır (dəyər YOX)
- `setContextMcpServers` tam əvəz edir
- `listContextMcpServers` **ada görə sıralanmış** qaytarır (determinizm)
- `contextsUsingMcpServer` istifadə edən konteksti tapır
- kontekst silinəndə bağlantı sətirləri də silinir (cascade)

- [ ] **Addım 5: Commit** — `feat(server): MCP/plugin sxemi (miqrasiya 0012)`

---

## Task 2: `exec/customizations.ts` — saf qat

**Fayllar:** YENİ `exec/customizations.ts`, test: `exec/customizations.test.ts`

- [ ] **Addım 1: Testi yaz** — saf funksiyalar, 0 token:

```ts
describe('buildMcpConfig', () => {
  it('stdio serverini command/args/env ilə qurur')
  it('http serverini url ilə qurur')
  it('sirlər keychain-dən oxunub içəri qoyulur')
  it('sirr tapılmasa server ATILIR — yarımçıq konfiqurasiya server-i sındırardı')
  it('server yoxdursa null qaytarır — fayl yazılmır')
})

describe('resolveCustomizations', () => {
  it('heç nə seçilməyibsə undefined qaytarır — SABİT dəst işlədilir')
  it('yalnız daxili skill-lər seçilibsə də customizations qaytarır')
  it('pluginDirs DETERMİNİST sıralanır')
})
```

- [ ] **Addım 2: Tətbiq**

```ts
export interface Customizations {
  mcpConfigPath?: string
  pluginDirs: readonly string[]
  builtinSkills: boolean
}

/**
 * `undefined` = fərdiləşdirmə YOXDUR → `CLAUDE_STABLE_FLAGS` işlədilir və
 * əmr sətri BAYT-BAYT köhnə qalır. Mövcud keşlərin toxunulmazlığı buna
 * bağlıdır (spesifikasiya §4).
 */
export function resolveCustomizations(input: {
  mcpConfigPath: string | undefined
  pluginDirs: readonly string[]
  builtinSkills: boolean
}): Customizations | undefined
```

`buildMcpConfig(servers, secrets)` → `{ mcpServers: {…} } | null`.
Sirri tapılmayan server ATILIR (rədd, kəsmə yox — qayda 39 prinsipi): yarımçıq
`env` ilə server ya sınar, ya da səssizcə səlahiyyətsiz işləyər.

- [ ] **Addım 3: Fayl yazıcısı** — `writeMcpConfig(dir, contextId, config)`

Hər icradan ƏVVƏL üzərinə yazılır (keşlənmir): seçim dəyişəndə köhnə fayl
səssizcə işlədilərdi. Yol `~/.orchestris/mcp/<contextId>.json`.

**ARGV-yə JSON QOYULMUR** — `env` API açarı daşıyır və argv proses siyahısında
görünür (spesifikasiya §6).

- [ ] **Addım 4: Testləri qaçır və commit**

---

## Task 3: `CLAUDE_CUSTOM_FLAGS`

**Fayllar:** `runners/claude.ts`, test: `runners/claude.test.ts`

- [ ] **Addım 1: Testi yaz** — ƏN VACİB test birincidir:

```ts
it('CLAUDE_STABLE_FLAGS DƏYİŞMİR — qayda 1', () => { /* mövcud test qalır */ })

it('CLAUDE_CUSTOM_FLAGS --safe-mode DAŞIMIR, --setting-sources daşıyır', () => {
  expect(CLAUDE_CUSTOM_FLAGS).not.toContain('--safe-mode')
  expect(CLAUDE_CUSTOM_FLAGS).toContain('--setting-sources')
  // `--strict-mcp-config` HƏR İKİ dəstdə qalır: istifadəçinin qlobal MCP
  // konfiqurasiyası heç vaxt səssizcə sızmamalıdır.
  expect(CLAUDE_CUSTOM_FLAGS).toContain('--strict-mcp-config')
})

it('customizations YOXDURSA əmr sətri SABİT dəstlə qurulur', () => {
  const args = buildClaudeArgs({ prompt: 'p', model: 'm' })
  expect(args).toContain('--safe-mode')
  expect(args).not.toContain('--setting-sources')
})

it('customizations VARSA safe-mode getmir, mcp-config gəlir')
it('hər plugin üçün ayrıca --plugin-dir')
it('builtinSkills true olanda --disable-slash-commands OLMUR')
it('builtinSkills false olanda --disable-slash-commands QALIR')
it('pluginDirs sırası dəyişməz ötürülür — sıralama customizations-dadır')
```

- [ ] **Addım 2: Tətbiq**

```ts
/**
 * İKİNCİ dondurulmuş dəst — fərdiləşdirmə seçilmiş kontekstlər üçün.
 *
 * ÖLÇÜLMÜŞ (claude 2.1.220, haiku, eyni prompt):
 *  - `--safe-mode`-u sadəcə çıxarmaq: prompt 23,447 → 76,161 token, keş TAM
 *    sınır, bir dəfəlik $0.1528 (isti etalonun 48 misli)
 *  - `--setting-sources ''` ilə birlikdə: 26,451 token (+3,004), isti xərc
 *    $0.0036 vs $0.0032 (+12.5%), keş SINMIR
 *
 * `--disable-slash-commands` burada YOXDUR — o, şərtə görə əlavə olunur
 * (daxili 16 skill: +3,648 token, ölçülmüş).
 */
export const CLAUDE_CUSTOM_FLAGS: readonly string[] = [
  '--output-format', 'stream-json', '--verbose',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--exclude-dynamic-system-prompt-sections',
]
```

`buildClaudeArgs`:

```ts
const custom = req.customizations
const base = custom === undefined ? CLAUDE_STABLE_FLAGS : CLAUDE_CUSTOM_FLAGS
const args: string[] = ['-p', req.prompt, ...base]
if (custom !== undefined) {
  if (!custom.builtinSkills) args.push('--disable-slash-commands')
  if (custom.mcpConfigPath !== undefined) args.push('--mcp-config', custom.mcpConfigPath)
  for (const dir of custom.pluginDirs) args.push('--plugin-dir', dir)
}
```

- [ ] **Addım 3: `codex.ts`-ə şərh əlavə et** (kod dəyişmir)

```ts
// Faza 5C: `customizations` codex-də TƏTBİQ OLUNMUR. `codex mcp add` və
// `-c mcp_servers.…` mövcuddur, amma nə işləmə, nə də qiymət ÖLÇÜLMƏYİB —
// uydurma dəstək yazmaq qayda 50-ni pozardı. UI bunu açıq yazır.
```

- [ ] **Addım 4: Testləri qaçır və commit**

---

## Task 4: Sirlərin saxlanması

**Fayllar:** `secrets/keychain.ts` (dəyişmir — mövcud `CredentialStore`),
`routes/customizations.ts` (YENİ)

MCP sirri açar adı: `mcp:<serverId>:<VAR>`.

Keychain əlçatan deyilsə sirli server **əlavə edilmir** (503) — qayda 13.

---

## Task 5: Route-lar

**Fayllar:** YENİ `routes/customizations.ts`, `routes/contexts.ts`, test:
`routes/customization-routes.test.ts`

- [ ] Endpoint-lər (spesifikasiya §9 cədvəli).
- [ ] `DELETE /api/mcp-servers/:id` işlədən kontekst varsa **409** + siyahı:
      səssizcə silmək həmin kontekstlərin icrasını növbəti dəfə sındırardı.
- [ ] `POST /api/plugins` yolun MÖVCUD olduğunu yoxlayır (qayda 65-dəki
      `dirProblem` naxışı; `.zip` üçün fayl da qəbul edilir).
- [ ] `GET /api/mcp-servers/available` — `~/.claude.json`-u OXUYUR (yazmır) və
      `mcpServers` açarlarını qaytarır. Fayl yoxdursa boş siyahı; **sirlər
      qaytarılmır** (yalnız ad + transport).
- [ ] `PATCH /api/contexts/:id` → `mcpServerIds`, `pluginIds`,
      `builtinSkillsEnabled`.
- [ ] Testlər: 409 yolu, sirrin cavabda OLMAMASI, mövcud olmayan plugin yolu
      → 400.

---

## Task 6: Nərdivana qoşulma

**Fayllar:** `exec/ladder.ts`, `exec/supervisor.ts`, `app.ts`,
test: `exec/ladder-customizations.test.ts`

- [ ] `ExecuteInput.customizations` → `RunRequest.customizations`.
- [ ] `Ladder.where(phase)` fərdiləşdirməni də verir (qayda 65-dəki eyni
      «bir yerdən» prinsipi — unudulan çağırış yeri səhv əmr sətri deməkdir).
- [ ] Faza qurularkən BİR DƏFƏ hesablanır və MCP faylı BİR DƏFƏ yazılır:
      hər icrada yenidən yazsaydıq paralel icralar eyni fayl üzərində yarışardı.
- [ ] Test: seçim yoxdursa `RunRequest.customizations` **undefined** olur
      (bayt-bayt köhnə davranış).

---

## Task 7: Paylaşılan sxem

`RunRequest.customizations` (bayraq adları YOX), `CreateMcpServerBody`,
`CreatePluginBody`, `UpdateContextBody`-yə üç sahə.

---

## Task 8: Web

- `pages/Customizations.tsx` — MCP serverləri + plugin-lər (əlavə/sil),
  `~/.claude.json`-dan seçim, `FolderPicker` təkrar işlədilir.
- `components/CustomizationPanel.tsx` — kontekstdə checkbox seçimi.
- Xəbərdarlıq mətni **ölçülmüş rəqəmlərlə**: «MCP: +12.5% (ölçülmüş, 1 kiçik
  server); daxili skill-lər: +3,648 token; plugin qiyməti ÖLÇÜLMƏYİB».
- `cli:codex`-in dəstəkləmədiyi açıq yazılır.
- Sidebar-a keçid.

---

## Task 9: Sənədləşmə

`CLAUDE.md` qayda 73–75:

- **73. İki dondurulmuş bayraq dəsti** — ölçmə cədvəli ilə; qayda 1
  DƏQİQLƏŞDİRİLİR (skill-ləri söndürən `--disable-slash-commands`-dır).
- **74. `--setting-sources ''` MCP-nin qapısıdır** — `--safe-mode`-u sadəcə
  çıxarmaq 76k partlayışı deməkdir.
- **75. MCP sirri argv-yə qoyulmur, fayla yazılır** — qayda 14-ün ailəsindən
  (URL əvəzinə proses siyahısı).

Fazalar siyahısına `5C (bitdi)`; §11-dəki altı boşluq köçürülür.

- [ ] `pnpm test` / `typecheck` / `lint` / `db:generate` — hamısı təmiz
- [ ] **Pulsuz probe ilə yekun yoxlama**: `scratchpad/probe_flags.py` naxışı ilə
      qurulmuş konfiqurasiyanın HƏQİQƏTƏN MCP başlatdığını təsdiqlə (model
      çağırışı YOX).
