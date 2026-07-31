# Faza 5B — İnsan-döngədə: agentin sualı və canlı review

**Tarix:** 2026-07-31
**Status:** Təsdiqlənmiş dizayn
**Müəllif:** brainstorming sessiyası (istifadəçi + Claude)

---

## 1. Kontekst

Bu, üç alt-layihənin **ikincisidir** (bax
`2026-07-31-faza5a-canli-gorunus-fayl-icazesi-design.md` §1):

| Alt-layihə | Vəziyyət |
|---|---|
| **A** — canlı görünüş, fayl icazəsi, qovluq seçicisi | **bitdi** (qayda 65–68) |
| **B** (bu sənəd) — agentin SUALI + canlı REVIEW | dizayn təsdiqləndi |
| **C** — MCP / skill / plugin | sonra |

A birinci idi, çünki işləyən icranı GÖRMƏDƏN ona canlı rəy vermək mümkün deyil.
B məhz o kanalın üstündə qurulur: `WsHub`-ın qlobal kanalı (qayda 66) və
`LiveBar` artıq mövcuddur.

### 1.1. İki mexanizm — BİR alt-layihə

Ayrı-ayrı qursaydıq eyni üç şeyi iki dəfə yazardıq:

1. **taskın gözləməsi** — icranın arasında dayanıb xarici hadisə gözləmək
2. **prompta mətn qoşulması** — istifadəçidən gələn mətnin işçiyə çatdırılması
3. **sessiyanın davam etdirilməsi** — `--resume` ilə kontekstin qorunması

---

## 2. Mərkəzi texniki məhdudiyyət

**İşləyən CLI prosesinə mətn ötürmək MÜMKÜN DEYİL.**

- `claude -p <prompt>` promptu **argv**-dən alır.
- `codex exec` **stdin BAĞLI** işləyir (qayda 7: açıq stdin ilə
  `"Reading additional input from stdin..."` deyib donur — real olaraq 2 dəqiqə
  timeout-a düşüb).

Yəni «işləyərkən rəy ver» sözün həqiqi mənasında prosesin içinə çatmır. Yeganə
yol **sessiyadır**: hər iki CLI `sessions: true` daşıyır, `runs.session_id`
saxlanılır və `RunRequest.resumeSessionId` artıq mövcuddur.

Bu məhdudiyyət dizaynın bütün formasını təyin edir: hər iki mexanizm
**icraların ARASINDA** işləyir, icranın içində yox.

---

## 3. Uğur kriteriyaları

1. İşçi məlumat çatışmazlığında sual verə bilir; istifadəçi checkbox (çoxseçimli),
   radio (təkseçimli) və ya bəli/xeyr ilə cavab verir; icra `--resume` ilə davam
   edir.
2. İstifadəçi işləyən icraya rəy yaza bilir və İKİ davranışdan birini seçir:
   növbəti icrada nəzərə al, yaxud indi kəs.
3. Cavabsız sual heç bir halda iş sahəsini KİLİDLƏMİR.
4. Cədvəl və zəncir icralarında sual mexanizmi işə düşmür (orada insan yoxdur).
5. Review yazılan taskın keş yazısı LƏĞV olunur.
6. Hər iki mexanizmin sınması taskı öldürmür (qayda 32 — monoton).
7. Testlər **sıfır token** xərcləyir (qayda 11).

---

## 4. Prompt sırası

Qayda 45-dəki sıra bir addım genişlənir:

```
task → şablon → yaddaş (ETİBARSIZ çərçivə) → REVIEW → müqavilə
```

**Review yaddaşdan SONRA gedir.** Yaddaş MƏLUMATDIR və etibarsızdır (qayda 45);
review isə istifadəçinin ÖZ göstərişidir — etibarlıdır. Modellər son göstərişə
daha çox əhəmiyyət verdiyi üçün etibarlı mətn sona yaxın olmalıdır.

**Müqavilə yenə ƏN SONDA qalır.** Səbəb dəyişmir: o, işçinin son göstərişidir və
«bacarmırsansa dayan» ondan sonra gələn heç nə ilə üstələnməməlidir.

Hər şey **suffiksdir** — sistem promptu toxunulmur (qayda 1, 29).

---

## 5. Mexanizm 1 — Agentin sualı

### 5.1. Müqavilə eskalasiya ilə BİRLƏŞDİRİLİR

Ayrıca ikinci blok YAZILMIR. Vahid `SIGNAL_CONTRACT`:

```
SİQNAL MÜQAVİLƏSİ (məcburi) — aşağıdakılardan YALNIZ biri, cavabın TAMI olaraq:
  bacarmırsansa:       {"escalate": true, "reason": "...", "partial": "..."}
  məlumat lazımdırsa:  {"ask": {"question": "...", "kind": "yes_no|single|multi", "options": [...]}}
Həll edə bilirsənsə heç birini yazma — taskı normal həll et.
```

İki səbəb:

- **Qiymət.** İki ayrı ~40 tokenlik blok hər işçi icrasında ödənilir. Vahid blok
  ortaq mətni (başlıq, «cavabın tamı olsun» şərti) bir dəfə yazır.
- **Aydınlıq.** İki oxşar JSON forması ardıcıl verilsə, model onları qarışdırır.
  İkisi eyni sinifdəndir — «dayan və siqnal ver».

Bloklar müstəqil qapılanır: eskalasiya `PROFILE_RUNGS`-dakı Pillə 6-ya,
suallar isə `contexts.questions_enabled`-ə bağlıdır. Yalnız biri açıqdırsa
müqavilədə yalnız o sətir olur.

### 5.2. Parse qayda 28 sərtliyindədir

JSON cavabın **BÜTÜNÜ** olmalıdır (ən çoxu bir kod çərçivəsi içində).

Səbəb eskalasiyadakı ilə eynidir və burada daha kəskindir: bu sistemin öz
sənədini, müqaviləsini və ya testlərini izah edən HƏR task `{"ask": …}`
nümunəsini sitat gətirər. `includes` qaydası ilə hər belə task əbədi «cavab
gözləyir» vəziyyətinə düşərdi — yəni sual mexanizmi öz sənədini oxuyan taskı
dondururdu.

`kind` MƏHZ üç dəyərdən biri olmalıdır. Tanınmayan `kind` → sual RƏDD edilir.

### 5.3. Rədd — KƏSMƏ YOX, geri çəkilmə

| Hal | Davranış |
|---|---|
| `question` `QUESTION_CHAR_LIMIT`-i aşır | rədd |
| `options` sayı `MAX_QUESTION_OPTIONS`-u aşır | rədd |
| `single`/`multi`-də `options` boş və ya 1 ədəd | rədd |
| `yes_no`-da `options` verilib | rədd (ziddiyyət) |
| `kind` tanınmır | rədd |

Rədd olunan sual **KƏSİLMİR** (qayda 39/52 prinsipi): yarımçıq kəsilmiş sual
istifadəçini yanıldar və o, səhv cavab verib pulu İKİ dəfə yandırar — bir dəfə
səhv işə, bir dəfə düzəlişə.

Rədd halında mexanizm **SƏSSİZCƏ geri çəkilir**: cavab adi mətn kimi qəbul
edilir və nərdivan normal davam edir (qayda 32 — bir orkestrasiya qərarının
uğursuzluğu istifadəçinin nəticəsini məhv etməməlidir).

### 5.4. Hovuz slotu BURAXILIR — bu, mərkəzi qərardır

`max_parallel = 1` olan kontekstdə cavab gözləyən task slotu tutub qalsaydı,
həmin iş sahəsi TAM KİLİDLƏNƏRDİ: bir cavabsız sual bütün növbəni dondurardı və
istifadəçi səbəbini heç yerdə görməzdi.

`TaskPool`-a `yield(key, limit, fn)` əlavə olunur: slot buraxılır, `fn`
gözlənilir, sonra YENİDƏN növbəyə girilir. Cavabdan sonra task adi qaydada
növbəyə düşür — yəni cavab vermək «növbədən kənar keçid» vermir.

`Ladder` hovuzu tanımır (hovuz `routes/tasks.ts`-dədir). Ona görə `QuestionGate`
konstruktorunda `yield` funksiyası ötürülür — nərdivan yalnız `ask()` çağırır.

### 5.5. Avtomatik icralarda SÖNDÜRÜLÜR

Cədvəl (`trigger: 'schedule'`) və zəncir addımlarında sual mexanizmi işə düşmür:
orada cavab verəcək insan yoxdur və task ƏBƏDİ gözləyərdi — üstəlik cədvəlin
növbəti tiki yeni icra başladar və gözləyənlər yığılardı.

Bu, qayda 57-dəki mühakimənin eynidir və Faza 5A-da rədd edilmiş «task başına
icazə seçimi» variantı ilə eyni səbəbdəndir: avtomatik icrada insan yoxdur.

### 5.6. Cavab `--resume` ilə çatdırılır

Cavab gəlincə YENİ icra başlayır, amma `resumeSessionId` ilə: işçinin konteksti
(oxuduğu fayllar, prompt keşi) qorunur. Sıfırdan başlatsaydıq, sual verməyin
qiyməti TAM icranın qiyməti olardı — yəni mexanizm qənaət əvəzinə xərc yaradardı.

Sessiya id-si yoxdursa (runner sessiya dəstəkləmir və ya icra onu vermədi) cavab
adi prompt suffiksi kimi verilir və icra sıfırdan qaçır. Bu, pisdir, amma
mexanizmi tamamilə söndürməkdən yaxşıdır.

**Sual-cavab icrası keşlənmir** (qayda 33 prinsipi): açar sualı və cavabı əks
etdirmir, yəni onu adi icranın açarı altında saxlamaq girişi yalançı edərdi.

### 5.7. Gözləmənin sonu

| Hadisə | Nəticə |
|---|---|
| istifadəçi cavab verdi | icra `--resume` ilə davam edir |
| istifadəçi taskı ləğv etdi | sual `cancelled`, nərdivan `interrupted` qaytarır |
| server çökdü | başlanğıcda sual `cancelled` işarələnir |

**Timeout YOXDUR** və bu, şüurlu qərardır. Avtomatik davam etmək iki pis
variantdan birini seçmək deməkdir: ya «cavab yoxdur» deyib modelə təxmin
etdirmək (o, məhz sual verməklə bunun qarşısını almaq istəyirdi), ya da taskı
uğursuz saymaq (görülmüş iş atılır). Hovuz slotu onsuz da buraxıldığı üçün
gözləmənin qiyməti sıfırdır — yəni tələsməyə səbəb yoxdur.

Server çökdükdən sonra gözləyən sualların təmizlənməsi MƏCBURİDİR
(`markOrphanedRunsInterrupted` yanında): əks halda UI əbədi «cavab gözləyir»
göstərərdi, halbuki gözləyən proses yoxdur.

---

## 6. Mexanizm 2 — Canlı review

### 6.1. İki rejim

`POST /api/tasks/:id/review` → `{ text, mode: 'next' | 'interrupt' }`

| Rejim | Davranış | Qiyməti |
|---|---|---|
| `next` | növbəyə düşür, nərdivan HƏR icradan ƏVVƏL boşaldır | 0 — heç bir iş atılmır |
| `interrupt` | əlavə olaraq `supervisor.cancel()` (proses ağacı ölür, qayda 6) | yarımçıq işin ÇIXIŞ tokenləri ödənilib atılır |

Seçim istifadəçinindir və UI-da iki ayrı düymədir. Mexanizm eynidir — fərq
yalnız `supervisor.cancel` çağırılıb-çağırılmamasıdır. Birini «düzgün» seçib
digərini gizlətsəydik, ya səhv yolla gedən işçi bitənə qədər gözlənilərdi, ya da
hər rəy çıxış tokenlərini yandırardı (çıxış girişdən 3–5x bahadır).

### 6.2. İcra işləmirsə — route yeni icra başladır

Task artıq bitibsə review-un tətbiq olunacağı «növbəti icra» yoxdur. Bu halda
route YENİ icra başladır (`--resume` ilə).

Sərhəd **route-dadır, nərdivanda yox**: nərdivanın içində «review varsa bir daha
qaç» dövrəsi qursaydıq, ard-arda yazılan rəylər bir nərdivan çağırışını sonsuz
uzada bilərdi və büdcə hesabı (`RemainingBudget`) mənasını itirərdi.

### 6.3. Review keş yazısını LƏĞV EDİR

Bu, dizaynın ən vacib incəliyidir.

İstifadəçi review yazırsa, deməli əvvəlki cavab SƏHV idi. Amma o cavab Pillə 0
keşinə ARTIQ yazılıb (`storeInCache`). Ləğv etməsəydik, eyni prompt bir daha
göndəriləndə məhz düzəldilməsini istədiyiniz səhv cavab qaytarılardı — və
istifadəçi bunu heç yerdə görməzdi.

**Texniki problem:** keş `hash` üzrə saxlanılır və taskdan hash-a keçid YOXDUR.
Hash-ı route-da yenidən hesablamaq olmaz — o, model, runner, şablon və yaddaş
digest-indən asılıdır (`cache-key.ts`) və hesablamanı iki yerdə təkrarlamaq
səssiz uyğunsuzluq mənbəyidir.

**Həll:** `runs.cache_key` sütunu — `storeInCache` icranın cavabını keşə yazanda
onu həmin sətrə də yazır. Review route taskın icralarını gəzir və boş olmayan
`cache_key`-lərə uyğun keş sətirlərini SİLİR. Yenidən hesablama yoxdur.

Alternativ (`tasks.cache_hash`) rədd edildi: bir taskda bir neçə icra ola bilər
(yoxlama dövrəsi, best-of-N) və hansının keşə düşdüyü məhz İCRA səviyyəsindəki
faktdır.

### 6.4. Review icrası keşdən OXUMUR və keşə YAZMIR

«Əvvəlki cavab səhvdir» deyən icraya keşdən cavab qaytarmaq absurd olardı.

Bu səbəbdən review keş açarına da GİRMİR (qayda 47-dəki `memoryDigest`-dən
fərqli olaraq): açar heç vaxt yoxlanılmır, yəni onu dəyişməyin mənası yoxdur və
mövcud açarların forması toxunulmaz qalır.

### 6.5. Review bütün SONRAKI icralara qoşulur

Nərdivan bir taskda bir neçə icra qaçırır (yoxlama dövrəsi, best-of-N, ipucu,
başçı). Review yalnız BİR icraya tətbiq olunsaydı, yoxlama dövrəsinin ikinci
cəhdi onu unudardı — halbuki istifadəçinin göstərişi bütün task boyu keçərlidir.

Ona görə nərdivan boşaltdığı rəyləri yaddaşda saxlayır və hər sonrakı promptda
təkrar qoşur. DB-də isə dərhal `applied_at` yazılır ki, route onları «tətbiq
olunmamış» sayıb ikinci icra başlatmasın.

---

## 7. Sxem

Miqrasiya **`0011`**.

### `task_questions`

| Sütun | Tip | Qeyd |
|---|---|---|
| `id` | `text` PK | |
| `task_id` | `text NOT NULL` → `tasks.id` cascade | |
| `run_id` | `text NOT NULL` | sualı verən icra |
| `question` | `text NOT NULL` | |
| `kind` | `text NOT NULL` | `yes_no` \| `single` \| `multi` |
| `options_json` | `text NOT NULL DEFAULT '[]'` | `yes_no`-da boş |
| `answer_json` | `text` | NULL = hələ cavab yoxdur |
| `status` | `text NOT NULL DEFAULT 'pending'` | `pending` \| `answered` \| `cancelled` |
| `asked_at` | `integer NOT NULL` | |
| `answered_at` | `integer` | |

İndeks: `(task_id, asked_at)` və `(status)` — «gözləyən suallar» sorğusu
`LiveBar` nişanı üçün hər açılışda qaçır.

### `task_reviews`

| Sütun | Tip | Qeyd |
|---|---|---|
| `id` | `text` PK | |
| `task_id` | `text NOT NULL` → `tasks.id` cascade | |
| `run_id` | `text` | rəy yazılanda işləyən icra; yoxdursa NULL |
| `text` | `text NOT NULL` | |
| `mode` | `text NOT NULL` | `next` \| `interrupt` |
| `applied_at` | `integer` | NULL = hələ tətbiq olunmayıb |
| `created_at` | `integer NOT NULL` | |

### Sütun əlavələri

- `contexts.questions_enabled` — `integer NOT NULL DEFAULT 1`
- `runs.cache_key` — `text` (nullable), §6.3

### Yeni task statusu

`waiting_input` — `TERMINAL_TASK_STATUSES`-ə **GİRMİR**. Girsəydi
`setTaskStatus` `completed_at` yazardı və task bitmiş görünərdi; `/history`
səhifəsi onu tamamlanmış kimi sayardı.

---

## 8. API

| Route | Təyinat |
|---|---|
| `POST /api/tasks/:id/questions/:qid/answer` | `{ answer: string \| string[] \| boolean }` |
| `POST /api/tasks/:id/review` | `{ text, mode }` |
| `GET /api/questions/pending` | `LiveBar` nişanı üçün |
| `GET /api/tasks/:id` | cavaba `questions` və `reviews` əlavə olunur |

WS mesajı (qayda 66-dakı `activity` ilə eyni prinsip — **delta yox, yalnız
hadisə**):

```
{ type: 'question', kind: 'asked' | 'answered' | 'cancelled', taskId, questionId }
```

**HƏM qlobal kanala, HƏM task kanalına** yayılır: qlobal — `LiveBar` nişanı
üçün, task kanalı — açıq `/tasks/:id` səhifəsi üçün. İkisindən birini seçsəydik,
ya nişan gecikərdi, ya da task səhifəsi qlobal kanala da abunə olmalı olardı.

`LiveBar` gözləyən sualları `runs`-dan OXUYA BİLMİR: sual verən icra artıq
BİTİB (`status = 'succeeded'`), yəni `/api/runs/active` onu görmür. Ona görə
ayrıca endpoint lazımdır.

---

## 9. Fayl dəyişiklikləri

### Paylaşılan

| Fayl | Dəyişiklik |
|---|---|
| `api.ts` | `AnswerQuestionBody`, `CreateReviewBody`, `PendingQuestion`, WS `question` mesajı, `UpdateContextBody.questionsEnabled` |

### Server

| Fayl | Dəyişiklik |
|---|---|
| `exec/ask.ts` | **YENİ** — `ASK_CONTRACT_LINE`, `parseAsk`, limitlər |
| `exec/escalation.ts` | `ESCALATION_CONTRACT` → `buildSignalContract({escalate, ask})` |
| `exec/interaction.ts` | **YENİ** — `QuestionGate`, `ReviewQueue` interfeysləri |
| `exec/question-gate.ts` | **YENİ** — DB + hub + hovuz üzərində tətbiq |
| `exec/review-queue.ts` | **YENİ** — DB üzərində tətbiq |
| `exec/pool.ts` | `yield()` |
| `exec/ladder.ts` | müqavilə qurulması, `ask` yoxlaması, review boşaltma, `--resume` |
| `db/schema.ts` | iki cədvəl + iki sütun |
| `db/interaction-repo.ts` | **YENİ** — sual/review sorğuları |
| `db/repo.ts` | `deleteCacheEntry`, `setRunCacheKey`, `cancelOrphanQuestions` |
| `routes/tasks.ts` | üç yeni route + cavaba `questions`/`reviews` |
| `app.ts` | gate/queue qurulması, WS yayımı |

### Web

| Fayl | Dəyişiklik |
|---|---|
| `components/QuestionPanel.tsx` | **YENİ** — checkbox / radio / bəli-xeyr |
| `components/ReviewBox.tsx` | **YENİ** — mətn + iki düymə |
| `components/LiveBar.tsx` | gözləyən sual nişanı |
| `pages/TaskView.tsx` | hər iki komponent |
| `lib/api.ts` | yeni endpoint-lər |
| `lib/useActivity.ts` | `question` mesajının emalı |

---

## 10. Test strategiyası — SIFIR token

| Sahə | Test |
|---|---|
| `parseAsk` | saf funksiya: üç `kind`, hər rədd halı, kod çərçivəsi, «içində keçir» halının RƏDD edilməsi |
| `buildSignalContract` | yalnız eskalasiya / yalnız sual / hər ikisi / heç biri |
| `TaskPool.yield` | slotun buraxılması, təkrar növbə, limit aşılmaması |
| `QuestionGate` | cavab, ləğv, hovuz slotunun buraxıldığı |
| Nərdivan | `ask` → gözləmə → `--resume` ilə davam; rədd olunan sual normal cavab kimi |
| `ReviewQueue` | boşaltma, `applied_at`, təkrar boşaltmanın boş qayıtması |
| Nərdivan + review | rəy hər sonrakı prompta düşür |
| Keş | review keş sətrini silir; review icrası keşə yazmır |
| Cədvəl | `questions_enabled` avtomatik icrada söndürülür |
| Web | `QuestionPanel` (üç forma), `ReviewBox`, `LiveBar` nişanı |

---

## 11. Qərar reyestri — nəyi ETMİRİK və niyə

| Rədd edilən | Səbəb |
|---|---|
| Prosesin stdin-inə mətn yazmaq | `claude -p` argv-dən oxuyur; codex açıq stdin ilə donur (qayda 7) |
| Ayrıca ikinci müqavilə bloku | Hər icrada ikiqat token; oxşar JSON formaları modeli çaşdırır (§5.1) |
| `answer.includes('"ask"')` | Öz sənədini izah edən task əbədi gözləyərdi (qayda 28) |
| Uzun sualı KƏSMƏK | Yarımçıq sual səhv cavab doğurur → pul iki dəfə yanır (§5.3) |
| Gözləyərkən hovuz slotunu saxlamaq | `max_parallel = 1`-də iş sahəsi tam kilidlənərdi (§5.4) |
| Cavab timeout-u | Hər iki avtomatik davranış pisdir; gözləmənin qiyməti onsuz da sıfırdır (§5.7) |
| Cədvəldə suallar | Cavab verəcək insan yoxdur; gözləyənlər yığılardı (§5.5) |
| Yalnız `next` və ya yalnız `interrupt` | Biri gözlədir, digəri token yandırır — seçim istifadəçinindir (§6.1) |
| Nərdivanda «review varsa bir daha qaç» dövrəsi | Ard-arda rəylər büdcə hesabını mənasız edərdi (§6.2) |
| `tasks.cache_hash` | Bir taskda bir neçə icra var; keşə hansının düşdüyü İCRA faktıdır (§6.3) |
| Review-un keş açarına girməsi | Açar heç vaxt yoxlanılmır — dəyişməyin mənası yoxdur (§6.4) |

---

## 12. Bilinən boşluqlar

- **Sual mexanizminin FAYDASI ölçülməyib.** «Zəif model doğru sual verirmi,
  yoxsa hər qeyri-müəyyənlikdə dayanırmı?» sualı real modellə sınanmayıb.
  Yanlış-müsbət burada bahalıdır: hər lazımsız sual istifadəçinin diqqətini
  tələb edir və task gözləyir. Ölçmə üsulu: `task_questions` sətirlərinin
  sayını taskların sayına nisbətlə izləmək; nisbət yüksəkdirsə müqavilə
  sərtləşdirilməli («yalnız cavabsız qala biləcək məlumat üçün soruş»).
- **`QUESTION_CHAR_LIMIT` və `MAX_QUESTION_OPTIONS` mühakimə ilə seçilib.** İlk
  real suallardan sonra rədd nisbəti (`parseAsk` → `null`) izlənilməlidir — hər
  rədd bir işçi icrasının siqnalının itməsidir.
- **Review-un iqtisadi faydası ölçülməyib.** `interrupt` rejimi çıxış tokenləri
  yandırır; `next` rejimi isə səhv işin bitməsini gözləyir. Hansının daha ucuz
  olduğu taskın uzunluğundan asılıdır və ölçülməyib. Ölçmə üsulu: eyni review
  mətni ilə iki rejimi qaçırıb `savings_ledger`-dəki `actual_cost_usd`
  tutuşdurmaq.
- **`--resume`-un prompt keşinə təsiri ölçülməyib.** Nəzəri olaraq sessiyanın
  davamı keşi qoruyur (prefiks dəyişmir), amma ölçülməyib. Qayda 1-dəki
  metodika ilə: eyni sual-cavab dövrəsini `--resume` ilə və onsuz qaçırıb
  `cache_read` rəqəmlərini tutuşdurmaq.
- **Bir taskda çoxlu ardıcıl sual sınanmayıb.** Mexanizm dövrəyə icazə verir
  (hər cavabdan sonra işçi yenidən sual verə bilər), amma hədd YOXDUR. Real
  modeldə «sual dövrəsi» müşahidə olunsa `MAX_QUESTIONS_PER_TASK` əlavə
  edilməlidir.
- **Server çökməsindən sonra sessiya davamı sınanmayıb.** `runs.session_id`
  saxlanılır, amma çökmədən sonra CLI-nin həmin sessiyanı hələ də tanıyıb
  tanımadığı yoxlanılmayıb.
