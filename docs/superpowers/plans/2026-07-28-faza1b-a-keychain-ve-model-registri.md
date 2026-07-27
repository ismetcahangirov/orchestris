# Faza 1B-A — Keychain və Model Registri: Implementation Plan

**Goal:** API provayderlərini işlədə bilmək üçün iki təməli qurmaq — açarların
OS anbarında təhlükəsiz saxlanması (issue #5) və modellərin qiymətləri ilə
kəşfi (issue #6). İkisi də `ApiRunner`-in (issue #4) ön şərtidir.

**Bu plan nəyi əhatə etmir:** `ApiRunner`-in özü (issue #4, Faza 1B-B),
qayda-əsaslı routing (issue #7), `savings_ledger` (issue #8).

---

## Niyə bu ardıcıllıq

Issue #4 (`ApiRunner`) iki şeyi tələb edir və onlarsız yazıla bilməz:

| Tələb | Kim verir |
|---|---|
| API açarı | #5 — keychain |
| `costUsd` hesablamaq üçün qiymət | #6 — models.dev registri |

Ona görə #5 və #6 birlikdə, #4-dən əvvəl gəlir.

## Ölçülmüş faktlar (bu planın əsası)

Hər qərar aşağıdakı ölçmələrə söykənir — 2026-07-28, `models.dev/api.json`.

| Ölçmə | Nəticə |
|---|---|
| Tam models.dev cavabı | 3.2 MB, 172 provayder |
| 3 provayderə (anthropic/openai/google) kəsilmiş, işlətdiyimiz sahələrlə | **68 KB, 103 model** |
| Qiyməti ÜMUMİYYƏTLƏ olmayan model | **9** |
| `cache_read` qiyməti olmayan model | **30** (anthropic 0, openai 12, google 18) |
| `@napi-rs/keyring` Windows-da | prebuilt binding var, `allowBuilds` **lazım deyil** |
| `Entry.getPassword()` silinmiş qeyd üçün | `null` qaytarır, **atmır** |
| `tsc` + `resolveJsonModule` | JSON-u `dist/`-ə **köçürür** → idxal `build`-dan sonra da işləyir |

Bu rəqəmlərdən çıxan iki qərar:

1. **Snapshot kəsilir.** 3.2 MB JSON-u repoda saxlamaq hər `git clone`-a düşərdi;
   68 KB isə diff-də oxunaqlıdır. `scripts/fetch-models-snapshot.mjs` onu yenidən
   yaradır.
2. **Qiymət komponent-səviyyəsində yoxlanılır.** 30 modelin `cache_read` qiyməti
   yoxdur; onları birbaşa "qiyməti bilinmir" saysaq, keşdən heç nə oxumayan
   icralarda da büdcə mühafizəsi kor qalardı (bax `CLAUDE.md` qayda 15).

## Fayl strukturu

```
scripts/
└─ fetch-models-snapshot.mjs        YENİ — snapshot-u yenidən yaradır

apps/server/src/
├─ secrets/
│  ├─ keychain.ts                   YENİ — CredentialStore, KeyringStore, MemoryStore
│  └─ redact.ts                     YENİ — açarı log/xəta/cavabdan kəsir
├─ registry/
│  ├─ models-snapshot.json          YENİ — bundled snapshot (68 KB, offline)
│  ├─ models-dev.ts                 YENİ — zod kataloq, 24 saat TTL keş
│  ├─ pricing.ts                    YENİ — computeCostUsd
│  └─ discovery.ts                  YENİ — provayder endpoint × models.dev kəsişməsi
├─ db/
│  ├─ schema.ts                     DƏYİŞİR — providers, models
│  ├─ client.ts                     DƏYİŞİR — DDL + qismən unikal indekslər
│  └─ registry-repo.ts              YENİ — provider/model repo funksiyaları
├─ routes/
│  ├─ providers.ts                  YENİ — açar, kəşf, model, kataloq REST-i
│  └─ tasks.ts                      DƏYİŞİR — köhnə /api/providers buradan çıxır
└─ app.ts                           DƏYİŞİR — credentials/catalog/fetchImpl inyeksiyası

apps/web/src/
├─ components/ModelList.tsx         YENİ
├─ pages/Providers.tsx              DƏYİŞİR — açar forması + model siyahısı
└─ lib/api.ts                       DƏYİŞİR — yeni cavab tipləri
```

## Əsas dizayn qərarları

### Açar yalnız bir istiqamətdə hərəkət edir

```
brauzer (type=password, lokal state)
   │  POST /api/providers/:id/credential   (yalnız body-də, URL-də YOX)
   ▼
server ──► OS keychain
   │
   └──► DB: YALNIZ credential_ref (`provider:anthropic`)
```

Geri yol yoxdur: heç bir cavab sxemində açar sahəsi yoxdur, `GET /api/providers`
yalnız `hasCredential: boolean` qaytarır. Bunu üç yerdə test yoxlayır (server
cavabı, DB sətri, brauzer sorğusu).

### İki qatlı kəsmə (redaction)

`redactSecret` konkret açarı, `redactApiKeys` isə tanınan naxışları kəsir.
İkinci qat lazımdır, çünki naxış siyahısı heç vaxt tam olmur; birinci qat
lazımdır, çünki naxış tanınmayan formatlar var. Kəsmə **mənbədə** — hadisə
yaranmazdan əvvəl — edilir, çünki `run_events` append-only jurnaldır: ora
düşən açar orada qalır.

### Kəşf = kəsişmə, birləşmə deyil

```
provayder endpoint-i  →  açarın REAL icazə verdiyi modellər
        ∩
models.dev            →  qiymət, limit, qabiliyyət
```

Yalnız models.dev-ə baxsaydıq istifadəçi işlətdiyi anda 403 alan modelləri
görərdi. Endpoint-in verdiyi, models.dev-də olmayan model **saxlanılır**
(`source: 'api'`), amma qiyməti `NULL` qalır — `0` yazmaq onu pulsuz
göstərərdi.

### Kəşf istifadəçinin seçimlərini sıfırlamır

`upsertModels` `delete + insert` DEYİL. Kəşf yalnız metadatanı (ad, qiymət,
limit, qabiliyyət) yeniləyir; `enabled`, `role_boss`, `role_worker`,
`role_classifier` toxunulmaz qalır. Kəşfdə görünməyən köhnə model də silinmir —
provayder müvəqqəti natamam cavab versə, istifadəçinin işlətdiyi model
siyahıdan yoxa çıxmamalıdır.

### Başçı/klassifikator təkliyi BAZADA təmin olunur

```sql
CREATE UNIQUE INDEX models_single_boss_idx ON models(role_boss) WHERE role_boss = 1;
```

Qismən unikal indeks "iki başçı" vəziyyətini tətbiq qatında yox, bazada
qeyri-mümkün edir. `setExclusiveRole` tranzaksiya içində əvvəlcə rolu köhnə
sahibdən alır — istifadəçi "başçını dəyiş" deyir, "əvvəlcə köhnəni sil" yox.

### Kataloq oxumaq şəbəkəyə çıxmır

`loadCatalog()` yalnız keş faylına və bundled snapshot-a baxır; şəbəkə
yeniləməsi açıq `refreshCatalog()` / `POST /api/registry/refresh` ilə edilir.
Səbəb: kataloq server startında və hər `/api/providers` sorğusunda oxunur —
onların hər birində 3 MB yükləmək (və şəbəkə yoxdursa gözləmək) qəbuledilməzdir.

Yeniləmə sınarsa **atır** və köhnə keş toxunulmaz qalır: istifadəçi
"yeniləndi" yazısını görüb köhnə qiymətlərə inanmamalıdır.

### Zod sxemi yumşaqdır, amma model-model yoxlanılır

models.dev bizim nəzarətimizdə deyil. Sərt sxem yazsaq, onlar bir sahə əlavə
edən kimi bütün kataloq yüklənməzdi. Ona görə hər model **ayrıca**
`safeParse`-dən keçir və yalnız pozuq model atılır — qalanı işləyir.

## Test strategiyası

Bütün testlər **sıfır token** və **sıfır şəbəkə** xərcləyir:

| Sahə | Necə |
|---|---|
| Model kəşfi | `fetchImpl` inyeksiyası — saxta `fetch` |
| Kataloq yeniləməsi | eyni |
| Keychain | `MemoryStore`; `KeyringStore` yalnız oxuma yolunda (yazmır) |
| Offline iş | bundled snapshot-dan yükləmə testi |

`buildApp` üçün `credentials` **məcburi şəkildə** `MemoryStore` ötürülməlidir —
default `KeyringStore` istifadəçinin real anbarına yazardı.

## Yan tapıntı — mövcud testdəki gizli qüsur

`verify.test.ts`-dəki "bir əmr artıq keçdikdən sonra siqnal ləğv edilsə"
testi `setTimeout(() => ac.abort(), 200)` işlədirdi, yəni `okCmd`-in 200 ms-dən
tez bitəcəyini fərz edirdi. Bu plandakı yeni test faylları paralel yükü
artırdıqda Node-un start vaxtı həddi aşdı və ləğv **birinci** əmrin ortasında
atəş açdı (3/3 qaçışda sındı, izolyasiyada keçdi).

Düzəliş: ləğv vaxta yox, **fakta** görə tetiklenir — ikinci əmr başladığını
fayl yaradaraq bildirir, test onu gözləyib sonra ləğv edir. Yükdən asılı deyil.

## Qəbul kriteriyaları

Issue #5:
- [x] Açar `~/.orchestris/`-ə və ya `.env`-ə yazılmır; DB-də yalnız `credential_ref`
- [x] Açar HTTP cavabında qaytarılmır
- [x] Açar xəta mesajlarından kəsilir (iki qatlı redaction)
- [x] Keychain əlçatan deyilsə açıq xəta (503) — səssiz fayl fallback-i YOXDUR
- [x] `git ls-files | grep 'sk-ant\|sk-proj-'` boş
- [x] `@napi-rs/keyring` build skripti tələb etmir → `allowBuilds` dəyişmir

Issue #6:
- [x] Açar əlavə ediləndə modellər qiymətləri ilə avtomatik düşür
- [x] Offline işləyir (bundled snapshot)
- [x] Qiyməti bilinməyən model işlədilə bilir, `costUsd` yazılmır
- [x] `/providers` səhifəsində kontekst limiti, $in/$out, qabiliyyət nişanları
- [x] Testlər şəbəkəyə çıxmır
