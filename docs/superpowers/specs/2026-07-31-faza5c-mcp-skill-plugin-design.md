# Faza 5C — MCP, skill və plugin dəstəyi

**Tarix:** 2026-07-31
**Status:** Təsdiqlənmiş dizayn
**Müəllif:** brainstorming sessiyası (istifadəçi + Claude)

---

## 1. Kontekst

Üç alt-layihənin **sonuncusu**:

| Alt-layihə | Vəziyyət |
|---|---|
| **A** — canlı görünüş, fayl icazəsi, qovluq seçicisi | bitdi (qayda 65–68) |
| **B** — agentin sualı + canlı review | bitdi (qayda 69–72) |
| **C** (bu sənəd) — MCP / skill / plugin | dizayn təsdiqləndi |

C sonuncudur, çünki **layihənin əsas qaydası ilə birbaşa toqquşur**: qayda 1
istifadəçinin MCP/skill/hook yükünü QƏSDƏN söndürür və bunun ölçülmüş səbəbi
var. Bu sənədin bütün məzmunu həmin toqquşmanı ölçüb həll etməkdir.

---

## 2. ÖLÇMƏ — bu fazanın təməli

Bütün rəqəmlər real `claude` 2.1.220 icraları ilə alınıb (`claude-haiku-4-5`,
eyni trivial prompt, eyni repo, ardıcıl).

### 2.1. Pulsuz ölçmə mexanizmi (yeni)

`claude -p --model <mövcud-olmayan-ad>` **API sorğusu GÖNDƏRMİR**
(`total_cost_usd: 0`), amma `system/init` sətrini yazır. O sətirdə
`mcp_servers`, `skills`, `slash_commands`, `plugins` sahələri var.

Daha güclüsü: MCP serverinin əmri olaraq marker fayl yazan proses veririk —
server HƏQİQƏTƏN başlayıbsa fayl yaranır. Bu, **davranış müşahidəsidir** və
CLI-nin öz-özünü bildirməsindən etibarlıdır.

**DİQQƏT:** `init` sətrindəki `plugins`/`skills` SAYLARI ziddiyyətli davranır
(`--safe-mode` ilə `plugins=10`, onsuz `0`). Onlara əsaslanan iddia bu sənəddə
YOXDUR — yalnız prosesin başlaması və REAL xərc ölçmələri işlədilir.

### 2.2. Bayraq matrisi (pulsuz)

| Konfiqurasiya | MCP prosesi | skills | cmds |
|---|---|---|---|
| mövcud `CLAUDE_STABLE_FLAGS` | — | 0 | 0 |
| sabit dəst + `--mcp-config` | **YOX** | 0 | 0 |
| sabit dəst − `--safe-mode` + `--mcp-config` | **BƏLİ** | 0 | 0 |
| sabit dəst − `--disable-slash-commands` | — | **16** | **45** |
| sabit dəst + `--settings '{"mcpServers":…}'` | YOX | 0 | 0 |
| sabit dəst + `--mcp-config` + `--setting-sources ''` | YOX | 0 | 0 |
| **− `--safe-mode` + `--mcp-config` + `--setting-sources ''`** | **BƏLİ** (`mcp=1`) | 0 | 0 |
| − `--safe-mode` + `--setting-sources ''` − `--disable-slash-commands` + `--plugin-dir` | — | **17** (öz plugin-imiz daxil) | 46 |

**Üç nəticə:**

1. **`--safe-mode` `--mcp-config`-i ÜSTƏLƏYİR.** MCP-ni qoşmaq üçün o bayraq
   çıxarılmalıdır — `--settings` və `--setting-sources` ilə yan keçmək
   mümkün olmadı.
2. **Skill-ləri söndürən `--safe-mode` DEYİL, `--disable-slash-commands`-dır.**
   CLAUDE.md qayda 1-in şərhi bunu `--safe-mode`-a aid edirdi — ölçmə onu
   **düzəldir**.
3. **Fərdi plugin/skill `--plugin-dir` ilə yüklənir**, amma yalnız
   `--safe-mode` olmayanda.

### 2.3. REAL xərc (ödənişli ölçmə)

| # | Konfiqurasiya | `cache_read` | `cache_create` | out | xərc |
|---|---|---|---|---|---|
| 1 | A: sabit dəst (soyuq) | 21,940 | 1,507 | 69 | $0.0062 |
| 2 | A: sabit dəst (isti) | 23,447 | 0 | 50 | **$0.0032** |
| 3 | B: −`safe-mode` +MCP (soyuq) | **0** | **76,161** | 97 | **$0.1528** |
| 4 | B: −`safe-mode` +MCP (isti) | 76,161 | 0 | 151 | $0.0084 |
| 5 | C: −`disable-slash` | 21,569 | 3,648 | 60 | $0.0104 |
| 6 | **D: −`safe-mode` +MCP +`--setting-sources ''`** (soyuq) | 24,872 | **1,579** | 94 | $0.0068 |
| 7 | **D** (isti) | 26,451 | 0 | 62 | **$0.0036** |

**Bu cədvəl fazanın bütün formasını təyin edir:**

- **`--safe-mode`-u sadəcə çıxarmaq FƏLAKƏTDİR** (sətir 3): prompt 23k → **76k**
  (3.2x), keş TAM sınır, bir dəfəlik xərc isti etalonun **48 mislidir**. Səbəb
  MCP deyil — o bayraq istifadəçinin CLAUDE.md-sini, hook-larını və bütün
  plugin-lərini geri gətirir.
- **`--setting-sources ''` bunu tam həll edir** (sətir 6–7): MCP qoşulur, prompt
  26,451 (etalondan **+3,004 token**), isti xərc $0.0036 (**+12.5%**), və keş
  SINMIR — ilk icrada belə `cache_read` 24,872 idi.
- **Daxili skill-lər ucuzdur** (sətir 5): 16 skill üçün +3,648 token, keş
  qorunur.

Ölçmənin ümumi qiyməti: **$0.1914** (abunəlik — kartdan pul çıxmadı).

---

## 3. Uğur kriteriyaları

1. İstifadəçi MCP serverlərini və plugin/skill-ləri UI-dan əlavə edir və
   kontekst başına **ədəd-ədəd** seçir.
2. **Qoşulmayan kontekstlərin əmr sətri BAYT-BAYT eyni qalır** — mövcud
   keşlər toxunulmur.
3. Seçimin qiyməti UI-da **ölçülmüş rəqəmlə** göstərilir, təxminlə yox.
4. MCP serverinin sirləri (API açarları) DB-yə **yazılmır** (qayda 13).
5. Testlər **sıfır token** xərcləyir (qayda 11).

---

## 4. İki dondurulmuş bayraq dəsti

`CLAUDE_STABLE_FLAGS` **DƏYİŞMİR** və default olaraq qalır. Yanına ikinci
dondurulmuş dəst gəlir:

```
CLAUDE_STABLE_FLAGS            (fərdiləşdirmə YOXDUR — default)
  --output-format stream-json --verbose
  --safe-mode --strict-mcp-config
  --exclude-dynamic-system-prompt-sections --disable-slash-commands

CLAUDE_CUSTOM_FLAGS            (fərdiləşdirmə VAR)
  --output-format stream-json --verbose
  --setting-sources ''         ← `--safe-mode`-un YERİNƏ
  --strict-mcp-config
  --exclude-dynamic-system-prompt-sections
  [--disable-slash-commands]   ← daxili skill-lər söndürülübsə
```

**Niyə iki dəst, bir dinamik dəst yox:** dinamik qursaydıq, hər yeni ayar bir
neçə fərqli əmr sətri kombinasiyası yaradardı və hər biri AYRI keş ailəsi
olardı. İki dondurulmuş dəst = ən çoxu iki keş ailəsi (üç, daxili skill-lər
sayılsa) və hər ikisi ÖLÇÜLÜB.

**Qayda 1 pozulmur, dəqiqləşdirilir:** o qaydanın əsl məzmunu «əmr sətrini
səbəbsiz dəyişmə» deyil, «prompt prefiksini dəyişmək keşi sındırır və bu,
ÖLÇÜLMÜŞ 5x xərc deməkdir». Burada dəyişiklik səbəbsiz deyil, ölçülüb və
**opt-in**-dir: seçim etməyən kontekst köhnə dəsti bayt-bayt alır.

`--strict-mcp-config` HƏR İKİ dəstdə qalır — o, «yalnız `--mcp-config`-dəkilər»
deməkdir, yəni istifadəçinin qlobal MCP konfiqurasiyası heç vaxt səssizcə
sızmır.

---

## 5. Nə seçilə bilir

| Növ | Mexanizm | Dəqiqlik | Ölçülmüş qiymət |
|---|---|---|---|
| MCP server | `--mcp-config <bizim fayl>` | **ədəd-ədəd** | +3,004 token (1 kiçik server) |
| Plugin / öz skill-lərin | `--plugin-dir <yol>` (təkrarlana bilər) | **ədəd-ədəd** | ölçülməyib (bax §11) |
| Daxili 16 skill | `--disable-slash-commands`-ın çıxarılması | **hamısı-birdən** | +3,648 token |

Daxili skill-lərin hamısı-birdən olması **CLI-nin məhdudiyyətidir**, bizim
seçimimiz deyil — ayrıca söndürmə bayrağı yoxdur. UI bunu açıq yazır.

---

## 6. MCP konfiqurasiya faylı

Hər icra üçün **müvəqqəti fayl** yazılır (`~/.orchestris/mcp/<contextId>.json`)
və `--mcp-config` ona işarə edir.

**Niyə fayl, `--mcp-config '<json>'` sətri yox:** əmr sətri arqumentləri proses
siyahısında (`ps`, Task Manager) GÖRÜNÜR. MCP serverlərinin `env`-i çox vaxt
API açarı daşıyır — onu argv-yə qoymaq açarı maşındakı hər prosesə açardı.
Fayl isə istifadəçinin öz qovluğundadır.

Fayl hər icradan ƏVVƏL yenidən yazılır (keşlənmir): seçim dəyişəndə köhnə fayl
səssizcə işlədilərdi.

### 6.1. Sirlər DB-yə yazılmır

MCP serverinin `env` dəyərləri iki qrupa bölünür:

- **adi dəyər** → `mcp_servers.env_json`
- **sirr** → OS keychain, `mcp:<serverId>:<VAR>` adı altında; DB-də yalnız
  dəyişənin ADI qalır (`secret_env_json`)

Bu, qayda 13-ün eyni tətbiqidir. Keychain əlçatan deyilsə sirli server **əlavə
edilmir** (HTTP 503) — səssizcə fayla yazmaq qadağandır.

Konfiqurasiya faylı yazılarkən sirlər keychain-dən oxunub içəri qoyulur. Fayl
icradan sonra SİLİNMİR (növbəti icrada üzərinə yazılır), amma
`~/.orchestris/mcp/` qovluğu yalnız istifadəçiyə açıqdır.

---

## 7. Sxem

Miqrasiya **`0012`**.

### `mcp_servers`

| Sütun | Tip | Qeyd |
|---|---|---|
| `id` | `text` PK | |
| `name` | `text NOT NULL UNIQUE` | konfiqurasiyadakı açar |
| `transport` | `text NOT NULL` | `stdio` \| `http` \| `sse` |
| `command` | `text` | `stdio` üçün |
| `args_json` | `text NOT NULL DEFAULT '[]'` | |
| `env_json` | `text NOT NULL DEFAULT '{}'` | **sirsiz** dəyərlər |
| `secret_env_json` | `text NOT NULL DEFAULT '[]'` | yalnız dəyişən ADLARI |
| `url` | `text` | `http`/`sse` üçün |
| `enabled` | `integer NOT NULL DEFAULT 1` | qlobal söndürmə |
| `created_at` | `integer NOT NULL` | |

### `plugin_sources`

| Sütun | Tip | Qeyd |
|---|---|---|
| `id` | `text` PK | |
| `name` | `text NOT NULL` | |
| `path` | `text NOT NULL` | qovluq və ya `.zip` |
| `created_at` | `integer NOT NULL` | |

`--plugin-url` DƏSTƏKLƏNMİR: uzaq zip yükləmək istifadəçinin maşınında
yoxlanılmamış kod işlətməkdir və bunun qərarı bizim deyil. İstifadəçi zip-i
özü endirib yolunu verə bilər.

### Bağlantı cədvəlləri

- `context_mcp_servers` (`context_id`, `mcp_server_id`) — PK ikisi birlikdə
- `context_plugins` (`context_id`, `plugin_source_id`) — PK ikisi birlikdə

**Niyə bağlantı cədvəli, `contexts`-də JSON massiv yox:** burada sorğu VAR —
«bu server hansı kontekstlərdə işlədilir?» sualı serveri silməzdən əvvəl
lazımdır. `extra_dirs_json` (qayda 65) fərqlidir: o, yalnız bütöv oxunur.

### `contexts` sütunu

- `builtin_skills_enabled` — `integer NOT NULL DEFAULT 0`

**Default SÖNÜLÜDÜR** — `file_access`-dən (qayda 65) fərqli olaraq. Səbəb:
orada `acceptEdits` FAKTİKİ mövcud davranış idi; burada isə daxili skill-lər
heç vaxt açıq olmayıb və default açsaydıq HƏR mövcud kontekst bir dəfə +3,648
token ödəyərdi.

---

## 8. Runner-ə ötürmə

`RunRequest`-ə **runner-dən asılı olmayan** sahə (qayda 65 ilə eyni prinsip):

```ts
RunRequest.customizations?: {
  /** MCP konfiqurasiya faylının yolu; yoxdursa MCP qoşulmur. */
  mcpConfigPath?: string
  /** Plugin qovluqları — DETERMİNİST sıralanmış. */
  pluginDirs: readonly string[]
  /** Daxili 16 skill açılsınmı. */
  builtinSkills: boolean
}
```

`buildClaudeArgs` qərar verir: sahə YOXDURSA `CLAUDE_STABLE_FLAGS`, VARSA
`CLAUDE_CUSTOM_FLAGS`. Bayraq adları paylaşılan müqaviləyə girmir.

Sıralama determinist olmalıdır (qayda 65-dəki eyni səbəb): eyni dəst fərqli
sıra ilə fərqli əmr sətri verər və keşi lazımsız yerə sındırardı.

### 8.1. `codex` DƏSTƏKLƏNMİR — açıq şəkildə

`codex` MCP-ni `~/.codex/config.toml` və ya `-c mcp_servers.…` ilə alır, amma
bu yol **ÖLÇÜLMƏYİB**. Uydurma dəstək yazmaq qayda 50-nin pozulmasıdır.

Ona görə: fərdiləşdirmə seçilmiş kontekstdə task `cli:codex`-ə düşərsə MCP/skill
**tətbiq olunmur** və bu, UI-da açıq yazılır. Bu, 5A-da düzəltdiyimiz
asimmetriyanın (qayda 65) qayıtmasıdır — fərq odur ki, indi o, GİZLİ deyil.

`codex` yolunun ölçülməsi §11-də boşluq kimi qeyd olunur.

---

## 9. API və UI

| Route | Təyinat |
|---|---|
| `GET /api/mcp-servers` | siyahı (sirlər YOX — yalnız `hasSecret`) |
| `POST /api/mcp-servers` | əlavə (sirlər keychain-ə) |
| `DELETE /api/mcp-servers/:id` | silinmə; işlədən kontekstlər varsa 409 |
| `GET /api/plugins` | siyahı |
| `POST /api/plugins` | qovluq/zip yolu (mövcudluq yoxlanılır) |
| `DELETE /api/plugins/:id` | |
| `PATCH /api/contexts/:id` | `mcpServerIds`, `pluginIds`, `builtinSkillsEnabled` |
| `GET /api/mcp-servers/available` | istifadəçinin `~/.claude.json`-undan **oxunan** mövcud serverlər — əl ilə yazmaq əvəzinə seçim |

UI: yeni **`/customizations`** səhifəsi (MCP serverləri + plugin-lər) və
kontekst ayarlarında **`CustomizationPanel`** — checkbox siyahısı, altında
**ölçülmüş** qiymət xəbərdarlığı.

Qovluq seçimi üçün Faza 5A-nın `FolderPicker`-i təkrar işlədilir.

---

## 10. Qərar reyestri — nəyi ETMİRİK və niyə

| Rədd edilən | Səbəb |
|---|---|
| `--safe-mode`-u sadəcə çıxarmaq | Prompt 23k → 76k, bir dəfəlik $0.1528 (§2.3) |
| `--bare` | OAuth və keychain oxunmasını söndürür (qayda 2) |
| `--settings '{"mcpServers":…}'` | Ölçüldü: `--safe-mode` altında İŞLƏMİR (§2.2) |
| Dinamik bayraq dəsti | Hər ayar yeni keş ailəsi yaradardı; iki dondurulmuş dəst ölçülüb (§4) |
| `--mcp-config` JSON-un ARGV-də verilməsi | `env` API açarı daşıyır və argv proses siyahısında görünür (§6) |
| `--plugin-url` | Uzaq zip = yoxlanılmamış kod; qərar bizim deyil (§7) |
| Kontekstdə JSON massiv | «Bu server harada işlədilir?» sorğusu lazımdır (§7) |
| `builtin_skills_enabled` default AÇIQ | Hər mövcud kontekst bir dəfə +3,648 token ödəyərdi (§7) |
| `codex` üçün MCP | Yol ÖLÇÜLMƏYİB — uydurma dəstək qayda 50-ni pozar (§8.1) |
| Daxili skill-lərin ədəd-ədəd seçimi | CLI-də belə bayraq YOXDUR — məhdudiyyət bizim deyil (§5) |

---

## 11. Bilinən boşluqlar

- **`--plugin-dir`-in QİYMƏTİ ölçülməyib.** Mexanizm pulsuz probe ilə
  təsdiqləndi (S4: öz plugin-imiz siyahıda göründü), amma bir plugin-in neçə
  token əlavə etdiyi bilinmir — o, plugin-in ölçüsündən asılıdır. UI hazırda
  plugin üçün rəqəm göstərmir və bunu açıq yazır. Ölçmə üsulu §2.3-dəki
  metodika ilə: eyni prompt, `--plugin-dir` ilə və onsuz.
- **`codex` üçün MCP yolu ölçülməyib** (§8.1). `codex mcp add` və
  `-c mcp_servers.…` mövcuddur, amma nə işləyib-işləmədiyi, nə də qiyməti
  yoxlanılıb.
- **`--setting-sources ''` başqa nəyi söndürür — tam bilinmir.** Ölçüldü ki,
  o, 76k partlayışının qarşısını alır və MCP qoşulur. Amma hook-ların,
  `CLAUDE.md`-nin və agent-lərin vəziyyəti ayrıca yoxlanılmayıb. Praktikada bu
  bizim üçün İSTƏNİLƏNDİR (hamısı sönülü qalmalıdır), amma təsdiqlənməyib.
- **MCP serverinin ÖZ qiyməti serverdən asılıdır.** Ölçülən +3,004 token BİR
  KİÇİK server üçündür (bir alət). `playwright` və ya `chrome-devtools` kimi
  serverlər onlarla alət verir — onların qiyməti ayrıca ölçülməlidir və UI-da
  server başına göstərilməlidir. Hazırda UI ümumi xəbərdarlıq göstərir.
- **MCP-nin FAYDASI ölçülməyib.** «Zəif model MCP alətləri ilə daha yaxşı
  nəticə verirmi?» sualı sınanmayıb. Qiymət artıq bilinir (+12.5% sabit), fayda
  isə yox — yəni mexanizmin özünü ödəyib-ödəmədiyi açıq sualdır. Ölçmə üsulu:
  eyni task dəstini MCP ilə və onsuz qaçırıb `runs.ladder_rung` bölgüsünü
  tutuşdurmaq.
- **`init` sətrindəki `plugins`/`skills` saylarının semantikası bilinmir**
  (§2.1). Ziddiyyətli davranır, ona görə heç bir qərar ona əsaslanmır.
