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

pnpm --filter @orchestris/server db:generate   # schema.ts dəyişdikdən SONRA
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

### 23. Qənaət yekunu SQL `SUM` ilə hesablanmır

`SUM` NULL-ları səssizcə atır. Xərci bilinməyən task cəmə `0` kimi girərdi və
"bu ay $X qənaət" rəqəmi olduğundan böyük görünərdi.

`summarizeSavings` sətirləri JS-də gəzir: naməlum xərcli tasklar cəmdən
ÇIXARILIR və `unknownCostTasks` kimi ayrıca sayılır. UI onları göstərir —
gizlətmək iddianı şişirtmək olardı.

### 24. Uğursuz taskda "qənaət" iddiası yoxdur

`computeTaskSavings` yalnız `succeeded` tasklar üçün baseline hesablayır.
Uğursuz taskda nəticə alınmayıb — nə ilə müqayisə edəcəyimiz yoxdur. Amma pul
REAL gedib, ona görə `actualCostUsd` yenə saxlanılır: xərc gizlədilmir,
sadəcə qənaət kimi göstərilmir.

Eyni səbəbdən icra ümumiyyətlə baş verməyibsə (məs. "işçi təyin olunmayıb")
ledger sətri YAZILMIR — task sayını şişirdib orta qənaəti kiçildərdi.

### 25. Baseline TƏXMİNDİR — dəqiq ölçmə `boss-only` profilidir

`baseline_cost_usd` əks-faktdır: *eyni tokenlər* başçının qiymətləri ilə.
Başçı həmin taskı daha az (və ya daha çox) token ilə həll edə bilərdi.

Dəqiq müqayisə üçün `boss-only` amplifikasiya profili var. Ölçülüb (saxta
runner-lə, eyni prompt, eyni tokenlər):

```
Balanslı profil:  actual $1   baseline(proqnoz) $15   net $14
boss-only profil: actual $15  ← REAL baseline
proqnoz == real ✓
```

### 26. Sxem yalnız migrasiya ilə dəyişir — köhnə bazalar "möhürlənir"

`db/client.ts` artıq xam DDL işlətmir: `openDb` hər açılışda
`drizzle/`-dakı migrasiyaları qaçırır. `schema.ts`-i dəyişəndən sonra
`pnpm --filter @orchestris/server db:generate` MÜTLƏQ çağırılmalıdır — CI
bunu yoxlayır (generasiya yeni fayl yaradırsa iş axını sınır).

Faza 1A–1C bazalarında cədvəllər VAR, `__drizzle_migrations` YOXDUR.
Migrator onları təmiz baza sayıb `CREATE TABLE contexts` icra edər və
"table already exists" ilə sınardı — istifadəçinin bütün tarixçəsi əlçatmaz
olardı. `migrate.ts` belə bazaları bir dəfə **möhürləyir**: 0000-in yalnız
ÇATIŞMAYAN obyektləri yaradılır, sonra migrasiya tətbiq olunmuş kimi qeyd
edilir. Baza silinib yenidən yaradılmır.

İki incəlik ölçülüb:
- `foreign_keys` pragma-sı migrasiyadan SONRA açılır. SQLite onu tranzaksiya
  daxilində saymır, drizzle isə migrasiyaları `BEGIN`/`COMMIT` arasında qaçırır
  — SQLite-da sütun dəyişikliyi cədvəlin yenidən qurulmasıdır və FK açıq ikən
  sınardı.
- Qismən unikal indekslər (`models_single_boss_idx`) indi `schema.ts`-dədir.
  Əvvəl yalnız əl DDL-də idi; migrasiyaya keçəndə sxemə köçürülməsəydi, YENİ
  bazalarda "yalnız bir başçı" təminatı səssizcə itərdi (qayda: bazadakı
  təminat tətbiq qatındakından güclüdür).

### 27. Partial axında eyni məzmun İKİ dəfə gəlir

`--include-partial-messages` bayrağı ilə `claude` əvvəlcə `stream_event`
deltalarını, SONRA həmin blokun tam `assistant` mesajını verir. Hər ikisini
emit etsək cavab jurnalda və UI-da iki dəfə görünərdi (real fixture ilə
sınandı: `"SALAM"` → `"SALAMSALAM"`).

`ClaudeStreamParser` deltaları blok indeksi üzrə yığır və `assistant` bloku
yığılmış mətnə BƏRABƏR olanda onu atır. Müqayisə məzmun üzrədir, indeks
üzrə yox — `assistant` mesajı indeks daşımır. Axıdılmamış blok tapılmır və
normal emit olunur, ona görə parser bayraq açıq da, bağlı da işləyir.

Digər ölçülmüş incəliklər (`claude` 2.1.220):

- **Bayraq prompt keşini SINDIRMIR.** Eyni prompt, ardıcıl iki icra:
  bayraqsız `cache_read` 21,102 / `cache_creation` 2,224 / $0.0075;
  bayraqla `cache_read` **21,102** / 2,180 / $0.0074. Ona görə bayraq
  `CLAUDE_STABLE_FLAGS`-a əlavə EDİLMƏDİ (qayda 1 — dəst dondurulub),
  ayrıca və söndürülə bilən şəkildə verilir.
- `input_json_delta` alət girişinin **yarımçıq JSON** parçalarıdır — atılır,
  tam giriş `assistant` blokundan götürülür.
- `signature_delta` düşünmə imzasıdır — heç vaxt emit olunmur.
- `stream_event/message_delta` KUMULYATİV `usage` daşıyır — emit edilsəydi
  tokenlər iki dəfə sayılardı (qayda 3).
- Hər API mesajı blok indeksini 0-dan başladır → `message_start`-da
  akkumulyator təmizlənir, yoxsa ikinci mesajın mətni birincininki ilə
  qarışardı.
- Deltalar hərf-hərf DEYİL, ~5–15 tokenlik parçalarla gəlir (ölçülmüş: 58
  tokenlik düşünmə = 4 delta). UI ardıcıl deltaları göstərişdə birləşdirir
  (`lib/mergeDeltas.ts`) — jurnalda isə hamısı ayrıca qalır.

### 28. Eskalasiya siqnalı cavabın BÜTÜNÜ olmalıdır, içində keçməsi kifayət deyil

Pillə 6 müqaviləsi işçiyə deyir: bacarmırsansa `{"escalate": true, ...}` qaytar.
`parseEscalation` bu JSON-u yalnız cavabın TAMI (ən çoxu bir kod çərçivəsi
içində) olanda qəbul edir.

Səbəb ölçüldü, təxmin deyil: `answer.includes('"escalate"')` yazsaydıq, bu
sistemin öz sənədini, müqaviləsini və ya testlərini izah edən HƏR task
"bacarmadım" kimi oxunardı — model həmin JSON-u nümunə kimi sitat gətirir.
Yanlış-müsbət eskalasiya layihənin məqsədinin tam əksidir: hazır nəticə atılır
və üstündən ən bahalı model işlədilir. `escalate` sahəsi məhz `true` olmalıdır
(`"true"` və `1` qəbul edilmir).

### 29. Müqavilə istifadəçi mesajının SONUNA gedir

Eskalasiya müqaviləsi sistem promptuna DEYİL, istifadəçi mesajına əlavə olunur.
Qayda 1-dəki ölçmə: `claude` CLI-nın sistem prompt prefiksini dəyişmək
Anthropic prompt-cache-ini sındırır və eyni task 5x bahalaşır ($0.0085 →
$0.0444). Suffiks prefiksi toxunmur.

### 30. Best-of-N yalnız yoxlama əmri OLMAYANDA işə düşür

Determinist yoxlama (`tsc`, testlər) PULSUZ həqiqət mənbəyidir və razılaşmadan
güclüdür: üç nüsxə eyni SƏHV cavabda da razılaşa bilər, `tsc` isə səhvi görür.
Pulsuz və güclü siqnal varkən bahalısını (N icra) almaq mənasızdır.

Eyni səbəbdən yoxlama 3 cəhddən sonra sınıbsa Pillə 3-ə DEYİL, birbaşa
başçıya (7) qalxılır — alət artıq "səhvdir" deyib.

`AGREEMENT_STEPS = [3, 5]` KUMULYATİVDİR: ilk icra onsuz da ödənilib, ona görə
hər addım cəmi 2 əlavə icradır. Sabit N=5 israfdır — adaptiv strategiya
naive best-of-N-dən ~4x səmərəlidir.

Razılaşma ölçüsü MƏTN normallaşdırmasıdır, AST deyil (`agreement.ts`). Semantik
eyni, amma fərqli yazılmış kod "razılaşmır" kimi oxunur — yəni xəta BAHA
istiqamətə gedir (task yuxarı qalxır), uydurma razılaşma yaranmır. Böyük/kiçik
hərf qorunur: kodda `Foo` və `foo` fərqli identifikatorlardır.

### 31. Pillə 7 "başçı işlədi" deməkdir — başqa heç nə

Əvvəllər yoxlama əmri olmayan İŞÇİ icrası da `ladder_rung: 7` yazılırdı. Bu,
layihənin əsas hədəfini ("taskların <20%-i 7-yə çatsın") ölçülməz edirdi:
metrik işçi icralarını başçı icraları kimi sayardı.

İndi hər işçi icrası 2-dir (yoxlama əmri olsun-olmasın), best-of-N nüsxələri
3-dür, 7 YALNIZ başçının TAM icrasıdır. `boss-only` profilində işçi rolunu başçı
oynayır — orada tək icra yenə 7-dir, yoxsa baseline ölçməsi (qayda 25) yalan
olardı.

Pillə 4-ün İKİ icrası da (başçının qısa ipucusu + işçinin ipuculu cəhdi) 4 kimi
qeyd olunur — başçı icra etsə də. Səbəb eynidir: ipucu MƏHZ tam başçı
icrasından qaçmaq üçündür; onu 7 saysaq, pillənin uğuru metrikada uğursuzluq
kimi görünərdi (bax qayda 34).

### 32. Kaskad monotondur — yuxarı pillə əvvəlkini ATA BİLMƏZ

Səhv qurulmuş kaskad tək modeldən PİS nəticə verə bilər. Ona görə hər
eskalasiya öz `fallback`-ını daşıyır: başçı təyin olunmayıbsa, büdcə bitibsə,
profil 7-ni söndürübsə və ya başçı da sınıbsa əvvəlki nəticə saxlanılır.
Başçının uğursuz icrası DB-də QALIR (xərc gizlədilmir), sadəcə nəticə onun
olmur.

`Ladder.settle` taskın DB statusunu QAYTARILAN nəticə ilə uyğunlaşdırır.
Məcburidir: `RunSupervisor` statusu SON icraya görə yazır, nərdivan isə sonda
başqa icranın nəticəsini qaytara bilər — uyğunlaşdırmasaq `/tasks/:id` uğurlu
cavabı `failed` kimi göstərərdi.

### 33. Başçının cavabı işçinin keş açarı altında saxlanılmır

Keş açarı model və runner id-sini ehtiva edir (`cache-key.ts`). Başqa modelin
cavabını ora yazmaq girişi yalançı edərdi — və sonrakı `cheap` profilli icra
(Pillə 7-ni QƏSDƏN söndürən) səssizcə başçı cavabı alardı. Eyni səbəbdən
işçinin eskalasiya JSON-u da keşlənmir: imtina cavab deyil.

Eyni qayda Pillə 4-ə də şamil olunur: ipucu ilə alınmış işçi cavabı da
keşlənmir — açar başçının köməyini əks etdirmir.

### 34. İpucu (Pillə 4) yalnız işçi İLİŞƏNDƏ istənilir, razılaşmamada yox

Pillə 4 iki icra ödəyir: başçının qısa ipucusu + işçinin ipuculu cəhdi. Uğurlu
halda bu, başçının TAM icrasından ucuzdur (çıxış tokeni girişdən 3–5x bahadır və
başçı çıxışın yalnız kiçik hissəsini yazır), UĞURSUZ halda isə ondan bahadır —
üstündən 7 onsuz da gəlir.

Bu asimmetriya iki qərar doğurur:

- Pillə 4 YALNIZ `quality` profilindədir. `balanced` gündəlik işdir; orada bu
  risk götürülmür.
- Razılaşmama (Pillə 3) halında ipucu İSTƏNMİR. Orada işçi ilişməyib — cavab
  verib, sadəcə nüsxələr uyğun gəlməyib; onların hər biri (3–5 icra) onsuz da
  ödənilib. Üstünə daha bir işçi icrası + başçı icrası qoymaq birbaşa 7-yə
  qalxmaqdan bahadır. İpucu yalnız `self` (Pillə 6) və `verification`
  siqnallarında işə düşür.

Cəhd BİRDİR (kaskad riski, issue #9). İpuculu cəhdin qəbulu PULSUZ siqnalla
ölçülür: yoxlama əmri varsa `tsc`/testlər, yoxdursa müqavilənin özü (işçi yenə
`escalate` qaytarırsa ipucu tutmayıb). Heç bir halda "yəqin yaxşıdır" deyilmir.

### 35. İpucunun uzunluğu büdcə ilə DEYİL, promptla məhdudlaşdırılır

`BudgetGuard` `usage` hadisəsinə baxır, CLI runner-ləri isə `usage`-i yalnız
SONDA verir (qayda 3). Yəni ipucu icrasına sərt `maxOutputTokens` qoysaq, uzun
ipucu KƏSİLMƏZDİ — sadəcə icra sonradan `budget_exceeded` işarələnər və biz
ödədiyimiz mətni atardıq. Limit qənaət etməz, pulu boşa çıxarardı.

Ona görə uzunluq başçıdan promptla istənilir ("10–30%, 15 sətirdən çox yazma")
və mətn işçiyə verilməzdən əvvəl `HINT_CHAR_LIMIT` ilə kəsilir — bu kəsmə
büdcəni yox, işçinin kontekstini qoruyur.

Eyni qayda Pillə 5-ə də şamil olunur: plan "3–7 addım, 25 sətirdən çox yazma"
ilə istənilir və `PLAN_CHAR_LIMIT` ilə kəsilir.

### 36. Pillə 4 və 5 EYNİ yerdə dayanır — ardıcıl yox, biri-birini istisna edir

Hər ikisi eyni axındır: başçıdan qısa mətn al → işçini onunla BİR dəfə qaçır →
pulsuz siqnalla yoxla. Yəni hər biri 1 başçı + 1 işçi icrası ödəyir. Ardıcıl
qaçsaydılar `quality` zənciri `2 → 4 → 4 → 5 → 5 → 7` = altı icra olardı və
pillələrin qənaəti kaskad riskinə (issue #9) qurban gedərdi. Bir slot ilə ən
pis hal 4 icradır — Pillə 4-ün tək olduğu vəziyyətlə eyni.

Seçim SIFIR token xərcləyir (`plan.ts` → `detectMultiStep`, saf funksiya) və
taskın şəklinə görədir, təsadüfi deyil:

- **çoxaddımlı task → PLAN (5).** İpucu həllin ilk 10–30%-idir; beş addımlı
  taskda o, sadəcə 1-ci addımdır və qalan dördü barədə işçiyə HEÇ NƏ demir.
  Zəif modelin burada problemi "başlaya bilmirəm" deyil, ipi ortada itirməkdir.
- **təkaddımlı task → İPUCU (4).** Orada "plan" bir sətrə yığılıb elə ipucunun
  özünə çevrilir; plan promptunun əlavə tələbləri isə başçıya boş yerə token
  yazdırardı.

Siqnal QƏSDƏN dardır (≥3 sətir-başı siyahı bəndi, VƏ YA ≥2 FƏRQLİ sıra sözü
qrupu). Yalan-müsbət burada bahadır: təkaddımlı taskda plan istəmək başçının
icrasını boş yerə ödəməkdir. Zəif siqnalda köhnə davranış (Pillə 4) qalır.
`\b` işlədilmir — qayda 20.

Qalan hər şey Pillə 4 ilə eynidir: razılaşmama halında heç biri işə düşmür
(qayda 34), cəhd BİRDİR, nəticə keşlənmir (qayda 33), qəbul yalnız pulsuz
siqnalla ölçülür.

## Amplification Ladder

Pillələr ucuzdan bahaya:

```
0. Cache                      hash → hazır nəticə            0 token   ✅
1. Qayda routing              regex/heuristika               0 token   ✅
2. Zəif model + ALƏT yoxlaması tsc/eslint/test dövrəsi        0 token  ⭐ ✅
3. Best-of-N + razılaşma      N adaptiv (1→3→5)                        ✅
4. İpucu (Shepherding)        başçıdan 10-30% prefiks       `quality`   ✅
5. Plan güclü / icra zəif     boss plan yazır, işçi tikir  `quality`   ✅
6. Self-escalation            işçi "əmin deyiləm" deyir                ✅
7. Tam güclü model            son çarə, hədəf: <20%                    ✅
```

Profil → aktiv pillələr (`exec/ladder.ts` → `PROFILE_RUNGS`, həqiqət mənbəyi;
UI onu `GET /api/routing/rules` cavabındakı `profileRungs`-dan alır):

| Profil | Pillələr |
|---|---|
| `cheap` | 0, 1, 2 |
| `balanced` (default) | 0, 1, 2, 3, 6, 7 |
| `quality` | 0, 1, 2, 3, 4, 5, 6, 7 (4 və 5 eyni slotdadır — qayda 36) |
| `boss-only` | 7 |

Eskalasiya axını (`exec/ladder.ts`):

```
işçi imtina etdi (Pillə 6)          → kömək*/başçı  ~40 token müqavilə
yoxlama 3 cəhddən sonra sındı        → kömək*/başçı  0 token siqnal
nüsxələr razılaşmadı (Pillə 3)      → başçı         N×işçi (kömək YOX, qayda 34)
başçı əlçatmazdır                    → əvvəlki nəticə saxlanılır

* `quality` profilində əvvəlcə başçının QISA köməyi sınanır (qayda 36):
    çoxaddımlı task → PLAN (5),  təkaddımlı task → İPUCU (4)   ← biri, ikisi yox
    başçının qısa mətni → işçinin bir köməkli cəhdi → tutmasa başçının tam icrası
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
- **1B** (bitdi) — API açarları + keychain, models.dev model kəşfi,
  ApiRunner (AI SDK 7), `--include-partial-messages` hərf-hərf axını
  (öz fixture-ləri ilə)
- **1C** (bitdi) — Pillə 0–2 amplifikasiya: keş, qayda routing + Auto, alət
  yoxlaması, `savings_ledger` (qənaətin dürüst ölçülməsi)
- **2** (davam edir) — Pillə 3 (best-of-N + razılaşma), 4 (ipucu/shepherding),
  5 (plan/icra bölgüsü), 6 (self-escalation) və 7-yə eskalasiya bitdi. Qalır:
  prompt distilləsi (`task_templates`), paralellik və git worktree izolyasiyası
  (issue #10)
- **3** — memory (claude-mem adapter arxasında)
- **4** — task dekompozisiyası, workflow zəncirləri

## Bilinən boşluqlar

- Pillə 3, 4, 5 və 6 **real modellə** yoxlanılmayıb: `FakeRunner` ilə hər yol
  örtülüb, amma zəif modelin müqaviləyə NƏ QƏDƏR əməl etdiyi (imtina nisbəti,
  yanlış-müsbət) ölçülməyib. Real işçi modeli təyin olunandan sonra bir neçə
  qəsdən çətin task verilib `routing_decisions` + `runs.ladder_rung` üzərindən
  "taskların neçə faizi 7-yə çatdı" ölçülməlidir (hədəf <20%).
- Pillə 4 və 5-in İQTİSADİ faydası ölçülməyib: qayda 34-dəki hesab ("başçının
  qısa çıxışı + işçinin tam çıxışı < başçının tam çıxışı") çıxış/giriş qiymət
  nisbətinə əsaslanır, real ölçməyə yox. `quality` profili ilə eyni task dəsti
  qaçırılıb `savings_ledger`-dəki `byRung` bölgüsü `balanced` ilə tutuşdurulmalı
  və başçının nə qədər token yazdığı (`HintSummary.hintChars` /
  `PlanSummary.planChars`) yoxlanılmalıdır — başçı müqaviləyə əməl etməyib tam
  həll yazırsa pillə zərərə işləyir.
- `detectMultiStep`-in dəqiqliyi real task korpusunda ölçülməyib: siqnal dar
  seçilib (yalan-müsbət bahadır), amma neçə çoxaddımlı taskın SƏHVƏN Pillə 4-ə
  düşdüyü bilinmir. `runs.ladder_rung` üzərindən 4 və 5-in payı və qəbul
  nisbətləri tutuşdurulmalıdır.
- Pillə 3 nüsxələri **ardıcıl** qaçır, paralel yox — 3 nüsxə divar saatı üzrə
  3x uzun çəkir. Paralellik issue #10-dadır (`contexts.max_parallel`).
- `codex` bu maşında login olunmayıb (`codex login status` → `Not logged in`).
  Ona görə codex parser-inin **uğur yolu** real fixture ilə yoxlanılmayıb —
  yalnız xəta yolu. `codex login` edildikdən sonra
  `fixtures/cli/codex-success.jsonl` tutulmalı və parser təsdiqlənməlidir.
- Hərf-hərf axının **canlı UI-da** görünüşü brauzerdə əl ilə yoxlanılmayıb —
  parser və `mergeDeltas` real fixture-lər üzərində test edilib, amma
  WebSocket → React yolu yalnız mövcud testlərlə örtülüdür.
- API provayderlərinin **uğur yolu** real açarla yoxlanılmayıb: model kəşfi
  saxta `fetch` ilə test olunur. Real açar əlavə edildikdə
  `/api/providers/:id/discover` bir dəfə əl ilə təsdiqlənməlidir.
- `ApiRunner` real API axını ilə yoxlanılmayıb — bu maşında API açarı yoxdur.
  Saxta axın `ai@7.0.37`-nin ÖZ `dist/index.d.ts` tipindən və
  `@ai-sdk/anthropic`-in usage çevirmə kodundan qurulub, uydurulmayıb. Açar
  əlavə ediləndən sonra bir dəfə:
  `ORCHESTRIS_E2E=1 ANTHROPIC_API_KEY=… pnpm test` — bu, default olaraq
  atlanan `runners/api.e2e.test.ts` blokunu işə salır (yeganə real çağırış).
