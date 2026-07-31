# Faza 5A — Canlı görünüş, fayl icazəsi və qovluq seçicisi

**Tarix:** 2026-07-31
**Status:** Təsdiqlənmiş dizayn
**Müəllif:** brainstorming sessiyası (istifadəçi + Claude)

---

## 1. Kontekst — bu, üç alt-layihədən BİRİNCİSİDİR

İstifadəçinin ilkin sorğusu altı müstəqil alt-sistem idi. Onlar asılılıqlarına
görə üç alt-layihəyə bölündü və hər biri öz spesifikasiyası → planı → icrası ilə
ayrıca gedir:

| Alt-layihə | Nə əhatə edir | Vəziyyət |
|---|---|---|
| **A** (bu sənəd) | Canlı icra görünüşü + fayl icazəsi + qovluq seçicisi | dizayn təsdiqləndi |
| **B** | İnsan-döngədə: agentin SUAL verməsi (checkbox / bəli-xeyr) və işləyən icraya CANLI review ötürülməsi | sonra |
| **C** | MCP / skill / plugin dəstəyi + onları əlavə etmə bölmələri | sonra |

**A birincidir, çünki B onun üzərində qurulur:** işləyən icranı GÖRMƏDƏN ona canlı
rəy vermək mümkün deyil. C sonuncudur, çünki ən böyük və ən risklidir — o vaxta
qədər sistem onsuz da işlək olur.

**B və C-yə saxlanılanlar (bu sənəddə YOXDUR):**

- icazəsiz qovluğa toxunanda icranın DAYANIB təsdiq gözləməsi — B-nin
  pauza/davam mexanizmini tələb edir, A-da qurula bilməz
- MCP / skill / plugin bölmələri — C
- canlı review-un işçiyə ötürülməsi — B

### 1.1. C haqqında qabaqcadan qeyd

`CLAUDE_STABLE_FLAGS` hazırda MCP/skill/hook yükünü **qəsdən söndürür**
(`--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`) və CLAUDE.md
qayda 1 bunun ölçülmüş səbəbini saxlayır: istifadəçinin tam yükü ilə $0.0251,
onsuz $0.0085 — **~3x**. Yəni C layihənin əsas məqsədinin ("zəif modellə güclü
nəticə") əksinə işləyən istiqamətdir və orada dizaynın mərkəzi sual **seçmə**
(yalnız seçilmiş MCP-lər), **kontekst başına opt-in** və **xərcin ölçülüb
göstərilməsi** olacaq. A bu qərara heç bir şəkildə mane olmur: aşağıdakı heç bir
dəyişiklik `CLAUDE_STABLE_FLAGS`-a toxunmur.

---

## 2. Problem — ölçülmüş mövcud vəziyyət

### 2.1. Fayl icazəsi asimmetrikdir və heç yerdə görünmür

| Runner | Qurulma yeri | Faktiki icazə |
|---|---|---|
| `cli:claude` | `main.ts:20` → `new ClaudeCliRunner({ permissionMode: 'acceptEdits' })` | **fayl yazır** |
| `cli:codex` | `main.ts:21` → `new CodexCliRunner()` (arqumentsiz) | `--sandbox read-only` → **fayl YAZMIR** |

Yəni eyni task claude-a düşsə faylı dəyişir, codex-ə düşsə səssizcə dəyişmir.
Router (Pillə 1) hansı runner-in seçiləcəyini istifadəçidən gizlədir — yəni bu
fərq **təsadüfi** görünür və heç bir yerdə bildirilmir.

Üstəlik icazə **konstruktorda dondurulub**: kontekst başına dəyişən dəyər ora
sığmır. "Bu iş sahəsi yalnız-oxu olsun" demək ÜMUMİYYƏTLƏ mümkün deyil.

Nəhayət, agent yalnız kontekstin `cwd`-sini görür (`--add-dir req.cwd`) — repo
xaricindəki qovluğa (məs. ayrıca sənəd qovluğu) çıxış yolu yoxdur.

### 2.2. "Hazırda nə işləyir" sualının cavabı çıxarılmır

- `WsHub` **yalnız task başına** abunəlik saxlayır (`byTask` xəritəsi,
  `ws/hub.ts:14`). Qlobal kanal yoxdur.
- İşləyən icraları qaytaran endpoint YOXDUR.
- Məlumat isə VAR: `runs` cədvəlində `status`, `model_id`, `runner_id`,
  `ladder_rung`, `started_at` (`db/schema.ts:81`).

Yəni istifadəçi başqa səhifədə ikən sistemin nə etdiyini bilmir — və ən vacibi,
**hansı modelin** işlədiyini bilmir. Halbuki layihənin bütün mənası budur: task
ucuz modelə düşdü, yoxsa başçıya qalxdı?

### 2.3. İş qovluğu əl ilə yazılır və sonradan dəyişdirilmir

`cwd` yalnız kontekst YARADILANDA verilir. `UpdateContextBody`
(`packages/shared/src/api.ts:55`) `cwd` sahəsini ÜMUMİYYƏTLƏ daşımır — yəni səhv
yazılmış yol düzəldilə bilmir, kontekst yenidən yaradılmalıdır.

Yazılan yolun mövcudluğu da yoxlanmır: səhv yol yalnız ilk task icrasında üzə
çıxır.

---

## 3. Uğur kriteriyaları

1. Kontekst başına fayl icazəsi seçilir və **hər iki CLI-ya** eyni mənanı verir —
   asimmetriya kökündən itir.
2. İstifadəçi hər səhifədə hansı modelin, hansı taskda, hansı pillədə işlədiyini
   görür — gecikməsiz.
3. İş qovluğu və əlavə qovluqlar **əl ilə yol yazmadan** seçilir, seçim anında
   qovluğun git repo olub-olmadığı və yazıla bilib-bilmədiyi bilinir.
4. `CLAUDE_STABLE_FLAGS` DƏYİŞMİR — mövcud prompt keşləri sınmır (qayda 1).
5. Mövcud kontekstlərin davranışı DƏYİŞMİR — miqrasiya səssiz reqressiya
   yaratmır.
6. Testlər **sıfır token** xərcləyir (qayda 11).

---

## 4. Bölmə 1 — Sxem

Miqrasiya **`0010`** (mövcud sonuncu `0009_complete_karen_page.sql`).
`schema.ts` dəyişdikdən sonra `pnpm --filter @orchestris/server db:generate`
MÜTLƏQ çağırılır (qayda 26 — CI bunu yoxlayır).

`contexts` cədvəlinə iki sütun:

| Sütun | Tip | Default | Məna |
|---|---|---|---|
| `file_access` | `text NOT NULL` | `'workspace'` | `'read-only'` \| `'workspace'` \| `'extended'` |
| `extra_dirs_json` | `text NOT NULL` | `'[]'` | `'extended'` səviyyəsində icazəli əlavə qovluqların JSON massivi |

### 4.1. Default niyə `'workspace'`, `'read-only'` deyil

Mövcud kontekstlərdə `cli:claude` **bu gün onsuz da yazır** (`acceptEdits`).
Miqrasiyada `'read-only'` yazsaydıq, istifadəçinin işləyən qurulumu bir gecədə
səssizcə yazmağı dayandırardı və səbəbi heç yerdə görünməzdi.

Bu, qayda 43-dəki mühakimənin **əks istiqamətidir** və fərq qəsdəndir: orada köhnə
`max_parallel = 1` dəyəri istifadəçinin seçimi DEYİLDİ (onu dəyişmək üçün API
ümumiyyətlə yox idi), ona görə `0`-a çevrildi. Burada isə `acceptEdits` FAKTİKİ
davranışdır — istifadəçi ona güvənərək task göndərib. Seçilməmiş default-u
dəyişmək olar; işləyən davranışı yox.

### 4.2. `extra_dirs_json` səviyyə aşağı salınanda SİLİNMİR

`'extended'` → `'workspace'` keçidində siyahı yerində qalır, sadəcə OXUNMUR.
Silsəydik, istifadəçi səviyyəni geri qaytaranda beş qovluğu yenidən seçməli
olardı — halbuki o, sadəcə müvəqqəti daraltmışdı.

### 4.3. `extra_dirs_json`, ayrıca cədvəl deyil

Qovluqlar yalnız BÜTÖV oxunur (icra anında `--add-dir` siyahısına çevrilir),
üzərlərində sorğu, filtr və ya birləşdirmə yoxdur. `verify_commands_json` ilə eyni
formadır — layihədə artıq mövcud olan naxış.

---

## 5. Bölmə 2 — İcazənin runner-lərə tərcüməsi

Yeni saf funksiya: `exec/file-access.ts` → `resolveFileAccess(context, cwd)`.
Model çağırışı yoxdur, **0 token**.

```
resolveFileAccess({ fileAccess, extraDirs }, cwd) → {
  level: 'read-only' | 'workspace' | 'extended'
  dirs: string[]        // determinist sıralanmış
}
```

Tərcümə cədvəli — **hər runner özü tətbiq edir**:

| Səviyyə | `claude --permission-mode` | `codex --sandbox` | `--add-dir` |
|---|---|---|---|
| `read-only` | `plan` | `read-only` | cwd |
| `workspace` | `acceptEdits` | `workspace-write` | cwd |
| `extended` | `acceptEdits` | `workspace-write` | cwd + əlavələr |

### 5.1. İcazə konstruktordan `RunRequest`-ə keçir — RUNNER-DƏN ASILI OLMAYAN formada

Hazırda `permissionMode` runner-in konstruktorunda dondurulub (`main.ts:20`) —
kontekst başına dəyişən dəyər orada saxlanıla bilməz. Ona görə icazə
`RunRequest`-ə keçir (`packages/shared/src/runner.ts`):

```
RunRequest.fileAccess?: { level: 'read-only' | 'workspace' | 'extended', dirs: string[] }
```

**`claudePermissionMode` / `codexSandbox` paylaşılan tipə QOYULMUR.**
`RunRequest` `ApiRunner` tərəfindən də işlədilir və orada `--permission-mode`
anlayışı ümumiyyətlə yoxdur — konkret bayraq adlarını ora yazsaydıq, paylaşılan
müqavilə bir runner-in əmr sətri detallarını bütün runner-lərə sızdırardı və hər
yeni CLI üçün genişlənməli olardı.

Əvəzinə `RunRequest` **niyyəti** daşıyır (səviyyə + qovluqlar), tərcüməni isə
`buildClaudeArgs` / `buildCodexArgs` özü edir — yəni bayraq bilikləri onu
işlədən yeganə faylda qalır. API runner-ləri `level`-i yox sayır (`fileAccess`
onlarda mənasızdır) və yalnız `dirs`-i də oxumur.

Konstruktor seçimi **default** kimi qalır (`RunRequest.fileAccess` verilməsə
işlədilir) — mövcud testlər sınmır.

### 5.2. `CLAUDE_STABLE_FLAGS` TOXUNULMUR

`--permission-mode` və `--add-dir` onsuz da o dəstin XARİCİNDƏDİR —
`buildClaudeArgs`-ın sonunda əlavə olunur (`runners/claude.ts:79-82`). Yəni
sistem prompt prefiksinə dəymirlər və qayda 1-dəki keş sınması BAŞ VERMİR.

`--add-dir` sıralaması **determinist** olur (leksik sıra, `dirs` massivi
qurulanda bir dəfə). Sıralamasaydıq, eyni qovluq dəsti fərqli sıra ilə fərqli
əmr sətri verər və keş lazımsız yerə sınardı.

### 5.3. `read-only` → `plan` seçimi

`plan` rejimində `claude` fayla toxunmur, amma cavab verir. Yəni `read-only`
kontekst praktikada **"izah et / oxu / təhlil et"** taskları üçündür.

Alternativ `--permission-mode manual` idi və rədd edildi: `-p` (print) rejimində
interaktiv icazə pəncərəsi göstərilə bilmir, yəni `manual` sadəcə "hər alət
sorğusu rədd edilir" deməkdir — model faylı OXUYA da bilməz və nəticə mənasız
olar. `plan` oxumağa icazə verir, yazmağa yox — istənilən məhz budur.

### 5.4. Worktree izolyasiyası icazəni ÜSTƏLƏMİR

İzolyasiya varsa `cwd` worktree yoludur (qayda 40) və `read-only` kontekstdə
agent orada da yaza bilmir.

Bu, qəsdəndir: `read-only` "heç nə dəyişmə" deməkdir, "başqa yerdə dəyiş" yox.
Əks davranış istifadəçini yanıldardı — o, `read-only` seçib nəticədə `pending`
diff alardı və "mən bunu qadağan etmişdim" deyərdi.

### 5.5. `danger-full-access` YOXDUR

codex-in üçüncü sandbox səviyyəsi (`danger-full-access`) UI-a çıxarılmır.
Bizim `'extended'` səviyyəmiz `--add-dir` ilə **seçilmiş** qovluqlar deməkdir;
`danger-full-access` isə bütün diski açır və claude tərəfində qarşılığı yoxdur —
yəni onu qoysaq, eyni səviyyə iki runner-də FƏRQLİ şey ifadə edərdi. Məhz bu
asimmetriya aradan qaldırılır (bax §2.1).

---

## 6. Bölmə 3 — Canlı zolaq

### 6.1. Seçilmiş yanaşma: REST anlıq şəkil + qlobal WS

İlk yüklənmədə `GET /api/runs/active`, sonra `WsHub`-a **qlobal kanal** əlavə
olunur və yalnız **həyat dövrü** hadisələri yayılır.

Alternativ (hər 2 saniyə polling) rədd edildi: zolaq HƏR səhifədə həmişə mount
olunur, yəni heç nə işləməyəndə də saniyədə yarım sorğu gedərdi — və B-yə
çatanda kanal onsuz da lazım olacaq, yəni iş iki dəfə görülərdi.

### 6.2. `GET /api/runs/active`

İşləyən icraların siyahısı:

```
{ runs: [{
    runId, taskId, contextName,
    promptExcerpt,        // taskın ilk ~60 simvolu
    modelId, runnerId,
    ladderRung, attempt,
    startedAt
}] }
```

### 6.3. WS — `activity` mesajı

`WsHub.subscribeGlobal(socket)` / `unsubscribeGlobal(socket)` əlavə olunur.
`removeSocket` qlobal dəsti də təmizləyir.

Yeni mesaj (`packages/shared/src/events.ts`):

```
{ t: 'activity', kind: 'started' | 'updated' | 'ended', run: {...} }
```

`RunSupervisor` üç nöqtədə yayır: icra başlayanda, pillə/cəhd dəyişəndə, icra
bitəndə.

### 6.4. Delta YAYILMIR — bu, mərkəzi qərardır

Hərf-hərf axın (`--include-partial-messages`, qayda 27) qlobal kanala
**girmir**. Girsəydi, 5 paralel icrada hər brauzer beş axının hamısını alardı və
zolaq — ekranın ən kiçik elementi — ən böyük trafiki yaradardı.

Deltalar olduğu yerdə, task səhifəsinin öz abunəliyində qalır.

### 6.5. Keçən vaxt BRAUZERDƏ hesablanır

Zolaqdakı `0:14` sayğacı `startedAt`-dan brauzerdə hesablanır. Hər saniyə server
mesajı göndərmək eyni məlumatı şəbəkədən keçirməkdir — və sayğac serverin
yayımından daha hamar işləyir.

### 6.6. Orkestrasiya icraları da GÖRÜNÜR

Klassifikator, distillə (`ladder_rung: -1`), dekompozisiya (`-2`) də zolağa
düşür.

Səbəb: onlar da pul yandırır (qayda 22, 37, 51) və "niyə hələ gözləyirəm?"
sualının cavabı çox vaxt məhz onlardır. Gizlətsəydik, istifadəçi boş zolağa baxıb
sistemi donmuş sayardı.

Mənfi pillə nömrəsi UI-da rəqəm kimi göstərilmir — ad işlədilir (`distillə`,
`bölgü`), çünki "Pillə -1" heç nə demir və qayda 37-nin bütün mənası onun
nərdivandan KƏNAR olmasıdır.

### 6.7. Komponentlər

- `apps/web/src/components/LiveBar.tsx` — Sidebar-ın başında
- `apps/web/src/lib/useActivity.ts` — REST anlıq şəkli + WS mesajlarını
  birləşdirən hook

---

## 7. Bölmə 4 — Qovluq seçicisi

### 7.1. Niyə brauzerin öz seçicisi işləmir

Bu, dizaynın çıxış nöqtəsidir və ölçülmüş məhdudiyyətdir:

| Brauzer yolu | Nə qaytarır | Niyə yararsızdır |
|---|---|---|
| `showDirectoryPicker()` | `FileSystemDirectoryHandle` — yalnız `.name` (`orchestris`) | Mütləq yol QƏSDƏN verilmir (təhlükəsizlik qərarı). Üstəlik yalnız Chromium |
| `<input webkitdirectory>` | `webkitRelativePath` | Nisbi yoldur; üstəlik qovluğun BÜTÜN fayllarını sadalayır — `node_modules` olan repoda donma |

Bizə isə `cwd` və `--add-dir` üçün məhz **mütləq yol** lazımdır. Yəni seçici
serverin köməyi ilə qurulmalıdır.

Nativ OS pəncərəsi (PowerShell `FolderBrowserDialog`) da nəzərdən keçirildi və
rədd edildi: Windows-a bağlıdır, pəncərə brauzerin arxasında aça bilər, STA
thread tələb edir və **desktop olmayan mühitdə heç vaxt test edilə bilməz**.
Ən vacibi — o, seçim anında bizə lazım olan məlumatı (git repo? yazıla bilir?)
VERMİR.

### 7.2. `GET /api/fs/list?path=<mütləq yol>`

```
{
  path,                  // normallaşdırılmış cari qovluq
  parent: string | null, // kökdədirsə null
  drives: string[],      // Windows-da ['C:\\','D:\\'], POSIX-də ['/']
  entries: [{ name, path, isRepo, hidden }]
}
```

Qaydalar:

- `path` verilməsə başlanğıc `os.homedir()`
- **Yalnız qovluqlar** qaytarılır — fayllar heç vaxt
- **Fayl məzmunu heç vaxt oxunmur**
- **Rekursiya yoxdur** — bir sorğu bir səviyyə
- Yol normallaşdırılır və mütləq olmalıdır (nisbi yol → 400)
- Oxuna bilməyən qovluq (`EACCES`) siyahıda qalır, `entries`-ə düşmür — bir
  qovluğun icazəsizliyi bütün sorğunu sındırmamalıdır

### 7.3. `isRepo` — `.git` FAYL da ola bilər

`isRepo` `.git`-in varlığını yoxlayır, **fayl VƏ YA qovluq** kimi.

Yalnız qovluğu yoxlasaydıq, git worktree-ləri "repo deyil" görünərdi: worktree-də
`.git` bir FAYLDIR və içində `gitdir: …/.git/worktrees/<ad>` yazılır (qayda 44).
Sistem özü belə qovluqlar yaradır — onları tanımamaq öz məhsulumuzu tanımamaq
olardı.

### 7.4. Yazıla bilmə hər sətirdə GÖSTƏRİLMİR

Node-un `fs.access(dir, W_OK)` yoxlaması **Windows-da ACL-ləri görmür** (Node
sənədi bunu açıq yazır) — qovluq üçün praktiki olaraq həmişə "yazılır" deyir.
Yəni hər sətirdəki belə işarə YALAN olardı.

Dürüst yoxlama real yazma probudur (müvəqqəti fayl yarat → sil), onu isə 50
sətrin hamısına tətbiq etmək olmaz — 50 disk əməliyyatı hər naviqasiyada.

Ona görə:

| Məlumat | Harada | Necə |
|---|---|---|
| `isRepo` | hər sətirdə | bir ucuz `stat` |
| yazıla bilmə | yalnız SEÇİLMİŞ qovluq üçün | `GET /api/fs/check?path=…` → real yazma probu |

Bir probe, dəqiq cavab, və məhz cavabın əhəmiyyət daşıdığı yerdə. Prob yaratdığı
faylı HƏR HALDA silir (`finally`) — yoxsa istifadəçinin qovluğunda zibil qalardı.

### 7.5. Gizli qovluqlar

Nöqtə ilə başlayan qovluqlar `hidden: true` alır və UI-da default gizlədilir
(açılan keçidlə görünür). Gizlətməsəydik hər repo `.git`, `.vscode`, `.turbo`,
`.next` ilə dolar və axtarılan qovluq itərdi.

Server onları FİLTRLƏMİR, yalnız işarələyir: qərar UI-ındır və istifadəçi
`.config` kimi qovluğu seçmək istəyə bilər.

### 7.6. Təhlükəsizlik — açıq etiraf

Bu endpoint maşının qovluq strukturunu porta çıxarır. Tətbiqdə **heç bir
autentifikasiya yoxdur** — yeganə qoruma serverin `127.0.0.1`-ə bind olunmasıdır
(qayda 16).

Sızma səthi qəsdən dardır: fayl adları yox (yalnız qovluqlar), fayl məzmunu yox,
rekursiya yox. Bu, gizlədilmir və spesifikasiyada saxlanılır — C alt-layihəsində
(MCP) autentifikasiya sualı yenidən qalxacaq və o zaman bu endpoint də yenidən
nəzərdən keçirilməlidir.

Qovluq yolu üzərində **ağ siyahı QOYULMUR**: seçicinin bütün mənası istifadəçinin
maşınındakı istənilən qovluğu seçə bilməsidir. Ağ siyahı özü seçiciyə ehtiyacı
aradan qaldırardı.

### 7.7. `cwd` dəyişdirilə bilən olur

`UpdateContextBody`-yə `cwd: z.string().nullable().optional()` əlavə olunur
(`null` = iş qovluğunu sil).

Server yadda saxlamazdan ƏVVƏL yoxlayır: yol mövcuddur və QOVLUQdur. Yoxlamasaq,
səhv yol yalnız ilk task icrasında üzə çıxardı — və o an istifadəçi artıq
gözləyir və pul ödəyib.

Eyni yoxlama `POST /api/contexts` və `extraDirs` üçün də tətbiq olunur.

### 7.8. Komponent

`apps/web/src/components/FolderPicker.tsx` — **iki yerdə** işlədilir:

1. Kontekstin `cwd`-si (yaratma formasında və kontekst ayarlarında)
2. `'extended'` səviyyəsindəki əlavə qovluqlar

Təkrar istifadə təsadüfi deyil — seçicinin bu formada (nativ pəncərə yox)
qurulmasının əsas səbəblərindən biri məhz budur.

---

## 8. Fayl dəyişiklikləri

### Server

| Fayl | Dəyişiklik |
|---|---|
| `db/schema.ts` | `contexts.file_access`, `contexts.extra_dirs_json` |
| `drizzle/0010_*.sql` | `db:generate` ilə yaradılır |
| `db/repo.ts` | `updateContext` yeni sahələri qəbul edir; `cwd` yenilənə bilir |
| `exec/file-access.ts` | **YENİ** — saf tərcümə funksiyası |
| `exec/ladder.ts` | `RunRequest` qurularkən `resolveFileAccess` çağırılır |
| `runners/claude.ts` | `buildClaudeArgs` icazəni `RunRequest`-dən oxuyur, `--add-dir` çoxlu |
| `runners/codex.ts` | `buildCodexArgs` sandbox-ı `RunRequest`-dən oxuyur |
| `routes/fs.ts` | **YENİ** — `GET /api/fs/list`, `GET /api/fs/check` |
| `routes/runs.ts` | **YENİ** — `GET /api/runs/active` |
| `routes/contexts.ts` | `cwd` və icazə sahələrinin yoxlanması |
| `ws/hub.ts` | `subscribeGlobal` / `unsubscribeGlobal` / qlobal yayım |
| `exec/supervisor.ts` | `activity` yayımı (3 nöqtə) |
| `app.ts` | yeni route-ların qeydiyyatı, WS-də qlobal abunəlik |

### Paylaşılan

| Fayl | Dəyişiklik |
|---|---|
| `api.ts` | `UpdateContextBody.cwd`, `fileAccess`, `extraDirs`; `FsListResponse`, `FsCheckResponse`, `ActiveRunsResponse` |
| `runner.ts` | `RunRequest.fileAccess` (`{ level, dirs }` — bayraq adları YOX, §5.1) |
| `events.ts` | `WsServerMessage`-a `activity` |

### Web

| Fayl | Dəyişiklik |
|---|---|
| `components/LiveBar.tsx` | **YENİ** |
| `components/FolderPicker.tsx` | **YENİ** |
| `components/FileAccessPanel.tsx` | **YENİ** — kontekstin icazə seçimi |
| `lib/useActivity.ts` | **YENİ** |
| `lib/api.ts` | yeni endpoint-lər |
| `components/Sidebar.tsx` | `LiveBar` qoşulur |
| `pages/Contexts.tsx` | `FolderPicker` + `FileAccessPanel` |

---

## 9. Test strategiyası — SIFIR token (qayda 11)

| Sahə | Test |
|---|---|
| `resolveFileAccess` | saf funksiya — hər üç səviyyə × hər iki runner; `dirs` sıralamasının determinist olması |
| `buildClaudeArgs` / `buildCodexArgs` | icazənin arqumentlərə düzgün düşməsi; **`CLAUDE_STABLE_FLAGS`-ın dəyişmədiyi** ayrıca test |
| `routes/fs.ts` | müvəqqəti qovluq ağacı üzərində real `fs`: alt-qovluqlar, `.git` FAYL və QOVLUQ halları, gizli qovluqlar, `EACCES` qovluğu, nisbi yol → 400 |
| `/api/fs/check` | yazıla bilən və bilinməyən qovluq; probun faylı SİLDİYİ |
| `WsHub` | qlobal abunəlik, `removeSocket`-in qlobal dəsti təmizləməsi, delta-nın qlobal kanala DÜŞMƏDİYİ |
| `/api/runs/active` | işləyən/bitmiş icraların ayrılması; mənfi pillələrin görünməsi |
| Miqrasiya | 0009-dan 0010-a keçidin mövcud kontekstlərə `'workspace'` yazması |
| Web | `LiveBar` (saxta WS), `FolderPicker` (saxta `fetch`), `FileAccessPanel` |

**Content-type tələsi (qayda 64):** `/api/fs/list` və `/api/fs/check` GÖVDƏSİZ
GET sorğularıdır. `lib/api.ts` artıq düzəldilib (başlıq yalnız gövdə olanda
qoyulur), amma yeni endpoint-lər üçün `lib/api.test.ts`-də eyni yoxlama təkrar
olunur.

---

## 10. Qərar reyestri — nəyi ETMİRİK və niyə

| Rədd edilən | Səbəb |
|---|---|
| Nativ OS qovluq dialoqu | Windows-a bağlı, test edilə bilmir, git/yazıla-bilmə məlumatını vermir (§7.1) |
| Brauzerin `showDirectoryPicker` | Mütləq yol vermir (§7.1) |
| Hər 2 saniyə polling | Boş vaxtda daimi trafik; B onsuz da qlobal kanal tələb edir (§6.1) |
| Deltaların qlobal kanala qoyulması | 5 paralel icrada zolaq ən böyük trafik mənbəyi olardı (§6.4) |
| Hər sətirdə "yazıla bilir" işarəsi | `fs.access(W_OK)` Windows-da ACL görmür → işarə yalan olardı (§7.4) |
| `codex --sandbox danger-full-access` | claude-da qarşılığı yoxdur → eyni səviyyə iki runner-də fərqli məna verərdi (§5.5) |
| Task başına icazə seçimi | Cədvəl və zəncir icralarında insan yoxdur — hər halda defaulta düşərdi |
| İcazəsiz qovluğa toxunanda pauza | B-nin pauza/davam mexanizmini tələb edir — A-da qurula bilməz (§1) |
| `fs` endpoint-ində ağ siyahı | Seçicinin bütün mənasını aradan qaldırardı (§7.6) |
| Miqrasiyada default `'read-only'` | İşləyən qurulumu səssizcə sındırardı (§4.1) |

---

## 11. Bilinən boşluqlar

- **Yazma probunun qiyməti ölçülməyib.** `GET /api/fs/check` müvəqqəti fayl
  yaradıb silir. Şəbəkə disklərində və ya yavaş antivirus filtri olan
  qovluqlarda bunun neçə millisaniyə çəkdiyi bilinmir. Seçim anında bir dəfə
  qaçdığı üçün risk aşağıdır, amma ilk real işlətmədə ölçülməlidir.
- **`--add-dir` çoxlu qovluğun prompt keşinə təsiri ölçülməyib.** Nəzəri olaraq
  `--add-dir` sistem prompt prefiksinə girmir (qayda 1 ölçməsi `--safe-mode`
  üzərində aparılıb), amma `'extended'` səviyyəsi ilk dəfə işlədiləndə
  `cache_read` rəqəmi yoxlanmalıdır. Sınarsa, `'extended'` səviyyəsinin xərci
  UI-da göstərilməlidir.
- **`read-only` səviyyəsinin faydası ölçülməyib.** `plan` rejimində zəif modelin
  cavab keyfiyyəti dəyişirmi — bilinmir. Nəzəri olaraq dəyişməməlidir (alət
  dəsti daralır, prompt yox), amma `plan` rejimi claude-ın öz sistem promptuna
  nə əlavə edir — ölçülməyib.
- **Zolağın davranışı çoxlu paralel icrada sınanmayıb.** `max_parallel` yuxarı
  həddi 4-dür (qayda 43), yəni zolaqda ən çox 4 sətir olur — amma dekompozisiya
  və zəncir icraları bunun üstünə alt-tasklar qoyur. Sətir sayı praktikada nə
  qədər olur, ölçülməlidir; çoxdursa zolaq yığılan (collapsible) olmalıdır.
- **Qlobal WS-in socket sayına təsiri ölçülməyib.** Zolaq hər açıq tabda mount
  olunur, yəni 5 tab = 5 qlobal abunəlik. Lokal serverdə bu əhəmiyyətsiz
  görünür, amma yayım sayı tab sayına düz mütənasibdir.

---

## 12. Növbəti addım

Bu spesifikasiya təsdiqləndikdən sonra `writing-plans` ilə icra planı yazılır:
`docs/superpowers/plans/2026-07-31-faza5a-canli-gorunus-fayl-icazesi.md`.

İcraya **sonra** başlanılır (istifadəçinin açıq qərarı).
