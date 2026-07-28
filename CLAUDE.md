# Orchestris — Layihə Təlimatı

Lokal AI orkestrasiya sistemi. **Əsas məqsəd:** zəif/ucuz modelləri işlədərək
güclü modelin performansını əldə etmək. Hər qərar buna tabedir.

- Dizayn: `docs/superpowers/specs/2026-07-26-orchestris-design.md`
- Faza 1A planı: `docs/superpowers/plans/2026-07-26-faza1a-temel-icra-qati.md`
  (o sənədin başındaki **Düzəliş 1** və **Düzəliş 2** bölmələri köhnə kod
  bloklarını əvəz edir — həqiqət mənbəyi repodaki kod)

## Quruluş

```
packages/shared/     Zod sxemləri + Runner interfeysi — server və web üçün TƏK mənbə
apps/server/         Fastify: CLI spawn, JSONL parse, SQLite, WebSocket
apps/web/            Vite + React 19 + Tailwind 4
fixtures/cli/        Real CLI çıxışları (təmizlənmiş) — parser testləri üçün
```

## Əmrlər

```bash
pnpm install
pnpm test                                  # bütün testlər — SIFIR token xərcləyir
pnpm typecheck
pnpm --filter @orchestris/server dev       # http://127.0.0.1:4319
pnpm --filter @orchestris/web dev          # http://localhost:5319
```

## Dəyişməz qaydalar

Hər qayda ölçülmüş və ya sınanmış səbəbə əsaslanır. Səbəbi oxumadan qaydanı
dəyişməyin.

### 1. `CLAUDE_STABLE_FLAGS`-a toxunma

`apps/server/src/runners/claude.ts`-dəki bayraq dəsti **sabitdir**.

Eyni trivial task üç konfiqurasiya ilə real ölçüldü (Haiku 4.5):

| Konfiqurasiya | Prompt token | Output | Xərc |
|---|---|---|---|
| Tam (istifadəçinin hook/skill/MCP-ləri) | 31,447 | 632 | $0.0251 |
| `--safe-mode --strict-mcp-config` | 25,076 | 59 | **$0.0085** |
| `--safe-mode` + öz `--system-prompt`-u | 21,718 | 70 | $0.0444 ⚠️ |

Üçüncü sətir ən vacib dərsdir: prompt **kiçildi**, xərc isə **5x artdı** —
çünki prefiks dəyişdi, Anthropic prompt-cache-i sındı və ~21.7k token
`cache_creation` tarifi (1.25x) ilə yenidən ödənildi. İkinci sətir keşdən
22,411 token oxudu.

Task-a xas heç nə sistem promptuna girmir — yalnız istifadəçi mesajına.
Buraya yeni bayraq əlavə etmək = bütün mövcud keşlərin bir dəfəlik sınması.

### 2. `--bare` istifadə etmə

O, OAuth və keychain oxumasını söndürür → abunəlik işləmir. Real run:
`apiKeySource: "none"`, `model: "<synthetic>"`, `is_error: true`.
Fərdiləşdirmə overhead-ini söndürmək üçün `--safe-mode` işlədilir — o auth-u
saxlayır.

### 3. `usage` kumulyativdir — heç vaxt toplama

`claude` CLI hər `assistant` hadisəsində və `result` sətrində yekun `usage`
verir. Toplamaq tokenləri ikiqat sayar. Əksinə, addım-addım emit etmək
`BudgetGuard`-ı (son-dəyər-qalib) səssizcə yan keçər — az saymaq təhlükəli
istiqamətdir.

- Parser `usage`-i YALNIZ `result` sətrindən emit edir
- `applyUsageToRun` `+=` deyil, `=` istifadə edir
- `BudgetGuard.check` mütləq dəyəri müqayisə edir

### 4. `costUsd` yoxluğu "bilinmir" deməkdir, `0` deyil

`codex` xərc bildirmir. `costUsd: 0` yazmaq "həqiqətən pulsuz" kimi oxunar və
büdcə mühafizəsini heç vaxt işə salmaz. Sxemdə sahə **opsionaldır**, DB-də
**NULL** ola bilər, UI-da "xərc bilinmir" göstərilir.

### 5. `billed` sahəsi UI-ın yalan danışmasının qarşısını alır

CLI icraları abunəlikdən gedir → `costUsd` **istinad** qiymətidir, kartdan real
pul çıxmır. `usage` hadisəsindəki `billed: 'real' | 'subscription'` bunu
göstərir. UI abunəlik xərcini "$0.0085 xərcləndi" kimi göstərməməlidir.

`BudgetGuard` hadisənin `billed` sahəsini konfiqurasiyadan **üstün** sayır —
runner öz billing rejimini daha yaxşı bilir.

### 6. Proses ağacını öldür, prosesi yox

Windows-da PATH-dakı `claude` bir shim-dir; real `.exe` uşaq prosesdir.
Shim-i öldürmək uşağı öldürmür — o işləməyə davam edir və **token yandırır**.
Hər cancel/timeout yolunda `taskkill /T /F` işlədilir (`spawn.ts` → `kill()`).

`resolve-exe.ts` shim-i oxuyub real `.exe`-ni tapır, ona görə `shell: true`
lazım gəlmir və PID birbaşa hədəf prosesə aiddir.

### 7. `codex exec` üçün stdin bağlı olmalıdır

Açıq stdin ilə codex `"Reading additional input from stdin..."` deyib əbədi
donur (real olaraq 2 dəqiqə timeout-a düşdü). `spawnLines`
`stdio: ['ignore', 'pipe', 'pipe']` istifadə edir.

### 8. Codex stderr-i JSON axınına qarışdırır

Rust log sətirləri stdout-a düşür və JSON deyil. Onlar **atılır**,
`parse_error` yaradılmır — yoxsa hər log sətri uydurma xəta kimi görünərdi.

### 9. Status kodlarını substring kimi axtarma

`classifyErrorText` söz sərhədi (`\b429\b`) işlədir və status kodu yoxlamasını
**ən sonda** edir. Səbəb: real CLI xətaları `cf-ray: a2140175bd9ce8ee` kimi hex
ID-lər daşıyır və onların içində təsadüfən "401" olur — `includes('401')`
işlətsək təkrarlanabilən rate-limit xətası təkrarsız `auth` kimi təsnif
olunardı. Söz sərhədi hex-i həll edir, amma `'timed out after 401 seconds'`
kimi adi rəqəmi yox — ona görə sıra da vacibdir.

### 10. `retryable` sahəsi yoxdur

`error` hadisəsində belə sahə saxlanılmır — o, `class`-ın saf funksiyasıdır.
Sahə kimi saxlanılsa iki istehlakçı fərqli qərar verə bilər. Lazım olduqda
`isRetryable(e.class)` çağırılır.

`isRetryable` "təkrar KÖMƏK EDƏ BİLƏRmi" sualına cavab verir, "indi təkrar et"
demir. Cəhdlərin sayını çağıran məhdudlaşdırmalıdır.

### 11. Testlər token xərcləməməlidir

Yeni funksionallıq `FakeRunner` + `fixtures/cli/` ilə test olunur. Real CLI
çağırışı yalnız `--version` / `login status` kimi pulsuz əmrlərlə, və ya açıq
env bayrağı arxasında ola bilər.

Yeni fixture əlavə edəndə həmişə `fixtures/sanitize.py`-dən keçir — o, şəxsi
konfiqurasiyanı (CLAUDE.md məzmunu, hook çıxışı, MCP adları, yollar, session
ID, memory yolları) təmizləyir. Sonra sızma yoxlaması et.

### 12. `node --experimental-strip-types` bu layihədə işləmir

İki səbəb (Node v22.16.0 ilə təsdiqlənib):
- `.js` spesifikatoru `.ts` fayla həll olunmur (bizim bütün nisbi importlarımız
  `.js` uzantılıdır)
- konstruktor parametr-xassələri (`constructor(private readonly x: T) {}`)
  strip-only rejimdə dəstəklənmir

TypeScript faylı əl ilə işə salmaq üçün `npx tsx <fayl>` işlədin. Dev server
artıq `tsx watch` istifadə edir.

### 13. API açarları OS keychain-də saxlanılır

`~/.orchestris/` içinə və ya `.env`-ə **heç vaxt** yazılmır. DB-də yalnız
`credential_ref` — OS anbarındakı qeydin adı (`provider:anthropic`).

Tətbiq: `secrets/keychain.ts` (`KeyringStore` / test üçün `MemoryStore`).
Windows-da real Credential Manager ilə yoxlanılıb.

Keychain əlçatan deyilsə açar **qəbul edilmir** (HTTP 503) — səssizcə fayla
yazmaq qadağandır. Testlər `MemoryStore` ötürməlidir: default `KeyringStore`
istifadəçinin real anbarına yazar və başsız CI runner-ində sınar.

### 14. API açarı heç vaxt URL-ə qoyulmur

Google Generative Language API açarı həm `?key=` sorğu parametri, həm də
`x-goog-api-key` başlığı ilə qəbul edir. **Başlıq işlədilir.**

URL-lər başlıqlardan fərqli olaraq hər yerə düşür: server log-ları, proxy
jurnalları, `fetch failed` xəta mətnləri, brauzer tarixçəsi. Açarı ora
qoymaq onu geri götürülməz şəkildə yayır.

Eyni səbəbdən `discovery.ts` provayder cavablarını `redactAll`-dan keçirir:
`Incorrect API key provided: sk-proj-…` mətni DB-yə
(`providers.last_discovery_error`) və oradan UI-a gedir.

### 15. Qiymət komponenti bilinmirsə xərc yalnız O KOMPONENT İŞLƏDİLİBSƏ bilinmir

`computeCostUsd` hər token növünü ayrıca yoxlayır. Ölçülmüş (models.dev,
2026-07-28, bundle edilmiş 103 model):

| Hal | Model sayı |
|---|---|
| Qiymət ümumiyyətlə yoxdur | 9 |
| `cache_read` qiyməti yoxdur | 30 |

`cache_read` qiyməti bilinməyən modeli birbaşa "qiyməti bilinmir" saysaydıq,
keşdən heç nə oxumayan icralarda da büdcə mühafizəsi kor qalardı. Ona görə:
komponentin token sayı `0`-dırsa, qiymətinin bilinməməsi əhəmiyyətsizdir.
Token sayı `0`-dan böyükdürsə və qiymət yoxdursa — yekun `undefined`.

### 16. Server yalnız 127.0.0.1-ə bind olunur

Xarici şəbəkəyə açılmır. Yoxlanılıb: `netstat` `127.0.0.1:4319 LISTENING`
göstərir, `0.0.0.0` yox.

### 17. AI SDK-nın `inputTokens`-i keş tokenlərini DƏ sayır

`ai@7` `LanguageModelUsage` bizim `usage` hadisəmizlə eyni adlarla, amma
**fərqli mənayla** gəlir. Ölçülmüş (`@ai-sdk/anthropic@4.0.21` dist kodu):

```
inputTokens          = noCache + cacheRead + cacheWrite   ← TOPLAM
inputTokenDetails.noCacheTokens                            ← keşsiz hissə
```

Bizim sxemdə (və `claude` CLI parser-ində) `inputTokens` **keşsiz** hissədir,
`cacheReadTokens`/`cacheWriteTokens` ayrıca gedir. SDK-nın `inputTokens`-ini
birbaşa götürsək, keş tokenləri həm orada, həm də ayrıca sahədə sayılar —
`computeCostUsd` onları iki dəfə qiymətləndirər, ledger isə qənaəti az
göstərər. Ona görə `parse-api.ts` `noCacheTokens` işlədir.

Eyni səbəbdən `usage` YALNIZ `finish` hissəsindən emit olunur — `finish-step`
addım-addımdır (qayda 3).

### 18. API xəta mətnləri `redactAll`-dan keçir

`ApiRunner.run` tutduğu hər xətanı hadisəyə çevirməzdən ƏVVƏL kəsir.
Provayder cavabları göndərilən açarı əks etdirə bilir; o mətn `run_events`
cədvəlinə yazılır və WebSocket ilə brauzerə gedir. Jurnal a düşən açar orada
qalır — kəsmə mənbədə edilməlidir (qayda 13, 14 ilə eyni prinsip).

### 19. Routing qaydaları `kind` üzərində qurulur, qabiliyyət üzərində yox

"Fayl işi → CLI, qısa mətn → API" qaydasının səbəbi qabiliyyət fərqi deyil
(onu `canHandle` onsuz da tutur), **ölçülmüş prompt döşəməsidir**: CLI ~21.7k
token, API ~0. Bu, `runner.kind`-dən başqa heç bir sahədə əks olunmur.

Ona görə `FakeRunner` `id` və `kind` qəbul edir — router testləri real CLI/API
runner-i işə salmadan hər iki yolu yoxlaya bilsin.

### 20. Unicode söz sərhədi: `\b` Azərbaycan dilində işləmir

`\b` ASCII `\w` üzərində qurulub. `xülasə` sözünün sonundakı `ə` ASCII söz
simvolu deyil, ona görə `/\bxülasə\b/` **"xülasə et" mətninə uyğun gəlmir**.
Eyni səbəbdən `/\btest\b/` "tests"/"testləri" tutmur.

`routing/classify.ts` `\p{L}` əsaslı lookaround-lar işlədir:
`(?<![\p{L}\p{N}_])` … `\p{L}*` … `(?![\p{L}\p{N}_])`. Bu, həm şəkilçini, həm
də "latest"də təsadüfi "test" halını düzgün həll edir.

### 21. CLI runner-ləri də `providers` cədvəlindədir (`kind: 'cli'`)

Auto rejimi yalnız `models` cədvəlindəki modellər arasından seçir. CLI
modelləri orada olmasaydı, routing-in ƏSAS qaydası ("fayl işi → CLI") heç vaxt
işə düşə bilməzdi.

`cli:claude` → Anthropic kataloqu, `cli:codex` → OpenAI kataloqu. Bu, təxmin
deyil: `claude --help` model adı kimi tam adı (`claude-fable-5`) qəbul edir və
models.dev id-ləri məhz o formadadır. Qiymətlər models.dev-dən gəlir və CLI
icrasında **istinad** qiyməti kimi qalır (`billed: 'subscription'`).

`GET /api/providers` `api` siyahısı `kind !== 'cli'` filtri ilə qurulur — əks
halda UI CLI-a "API açarı əlavə et" formu göstərərdi.

### 22. Klassifikatorun xərci qərar verməsə də sayılır

`runClassifier` `decision: null` qaytaranda belə `tokens`/`costUsd` qaytarır və
`routing_decisions`-a yazılır. Çağırış onsuz da pul yandırıb; onu gizlətmək
"orkestrasiya xərci"ni olduğundan az göstərər və qənaət rəqəmini şişirdərdi
(issue #8).

## Amplification Ladder (Faza 2+)

Pillələr ucuzdan bahaya:

```
0. Cache                      hash → hazır nəticə            0 token   ✅
1. Qayda routing              regex/heuristika               0 token   ✅
2. Zəif model + ALƏT yoxlaması tsc/eslint/test dövrəsi        0 token  ⭐ ✅
3. Best-of-N + razılaşma      N adaptiv (1→3→5)                        Faza 2
4. İpucu (Shepherding)        başçıdan 10-30% prefiks                  Faza 2
5. Plan güclü / icra zəif     boss plan yazır, işçi tikir              Faza 2
6. Self-escalation            işçi "əmin deyiləm" deyir                Faza 2
7. Tam güclü model            son çarə, hədəf: <20%                    ✅
```

Pillə 1 axını (`routing/decide.ts`):

```
əl ilə seçim       → dərhal            0 token
boss-only profili  → başçı             0 token   (baseline ölçməsi)
qayda uyğun gəlir  → dərhal            0 token   ⭐ hədəf hal
klassifikator əmin → seç              ~50 token (opsional, rol təyin olunubsa)
qeyri-müəyyən      → default işçi      0 token
```

Başçının qərar verməsi (spesifikasiyadakı 3-cü addım) Faza 2-dədir — Faza 1
qeyri-müəyyənlikdə kontekstin `default_worker_model_id`-sinə düşür.

Ən vacib pillə **2**-dir. Araşdırma göstərir ki, kiçik modellər öz-özünü
yoxlamaqda pisdir (yoxlama yaddaş-tələbkardır), ona görə yoxlama determinist
alətlərə verilir. Bu sayədə 1B parametrli model 8B-ni üstələyir.

Mətn tasklarında amplifikasiya kod tasklarından zəif olacaq — orada pulsuz
həqiqət mənbəyi yoxdur.

## Fazalar

- **1A** (bitdi) — təməl: Runner interfeysi, CLI parser-lər, SQLite, REST/WS, UI
- **1B** — API açarları + keychain (bitdi), models.dev model kəşfi (bitdi),
  ApiRunner — AI SDK 7 (bitdi), `--include-partial-messages` hərf-hərf axını
  (öz fixture-i ilə) — qalır
- **1C** — Pillə 0–2 amplifikasiya (bitdi: keş, qayda routing + Auto, alət yoxlaması)
- **2** — tam Ladder, paralellik, git worktree izolyasiyası
- **3** — memory (claude-mem adapter arxasında)
- **4** — task dekompozisiyası, workflow zəncirləri

## Bilinən boşluqlar

- `codex` bu maşında login olunmayıb (`codex login status` → `Not logged in`).
  Ona görə codex parser-inin **uğur yolu** real fixture ilə yoxlanılmayıb —
  yalnız xəta yolu. `codex login` edildikdən sonra
  `fixtures/cli/codex-success.jsonl` tutulmalı və parser təsdiqlənməlidir.
- `drizzle-kit` migrasiyaları yoxdur — `db/client.ts` xam DDL + idempotent
  `ALTER` işlədir. Sxem böyüdükcə bu davam edə bilməz (issue #13).
- API provayderlərinin **uğur yolu** real açarla yoxlanılmayıb: model kəşfi
  saxta `fetch` ilə test olunur. Real açar əlavə edildikdə
  `/api/providers/:id/discover` bir dəfə əl ilə təsdiqlənməlidir.
- `ApiRunner` real API axını ilə yoxlanılmayıb — bu maşında API açarı yoxdur.
  Saxta axın `ai@7.0.37`-nin ÖZ `dist/index.d.ts` tipindən və
  `@ai-sdk/anthropic`-in usage çevirmə kodundan qurulub, uydurulmayıb. Açar
  əlavə ediləndən sonra bir dəfə:
  `ORCHESTRIS_E2E=1 ANTHROPIC_API_KEY=… pnpm test` — bu, default olaraq
  atlanan `runners/api.e2e.test.ts` blokunu işə salır (yeganə real çağırış).
