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

### 37. Prompt distilləsi pillə DEYİL — `ladder_rung: -1`

Distillə taskın cavabını yazmır; gələcək EYNİ TİPLİ taskların iş üsulunu yazır.
0–7 aralığından bir nömrə seçsəydik iki ölçmə birdən yalan danışardı:

- "taskların <20%-i 7-yə çatsın" hədəfi (qayda 31) bir dəfəlik investisiyanı
  tam başçı icrası kimi sayardı
- `byRung` bölgüsü onu taskın öz həll xərcinin içində gizlədərdi

Mənfi nömrə "nərdivandan kənar" deməkdir və `PROFILE_RUNGS`-a girmir. Şablonun
TƏTBİQİ də profildən asılı deyil — o, artıq ödənilmiş mətndir və `cheap`
profilində belə sıfır əlavə token xərcləyir. Profil yalnız YAZILMASINA təsir
edir (başçı lazımdır).

Ölçmədə (`savings.ts`): distillə icrasının tokenləri **baseline-a girmir**
(başçı bu taskı təkbaşına həll etsəydi şablon YAZMAZDI — girsəydi baseline
şişər və qənaət olduğundan böyük görünərdi), xərci isə **orkestrasiya
xərcinə** yazılır (klassifikatorla eyni məntiq, qayda 22) və `byRung`-da
görünür. Gizlədilmir, sadəcə taskın həll xərci sayılmır.

### 38. Şablon yalnız TƏKRARLANAN tipə yazılır

Bir distillə icrası (~800 token) yalnız çox dəfə işlədiləndə özünü ödəyir. Ona
görə qapı (`distill.ts` → `shouldDistill`) sübut tələb edir: həmin tipdə ƏN AZI
**iki** task başçının köməyinə möhtac qalmalıdır (`DISTILL_MIN_ASSISTED_TASKS`).
`1` yazsaydıq hər yeni tip ilk ilişmədə əlavə başçı icrası ödəyərdi — halbuki
o task bir dəfəlik ola bilər və şablon heç vaxt işlədilməzdi.

Say `runs`-dan gəlir və İKİ şərt birlikdə vacibdir (`countBossAssistedTasks`):
`escalated_from_run_id IS NOT NULL` (nə isə SINDIQDAN sonra doğub) **və**
`ladder_rung ∈ {4, 5, 7}`. Birincisiz `boss-only` profilinin adi tək icrası da
qapını açardı, ikincisiz zəif modelin adi retry-ları açardı. Sayılan TASK-dır,
icra yox: Pillə 4/5 bir taskda iki sətir yazır.

`boss-only` və `unknown` tam kənardadır: birincisi baseline ölçməsidir (qayda
25) və ora əlavə icra qatmaq ölçünün özünü korlayardı; ikincisi "bilmirəm"in
adıdır və ora yazılan mətn təsnif oluna bilməyən HƏR taska yapışardı.

### 39. Uzun şablon KƏSİLMİR, RƏDD edilir

Şablon hər gələcək icrada giriş tokeni kimi ödənilir — yəni BİR DƏFƏLİK xərci
DAİMİ vergiyə çevirir. Ona görə burada Pillə 4/5-in kəsmə davranışı (qayda 35)
TƏTBİQ OLUNMUR: yarımçıq kəsilmiş təlimat yanıldıcıdır və o da sonsuz dəfə
oxunardı. Hədd aşılanda (`TEMPLATE_CHAR_LIMIT`) şablon saxlanılmır — bir icranı
itirmək daimi vergidən ucuzdur.

Eyni sərtlik parse-a da aiddir (qayda 28 ilə eyni prinsip): hər iki başlıq
(`### İŞÇİ PROMPTU`, `### RUBRİKA`) mütləqdir. Səhv parse olunmuş mətn bir
taska deyil, BÜTÜN gələcək tasklara yapışardı.

Şablonun `id`-si MƏZMUN hash-idir və keş açarına girir (`cache-key.ts`):
şablonsuz cavabın şablonlu icraya (və əksinə) qaytarılması səssiz və təhlükəli
səhv olardı. Şablonsuz halda açara heç nə əlavə olunmur — mövcud keşlər sınmır.

### 40. İzolyasiya YALNIZ paralel kod tasklarında açılır

`git worktree add` ~200–500 ms və disk yeri tələb edir. Hər taska worktree
açsaydıq, "bu funksiyanı izah et" sualı da reponun tam nüsxəsini ödəyərdi —
heç bir toqquşmanın qarşısını almadan.

`shouldIsolate` (`exec/worktree.ts`, saf funksiya, **0 token**) ÜÇ şərti
BİRLİKDƏ tələb edir və hər biri ayrıca bir israfı kəsir:

- `max_parallel > 1` — izolyasiya yalnız iki task eyni anda eyni fayllara
  toxuna biləndə məna daşıyır. Ardıcıl rejimdə qarşısı alınacaq toqquşma yoxdur.
- runner `fileAccess` — API runner-i fayl yazmır, onun üçün worktree boş qovluqdur.
- task tipi `code` və ya `test` — mətn taskı repoya toxunmur.

Worktree taskın ÖZÜ üçündür, icra üçün yox: nərdivan eyni taskda bir neçə icra
qaçırır (yoxlama dövrəsi, best-of-N, ipucu, başçı) və hamısı EYNİ ağacda işləyir.
Hər icraya ayrı ağac versəydik, 2-ci cəhd 1-ci cəhdin işini görməzdi — halbuki
yoxlama dövrəsinin bütün mənası məhz əvvəlki işi düzəltməkdir.

Açılış Pillə 0-dan SONRADIR: keşdən cavab alan task heç nə icra etmir.

### 41. Worktree istifadəçinin COMMIT EDİLMƏMİŞ işini daşıyır

`git worktree add … HEAD` yalnız son commit-i alır. Köçürməsək, yarımçıq işi
olan repoda agent KÖHNƏ kodu görər: "bu funksiyanı düzəlt" taskı artıq mövcud
olmayan kodu düzəldər və nəticə diff-i əsas repoya heç vaxt təmiz oturmazdı.

İki mexanizm lazımdır, çünki `git diff HEAD` izlənilməyən faylı GÖRMÜR:
izlənilən dəyişikliklər patch ilə, izlənilməyən fayllar (`ls-files --others
--exclude-standard`) kopyalanaraq keçir. `.gitignore`-dakılar kopyalanmır —
`node_modules` köçürülsəydi hər worktree gigabaytlar yeyərdi.

Köçürmə alınmasa worktree SİLİNİR və izolyasiya ləğv olunur: izolyasiyasız,
amma DÜZGÜN kod üzərində işləmək — səssizcə köhnə kod üzərində işləməkdən
yaxşıdır. Eyni prinsip bütün yollarda: git yoxdur, repo deyil, commit yoxdur →
task əsas `cwd`-də normal davam edir. İzolyasiya optimallaşdırmadır, tələb deyil.

### 42. Diff `git apply` ilə tətbiq olunur, merge ilə YOX — və qərar insanındır

Paralel agentlər eyni faylı fərqli cür dəyişə bilər. Avtomatik merge etsəydik,
ikinci taskın nəticəsi birincini səssizcə üstələyərdi — MƏHZ izolyasiyanın
qarşısını almaq istədiyi hal. Ona görə nəticə `artifacts` cədvəlinə `pending`
kimi yazılır və əsas repoya istifadəçi "qəbul et" deyənə qədər HEÇ NƏ yazılmır.

`merge` yox, `apply` — çünki merge istifadəçinin branch-ına və commit
tarixçəsinə toxunur, münaqişədə isə repo yarımçıq merge vəziyyətində qalır.
`apply` yalnız işçi ağacı dəyişir; `--check` ƏVVƏLCƏ qaçır ki, yarım tətbiq
olunmuş patch istifadəçinin ağacını sındırmasın. Tətbiq alınmasa sətir `pending`
QALIR və worktree SİLİNMİR — dəyişikliyin yeganə nüsxəsi hələ oradadır.

Diff `git add -A` + `git diff --cached` ilə toplanır: adi `git diff`
izlənilməyən faylı göstərmir, halbuki agentin yaratdığı YENİ fayl dəyişikliyin
ən vacib hissəsi ola bilər.

`DIFF_CHAR_LIMIT` aşılanda diff kəsilir və `truncated` işarələnir — belə diff
YALNIZ baxış üçündür və qəbul route-u onu 409 ilə rədd edir (qayda 39 ilə eyni
prinsip: yarımçıq mətn tətbiq olunmamalıdır).

### 43. `max_parallel = 0` "avtomatik" deməkdir

Sabit rəqəm default ola bilməz: cavab maşından asılıdır. `resolveMaxParallel`
`min(4, nüvə - 2)` verir — bir nüvə serverə, biri istifadəçinin redaktoruna
qalır. Yuxarı hədd `4`-dür: hər paralel icra ~21.7k token prompt döşəməsi ödəyir
(qayda 1), yəni paralelliyi nüvə sayına görə sonsuz artırmaq pul yandırmaqdır.

Köhnə default `1` idi və onu dəyişmək üçün API ÜMUMİYYƏTLƏ YOX İDİ — yəni
bazadakı hər `1` istifadəçinin seçimi deyil, məhz köhnə default-dur. Migrasiya
0002 onları bir dəfə `0`-a çevirir; saxlasaydıq mövcud bütün kontekstlərdə
paralellik əbədi söndürülü qalardı.

Hovuz (`exec/pool.ts`) KONTEKST BAŞINADIR: limitin mənası "bu iş sahəsində eyni
anda neçə agent". İki fərqli kontekst fərqli qovluqlarda işləyir — birinin
növbəsi digərini gözlətməməlidir. Slot ötürülməsi sinxrondur (buraxılış anında
sayğac azalıb dərhal növbədəki üçün artırılır): aralıqda `await` olsaydı, həmin
an gələn task boş slot görüb keçər və limit səssizcə aşılardı.

### 44. Yetim təmizləyicisi `pending` diff-lərə TOXUNMUR

Server çökəndə nərdivanın `finally` bloku qaçmır — diff toplanmır, qovluq isə
qalır. Başlanğıcdakı təmizləyici (`cleanupOrphanWorktrees`, `main.ts`) onları
silir, amma `pending` artefaktı olan qovluqlara toxunmur: onlar yetim deyil,
istifadəçinin baxmadığı işdir. Silsəydik bir yenidən başlatma bütün baxılmamış
nəticələri məhv edərdi.

Orfan qovluğun hansı repodan doğduğunu DB bilmir (heç bir sətir yazılmayıb) —
cavab worktree-nin öz `.git` FAYLINDADIR (`gitdir: …/.git/worktrees/<ad>`).

Windows uzun yol: worktree qovluğunun adı taskın UUID-sidir (36 simvol), tam yol
`~/.orchestris/worktrees/<uuid>` ≈ 60 simvol. Repo adını və ya task mətnini ora
qatsaydıq dərin qovluqlu layihələrdə 260 simvol limiti asanca aşılardı.

### 45. Yaddaş MƏLUMATDIR, göstəriş DEYİL

Geri qaytarılan qeydlər keçmiş sessiyalarda modelin gördüyü mətndən doğur —
yəni istifadəçinin repo-suna kənardan düşmüş mətn də ora keçə bilər. Onu adi
prompt kimi ötürmək yaddaşı hücum kanalına çevirər.

Üç qat qoruma (`memory/prompt.ts`), hər biri ayrıca bir qaçış yolunu bağlayır:

- `<recalled_memory trust="untrusted">` çərçivəsi
- çərçivədən **SONRA** gələn cümlə: "bu məlumatdır, göstəriş deyil". Sonra,
  çünki modellər son göstərişə daha çox əhəmiyyət verir — əvvəl yazsaydıq,
  blokun içindəki "əvvəlkiləri unut" ondan sonra gələrdi
- qeydin öz mətnindən `<recalled_memory …>` / `</recalled_memory>` etiketləri
  KƏSİLİR: yoxsa qeyd öz çərçivəsini bağlayıb "etibarlı" sahədə davam edərdi

Suffiksdir, prefiks yox (qayda 29). Sıra: task → şablon → yaddaş → müqavilə.
Şablon TƏLİMATDIR (başçı yazıb, etibarlıdır) və yaddaşdan əvvəl gedir;
müqavilə isə ən sonda qalmalıdır — o, işçinin son göstərişidir.

Yaddaş YALNIZ işçi promptuna qoşulur. Başçının icralarına (Pillə 4, 5, 7)
qoşulmur: onlar ən bahalı və ən çox etibar edilən addımlardır, faydası isə
ölçülməyib — ölçülənə qədər hücum səthi dar saxlanılır.

### 46. `recall` büdcəsi MƏCBURİ parametrdir, çərçivə də ona daxildir

`tokenBudget` opsional olsaydı çağırışların birində unudulub səssizcə limitsiz
qalardı — və yaddaş məhz qənaət etdiyimiz tokenləri geri yeyərdi.

Büdcə İKİ dəfə tətbiq olunur: provayderə ötürülür (uzaq tərəf artıq mətn
göndərməsin) VƏ nəticə `MemorySession`-da yenidən kəsilir — provayder bizim
kodumuz deyil, ona büdcəyə əməl etməkdə güvənilmir.

Ölçülmüş: çərçivənin özü ~79 token tutur (`MEMORY_TOKEN_BUDGET = 600`-ün
~13%-i). Onu büdcədən çıxmasaydıq "600 token yaddaş" rəqəmi yalan olardı.
Çərçivəyə belə yer qalmırsa yaddaş ÜMUMİYYƏTLƏ qoşulmur: boş çərçivə ödəniş
tələb edir, fayda vermir.

Simvol→token nisbəti `3`-dür, `4` yox: Azərbaycan mətni tokenləşdiricidə pis
sıxılır və `4` işlətsək təxmin həqiqi tokendən AZ göstərərdi. `3` yuxarı
qiymətləndirir — səhvin ucuz istiqaməti budur.

Kəsim relevantlığa (`score`) görədir, sıraya görə yox; qeydin MƏTNİ heç vaxt
kəsilmir (yarımçıq cümlə yanıldıcıdır). Sığmayan qeyddən sonra dövrə DAYANMIR:
bir uzun qeyd qalan büdcəni israf etməməlidir.

Hədd kontekst başına ayarlanmır. Hər knob istifadəçidən ölçmə tələb edir,
halbuki hələ heç bir real ölçmə yoxdur (bax "Bilinən boşluqlar").

### 47. Yaddaş keş açarına GİRİR

Yaddaş işçinin promptunu dəyişir — yəni cavab ondan asılıdır. Açara girməsəydi
(`cache-key.ts` → `memoryDigest`), yaddaşsız alınmış cavab yaddaşlı icraya (və
əksinə) səssizcə qaytarılardı; `templateId` üçün eyni səhv artıq bağlanıb
(qayda 39).

Ona görə `recall` keş yoxlanışından ƏVVƏL gəlir — worktree-dən (Pillə 0-dan
SONRA açılır, qayda 40) fərqli olaraq. Fərqin səbəbi: açarın özü yaddaşdan
asılıdır, worktree isə yalnız icra üçün lazımdır. Oxuma lokal axtarışdır, ona
görə keşdən cavab alan taskda praktiki olaraq sıfır ödənilir.

Yaddaşsız halda açara BİR BAYT belə əlavə olunmur — mövcud keşlər sınmır.

### 48. Yaddaşı BİZ yazırıq — və yalnız UĞURLU nəticəni

claude-mem-in öz hook-ları bizim CLI icralarımızda **işə düşmür**:
`CLAUDE_STABLE_FLAGS` `--safe-mode` daşıyır və onun bütün mənası məhz
istifadəçinin hook/skill/MCP yükünü söndürməkdir (qayda 1, ölçülmüş: $0.0251 →
$0.0085). API işçilərində isə hook anlayışı onsuz da yoxdur. Yəni yazmasaq,
yaddaş HEÇ VAXT dolmaz.

Yazılmır:
- **uğursuz task** — səhv cavab bir taskı deyil, həmin sahədəki BÜTÜN gələcək
  taskları zəhərləyər; üstəlik zərəri şablondan (qayda 39) gizlidir, çünki
  yaddaş mətni heç bir yerdə nəzərdən keçirilmir
- **keşdən gələn nəticə** — o cavab artıq bir dəfə yadda saxlanılıb; təkrar
  yazmaq eyni qeydi çoxaldar və hər dəfə sıxma xərci ödədərdi

Cavab kəsilir (`MEMORY_WRITE_CHAR_LIMIT`) və kəsilmə açıq işarələnir. Bu,
qayda 39-a (uzun şablon RƏDD edilir) zidd deyil: şablon GÖSTƏRİŞDİR və yarımçıq
göstəriş yanıldıcıdır, yaddaş qeydi isə QEYDDİR — az fayda verir, yanlış
göstəriş vermir.

### 49. Naməlum yaddaş xərci `0` DEYİL

`savings_ledger.memory_cost_usd` artıq `NOT NULL DEFAULT 0` deyil. Əvvəl doğru
idi (yaddaş yox idi), indi isə provayder sıxma xərcini bildirməyə bilər — onu
susaraq `0` saysaq "bu ay $X qənaət" rəqəmi ödədiyimiz pulu udardı (qayda 23
ilə eyni səhv).

Fərq dəqiqdir və `memory_ops` cədvəlində sətir-sətir saxlanılır:

| Hal | `cost_usd` |
|---|---|
| yaddaş ümumiyyətlə işə düşməyib | `0` (ölçülə bilən sıfır) |
| lokal axtarış (`recall`) | `0` — model çağırışı yoxdur |
| sıxma (`remember`), provayder xərc bildirir | bildirilən rəqəm |
| sıxma, provayder susur | **`NULL`** → net qənaət də `NULL` |

Yaddaş xərci orkestrasiya xərcinə QATILMIR, ayrıca sütundadır (spesifikasiya
§10): "yaddaş özünü ödəyirmi?" sualına yalnız ayrı sütun cavab verə bilər. Net
qənaətdən isə hər ikisi çıxılır.

`memory_ops` sətirləri `runs`-da saxlanıla bilməzdi: yaddaş çağırışı bizim
runner-lərimizdən keçmir, orada nə `runner_id`, nə `model_id`, nə də hadisə
jurnalı olardı. Uğursuz əməliyyat da yazılır — sınmış yaddaş taskı dayandırmır,
amma izsiz qalsa "yaddaş işləyir" illüziyası yaradardı. Heç nə etməyən
əməliyyat (0 qeyd, 0 xərc, uğurlu) isə yazılmır: hər taska iki boş sətir
jurnalı oxunmaz edərdi.

### 50. Yoxlaya bilmədiyimiz minimum versiya UYDURULMUR

claude-mem-də keçmişdə command-injection zəifliyi olub (#354, düzəldilib) və
`detect()` minimum versiyanı yoxlamalıdır. Amma bu maşında claude-mem
quraşdırılmayıb (`~/.claude-mem` yoxdur) — hansı versiyada düzəldiyini
yoxlaya bilmirik.

Uydurma rəqəm yazsaydıq iki səhvdən biri qaçılmaz olardı: ya zəif versiyanı
səssizcə qəbul edərdik, ya da işləyən quraşdırmanı səbəbsiz rədd edərdik. Ona
görə `minVersion` default `null`-dır və o halda `health()` `ok: false` qaytarır
— yəni yaddaş **fail-closed**-dur, cavabı isə istifadəçi verir
(`ORCHESTRIS_CLAUDE_MEM_MIN_VERSION`) və o, `/api/memory`-də görünür.

Eyni səbəbdən `ClaudeMemProvider`-in bütün sim protokolu (ünvan, endpoint
yolları, cavab sahələri) konfiqurasiyadadır: **təsdiqlənməyib** (bax "Bilinən
boşluqlar"). Protokol fərqli çıxsa bir env dəyişikliyi kifayət edir — adapterin
bütün mənası budur.

Provayder ÜMUMİYYƏTLƏ env ilə qoşulur (`ORCHESTRIS_MEMORY`), UI-dan bir kliklə
yox: yaddaş taskların mətnini XARİCİ prosesə yazır və bu, istifadəçinin açıq
qərarı olmalıdır. Kontekst səviyyəsindəki `memory_enabled` isə UI-dadır — o,
verilmiş razılığı geri götürməkdir, yeni razılıq vermək yox.

### 51. Dekompozisiya pillə DEYİL — `ladder_rung: -2`

Bölgü taskın cavabını yazmır, onu PARÇALARA bölür. Distillə ilə (qayda 37) eyni
səbəbdən mənfi nömrə alır: 0–7 aralığından bir rəqəm seçsəydik "taskların
<20%-i 7-yə çatsın" hədəfi (qayda 31) bölgünü tam başçı icrası kimi sayardı,
`byRung` bölgüsü isə orkestrasiya xərcini taskın öz həll xərcinin içində
gizlədərdi.

Ölçmədə (`savings.ts` → `ORCHESTRATION_RUNGS`) hər iki mənfi pillə eynidir:
tokenləri **baseline-a girmir** (başçı taskı təkbaşına həll etsəydi nə şablon,
nə bölgü yazardı — girsəydi baseline şişər və qənaət olduğundan böyük
görünərdi), xərci isə **orkestrasiya xərcinə** yazılır və `byRung`-da görünür.

Valideyn taskın ledger sətrində yalnız bölgünün xərci olur; həllin xərci və
qənaəti hər alt-taskın ÖZ sətrindədir. Bu, qəsdəndir: bölgü təmiz xərcdir və
qənaət alt-tasklarda yaranırsa yaranır — cəmi bir sətrə yığsaydıq mexanizmin
zərərə işlədiyi hal görünməz olardı.

### 52. Dekompozisiya AÇIQ istənilir — avtomatik deyil

Qapı (`decompose.ts` → `shouldDecompose`) `POST /api/tasks` gövdəsindəki
`decompose: true` tələb edir. Səbəb ölçülə bilən xərcdir: bölgü **bir başçı
icrası + N nərdivan dövrəsi** ödəyir, faydası isə hələ ölçülməyib.

Avtomatik açsaydıq hər çoxaddımlı task əlavə başçı icrası ödəyərdi — halbuki
MƏHZ o hal üçün Pillə 5 (plan) var və o, cəmi bir başçı + bir işçi icrasıdır
(qayda 36). Yəni avtomatik dekompozisiya ucuz mexanizmin üstündən bahalısını
qoymaq olardı.

`boss-only` kənardadır (qayda 25 ilə eyni səbəb: bir taskı N taska çevirsək
baseline ölçməsi mənasız olar), router yoxdursa da açılmır — bölgünü yazacaq
başçı yoxdur.

İkinci qapı BAŞÇININ ÖZÜDÜR: cavab sərt parse olunur (qayda 28 prinsipi — JSON
cavabın BÜTÜNÜ olmalıdır) və ən azı **iki** parça tələb edir. Bir parçalı bölgü
bölgü deyil: başçının icrası ödənilib, task isə eyni qalıb.

Uzun və ya çox parça **RƏDD edilir, KƏSİLMİR** (qayda 39 prinsipi): yarımçıq
kəsilmiş alt-task mətni icra olunanda pul iki dəfə yanardı — bir dəfə səhv işə,
bir dəfə düzəlişə.

Bölgü alınmasa mexanizm SƏSSİZCƏ geri çəkilir və task adi nərdivandan keçir
(monoton qayda, qayda 32): bir orkestrasiya qərarının uğursuzluğu istifadəçinin
nəticəsini məhv etməməlidir.

### 53. Alt-tasklar ARDICIL və EYNİ ağacda qaçır, yoxlama isə SONDA bir dəfə

Bölgü müqaviləsi başçıya "sonrakı alt-task əvvəlkinin nəticəsi üzərində işləyir"
deyir — yəni parçalar ASILIDIR. Onları paralel qaçırsaydıq iki nəticədən biri
qaçılmaz olardı: ya eyni fayllarda yarış, ya da ayrı worktree-lərdə bir-birinin
işini GÖRMƏMƏK — məhz qayda 40-ın qarşısını aldığı səhv. Paralellik onsuz da
var və orada yeri var: MÜSTƏQİL istifadəçi taskları arasında (`pool.ts`).

Ona görə ağac VALİDEYN taskındır: `Decomposer` onu açır, hər alt-taskın
`Ladder.run` çağırışına ötürür (`LadderInput.worktree`) və sonda özü bağlayır.
Nərdivan verilən ağacı NƏ AÇIR, NƏ BAĞLAYIR — birinci alt-task qurtaran kimi
bağlasaydı, qalanları boş qovluqda işləyərdi. Diff `artifacts`-a **valideyn**
taskın adına yazılır: bölgü bir iş vahididir, parça-parça diff isə istifadəçiyə
eyni dəyişikliyin yarımçıq variantlarını göstərərdi.

Determinist yoxlama alt-tasklarda **söndürülür** (`verifyCommandsJson: '[]'`).
Səbəb quruluşdadır, təsadüf deyil: 4 parçadan 1-cisi bitəndə kod hələ tamam
deyil və `tsc` QURULUŞ ETİBARI İLƏ sınır. Yoxlamanı orada saxlasaydıq, hər
alt-task 3 cəhd yandırıb başçıya qalxardı — yəni mexanizm ən bahalı halı
MƏCBURİ edərdi. Ağac ortaq olduğu üçün sonda bir dəfə qaçan yoxlama bütün
parçaların BİRLİKDƏ nəticəsini görür və `verification_runs`-a BÖLGÜ icrasının
adına yazılır (alt-taskın icrasına yazsaydıq, həmin parça başqasının səhvinə
görə uğursuz görünərdi).

Büdcə alt-tasklar ARASINDA paylaşılır (`RemainingBudget` — `ladder.ts`-dən
export olunur): hər alt-task limiti təzədən alsaydı, altı parçalı task büdcənin
altı mislini xərcləyə bilərdi. Büdcə bitəndə qalan alt-tasklar `pending`
QALMIR, `failed` işarələnir — UI-da "gözləyir" görünən, əslində heç vaxt
başlamayacaq task yalandır.

### 54. Zəncirin öz məntiqi SIFIR token xərcləyir

Workflow zəncirlərində (Faza 4) şərtlər determinist predikatlardır və dəyişən
əvəzlənməsi sadə mətn əməliyyatıdır (`exec/workflow.ts`). "Bu cavab yaxşıdırmı,
növbəti addıma keçək?" sualını modelə vermək ən asan yol olardı — və hər addımda
ƏLAVƏ icra ödəyərdi. Zəncir uzandıqca orkestrasiya xərci taskların öz xərcini
üstələyərdi; bu, layihənin məqsədinin əksidir (eyni fəlsəfə: Pillə 2 — pulsuz
həqiqət mənbəyi razılaşmadan güclüdür).

`matches` (regex) şərti QƏSDƏN YOXDUR: istifadəçidən gələn regex katastrofik
geri izləmə (ReDoS) ilə serveri dondura bilər, halbuki real ehtiyac status
yoxlaması və mətn axtarışıdır.

**Sınıq addım zənciri DAYANDIRIR** — `continueOnError: true` ilə açıq şəkildə
ləğv edilməsə. Əks default sınmış birinci addımdan sonra qalan bütün addımların
pulunu ZİBİL giriş üzərində yandırardı. Bayraq eyni zamanda `test: 'failed'`
şərtini işlək edir: "sındısa təmir addımını qaçır" budağı yalnız zəncir sağ
qaldıqda mümkündür. Davranış MAGİYA ilə təxmin edilmir (məs. "sonrakı addımda
`failed` şərti varmı?"), istifadəçinin açıq qərarı olur.

**Atlanan addım `{{previous}}` üçün ŞƏFFAFDIR** — `previous` son İCRA OLUNMUŞ
addımdır. Əks halda budaqlanma özünü sındırardı: `when` ödənməyən addımdan
sonrakı hər addım boş giriş alardı. Atlanan addım yenə də `workflow_step_runs`-a
sətir yazır (səbəbi ilə): yoxsa istifadəçi "5-ci addım niyə işləmədi?" sualının
cavabını heç yerdə tapa bilməzdi.

**Təkrarda `{{previous}}` addımın ÖZ əvvəlki cəhdidir.** Səbəb Pillə 0-dır: eyni
prompt eyni keş açarını verir, yəni dəyişməyən promptla təkrar həmişə eyni cavabı
alar və dövrə `max`-a qədər boş fırlanardı. Öz çıxışını geri vermək təkrarı
"düzəlişlə yenidən cəhd et"ə çevirir. `{{previous}}`-a toxunmayan prompt yenə
keşə düşür — yəni mənasız təkrar bahalı yox, sadəcə faydasız olur.

**Zəncirdə izolyasiya ADDIM BAŞINA DEYİL, ZƏNCİR BAŞINADIR** (qayda 58).
Addımlar alt-tasklar kimi ASILIDIR (qayda 53): 2-ci addım 1-cinin yazdığı faylı
görməlidir. Hər addıma ayrıca worktree açılsaydı, hər addımın işi öz `pending`
diff-ində qalar və növbəti addım köhnə kod görərdi. Ona görə ağac BİR dəfə —
zəncirin sintetik valideyn taskı üçün — açılır və hər addımın `Ladder.run`
çağırışına ötürülür.

### 55. `contains` müqayisəsi Azərbaycan `i` cütünü nəzərə almalıdır

Qayda 20-nin ailəsindən, amma fərqli mexanizm. Ölçülmüş:

```
'QAYDASINDA'.toLowerCase()  →  'qaydasinda'   (I → i, NÖQTƏLİ)
'qaydasında'                →  'qaydasında'   (ı, NÖQTƏSİZ)   ← uyğun GƏLMİR
'İSTİFADƏ'.toLowerCase()    →  'i̇sti̇fadə'      (i + U+0307 birləşən nöqtə)
```

Yəni sadə `toLowerCase()` hər iki tərəfə tətbiq olunsa BELƏ, böyük hərfli
Azərbaycan mətni axtarışa uyğun gəlmir. `toLocaleLowerCase('az')` bunu düzəldər,
amma İNGİLİS mətnini sındırar (`API` → `apı`) — halbuki model çıxışı hər ikisini,
üstəlik kodu da daşıyır.

`workflow.ts` → `foldForSearch` hər iki tərəfi VAHİD formaya yığır: birləşən
nöqtə atılır, `ı` → `i` çevrilir. Qiyməti: `contains` artıq `ı`/`i`
fərqləndirmir ("sinif" mətni "sınıf" axtarışına da uyğun gəlir). Bu,
GENİŞLƏNMƏDİR və şüurlu seçimdir — səssizcə uyğun GƏLMƏMƏK qat-qat pisdir:
budaq işə düşmür və səbəbi heç yerdə görünmür.

### 56. Xarici HTTP addımı FAIL-CLOSED-dur

Zəncir taskın nəticəsini — istifadəçinin kodunu, sənədini, bəzən sirrini —
XARİCİ ünvana göndərir. Ona görə default "heç nə göndərmə"dir və icazə yalnız
`ORCHESTRIS_WORKFLOW_HTTP_ALLOW` ilə verilir (qayda 50 ilə eyni prinsip). Siyahı
boşdursa hər HTTP addımı səhvlə dayanır və `fetch` ÇAĞIRILMIR. Fail-open
yazsaydıq, dəyişəni təyin etməyi unudan istifadəçi ən geniş icazəni səssizcə
alardı — və bunu yalnız məlumat kənara çıxandan sonra bilərdi.

Üç əlavə məhdudiyyət, hər biri ayrıca bir sızma yolunu bağlayır:

- **URL-də dəyişən əvəzlənmir**, yalnız gövdədə. URL-ə model çıxışını yapışdırmaq
  ona ünvanı seçdirmək olardı — yəni zəif modelin (və ya onun oxuduğu ETİBARSIZ
  yaddaş mətninin, qayda 45) sorğunu yönləndirməsi.
- **Başlıq yazmaq olmur.** `Authorization` imkanı verilsəydi, istifadəçi açarını
  zəncir tərifinə — yəni SQLite-a və oradan UI-a — yazardı (qayda 13).
- **Host müqayisəsi TAM uyğunluqdur.** `endsWith` işlətsəydik `evil-example.com`
  keçərdi; prefiks müqayisəsi isə `example.com.attacker.net`-i buraxardı.

Cavab `redactAll`-dan keçir (qayda 18): endpoint göndərilən məzmunu əks etdirə
bilir və o mətn `workflow_step_runs`-a yazılır.

### 57. Cədvəldə DÖRD tavan var və hər biri ayrı sızma yolunu bağlayır

Issue #12 xəbərdarlığı bu sxemin bütün formasını təyin edir: *"nəzarətsiz cədvəl
`$0.50 testdə → $50,000/ay` ssenarisinin ən asan yoludur"*. Ona görə hər dörd
limit `NOT NULL`-dur (bazada, tətbiq qatında yox — qayda 26 prinsipi):

| Limit | Nəyin qarşısını alır |
|---|---|
| `budget_usd_per_run` | bir icranın qaçması — `BudgetGuard`-a ötürülür |
| `budget_usd_total` | icraların YIĞILMASI: dəqiqədə $0.50 = aylıq $21,600 |
| `max_runs` | abunəlik icraları: real xərc `0`-dır, USD tavanı ONLARI TUTMUR |
| `max_pending_diffs` | DİSK (qayda 59) — yuxarıdakı üçü PULU qoruyur |

**Ölçülmüş incəlik — keş USD tavanını dayandırır.** Cədvəlin addım mətnləri
tərifdə SABİTDİR, yəni hər icra eyni keş açarını verir (Pillə 0). İkinci icradan
sonra xərc praktiki olaraq `0`-a düşür və `budget_usd_total` bir daha ARTMIR.
Qənaət baxımından yaxşı, tavan baxımından təhlükəli: USD tək başına cədvəli heç
vaxt dayandırmaya bilər. `max_runs` məhz buna görə ayrıca və məcburi tavandır
(`scheduler.test.ts`-də test edilib).

**Naməlum xərc cədvəli SÖNDÜRÜR.** Qayda 4 deyir ki, naməlum `0` deyil. Adi
taskda bu sadəcə ölçmənin boşluğudur; AVTOMATİK icrada isə "nə qədər
xərclədiyimi bilmirəm, amma davam edirəm" deməkdir — yəni tavanın kor olması.

Tavanlar `>=` ilə yoxlanılır (`>` yox): `maxRuns = 10` "on icra" deməkdir, on
birinci başlamamalıdır — `>` yazsaydıq hər tavan bir vahid sızardı. Növbəti icra
vaxtı və sayğac icradan ƏVVƏL yazılır: icra intervaldan uzun çəkərsə, sonra
yazsaydıq hər tik yeni icra başladar və onlar üst-üstə yığılardı.

**Taymer `buildApp`-da QURULMUR** (`startScheduler` default `false`).
`buildApp` testlərin əsas giriş nöqtəsidir; hər test fon taymeri açsaydı,
testlər bir-birinin cədvəlini qaçırar və ən pisi — səssizcə model çağıra
bilərdi. Məntiq taymerdən asılı deyil: `Scheduler.tick(now)` saatı parametr kimi
alır, ona görə aylıq davranış testdə saniyələrdə yoxlanılır. Taymer yalnız
`main.ts`-dədir və `unref` edilir — əks halda `SIGINT`-dən sonra proses
bağlanmazdı.

### 58. Zəncirin ağacının SAHİBİ sintetik valideyn taskdır

Issue #36. Əvvəl zəncirin `code` addımları istifadəçinin repo-suna BİRBAŞA
yazırdı: qayda 42-dəki baxış qapısı (*"diff `pending` yazılır, istifadəçi qəbul
edənə qədər repoya heç nə düşmür"*) zəncirdə işə düşmürdü. Bu, səssiz fərq idi —
eyni task tək göndəriləndə izolyasiya olunurdu, zəncirin addımı kimi göndəriləndə
isə yox.

Səbəb unudulmuş iş deyil, SXEM məhdudiyyəti idi: `artifacts.task_id` `NOT NULL`-dur
və zəncir icrasının öz taskı yox idi. İki alternativin hər ikisi daha pisdir:

- **addım başına ağac** — 2-ci addım 1-cinin yazdığı faylı GÖRMƏZDİ (qayda 40-ın
  qarşısını aldığı səhv, bir səviyyə yuxarıda)
- **sahibsiz ortaq ağac** — diff-i yazacaq yer yoxdur, yəni iş yalnız diskdə qalar

Ona görə `WorkflowEngine.start()` zəncir icrası üçün BİR sintetik task yaradır
(`workflow_runs.root_task_id`) və dekompozisiyanın hazır maşınları olduğu kimi
işləyir: ağac valideynin adına açılır, hər addımın `Ladder.run` çağırışına ORTAQ
ağac kimi ötürülür, addımların taskları `parent_task_id` ilə onun altına düşür və
diff sonda `finalizeWorktree` ilə valideynin adına `pending` yazılır.

Dörd incəlik, hər biri ayrıca bir səhvi bağlayır:

- **`http`-only zəncirdə task YARADILMIR.** Belə zəncir nə task qaçırır, nə fayla
  toxunur — boş task yalnız `/history` səhifəsini zibilləyərdi.
- **Ledger sətri YAZILMIR.** Valideynin öz icrası yoxdur, yəni ölçüləcək xərc də
  (qayda 24). Xərc addımların ÖZ ledger sətirlərindədir.
- **Statusu zəncirin yekununa uyğunlaşdırılır** (`settleRoot`, `Decomposer.settle`
  ilə eyni səbəb): bu taskın öz icrası yoxdur, yəni `RunSupervisor` onun statusunu
  HEÇ VAXT yazmır və `GET /api/tasks/:id` (diff-in baxıldığı səhifə) bitmiş işi
  əbədi "pending" göstərərdi. Addım icrası XƏTA atsa da bu yazılır, yoxsa bir
  tutulmamış xəta həm `workflow_runs`-u "running", həm taskı "pending"
  vəziyyətində dondurardı.
- **İzolyasiya şərti `shouldIsolate`-dir** — tək task və dekompozisiya ilə TAM
  eyni üç şərt (paralellik, `fileAccess`, kod/test tipi). Zəncirə xas daha sərt
  qayda YAZILMADI: baxış qapısının nə vaxt işə düşdüyü bütün yollarda eyni
  olmalıdır, yoxsa "eyni task tək göndəriləndə niyə başqa cür davranır?" sualı
  qayıdardı. Addımlar ayrıca təsnif olunur və ilk kod/test addımı ağacı açır:
  birləşdirilmiş mətni bir dəfə təsnif etsəydik, dörd mətn addımının yanındakı
  tək kod addımı siqnalda itərdi.

### 59. Cədvəlin dördüncü tavanı PULU deyil, DİSKİ qoruyur

Issue #38 (#36-dan qalan hissə). Qayda 58-dən sonra zəncirin `code` addımları
ortaq worktree-də işləyir və nəticə `pending` diff kimi saxlanılır. ƏL İLƏ
icrada bu doğrudur — istifadəçi baxıb qərar verir. AVTOMATİK icrada isə hər tik
yeni sintetik task, yeni ağac və yeni `pending` diff yaradır; yetim təmizləyicisi
onlara QƏSDƏN toxunmur (qayda 44), çünki onlar yetim deyil, baxılmamış işdir.
Yəni disk heç bir avtomatik yolla geri qaytarılmır.

Mövcud üç tavan buna KORDUR və bu, unudulmuş iş deyil — hər üçü XƏRC üçün
seçilib: `max_runs: 500` tam qanunidir, `budget_usd_total` isə keş səbəbindən
onsuz da praktiki olaraq dayanır (qayda 57). Ona görə dördüncü tavan LAZIMDIR,
mövcud birini "bir az daha dar seç" tövsiyəsi yox: iki fərqli resurs bir rəqəmlə
idarə olunmur.

Üç ehtimal olunan həlldən (issue #38) TAVAN seçildi, çünki qalan ikisi qaydaları
sındırır: "əvvəlkini əvəz et" baxılmamış işi SİLƏRDİ (qayda 44-ün əksi),
"cədvəldə izolyasiyanı söndür" isə baxış qapısını (qayda 42) məhz avtomatik
icrada — yəni istifadəçinin ən az baxdığı yerdə — bağlayardı.

Dörd qərar davranışı izah edir:

- **Say SAXLANILMIR, hər dəfə hesablanır** (`countPendingDiffsForSchedule`).
  Sayğac sütunu olsaydı, istifadəçi diff-i qəbul/rədd edəndə azalmazdı və tavan
  dolan kimi ƏBƏDİ dolu qalardı — "baxdım, davam et" mümkün olmazdı.
- **Say CƏDVƏL başınadır**, zəncir başına yox. Eyni zəncirə iki cədvəl qurmaq
  qanunidir və biri digərinin diskinə görə söndürülməməlidir. `trigger:
  'schedule'` bunu ayırd edə bilmir, ona görə `workflow_runs.schedule_id` sütunu
  əlavə edildi (xarici açar YOX — `root_task_id` ilə eyni səbəb: cədvəl
  silinəndə tarixçə qalmalıdır).
- **Yoxlama icradan ƏVVƏL də, SONRA da.** Yalnız əvvəldə yoxlasaydıq, gündəlik
  cədvəldə söndürülmə bir GÜN gecikər və istifadəçi səbəbi yalnız sabah görərdi.
  Sonrakı yoxlama sətri yenidən oxuyur: `settleCost` cədvəli artıq söndürmüş ola
  bilər (naməlum xərc) və o səbəb üstündən yazılmamalıdır.
- **Hədd rəqəmi hələ ÖLÇÜLMƏYİB** və bu, açıq etiraf olunur. Sahə API-də
  MƏCBURİDİR (qalan üçü kimi); `DEFAULT_MAX_PENDING_DIFFS = 5` isə YALNIZ sxem
  miqrasiyasının tələbidir — SQLite `ADD COLUMN … NOT NULL` əmrini DEFAULT
  olmadan qəbul etmir. Rəqəm KİÇİK seçilib, çünki səhvin iki istiqaməti eyni
  qiymətə başa gəlmir: çox kiçik → cədvəl tez dayanır, istifadəçi bir kliklə
  açır; çox böyük → disk heç nə ilə geri qaytarılmır (eyni mühakimə: qayda 46).

Sabit `schema.ts`-də LİTERALDIR, `@orchestris/shared` importu deyil:
`drizzle-kit generate` sxemi CJS kimi yükləyir və shared paketin ESM `.js`
spesifikatorlarını həll edə bilmir (`MODULE_NOT_FOUND`) — import migrasiya
generasiyasını tamamilə sındırardı. İki mənbənin ayrılmasını
`scheduler-diff.test.ts` bağlayır.

### 60. Tətbiq oluna bilməyən diff QAPIDA dayandırılır, `git apply`-də yox

Issue #41. `git apply` patch-i BÜTÖV qəbul edir və ya BÜTÖV rədd edir — ölçülüb
(real `git`, mətn + PNG dəyişikliyi):

```
error: cannot apply binary patch to 'logo.png' without full index line
error: logo.png: patch does not apply
```

`a.txt` toxunulmamış qaldı. Yəni doqquz mətn faylı + bir PNG dəyişən task
"Qəbul et" düyməsi ilə **heç nə** tətbiq etmir.

Repo toxunulmaz qalır (qayda 42 doğru işləyir) — sınıq olan İSTİFADƏÇİYƏ DEYİLƏN
SÖZDÜR. Ona görə qapı `apply`-dən ƏVVƏLƏ qoyulur və üç şey verir: səbəb,
FAYLLARIN ADI, worktree yolu. Xam git xətası bunların yalnız birini verir və ən
vacibini — dəyişikliyin HƏLƏ DƏ diskdə olduğunu — heç demir.

Bu, `truncated` ilə eyni müqavilədir (qayda 39): tətbiq oluna bilməyən diff
baxış üçün qalır, mənbə isə worktree qovluğudur. Fərq saxlanmadadır —
`truncated` SÜTUNDUR, çünki kəsmə `collect()` anında baş verir və məzmundan geri
oxuna bilmir; ikili marker isə saxlanılan mətnin İÇİNDƏDİR, ona görə HESABLANIR
(eyni mühakimə: issue #38-dəki `pendingDiffs`). Sütun əlavə etsəydik, mövcud
sətirlərə yanlış "boş" dəyər yazılar və qapı köhnə diff-lərdə səssizcə işləməzdi.

Marker sətrin ƏVVƏLİNDƏ axtarılır, `includes` ilə yox (qayda 9 prinsipi):
unified diff-də məzmun sətirləri həmişə `+`/`-`/` ` ilə başlayır, yəni 0-cı
sütun git-in özünə aiddir. Bu olmasaydı, məhz BU sənədi (və ya `worktree.ts`-i)
dəyişən hər task "ikili fayl var" kimi oxunardı.

Üç forma da tutulur (hər biri real `git` ilə ölçülüb) — yalnız birincisini
tutsaydıq, YENİ əlavə edilmiş şəkil qapıdan səssizcə keçərdi:

| Hal | Marker |
|---|---|
| dəyişib | `Binary files a/X and b/X differ` |
| silinib | `Binary files a/X and /dev/null differ` |
| yaranıb | `Binary files /dev/null and b/X differ` |

`GIT binary patch` markeri QƏSDƏN axtarılmır: o yalnız `--binary` ilə yaranır və
həmin halda patch TƏTBİQ OLUNA BİLİR — onu da "ikili" saysaydıq, işləyən diff-i
səhvən bloklayardıq.

### 61. Provayderin dəstəklənməsinə models.dev-in ÖZÜ qərar verir

Issue #44. Əvvəl `providers` cədvəlinə yalnız kəşf adapteri olan ÜÇ provayder
düşürdü və başqasını (DeepSeek, Groq, OpenRouter…) əlavə etmək ÜMUMİYYƏTLƏ
mümkün deyildi: `POST /api/providers` yox idi, `API_PROVIDER_IDS` sabit tuple
idi, `createProviderModel` üç SDK üzərində hardcoded `switch` idi.

Ölçmə həllin formasını təyin etdi (models.dev, 2026-07-29, 174 provayder):

| npm paketi | Say |
|---|---|
| `@ai-sdk/openai-compatible` | **138** |
| `@ai-sdk/anthropic` | 9 |
| `@ai-sdk/openai` | 4 |
| qalan (hər biri öz paketi) | 23 |

Və həmin 138-in **hamısının** `api` (baseURL) sahəsi var. Yəni əksəriyyət EYNİ
protokolu danışır və ünvanları onsuz da kataloqdadır.

Buradan iki qərar çıxır:

- **Ağ siyahı AD üzrə DEYİL, PROTOKOL üzrədir** (`providerSupport`). `['deepseek',
  'groq', …]` yazsaydıq, siyahı models.dev hər yeni provayder əlavə edəndə
  köhnələrdi və istifadəçi "niyə yoxdur?" sualını bizdən soruşardı. `npm` sahəsi
  isə provayderin protokolunu bildirir — bizə lazım olan da elə budur.
- **Ünvan istifadəçidən İSTƏNMİR.** Kataloqda olduğu üçün seçim + açar
  kifayətdir. Qiymətlər də oradan gəlir, yəni qənaət hesabı ilk gündən düzgün
  işləyir (qayda 4: kataloqda olmayan model üçün qiymət `undefined` qalır).

Öz adapteri olan üç provayder ÜSTÜN tutulur: `anthropic` OpenAI protokolunu
danışmır (`x-api-key` + `anthropic-version`), `google` isə ümumiyyətlə başqa
formatdadır. `openai-compatible` yalnız qalanlar üçündür.

**Ünvan DB-də saxlanılır, hər dəfə kataloqdan oxunmur.** models.dev bizim
nəzarətimizdə deyil: provayder oradan silinsə və ya ünvanı dəyişsə,
istifadəçinin İŞLƏYƏN quraşdırması bir gecədə sınardı — halbuki açar hələ də
həmin ünvana aiddir. Kataloq ilk əlavə anında oxunur, sonra sətir müstəqil
yaşayır.

**Runner-lər DİNAMİK qeydiyyata düşür.** `runners` xəritəsi artıq `ReadonlyMap`
deyil: `POST /api/providers` yeni runner-i ora yazır və bütün istehlakçılar
(router, readiness, `/api/health`) EYNİ istinadı gördüyü üçün provayder prosesi
yenidən başlatmadan işləyir. Nüsxə saxlasaydıq, istifadəçi açarı yazandan sonra
"runner yoxdur" görər və səbəbini heç yerdə tapa bilməzdi. Startda siyahı
`API_PROVIDER_IDS` DEYİL, DB-dən qurulur.

**~135 provayder AVTOMATİK səpilmir.** Hamısını `providers` cədvəlinə yazsaydıq,
`/providers` səhifəsi istifadəçinin heç vaxt işlətməyəcəyi sətirlərlə dolar və
"hansı biri mənimdir?" sualı yaranardı. `seedProviders` yenə yalnız üç adapterli
provayderi yazır; qalanı `GET /api/providers/available` siyahısından AÇIQ seçimlə
əlavə olunur.

Açar OPSİONALDIR — lokal provayderlər (Ollama, LM Studio) tələb etmir. Açarsız
əlavədə kəşf qaça bilmir, ona görə modellər KATALOQDAN yazılır: seçicidə model
görünməsə provayderi əlavə etməyin mənası qalmazdı.

### 62. Əməliyyatın nəticəsini SERVERİN vəziyyəti təyin edir, klientin `fetch`-i yox

Issue #46. `/providers` səhifəsi "Kataloqu yenilə" düyməsinin nəticəsini
`mutation.isError`-dan oxuyurdu. Bu, klientin sorğusunun taleyidir — SERVERİN
gördüyü işin deyil. `POST /api/registry/refresh` 3 MB yükləyir, keş faylını yazır
və provayderləri yenidən səpir; sorğu yolda kəsilsə iş yenə də GÖRÜLÜB, UI isə
"yenilənmədi" yazır. İstifadəçi düyməyə bir daha basır — halbuki hər basış yeni
3 MB yükləmə deməkdir.

Ona görə `mutationFn` artıq XƏTA ATMIR: sorğunun taleyi (`requestError`) və
kataloqun ƏVVƏL/SONRA vəziyyəti (`GET /api/providers` → `catalog`) birləşdirilir
(`lib/catalogRefresh.ts` → `catalogRefreshVerdict`, saf funksiya):

| Sorğu | Kataloq | Deyilən söz |
|---|---|---|
| uğurlu | — | yeniləndi |
| sınıq | `fetchedAt` irəliləyib (və ya `bundled` → `cache`) | **yeniləndi** |
| sınıq | dəyişməyib / oxunmayıb | yenilənmədi + **SƏBƏB** |

İki incəlik:

- **`bundled` → `cache` keçidi ayrıca yoxlanılır.** Yalnız `fetchedAt`
  müqayisəsi yazsaydıq, ilk uğurlu yeniləmə görünməzdi: snapshot mənbəyində o
  sahə ÜMUMİYYƏTLƏ yoxdur.
- **Səbəb indi göstərilir.** Server 502 gövdəsində `error` sahəsini qaytarır,
  köhnə UI isə onu atırdı — istifadəçi "sındı"nın niyəsini heç yerdə tapa
  bilmirdi. `refreshErrorReason` xam JSON-u açır (`{"ok":false,"error":"…"}` →
  yalnız mətn), çünki ekrana yazılan JSON səbəbi gizlətməklə eynidir.

Bilinməyən qəsdən bilinməz saxlanılır: kataloq vəziyyəti OXUNMAYANDA (`after`
yoxdur) nəticə **uğursuz** sayılır. "Bilmirəm"i "oldu" kimi göstərmək məhz
issue #46-daki yalanın əks istiqamətidir.

İssue-daki ehtimal (klient `fetch` timeout-u) TƏSDİQLƏNMƏDİ — ölçülmüş:
`POST /api/registry/refresh` 0.28 s-də cavab verir. Uydurma timeout əlavə
edilmədi (qayda 50 prinsipi); əvəzinə nəticə mesajı hər iki halda dürüst edildi.

### 63. Model seçicisinin süzgəci MODALİTƏ görədir, bayraqlara görə YOX

Issue #47. Başçı/İşçi seçicisi kataloqdaki BÜTÜN modelləri göstərirdi —
embedding, şəkil, audio (`text-embedding-3-small`, `gpt-image-2`,
`gpt-realtime-2.1`). Onlar başçı və ya işçi ola bilməz: seçilsə task icra anında
sınır.

İssue-də təklif olunan hər iki sadə siqnal ÖLÇÜLDÜ (models.dev keşi,
2026-07-30, 175 provayder / 5892 model, 5686-sı mətn→mətn) və hər ikisi
TƏKBAŞINA YANLIŞ çıxdı:

| Siqnal | Nə edir |
|---|---|
| `toolCall` | **1000** mətn modelini atır (`gpt-3.5-turbo`, lokal modellər) |
| `toolCall && structuredOutput` | **3288**-ni atır — `azure/claude-opus-4-5`-də `structured_output` sahəsi ÜMUMİYYƏTLƏ yoxdur |
| modality | embedding-i TUTMUR: models.dev onları `out: ["text"]` bildirir |

Ona görə süzgəc İKİ müstəqil qapıdan ibarətdir (`registry/capability.ts` →
`isTaskCapableModel`, saf funksiya, **0 token**) və bayraqlar İSTİFADƏ
OLUNMUR:

- **çıxışda mətn olmayan modalit varsa rədd** — `gpt-image-1.5` çıxışında `text`
  DA var (`limit.output` isə sıfırdır), ona görə şərt "mətn çıxarırmı" deyil,
  "mətndən BAŞQA nə çıxarır"dır. Girişdə mətn yoxsa da rədd (`whisper`:
  `in: ["audio"]` — prompt verə bilmirik).
- **adında `embed` varsa rədd** — kataloqda embedding üçün STRUKTUR bayraq
  yoxdur (`family: "text-embedding"` sərbəst mətndir). Ölçülmüş: adında `embed`
  olan 58 modelin HEÇ BİRİ `tool_call: true` deyil, yəni bu qapı işlək çat
  modelinə dəymir. Ad həm də modalitlər bilinmədikdə (Ollama, LM Studio) yeganə
  siqnaldır.

Dörd qərar davranışı izah edir:

- **Modalitlər DB-də SAXLANILMIR** — `taskCapable` `GET /api/models` cavabında
  kataloqdan HESABLANIR. Sütun kəşf anındaki nüsxəni dondurar və kataloq
  yeniləndikdən sonra köhnə qalardı (yalnız yenidən kəşf düzəldərdi). Eyni
  mühakimə issue #38-dəki `pendingDiffs` və #41-dəki `binaryFiles` ilə eynidir.
- **CLI provayderləri üçün xəritə MƏCBURİDİR.** `CLI_CATALOG_PROVIDER`
  (`cli:codex` → `openai`, qayda 21) olmadan süzgəc SIFIR model tutardı: real
  ölçmədə bu maşındaki 66 modeldən düşən 9-un HAMISI `cli:codex` altındadır —
  çünki `seedCliProviders` BÜTÜN OpenAI kataloqunu (embedding və şəkil daxil)
  köçürür.
- **Modalitlər bilinmirsə model BURAXILIR.** Kəşf edilmiş, kataloqda olmayan
  model (`source: 'api'`) `[]` daşıyır. Səhvin ucuz istiqaməti budur: yararsız
  model siyahıda görünsə istifadəçi onu seçib xətanı görür, işlək model səssizcə
  düşsə səbəbi heç yerdə tapa bilmir.
- **Süzgəc YALNIZ seçicidədir** (`lib/selectableModels.ts`). `/providers`
  siyahısı hamısını göstərməyə davam edir — orada istifadəçi əl ilə
  aktiv/söndürür — amma yararsız model `task üçün yararsız` işarəsi alır. İşarə
  olmasaydı, "modelim niyə seçicidə yoxdur?" sualının cavabı heç yerdə
  görünməzdi.

`gpt-3.5-turbo` QƏSDƏN siyahıda qalır: models.dev onu `tool_call: false`
bildirir, amma model task icra EDƏ BİLİR. Onu tutmaq üçün lazım olan bayraq
yanında 1000 işlək modeli atardı.

Ölçmə (real DB, 66 model): düşən **9** model — issue-də sadalananların hamısı.

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

Kəsişən mexanizm — **prompt distilləsi** (`exec/distill.ts`, pillə DEYİL):

```
eyni tipdə 2-ci task başçıya qalxdı → başçı BİR DƏFƏ işçi promptu + rubrika yazır
                                       (`task_templates`, ladder_rung -1)
sonrakı bütün eyni tipli tasklar     → şablon suffiks kimi əlavə olunur   0 token
```

Faydası `uses` / `escalations_after` nisbəti ilə ölçülür və `/ladder`
səhifəsində göstərilir: şablon tətbiq olunub, task yenə qalxırsa mexanizm
zərərə işləyir.

İkinci kəsişən mexanizm — **paralellik və izolyasiya** (`exec/pool.ts`,
`exec/worktree.ts`, pillə DEYİL, nəticəyə TOXUNMUR):

```
task göndərildi          → kontekst hovuzu: eyni anda ən çox `max_parallel` icra
paralel KOD taskı        → ayrıca git worktree (`orchestris/<taskId>` branch-ı)
icra bitdi, dəyişiklik var → diff `artifacts`-a `pending` yazılır, ağac QALIR
istifadəçi qəbul etdi     → `git apply` əsas repoya, ağac silinir
istifadəçi rədd etdi      → ağac silinir, repoya heç nə yazılmır
kəsilmiş / İKİLİ diff     → qəbul QAPIDA dayanır (409), ağac QALIR (qayda 60)
```

Üçüncü kəsişən mexanizm — **yaddaş** (`memory/`, pillə DEYİL, Faza 3):

```
task başlayır  → recall(scope, ~600 token) → ETİBARSIZ çərçivə işçi promptunun sonunda
                 (keş açarı bu mətnin hash-ini daşıyır — qayda 47)
task UĞURLA bitdi (keşdən DEYİL) → remember(scope, task + nəticə)
xərc            → `memory_ops` → `savings_ledger.memory_cost_usd` (AYRICA sütun)
provayder sındı → task yaddaşsız DAVAM EDİR (yaddaş optimallaşdırmadır)
```

Default `NullProvider`-dir: yaddaş yalnız `ORCHESTRIS_MEMORY=claude-mem` ilə
qoşulur (qayda 50). Vəziyyət `/ladder` səhifəsində, task başına əməliyyatlar
isə `/tasks/:id` cavabında görünür.

Dördüncü kəsişən mexanizm — **task dekompozisiyası** (`exec/decompose.ts`,
`exec/decomposer.ts`, pillə DEYİL, Faza 4):

```
istifadəçi `decompose: true` verdi → başçı BİR DƏFƏ bölgü yazır (ladder_rung -2)
bölgü 2–6 parça verdi              → hər parça `tasks.parent_task_id` ilə yaradılır
                                     və ÖZ nərdivanından keçir (keş, routing, 3, 6, 7)
parçalar ARDICIL, EYNİ worktree-də → sonrakı əvvəlkinin işini görür (qayda 53)
hamısı bitdi                       → yoxlama əmrləri BİR dəfə, bütöv nəticə üzərində
bölgü alınmadı                     → task ADİ nərdivandan keçir (nəticə itmir)
```

Bölgü AVTOMATİK DEYİL (qayda 52) və nəticəyə toxunmur: parçaların cavabları
`/tasks/:id` cavabındakı `subtasks` ağacındadır, xərci isə valideynin
`savings_ledger` sətrində orkestrasiya xərci kimi görünür (qayda 51).

Beşinci kəsişən mexanizm — **workflow zəncirləri** (`exec/workflow*.ts`, pillə
DEYİL, Faza 4):

```
zəncir tərifi (`workflows.steps_json`) → addımlar SIRA İLƏ
addım çıxışı → növbətinin `{{previous}}` girişi              0 token
`when` şərti ödənmirsə → addım ATLANIR (zəncir davam edir)   0 token
`repeat.until` ödənənə qədər → addım təkrarlanır (max 5)
`continueOnError` yoxdursa → sınıq addım zənciri DAYANDIRIR
`kind: 'http'` → xarici sorğu, YALNIZ ağ siyahıdakı hosta    (fail-closed)
büdcə          → addımlar ARASINDA paylaşılır
task addımı var → sintetik VALİDEYN task (`workflow_runs.root_task_id`)
paralel KOD zənciri → BİR ortaq worktree, sonda diff valideynin adına `pending`
```

Zəncirin öz məntiqi **sıfır token** xərcləyir (qayda 54) — hər addım isə tam
nərdivandan keçir. İzolyasiya addım başına deyil, ZƏNCİR başınadır (qayda 58):
addımlar asılıdır, ona görə hamısı eyni ağacda işləyir və nəticə `git apply` baxış
qapısından keçir.

Altıncı kəsişən mexanizm — **cədvəl üzrə icra** (`exec/scheduler.ts`, Faza 4):

```
`schedules` sətri → hər `interval_seconds`-də bir zəncir icrası
hər icraya      → `budget_usd_per_run` sərt limit kimi ötürülür
hər icradan sonra → REAL xərc `savings_ledger`-dən yığılır
                    + baxılmamış diff sayı (CANLI hesablanır)
tavan doldu (USD / icra sayı / naməlum xərc / baxılmamış diff) → SÖNDÜR + səbəb
```

Dörd tavanın hər biri ayrı sızma yolunu bağlayır (qayda 57) və hamısı
MƏCBURİDİR; sonuncusu pulu deyil, DİSKİ qoruyur (qayda 59). Taymer yalnız
`main.ts`-də qurulur; `Scheduler.tick(now)` saatı parametr alır.

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
  (öz fixture-ləri ilə); sonradan: OpenAI-uyğun provayderlərin əlavə edilməsi
  (`providers.base_url`, `POST /api/providers`, issue #44, qayda 61)
- **1C** (bitdi) — Pillə 0–2 amplifikasiya: keş, qayda routing + Auto, alət
  yoxlaması, `savings_ledger` (qənaətin dürüst ölçülməsi)
- **2** (bitdi) — Pillə 3 (best-of-N + razılaşma), 4 (ipucu/shepherding),
  5 (plan/icra bölgüsü), 6 (self-escalation), 7-yə eskalasiya, prompt
  distilləsi (`task_templates`), paralel icra hovuzu (`contexts.max_parallel`)
  və git worktree izolyasiyası + diff qəbulu (`artifacts`)
- **3** (bitdi) — memory: `MemoryProvider` adapteri (`NullProvider` default,
  `ClaudeMemProvider` opsional), token büdcəsi + prompt injection qoruması,
  yaddaş xərcinin ayrıca ölçülməsi (`memory_ops` → `savings_ledger`)
- **4** (bitdi) — task dekompozisiyası (`tasks.parent_task_id`, `Decomposer`,
  alt-task ağacı), workflow zəncirləri (`workflows` / `workflow_runs` /
  `workflow_step_runs`, şərtli budaqlanma + təkrar + xarici HTTP addımı),
  cədvəl üzrə icra (`schedules`, dörd məcburi tavan) və `/workflows` səhifəsi;
  zəncir icrasının sintetik valideyn taskı (`workflow_runs.root_task_id`) —
  ortaq worktree və `git apply` baxış qapısı (issue #36); cədvəlin disk tavanı
  (`schedules.max_pending_diffs`, `workflow_runs.schedule_id`, issue #38)

## Bilinən boşluqlar

- **Dekompozisiyanın faydası ölçülməyib.** `FakeRunner` ilə hər yol örtülüb,
  amma "zəif model 4 kiçik parçanı bir böyük taskdan yaxşı həll edirmi?" sualı
  real modellə sınanmayıb. Ölçmə üsulu var: eyni task dəstini `decompose: true`
  və `false` ilə qaçırıb `runs.ladder_rung` bölgüsünü (7-yə çatan parça faizi)
  və `savings_ledger`-dəki net qənaəti tutuşdurmaq. Bölgü ZƏRƏRƏ işləyirsə bu,
  valideynin orkestrasiya xərcində dərhal görünəcək (qayda 51) — mexanizm
  qəsdən belə qurulub.
- Başçının bölgü müqaviləsinə NƏ QƏDƏR əməl etdiyi bilinmir: `MAX_SUBTASKS`,
  `SUBTASK_CHAR_LIMIT` və "həlli yazma" tələbi mühakimə ilə seçilib. İlk real
  bölgülərdən sonra rədd nisbəti (`parseDecomposition` → `null`) izlənilməlidir
  — hər rədd bir başçı icrasının boşa getməsidir.
- **Alt-tasklar PARALEL qaçmır** (qayda 53). Issue #12 paralel icranı nəzərdə
  tuturdu, amma bölgünün öz müqaviləsi parçaları ASILI edir ("sonrakı əvvəlkinin
  üzərində qurur"). Paralel icra üçün başçıdan asılılıq QRAFI istənilməlidir və
  müstəqil parçalar ayrı worktree-lərdə qaçmalıdır; qazanc divar saatıdır, xərci
  isə N ağac + mürəkkəbləşən bölgü promptudur — ölçülməyib.
- Dekompozisiyada yekun yoxlama SINANDA avtomatik təmir dövrəsi YOXDUR: valideyn
  `verification_failed` olur və istifadəçi özü qərar verir. Avtomatik təmir üçün
  "hansı parça sındı?" sualına cavab lazımdır, `tsc` çıxışı isə bunu demir —
  səhv təxminlə yanlış parçanı yenidən qaçırmaq pulu boşa yandırardı. Zəncirlə
  bu, ƏL İLƏ qurula bilər (`continueOnError` + `test: 'failed'` budağı), amma
  dekompozisiyanın içində avtomatik deyil.
- **Baxılmamış diff tavanının RƏQƏMİ ölçülməyib** (qayda 59, issue #38).
  Mexanizm işləkdir və `FakeRunner` + saxta `WorktreeManager` ilə tam örtülüdür
  (`scheduler-diff.test.ts`), amma `DEFAULT_MAX_PENDING_DIFFS = 5` mühakimə ilə
  seçilib. İki rəqəm real işlətmə ilə ölçülməlidir: (1) cədvəllə qaçan `code`
  zəncirinin icralarının neçə faizi HƏQİQƏTƏN diff yaradır — Pillə 0 keşi
  səbəbindən ikinci icradan sonra cavab dəyişməyə bilər (qayda 57-dəki eyni
  mexanizm), (2) orta worktree ölçüsü. Birinci rəqəm kiçikdirsə tavan praktiki
  olaraq heç vaxt işə düşməyəcək və hədd genişləndirilə bilər; böyükdürsə
  cədvəl hər neçə icradan bir dayanacaq və istifadəçi bunu darıxdırıcı sayacaq.
  Ölçmə üsulu: `schedules.max_pending_diffs`-i geniş qoyub
  `GET /api/schedules` cavabındakı `pendingDiffs` sayının `runs` ilə nisbətini
  izləmək.
- Zəncirlərin FAYDASI ölçülməyib: `FakeRunner` ilə hər yol örtülüb, amma
  "çoxaddımlı işi zəncirə bölmək tək taskdan yaxşıdırmı?" sualı real modellə
  sınanmayıb. Xüsusən `{{previous}}` ilə ötürülən mətnin uzunluğu hər addımda
  giriş tokeni kimi ödənilir (`STEP_OUTPUT_CHAR_LIMIT` = 8000) — uzun zəncirdə
  bu, dekompozisiyadan bahalı ola bilər. Ölçmə üsulu: eyni işi bir taskla,
  dekompozisiya ilə və zəncirlə qaçırıb `savings_ledger` cəmini tutuşdurmaq.
- **Cədvəl üzrə icra real modellə sınanmayıb.** Tavanlar `FakeRunner` ilə tam
  örtülüdür (`scheduler.test.ts`), amma ən vacib sual — "keş səbəbindən USD
  tavanı praktiki olaraq dayanır" (qayda 57) — real işçi ilə təsdiqlənməlidir.
  İlk real cədvəldən sonra `schedules.spent_usd` və `runs` nisbəti izlənilməli,
  `spent_usd` gözləniləndən çox kiçik qalırsa səbəb keşdir və `max_runs`
  yeganə işləyən tavandır.
- Cədvəl `interval + startAt` ilə qurulur, tam cron ifadəsi ilə YOX. "Hər gün
  saat 9-da" `intervalSeconds: 86400` + uyğun `startAt` ilə ifadə olunur, amma
  "iş günləri" və ya "ayın 1-i" ifadə oluna bilmir. Cron parseri asılılıq və ya
  ~200 sətir kod + test tələb edir; ehtiyac real işlətmədə görünəndə əlavə
  edilməlidir.
- Zəncir redaktoru JSON-dur: struktur redaktor (sürüklə-burax) yoxdur. Səhvlər
  eyni Zod sxemi ilə göndərilməzdən ƏVVƏL tutulur və addımlar oxunaqlı siyahı
  kimi göstərilir (`StepList`), amma uzun zəncirlərdə bu, əlverişsizdir.
- **`ClaudeMemProvider`-in sim protokolu təsdiqlənməyib.** Bu maşında
  claude-mem quraşdırılmayıb (`~/.claude-mem` yoxdur, `claude-mem` PATH-da
  yoxdur), ona görə endpoint yolları (`/health`, `/recall`, `/remember`), port
  (`37777`) və cavab sahələri sənədə əsaslanır, ölçməyə yox. Bütün yollar saxta
  `fetch` ilə test olunub (`claude-mem.test.ts`) — yəni ADAPTER işləyir, uzaq
  tərəflə uyğunluğu isə bilinmir. Real quraşdırmadan sonra bir dəfə
  `GET /api/memory` yoxlanmalı, uyğunsuzluq varsa `DEFAULT_CLAUDE_MEM_CONFIG`
  düzəldilməlidir. Fail-closed olduğu üçün səhv konfiqurasiya səssiz zərər
  vermir: `health()` `ok: false` qaytarır və yaddaş qoşulmur.
- Minimum claude-mem versiyası (command-injection düzəlişi, #354) **bilinmir**
  və ona görə konfiqurasiya tələb olunur (qayda 50). Düzəlişin hansı versiyada
  olduğu təsdiqlənəndə `DEFAULT_CLAUDE_MEM_CONFIG.minVersion`-a yazılmalıdır.
- Yaddaşın FAYDASI ölçülməyib: `MEMORY_TOKEN_BUDGET = 600` mühakimə ilə
  seçilib (CLI prompt döşəməsinin ~3%-i), amma "600 token yaddaş zəif modelin
  nəticəsini yaxşılaşdırırmı?" sualı sınanmayıb. Ölçmə üsulu var: eyni task
  dəstini `memory_enabled` açıq və bağlı qaçırıb `runs.ladder_rung` bölgüsünü
  (7-yə çatan tasklar) tutuşdurmaq. Nəticə pisdirsə büdcə kiçildilməli və ya
  yaddaş yalnız müəyyən task tiplərinə verilməlidir.
- Yaddaş qeydinin FORMATI sınanmayıb: hazırda `TASK: … / NƏTİCƏ: …` xam
  mətndir və sıxma tamamilə provayderin öhdəsinədir. Provayder sıxmırsa qeydlər
  böyüyəcək və büdcə getdikcə daha az qeyd buraxacaq — bu, `memory_ops.items`
  sütununda görünəcək (qeyd sayı zamanla azalırsa səbəb budur).
- Worktree izolyasiyası **real paralel yükdə** ölçülməyib: git yolu müvəqqəti
  repo üzərində real `git` ilə test olunur (`worktree.test.ts`), nərdivan yolu
  isə saxta manager ilə — amma iki agentin EYNİ ANDA iki worktree-də işləməsi
  yalnız real modellə görünəcək. Xüsusi risk: yoxlama əmrləri (`pnpm test`,
  dev server portu, paylaşılan build keşi) paralel worktree-lərdə bir-birinə
  mane ola bilər. `max_parallel > 1` ilə ilk real sınaqdan sonra yoxlanmalıdır.
- **İkili (binary) fayl hələ də ƏL İLƏ götürülməlidir** (qayda 60, issue #41).
  Xəbərdarlıq artıq var — qəbul qapısı belə diff-i bloklayır və faylları adbaad
  sadalayır — amma sistem faylı istifadəçi üçün ÇIXARMIR. Diff-i `--binary` ilə
  toplamaq bunu həll edərdi, lakin qiyməti ölçülməyib: base64 blob UI-da oxunmaz
  olar və SQLite sətrini şişirdər. Ölçmə üsulu: real ikili dəyişiklikli bir neçə
  taskda `--binary` diff-in uzunluğunu mövcud `DIFF_CHAR_LIMIT` ilə tutuşdurmaq.
  Alternativ (daha ucuz) yol: faylı worktree-dən birbaşa endirmək üçün route.
- Pillə 3-ün nüsxələri EYNİ worktree-də ARDICIL qaçır (bax qayda 40). Nüsxələri
  paralel qaçırmaq üçün hər nüsxəyə ayrıca ağac lazımdır — qazanc divar saatıdır,
  xərci isə N ağacdır; ölçülməyib.
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
- Prompt distilləsinin faydası ölçülməyib: `FakeRunner` ilə hər yol örtülüb,
  amma zəif modelin başçının yazdığı şablonla NƏ QƏDƏR yaxşılaşdığı bilinmir.
  İlk real şablonlardan sonra `/ladder` səhifəsindəki `uses` /
  `escalations_after` nisbəti izlənilməlidir — nisbət pisdirsə şablon zərərə
  işləyir və qapı (qayda 38) sərtləşdirilməlidir. Eyni şəkildə başçının
  müqaviləyə əməl edib-etmədiyi (`worker_prompt` uzunluğu, nümunəyə xas
  detalların sızması) əl ilə yoxlanılmalıdır.
- `detectMultiStep`-in dəqiqliyi real task korpusunda ölçülməyib: siqnal dar
  seçilib (yalan-müsbət bahadır), amma neçə çoxaddımlı taskın SƏHVƏN Pillə 4-ə
  düşdüyü bilinmir. `runs.ladder_rung` üzərindən 4 və 5-in payı və qəbul
  nisbətləri tutuşdurulmalıdır.
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
- **OpenAI-uyğun provayderlər real açarla sınanmayıb** (qayda 61, issue #44).
  Protokolun EYNİ olduğu models.dev-in `npm` sahəsindən götürülür — bu, güclü
  siqnaldır, amma ölçmə deyil: bəzi provayderlər `/models` endpoint-ini
  ümumiyyətlə vermir və ya `Authorization` əvəzinə başqa başlıq gözləyir. Belə
  halda kəşf sınır, `providers.last_discovery_error` səbəbi göstərir və
  provayder əlavə edilmiş qalır — yəni səssiz zərər yoxdur, amma istifadəçi
  modelləri əl ilə əlavə edə bilmir. İlk real DeepSeek/Groq/Ollama açarından
  sonra `POST /api/providers` bir dəfə təsdiqlənməlidir; sınan provayder
  aşkarlansa, kəşfsiz (yalnız kataloq modelləri ilə) əlavə yolu lazım olacaq —
  hazırda o yol yalnız AÇARSIZ əlavədə var.
- `ApiRunner` real API axını ilə yoxlanılmayıb — bu maşında API açarı yoxdur.
  Saxta axın `ai@7.0.37`-nin ÖZ `dist/index.d.ts` tipindən və
  `@ai-sdk/anthropic`-in usage çevirmə kodundan qurulub, uydurulmayıb. Açar
  əlavə ediləndən sonra bir dəfə:
  `ORCHESTRIS_E2E=1 ANTHROPIC_API_KEY=… pnpm test` — bu, default olaraq
  atlanan `runners/api.e2e.test.ts` blokunu işə salır (yeganə real çağırış).
