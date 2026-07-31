# Faza 5B — İnsan-döngədə — İcra Planı

> **Agent işçilər üçün:** TƏLƏB OLUNAN ALT-SKILL: `superpowers:executing-plans`
> və ya `superpowers:subagent-driven-development`. Addımlar checkbox
> (`- [ ]`) sintaksisindədir.

**Məqsəd:** İşçi model məlumat çatışmazlığında SUAL versin (checkbox / radio /
bəli-xeyr), istifadəçi isə işləyən icraya CANLI rəy yaza bilsin — hər ikisi
`--resume` ilə sessiyanı davam etdirsin.

**Arxitektura:** İşləyən CLI prosesinə mətn ötürmək mümkün deyil (qayda 7), ona
görə hər iki mexanizm icraların ARASINDA işləyir. Sual eskalasiya ilə birləşmiş
`SIGNAL_CONTRACT` vasitəsilə istənilir və qayda 28 sərtliyi ilə parse olunur.
Gözləyərkən hovuz slotu BURAXILIR. Review növbəyə düşür və nərdivan hər icradan
əvvəl onu boşaldır; `interrupt` rejimi əlavə olaraq prosesi öldürür.

**Texnologiya:** TypeScript (ESM, `.js` spesifikatorları), Fastify 5,
drizzle-orm (SQLite), zod 3, React 19 + TanStack Query 5, vitest 3.

**Spesifikasiya:** `docs/superpowers/specs/2026-07-31-faza5b-insan-dongede-design.md`

---

## Ümumi qaydalar

- Nisbi importlar `.js` uzantısı ilə (ESM).
- Testlər **sıfır token** (qayda 11) — `FakeRunner`, saxta gate.
- `schema.ts` dəyişəndən sonra `pnpm --filter @orchestris/server db:generate`.
- `CLAUDE_STABLE_FLAGS`-a heç nə əlavə edilmir (qayda 1).
- Şərhlər Azərbaycan dilində, "niyə" yazılır.

---

## Task 1: `parseAsk` — sual siqnalının parse-ı

**Fayllar:**
- Yaradılır: `apps/server/src/exec/ask.ts`
- Test: `apps/server/src/exec/ask.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/exec/ask.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_QUESTION_OPTIONS, parseAsk, QUESTION_CHAR_LIMIT } from './ask.js'

const wrap = (o: unknown): string => JSON.stringify(o)

describe('parseAsk — qəbul edilən formalar', () => {
  it('yes_no sualını qəbul edir', () => {
    const got = parseAsk(wrap({ ask: { question: 'Davam edim?', kind: 'yes_no' } }))
    expect(got).toEqual({ question: 'Davam edim?', kind: 'yes_no', options: [] })
  })

  it('single sualını variantları ilə qəbul edir', () => {
    const got = parseAsk(
      wrap({ ask: { question: 'Hansı?', kind: 'single', options: ['a', 'b'] } }),
    )
    expect(got).toEqual({ question: 'Hansı?', kind: 'single', options: ['a', 'b'] })
  })

  it('multi sualını qəbul edir', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Hansılar?', kind: 'multi', options: ['a', 'b'] } }))
        ?.kind,
    ).toBe('multi')
  })

  it('kod çərçivəsi soyulur', () => {
    const body = wrap({ ask: { question: 'Q', kind: 'yes_no' } })
    expect(parseAsk('```json\n' + body + '\n```')).not.toBeNull()
  })
})

describe('parseAsk — RƏDD halları', () => {
  it('cavabın İÇİNDƏ keçən JSON rədd edilir', () => {
    // Bu, mexanizmin ən vacib testidir: sistemin öz sənədini izah edən task
    // məhz belə bir JSON-u nümunə kimi sitat gətirir. `includes` qaydası ilə
    // hər belə task ƏBƏDİ "cavab gözləyir" vəziyyətinə düşərdi.
    const body = wrap({ ask: { question: 'Q', kind: 'yes_no' } })
    expect(parseAsk(`Müqavilə belədir: ${body} — yəni model soruşa bilər.`)).toBeNull()
  })

  it('tanınmayan kind rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'dropdown' } }))).toBeNull()
  })

  it('single-də variant yoxdursa rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'single' } }))).toBeNull()
  })

  it('single-də TƏK variant rədd edilir — seçim deyil', () => {
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'single', options: ['a'] } }))).toBeNull()
  })

  it('yes_no-da variant verilibsə rədd edilir — ziddiyyət', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Q', kind: 'yes_no', options: ['a', 'b'] } })),
    ).toBeNull()
  })

  it('çox variant RƏDD edilir, KƏSİLMİR', () => {
    const options = Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, (_, i) => `v${i}`)
    expect(parseAsk(wrap({ ask: { question: 'Q', kind: 'multi', options } }))).toBeNull()
  })

  it('uzun sual RƏDD edilir, KƏSİLMİR', () => {
    const question = 'a'.repeat(QUESTION_CHAR_LIMIT + 1)
    expect(parseAsk(wrap({ ask: { question, kind: 'yes_no' } }))).toBeNull()
  })

  it('boş sual rədd edilir', () => {
    expect(parseAsk(wrap({ ask: { question: '   ', kind: 'yes_no' } }))).toBeNull()
  })

  it('sətir olmayan variant rədd edilir', () => {
    expect(
      parseAsk(wrap({ ask: { question: 'Q', kind: 'single', options: ['a', 5] } })),
    ).toBeNull()
  })

  it('adi mətn cavabı null verir', () => {
    expect(parseAsk('Bu, adi bir cavabdır.')).toBeNull()
  })

  it('sınıq JSON null verir', () => {
    expect(parseAsk('{"ask": {')).toBeNull()
  })

  it('escalate JSON-u ask kimi oxunmur', () => {
    expect(parseAsk(wrap({ escalate: true, reason: 'r' }))).toBeNull()
  })
})
```

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

Əmr: `npx vitest run apps/server/src/exec/ask.test.ts`
Gözlənilən: `Failed to resolve import "./ask.js"`

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/exec/ask.ts`:

```ts
/**
 * Faza 5B — işçinin İSTİFADƏÇİYƏ sualı.
 *
 * Eskalasiya (Pillə 6) ilə eyni sinifdəndir: hər ikisi "dayan və siqnal ver"
 * deməkdir. Fərq odur ki, eskalasiya taskı BAŞÇIYA ötürür, sual isə
 * İSTİFADƏÇİDƏN məlumat istəyir — və bu, qat-qat ucuzdur: başçının icrası
 * əvəzinə bir cümlə.
 */

export const QUESTION_KINDS = ['yes_no', 'single', 'multi'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/**
 * Sual mətninin həddi.
 *
 * KƏSMƏ YOX, RƏDD (qayda 39/52 prinsipi): yarımçıq kəsilmiş sual istifadəçini
 * yanıldar və o, səhv cavab verib pulu İKİ dəfə yandırar — bir dəfə səhv işə,
 * bir dəfə düzəlişə. Rədd halında isə mexanizm sadəcə geri çəkilir.
 */
export const QUESTION_CHAR_LIMIT = 500

/**
 * Variantların sayı.
 *
 * Checkbox siyahısı ekranda oxunaqlı qalmalıdır; 8-dən çox variant o deməkdir
 * ki, model sual vermir, siyahı sadalayır.
 */
export const MAX_QUESTION_OPTIONS = 8

export interface AskRequest {
  question: string
  kind: QuestionKind
  /** `yes_no`-da həmişə boş. */
  options: string[]
}

/** ```json ... ``` və ya ``` ... ``` çərçivəsini soyur. */
function stripCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim())
  return fence?.[1]?.trim() ?? text.trim()
}

function isKind(v: unknown): v is QuestionKind {
  return typeof v === 'string' && (QUESTION_KINDS as readonly string[]).includes(v)
}

/**
 * İşçinin cavabında sual siqnalı varmı?
 *
 * MÜQAVİLƏ QƏSDƏN SƏRTDİR: JSON obyekti cavabın BÜTÜNÜ olmalıdır (ən çoxu bir
 * kod çərçivəsi içində). "Cavabın içində belə bir JSON keçir" qaydası burada
 * eskalasiyadakından da TƏHLÜKƏLİDİR (qayda 28): bu sistemin öz sənədini və ya
 * müqaviləsini izah edən HƏR task nümunəni sitat gətirər və biz onu sual sayıb
 * taskı ƏBƏDİ gözləmə vəziyyətinə salardıq — istifadəçi isə heç vaxt cavab
 * verməyəcəyi bir suala baxardı.
 */
export function parseAsk(answer: string): AskRequest | null {
  const body = stripCodeFence(answer)
  if (!body.startsWith('{') || !body.endsWith('}')) return null

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null

  const ask = (raw as { ask?: unknown }).ask
  if (typeof ask !== 'object' || ask === null) return null

  const { question, kind, options } = ask as {
    question?: unknown
    kind?: unknown
    options?: unknown
  }

  if (typeof question !== 'string' || question.trim() === '') return null
  if (question.length > QUESTION_CHAR_LIMIT) return null
  if (!isKind(kind)) return null

  const list = options === undefined ? [] : options
  if (!Array.isArray(list)) return null
  if (!list.every((o): o is string => typeof o === 'string' && o.trim() !== '')) return null
  if (list.length > MAX_QUESTION_OPTIONS) return null

  // `yes_no` variant DAŞIMIR: variant verilibsə model iki fərqli forma
  // qarışdırıb və nə istədiyi bilinmir — təxmin etmək səhv sual göstərməkdir.
  if (kind === 'yes_no' && list.length > 0) return null
  // Tək variantlı seçim seçim deyil.
  if (kind !== 'yes_no' && list.length < 2) return null

  return { question: question.trim(), kind, options: list }
}
```

- [ ] **Addım 4: Testi qaçır — KEÇMƏLİDİR**

Əmr: `npx vitest run apps/server/src/exec/ask.test.ts`
Gözlənilən: 17 test PASS

- [ ] **Addım 5: Commit**

```bash
git add apps/server/src/exec/ask.ts apps/server/src/exec/ask.test.ts
git commit -m "feat(server): sual siqnalının sərt parse-ı (parseAsk)"
```

---

## Task 2: Vahid `SIGNAL_CONTRACT`

**Fayllar:**
- Dəyişir: `apps/server/src/exec/escalation.ts`
- Test: `apps/server/src/exec/escalation.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/exec/escalation.test.ts` faylının sonuna:

```ts
describe('buildSignalContract', () => {
  it('heç bir siqnal aktiv deyilsə boş sətir verir', () => {
    expect(buildSignalContract({ escalate: false, ask: false })).toBe('')
  })

  it('yalnız eskalasiya', () => {
    const c = buildSignalContract({ escalate: true, ask: false })
    expect(c).toContain('"escalate"')
    expect(c).not.toContain('"ask"')
  })

  it('yalnız sual', () => {
    const c = buildSignalContract({ escalate: false, ask: true })
    expect(c).toContain('"ask"')
    expect(c).not.toContain('"escalate"')
  })

  it('hər ikisi BİR blokda verilir', () => {
    const c = buildSignalContract({ escalate: true, ask: true })
    expect(c).toContain('"escalate"')
    expect(c).toContain('"ask"')
    // İki ayrı başlıq YOX — ortaq mətn bir dəfə yazılır.
    expect(c.match(/SİQNAL MÜQAVİLƏSİ/g)).toHaveLength(1)
  })

  it('hər iki siqnalla belə 900 simvoldan qısadır', () => {
    // Müqavilə HƏR işçi icrasında ödənilir — uzunluğu daimi vergidir.
    expect(buildSignalContract({ escalate: true, ask: true }).length).toBeLessThan(900)
  })
})
```

Faylın importuna `buildSignalContract` əlavə et.

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/exec/escalation.ts`-də `ESCALATION_CONTRACT` sabitini SAXLA
(mövcud testlər ondan asılıdır) və yanına əlavə et:

```ts
/**
 * Vahid siqnal müqaviləsi (Faza 5B).
 *
 * Eskalasiya və sual AYRI bloklar kimi verilmir. İki səbəb:
 *
 *  - **Qiymət.** Hər blok ~40 token və HƏR işçi icrasında ödənilir. Vahid blok
 *    ortaq mətni (başlıq, "cavabın TAMI olsun" şərti) bir dəfə yazır.
 *  - **Aydınlıq.** İki oxşar JSON forması ardıcıl verilsə model onları
 *    qarışdırır — halbuki ikisi eyni sinifdəndir: "dayan və siqnal ver".
 *
 * Sistem promptuna DEYİL, istifadəçi mesajının SONUNA əlavə olunur (qayda 1,
 * 29): prefiks dəyişməsi Anthropic prompt-cache-ini sındırır və eyni task 5x
 * bahalaşır ($0.0085 → $0.0444).
 */
export function buildSignalContract(on: { escalate: boolean; ask: boolean }): string {
  if (!on.escalate && !on.ask) return ''

  const lines = [
    '---',
    'SİQNAL MÜQAVİLƏSİ (məcburi) — aşağıdakılardan YALNIZ biri, cavabın TAMI olaraq:',
  ]
  if (on.escalate) {
    lines.push(
      'bacarmırsansa:      {"escalate": true, "reason": "niyə", "partial": "qismən nəticə (ola bilər boş)"}',
    )
  }
  if (on.ask) {
    lines.push(
      'məlumat lazımdırsa: {"ask": {"question": "sual", "kind": "yes_no|single|multi", "options": ["variant", ...]}}',
      '  — `yes_no` variant DAŞIMIR; `single`/`multi` ən azı 2 variant tələb edir.',
      '  — Yalnız cavabını TƏXMİN EDƏ BİLMƏDİYİN məlumat üçün soruş.',
    )
  }
  lines.push(
    'Həll edə bilirsənsə heç birini yazma — taskı normal şəkildə həll et.',
  )
  return lines.join('\n')
}
```

- [ ] **Addım 4: Testi qaçır**

Əmr: `npx vitest run apps/server/src/exec/escalation.test.ts`

- [ ] **Addım 5: Commit**

```bash
git add apps/server/src/exec/escalation.ts apps/server/src/exec/escalation.test.ts
git commit -m "feat(server): eskalasiya və sual üçün vahid siqnal müqaviləsi"
```

---

## Task 3: Sxem — `task_questions`, `task_reviews`, iki sütun

**Fayllar:**
- Dəyişir: `apps/server/src/db/schema.ts`
- Yaradılır: `apps/server/drizzle/0011_*.sql`
- Yaradılır: `apps/server/src/db/interaction-repo.ts`
- Test: `apps/server/src/db/interaction-repo.test.ts`

- [ ] **Addım 1: Sxemə əlavə et**

`contexts`-ə (`extraDirsJson`-dan sonra):

```ts
  /**
   * İşçi bu kontekstdə İSTİFADƏÇİYƏ sual verə bilirmi (Faza 5B).
   *
   * Default AÇIQ: müqavilə bağlı olduqca mexanizm heç vaxt özünü göstərməz və
   * istifadəçi onun mövcud olduğunu bilməz. Qiyməti ~40 tokendir — eskalasiya
   * müqaviləsi ilə eyni ölçüdə.
   *
   * Bayraq AÇIQ olsa belə cədvəl və zəncir icralarında suallar SÖNDÜRÜLÜR:
   * orada cavab verəcək insan yoxdur (`exec/ladder.ts` → `LadderInput.interactive`).
   */
  questionsEnabled: integer('questions_enabled', { mode: 'boolean' }).notNull().default(true),
```

`runs`-a (`worktreePath`-dan sonra):

```ts
  /**
   * Bu icranın cavabı hansı keş açarı altında saxlanıldı (Faza 5B).
   *
   * NİYƏ LAZIMDIR: review yazılanda həmin keş sətri SİLİNMƏLİDİR — istifadəçi
   * rəy yazırsa, deməli cavab səhv idi, amma o cavab keşə ARTIQ düşüb və eyni
   * prompt bir daha göndəriləndə qaytarılardı.
   *
   * Açarı route-da yenidən hesablamaq OLMAZ: o, model, runner, şablon və yaddaş
   * digest-indən asılıdır (`cache-key.ts`) və hesablamanı iki yerdə təkrarlamaq
   * səssiz uyğunsuzluq mənbəyidir. Sütun `tasks`-da deyil `runs`-dadır, çünki
   * bir taskda bir neçə icra olur (yoxlama dövrəsi, best-of-N) və keşə hansının
   * düşdüyü məhz İCRA faktıdır.
   */
  cacheKey: text('cache_key'),
```

Faylın sonuna iki cədvəl:

```ts
/**
 * İşçinin istifadəçiyə verdiyi suallar (Faza 5B).
 *
 * `runs`-da SAXLANILA BİLMƏZDİ: sual bir icranın NƏTİCƏSİDİR, amma cavab
 * BAŞQA icraya aiddir — bir sətirdə ikisini birləşdirsək "hansı icra gözləyir"
 * sualının cavabı itərdi.
 */
export const taskQuestions = sqliteTable(
  'task_questions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Sualı VERƏN icra. */
    runId: text('run_id').notNull(),
    question: text('question').notNull(),
    /** `yes_no` | `single` | `multi` */
    kind: text('kind').notNull(),
    optionsJson: text('options_json').notNull().default('[]'),
    /** NULL = hələ cavab yoxdur. */
    answerJson: text('answer_json'),
    /** `pending` | `answered` | `cancelled` */
    status: text('status').notNull().default('pending'),
    askedAt: integer('asked_at').notNull(),
    answeredAt: integer('answered_at'),
  },
  (t) => [
    index('questions_task_idx').on(t.taskId, t.askedAt),
    // "Gözləyən suallar" sorğusu `LiveBar` nişanı üçün hər açılışda qaçır.
    index('questions_status_idx').on(t.status),
  ],
)

/**
 * İstifadəçinin işləyən icraya yazdığı rəy (Faza 5B).
 *
 * `applied_at` NULL olduqca rəy "tətbiq olunmayıb" sayılır — nərdivan onu
 * növbəti icrada boşaldır, route isə icra işləmirsə yeni icra başladır.
 */
export const taskReviews = sqliteTable(
  'task_reviews',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Rəy yazılanda işləyən icra; yoxdursa NULL. */
    runId: text('run_id'),
    text: text('text').notNull(),
    /** `next` | `interrupt` */
    mode: text('mode').notNull(),
    appliedAt: integer('applied_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('reviews_task_idx').on(t.taskId, t.createdAt)],
)
```

- [ ] **Addım 2: Miqrasiyanı generasiya et**

Əmr: `npx pnpm --filter @orchestris/server db:generate`
Gözlənilən: `0011_*.sql` yaranır. Faylı OXU və təsdiq et ki, iki `CREATE TABLE`
və iki `ALTER TABLE … ADD COLUMN` var; `questions_enabled` `NOT NULL DEFAULT 1`
daşıyır (SQLite `ADD COLUMN … NOT NULL`-u DEFAULT olmadan qəbul etmir).

- [ ] **Addım 3: Repo funksiyalarını yaz**

`apps/server/src/db/interaction-repo.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from './client.js'
import { taskQuestions, taskReviews } from './schema.js'

export type Question = typeof taskQuestions.$inferSelect
export type Review = typeof taskReviews.$inferSelect

const now = (): number => Date.now()

export function createQuestion(
  db: Db,
  input: {
    taskId: string
    runId: string
    question: string
    kind: string
    options: readonly string[]
  },
): Question {
  const id = randomUUID()
  db.insert(taskQuestions)
    .values({
      id,
      taskId: input.taskId,
      runId: input.runId,
      question: input.question,
      kind: input.kind,
      optionsJson: JSON.stringify(input.options),
      askedAt: now(),
    })
    .run()
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id)).get() as Question
}

export function getQuestion(db: Db, id: string): Question | undefined {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id)).get()
}

export function listQuestions(db: Db, taskId: string): Question[] {
  return db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, taskId))
    .orderBy(asc(taskQuestions.askedAt))
    .all()
}

/** `LiveBar` nişanı — sual verən icra ARTIQ bitib, yəni `/api/runs/active` onu görmür. */
export function listPendingQuestions(db: Db): Question[] {
  return db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.status, 'pending'))
    .orderBy(asc(taskQuestions.askedAt))
    .all()
}

export function answerQuestion(db: Db, id: string, answer: unknown): Question | undefined {
  const row = getQuestion(db, id)
  // Cavablanmış və ya ləğv edilmiş suala təkrar cavab QƏBUL EDİLMİR: icra artıq
  // davam edib və ikinci cavab heç yerə çatmazdı — istifadəçi isə çatdığını
  // sanardı.
  if (row === undefined || row.status !== 'pending') return undefined
  db.update(taskQuestions)
    .set({ answerJson: JSON.stringify(answer), status: 'answered', answeredAt: now() })
    .where(eq(taskQuestions.id, id))
    .run()
  return getQuestion(db, id)
}

export function cancelQuestion(db: Db, id: string): void {
  db.update(taskQuestions)
    .set({ status: 'cancelled', answeredAt: now() })
    .where(and(eq(taskQuestions.id, id), eq(taskQuestions.status, 'pending')))
    .run()
}

export function cancelQuestionsForTask(db: Db, taskId: string): number {
  const pending = db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.status, 'pending')))
    .all()
  for (const q of pending) cancelQuestion(db, q.id)
  return pending.length
}

/**
 * Server çökdükdən sonra qalan gözləyən suallar.
 *
 * `markOrphanedRunsInterrupted` ilə eyni məntiq: gözləyən PROSES yoxdur, yəni
 * cavab heç yerə çatmayacaq. Təmizləməsəydik UI əbədi "cavab gözləyir"
 * göstərərdi.
 */
export function cancelOrphanQuestions(db: Db): number {
  const pending = listPendingQuestions(db)
  for (const q of pending) cancelQuestion(db, q.id)
  return pending.length
}

export function createReview(
  db: Db,
  input: { taskId: string; runId?: string | null; text: string; mode: string },
): Review {
  const id = randomUUID()
  db.insert(taskReviews)
    .values({
      id,
      taskId: input.taskId,
      runId: input.runId ?? null,
      text: input.text,
      mode: input.mode,
      createdAt: now(),
    })
    .run()
  return db.select().from(taskReviews).where(eq(taskReviews.id, id)).get() as Review
}

export function listReviews(db: Db, taskId: string): Review[] {
  return db
    .select()
    .from(taskReviews)
    .where(eq(taskReviews.taskId, taskId))
    .orderBy(asc(taskReviews.createdAt))
    .all()
}

/**
 * Tətbiq olunmamış rəyləri GÖTÜRÜR və dərhal `applied_at` yazır.
 *
 * Dərhal yazılır (icradan SONRA yox): əks halda route onları hələ də
 * "tətbiq olunmayıb" sayıb PARALEL ikinci icra başladardı.
 */
export function drainReviews(db: Db, taskId: string): Review[] {
  const pending = db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), isNull(taskReviews.appliedAt)))
    .orderBy(asc(taskReviews.createdAt))
    .all()
  if (pending.length === 0) return []
  const at = now()
  for (const r of pending) {
    db.update(taskReviews).set({ appliedAt: at }).where(eq(taskReviews.id, r.id)).run()
  }
  return pending
}

export function hasPendingReviews(db: Db, taskId: string): boolean {
  return (
    db
      .select()
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, taskId), isNull(taskReviews.appliedAt)))
      .all().length > 0
  )
}
```

- [ ] **Addım 4: `repo.ts`-ə iki funksiya əlavə et**

```ts
/** Review keş sətrini LƏĞV EDİR — bax `runs.cache_key` şərhi. */
export function deleteCacheEntry(db: Db, hash: string): void {
  db.delete(cacheEntries).where(eq(cacheEntries.hash, hash)).run()
}

/** `storeInCache` yazdığı açarı icra sətrinə də yazır. */
export function setRunCacheKey(db: Db, runId: string, cacheKey: string): void {
  db.update(runs).set({ cacheKey }).where(eq(runs.id, runId)).run()
}
```

- [ ] **Addım 5: Testi yaz**

`apps/server/src/db/interaction-repo.test.ts` — `repo.test.ts`-dəki
`openDb(':memory:')` naxışı ilə:

```ts
import { describe, expect, it } from 'vitest'
import { openDb } from './client.js'
import { createContext, createTask } from './repo.js'
import {
  answerQuestion,
  cancelOrphanQuestions,
  createQuestion,
  createReview,
  drainReviews,
  hasPendingReviews,
  listPendingQuestions,
} from './interaction-repo.js'

function seed() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  return { db, task }
}

const ASK = { question: 'Q', kind: 'yes_no', options: [] as string[] }

describe('task_questions', () => {
  it('sual pending statusu ilə yaranır', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    expect(q.status).toBe('pending')
    expect(q.answerJson).toBeNull()
  })

  it('cavab yazılır və status dəyişir', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    const got = answerQuestion(db, q.id, true)
    expect(got?.status).toBe('answered')
    expect(JSON.parse(got?.answerJson ?? 'null')).toBe(true)
  })

  it('cavablanmış suala TƏKRAR cavab qəbul edilmir', () => {
    const { db, task } = seed()
    const q = createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    answerQuestion(db, q.id, true)
    expect(answerQuestion(db, q.id, false)).toBeUndefined()
  })

  it('çoxseçimli cavab massiv kimi saxlanılır', () => {
    const { db, task } = seed()
    const q = createQuestion(db, {
      taskId: task.id,
      runId: 'r1',
      question: 'Q',
      kind: 'multi',
      options: ['a', 'b'],
    })
    const got = answerQuestion(db, q.id, ['a', 'b'])
    expect(JSON.parse(got?.answerJson ?? 'null')).toEqual(['a', 'b'])
  })

  it('yetim təmizləyicisi gözləyənləri ləğv edir', () => {
    const { db, task } = seed()
    createQuestion(db, { taskId: task.id, runId: 'r1', ...ASK })
    expect(cancelOrphanQuestions(db)).toBe(1)
    expect(listPendingQuestions(db)).toHaveLength(0)
  })
})

describe('task_reviews', () => {
  it('boşaltma applied_at yazır və İKİNCİ dəfə boş qaytarır', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'düzəlt', mode: 'next' })
    expect(drainReviews(db, task.id)).toHaveLength(1)
    expect(drainReviews(db, task.id)).toHaveLength(0)
  })

  it('hasPendingReviews boşaltmadan sonra false verir', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'x', mode: 'next' })
    expect(hasPendingReviews(db, task.id)).toBe(true)
    drainReviews(db, task.id)
    expect(hasPendingReviews(db, task.id)).toBe(false)
  })

  it('rəylər yazılma sırası ilə qaytarılır', () => {
    const { db, task } = seed()
    createReview(db, { taskId: task.id, text: 'bir', mode: 'next' })
    createReview(db, { taskId: task.id, text: 'iki', mode: 'interrupt' })
    expect(drainReviews(db, task.id).map((r) => r.text)).toEqual(['bir', 'iki'])
  })
})
```

- [ ] **Addım 6: Testləri qaçır**

Əmr: `npx vitest run apps/server/src/db/`
Gözlənilən: hamısı PASS

- [ ] **Addım 7: Commit**

```bash
git add apps/server/src/db apps/server/drizzle
git commit -m "feat(server): task_questions, task_reviews və runs.cache_key (miqrasiya 0011)"
```

---

## Task 4: `TaskPool.yield` — slotun buraxılması

**Fayllar:**
- Dəyişir: `apps/server/src/exec/pool.ts`
- Test: `apps/server/src/exec/pool.test.ts`

- [ ] **Addım 1: Testi yaz**

`apps/server/src/exec/pool.test.ts` sonuna:

```ts
describe('yield — gözləyərkən slot buraxılır', () => {
  it('cavab gözləyən task limiti tutmur', async () => {
    // BU, MEXANİZMİN BÜTÜN MƏNASIDIR: `max_parallel = 1` olan kontekstdə
    // cavab gözləyən task slotu saxlasaydı, iş sahəsi TAM kilidlənərdi.
    const pool = new TaskPool()
    let secondRan = false
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))

    const first = pool.run('ctx', 1, async () => {
      await pool.yield('ctx', 1, () => gate)
      return 'birinci'
    })
    // Slot buraxıldığı üçün ikinci task DƏRHAL qaçmalıdır.
    const second = pool.run('ctx', 1, async () => {
      secondRan = true
      return 'ikinci'
    })

    expect(await second).toBe('ikinci')
    expect(secondRan).toBe(true)
    release()
    expect(await first).toBe('birinci')
  })

  it('yield-dən sonra slot YENİDƏN alınır — limit aşılmır', async () => {
    const pool = new TaskPool()
    let peak = 0
    let active = 0
    const track = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
    }

    await Promise.all([
      pool.run('ctx', 1, async () => {
        await pool.yield('ctx', 1, async () => undefined)
        await track()
      }),
      pool.run('ctx', 1, track),
    ])
    expect(peak).toBe(1)
  })

  it('yield içindəki xəta slotu geri qaytarır', async () => {
    const pool = new TaskPool()
    await expect(
      pool.run('ctx', 1, () =>
        pool.yield('ctx', 1, () => Promise.reject(new Error('sındı'))),
      ),
    ).rejects.toThrow('sındı')
    expect(pool.activeCount('ctx')).toBe(0)
  })
})
```

- [ ] **Addım 2: Testi qaçır — SINMALIDIR**

- [ ] **Addım 3: Tətbiqi yaz**

`apps/server/src/exec/pool.ts`-də `run`-dan slot alma hissəsini ayır və
`yield` əlavə et:

```ts
  async run<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
    const lane = await this.acquire(key, limit)
    try {
      return await fn()
    } finally {
      this.release(key, lane)
    }
  }

  /**
   * Slotu MÜVƏQQƏTİ buraxıb `fn`-i gözləyir, sonra yenidən növbəyə girir.
   *
   * NİYƏ LAZIMDIR (Faza 5B): işçi istifadəçidən sual soruşanda task cavabı
   * gözləyir. Slotu saxlasaydıq, `max_parallel = 1` olan kontekstdə bir
   * cavabsız sual BÜTÜN iş sahəsini kilidlərdi və istifadəçi səbəbini heç
   * yerdə görməzdi.
   *
   * Cavabdan sonra task ADİ qaydada növbəyə düşür — cavab vermək "növbədən
   * kənar keçid" vermir, yoxsa uzun növbədə gözləyənlər əbədi geri atılardı.
   */
  async yield<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
    const lane = this.lane(key)
    this.release(key, lane)
    try {
      return await fn()
    } finally {
      await this.acquire(key, limit)
    }
  }

  private async acquire(key: string, limit: number): Promise<Lane> {
    const lane = this.lane(key)
    lane.limit = Math.max(1, Math.floor(limit))
    if (lane.active < lane.limit && lane.waiting.length === 0) {
      lane.active += 1
    } else {
      await new Promise<void>((resolve) => lane.waiting.push(resolve))
    }
    return lane
  }
```

**DİQQƏT:** `release` `lane.active === 0 && waiting.length === 0` halında
`lanes`-dən sətri SİLİR. `yield` sonrasında `acquire` yeni `lane` yaradır — bu,
düzgündür (limit hər çağırışda verilir), amma `run`-dakı `finally` KÖHNƏ
`lane` obyektini buraxmamalıdır. Ona görə `run` `acquire`-in QAYTARDIĞI
lane-i deyil, `this.lane(key)`-i buraxmalıdır:

```ts
    } finally {
      this.release(key, this.lane(key))
    }
```

Hər iki metodda `release(key, this.lane(key))` işlədilir.

- [ ] **Addım 4: Testləri qaçır**

Əmr: `npx vitest run apps/server/src/exec/pool.test.ts`
Gözlənilən: hamısı PASS (mövcud testlər daxil)

- [ ] **Addım 5: Commit**

```bash
git add apps/server/src/exec/pool.ts apps/server/src/exec/pool.test.ts
git commit -m "feat(server): TaskPool.yield — gözləyərkən slot buraxılır"
```

---

## Task 5: `QuestionGate` və `ReviewQueue`

**Fayllar:**
- Yaradılır: `apps/server/src/exec/interaction.ts`
- Yaradılır: `apps/server/src/exec/question-gate.ts`
- Test: `apps/server/src/exec/question-gate.test.ts`

- [ ] **Addım 1: İnterfeysləri yaz**

`apps/server/src/exec/interaction.ts`:

```ts
import type { QuestionKind } from './ask.js'

export interface AskInput {
  taskId: string
  runId: string
  contextId: string
  /** Hovuz limiti — slot buraxılıb yenidən alınarkən lazımdır. */
  maxParallel: number
  question: string
  kind: QuestionKind
  options: readonly string[]
}

/** Cavab: `yes_no` → boolean, `single` → string, `multi` → string[]. */
export type QuestionAnswer = boolean | string | string[]

export interface QuestionGate {
  /**
   * Sualı yazır və cavabı GÖZLƏYİR.
   *
   * `null` = cavab gəlmədi (ləğv). Nərdivan bu halda DAYANMIR — nəticə
   * olduğu kimi qaytarılır (qayda 32: monoton).
   */
  ask(input: AskInput): Promise<QuestionAnswer | null>
}

export interface ReviewQueue {
  /** Tətbiq olunmamış rəyləri götürür və dərhal "tətbiq olunub" işarələyir. */
  drain(taskId: string): string[]
}

/** İstifadəçinin cavabını işçiyə çatdıran prompt parçası. */
export function buildAnswerPrompt(question: string, answer: QuestionAnswer): string {
  const rendered = Array.isArray(answer)
    ? answer.join(', ')
    : typeof answer === 'boolean'
      ? answer
        ? 'bəli'
        : 'xeyr'
      : answer
  return [
    'İSTİFADƏÇİNİN CAVABI:',
    `Sual: ${question}`,
    `Cavab: ${rendered}`,
    'İndi taskı bu cavaba əsasən həll et.',
  ].join('\n')
}

/** Rəyləri işçiyə çatdıran prompt parçası. */
export function buildReviewPrompt(reviews: readonly string[]): string {
  if (reviews.length === 0) return ''
  return [
    'İSTİFADƏÇİNİN RƏYİ (məcburi nəzərə al):',
    ...reviews.map((r) => `- ${r}`),
  ].join('\n')
}
```

- [ ] **Addım 2: Testi yaz**

`apps/server/src/exec/question-gate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client.js'
import { listPendingQuestions } from '../db/interaction-repo.js'
import { createContext, createTask, getTask } from '../db/repo.js'
import { DbQuestionGate } from './question-gate.js'
import { TaskPool } from './pool.js'

function seed() {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
  return { db, ctx, task }
}

const ASK = {
  runId: 'r1',
  question: 'Davam edim?',
  kind: 'yes_no' as const,
  options: [] as string[],
}

describe('DbQuestionGate', () => {
  it('sual yazılır, task waiting_input olur və cavab gözlənilir', async () => {
    const { db, ctx, task } = seed()
    const pool = new TaskPool()
    const broadcast = vi.fn()
    const gate = new DbQuestionGate({ db, pool, broadcast })

    const pending = gate.ask({
      taskId: task.id,
      contextId: ctx.id,
      maxParallel: 1,
      ...ASK,
    })
    await Promise.resolve()

    expect(getTask(db, task.id)?.status).toBe('waiting_input')
    const [q] = listPendingQuestions(db)
    expect(q?.question).toBe('Davam edim?')
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'asked', taskId: task.id }),
    )

    expect(gate.resolve(q?.id ?? '', true)).toBe(true)
    expect(await pending).toBe(true)
    // Cavabdan sonra task yenidən işləyir — `waiting_input` qalsaydı UI
    // "hələ də sual gözləyir" yalanı danışardı.
    expect(getTask(db, task.id)?.status).toBe('running')
  })

  it('ləğv null qaytarır — nərdivan dayanmır', async () => {
    const { db, ctx, task } = seed()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast: vi.fn() })

    const pending = gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK })
    await Promise.resolve()
    const [q] = listPendingQuestions(db)
    gate.cancel(q?.id ?? '')

    expect(await pending).toBeNull()
  })

  it('tanınmayan sual id-si üçün resolve false verir', () => {
    const { db } = seed()
    const gate = new DbQuestionGate({ db, pool: new TaskPool(), broadcast: vi.fn() })
    expect(gate.resolve('yoxdur', true)).toBe(false)
  })

  it('gözləyərkən hovuz slotu BURAXILIR', async () => {
    const { db, ctx, task } = seed()
    const pool = new TaskPool()
    const gate = new DbQuestionGate({ db, pool, broadcast: vi.fn() })
    let secondRan = false

    const first = pool.run(ctx.id, 1, async () => {
      await gate.ask({ taskId: task.id, contextId: ctx.id, maxParallel: 1, ...ASK })
    })
    const second = pool.run(ctx.id, 1, async () => {
      secondRan = true
    })

    await second
    expect(secondRan).toBe(true)

    const [q] = listPendingQuestions(db)
    gate.cancel(q?.id ?? '')
    await first
  })
})
```

- [ ] **Addım 3: Testi qaçır — SINMALIDIR**

- [ ] **Addım 4: Tətbiqi yaz**

`apps/server/src/exec/question-gate.ts`:

```ts
import type { Db } from '../db/client.js'
import { cancelQuestion, createQuestion, getQuestion } from '../db/interaction-repo.js'
import { setTaskStatus } from '../db/repo.js'
import type { AskInput, QuestionAnswer, QuestionGate } from './interaction.js'
import type { TaskPool } from './pool.js'

export interface QuestionEvent {
  kind: 'asked' | 'answered' | 'cancelled'
  taskId: string
  questionId: string
}

export interface QuestionGateInput {
  db: Db
  pool: TaskPool
  broadcast: (event: QuestionEvent) => void
}

/**
 * Sual gözləmə qapısı (Faza 5B).
 *
 * Gözləmə HOVUZ SLOTUNU BURAXARAQ baş verir (`pool.yield`): `max_parallel = 1`
 * olan kontekstdə cavabsız bir sual bütün iş sahəsini kilidləyərdi.
 *
 * TIMEOUT YOXDUR və bu, şüurlu qərardır. Avtomatik davam etmək iki pis
 * variantdan birini seçmək olardı: ya modelə "cavab yoxdur" deyib təxmin
 * etdirmək (o, məhz bunun qarşısını almaq üçün soruşdu), ya da taskı uğursuz
 * sayıb görülmüş işi atmaq. Slot onsuz da buraxıldığı üçün gözləmənin qiyməti
 * sıfırdır — tələsməyə səbəb yoxdur.
 */
export class DbQuestionGate implements QuestionGate {
  private readonly db: Db
  private readonly pool: TaskPool
  private readonly broadcast: (event: QuestionEvent) => void
  private readonly waiters = new Map<string, (a: QuestionAnswer | null) => void>()

  constructor(input: QuestionGateInput) {
    this.db = input.db
    this.pool = input.pool
    this.broadcast = input.broadcast
  }

  async ask(input: AskInput): Promise<QuestionAnswer | null> {
    const row = createQuestion(this.db, {
      taskId: input.taskId,
      runId: input.runId,
      question: input.question,
      kind: input.kind,
      options: input.options,
    })
    // `waiting_input` TERMINAL DEYİL — `setTaskStatus` ona `completed_at`
    // yazmır (bax `TERMINAL_TASK_STATUSES`), yoxsa task bitmiş görünərdi.
    setTaskStatus(this.db, input.taskId, 'waiting_input')
    this.broadcast({ kind: 'asked', taskId: input.taskId, questionId: row.id })

    const answer = await this.pool.yield(
      input.contextId,
      input.maxParallel,
      () =>
        new Promise<QuestionAnswer | null>((resolve) => {
          this.waiters.set(row.id, resolve)
        }),
    )

    this.waiters.delete(row.id)
    setTaskStatus(this.db, input.taskId, 'running')
    return answer
  }

  /** Cavab gəldi — route çağırır. `false` = belə gözləyən yoxdur. */
  resolve(questionId: string, answer: QuestionAnswer): boolean {
    const waiter = this.waiters.get(questionId)
    if (waiter === undefined) return false
    this.waiters.delete(questionId)
    const row = getQuestion(this.db, questionId)
    if (row !== undefined) {
      this.broadcast({ kind: 'answered', taskId: row.taskId, questionId })
    }
    waiter(answer)
    return true
  }

  /** Task ləğv edildi və ya server bağlanır. */
  cancel(questionId: string): void {
    const row = getQuestion(this.db, questionId)
    cancelQuestion(this.db, questionId)
    const waiter = this.waiters.get(questionId)
    if (waiter !== undefined) {
      this.waiters.delete(questionId)
      waiter(null)
    }
    if (row !== undefined) {
      this.broadcast({ kind: 'cancelled', taskId: row.taskId, questionId })
    }
  }

  /** Server bağlananda bütün gözləyənləri buraxır — proses asılı qalmamalıdır. */
  cancelAll(): void {
    for (const id of [...this.waiters.keys()]) this.cancel(id)
  }
}
```

- [ ] **Addım 5: `ReviewQueue` tətbiqini yaz**

`apps/server/src/exec/review-queue.ts`:

```ts
import type { Db } from '../db/client.js'
import { drainReviews } from '../db/interaction-repo.js'
import type { ReviewQueue } from './interaction.js'

/** DB üzərində rəy növbəsi — boşaltma `applied_at` yazır (bax `drainReviews`). */
export class DbReviewQueue implements ReviewQueue {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  drain(taskId: string): string[] {
    return drainReviews(this.db, taskId).map((r) => r.text)
  }
}
```

- [ ] **Addım 6: Testləri qaçır**

Əmr: `npx vitest run apps/server/src/exec/question-gate.test.ts`
Gözlənilən: 4 test PASS

- [ ] **Addım 7: Commit**

```bash
git add apps/server/src/exec/interaction.ts apps/server/src/exec/question-gate.ts apps/server/src/exec/review-queue.ts apps/server/src/exec/question-gate.test.ts
git commit -m "feat(server): sual qapısı və rəy növbəsi"
```

---

## Task 6: Nərdivanın qoşulması

**Fayllar:**
- Dəyişir: `apps/server/src/exec/ladder.ts`
- Test: `apps/server/src/exec/ladder-interaction.test.ts`

- [ ] **Addım 1: `LadderInput`-a sahələr əlavə et**

```ts
  /**
   * İSTİFADƏÇİ İŞTİRAKI mümkündürmü (Faza 5B).
   *
   * `false` — cədvəl və zəncir icralarında: orada cavab verəcək insan yoxdur
   * və task ƏBƏDİ gözləyərdi; üstəlik cədvəlin növbəti tiki yeni icra başladar
   * və gözləyənlər yığılardı (qayda 57-dəki eyni mühakimə).
   */
  interactive?: boolean
```

`LadderContext`-ə:

```ts
  /** İşçi bu kontekstdə sual verə bilirmi. Default `true`. */
  questionsEnabled?: boolean
```

`Ladder` konstruktoruna beşinci/altıncı parametr yerinə **bir obyekt**:

```ts
  constructor(
    db: Db,
    supervisor: RunSupervisor,
    router?: WorkerRouter,
    worktrees?: WorktreeManager,
    memory?: MemorySession,
    interaction?: { questions?: QuestionGate; reviews?: ReviewQueue },
  )
```

- [ ] **Addım 2: `Phase`-ə sahələr**

```ts
  /** Bu taskda tətbiq olunmuş rəylər — HƏR sonrakı prompta qoşulur. */
  reviews: string[]
  /** Sual mexanizmi bu icrada aktivdirmi. */
  askEnabled: boolean
  /** Sual-cavab dövrəsində sessiyanın davamı. */
  resumeSessionId: string | undefined
```

`askEnabled` hesablanması (faza qurularkən):

```ts
    // Üç şərt BİRLİKDƏ: qapı, kontekst bayrağı və İNSAN İŞTİRAKI.
    const askEnabled =
      input.interactive !== false && (input.context.questionsEnabled ?? true)
```

- [ ] **Addım 3: Müqaviləni yenilə**

`workerPhase`-də:

```ts
    const useContract = phase.rungs.has(RUNG_SELF_ESCALATION)
    const contractSuffix = (() => {
      const c = buildSignalContract({ escalate: useContract, ask: phase.askEnabled })
      return c === '' ? '' : `\n\n${c}`
    })()
```

`ESCALATION_CONTRACT` işlədilən BÜTÜN yerləri (`workerPhase`, ipucu/plan yolu —
sətir ~972) eyni funksiyaya keçir.

- [ ] **Addım 4: Prompt qurulmasına review əlavə et**

`workerPrompt` hesablanmasından sonra:

```ts
    // SIRA: task → şablon → yaddaş(ETİBARSIZ) → REVIEW → müqavilə.
    // Review yaddaşdan SONRA gedir: o, istifadəçinin ÖZ göstərişidir —
    // etibarlıdır, halbuki yaddaş kənar mətndir (qayda 45). Model son
    // göstərişə daha çox əhəmiyyət verdiyi üçün etibarlı mətn sona yaxındır.
    // Müqavilə isə ƏN SONDA qalır.
    const withReviews = (base: string): string => {
      const block = buildReviewPrompt(phase.reviews)
      return block === '' ? base : `${base}\n\n${block}`
    }
```

Hər `prompt = …` yerində `withReviews(...)` çağırılır və ondan ƏVVƏL
`this.drainReviews(phase)` işlədilir:

```ts
  /** Yeni rəyləri götürür və fazanın siyahısına əlavə edir. */
  private drainReviews(phase: Phase): void {
    const fresh = this.interaction?.reviews?.drain(phase.input.task.id) ?? []
    // Rəy BİR icraya deyil, BÜTÜN sonrakı icralara qoşulur: yoxlama
    // dövrəsinin ikinci cəhdi istifadəçinin göstərişini unutmamalıdır.
    if (fresh.length > 0) phase.reviews.push(...fresh)
  }
```

- [ ] **Addım 5: `ask` yoxlamasını əlavə et**

`workerPhase`-də, eskalasiya yoxlamasından ƏVVƏL:

```ts
      // ── Faza 5B — işçi məlumat istədi ──────────────────────────────────
      // Eskalasiyadan ƏVVƏL yoxlanılır: sual UCUZDUR (bir cümlə), eskalasiya
      // isə başçının tam icrasına aparır. İkisi eyni cavabda ola bilməz —
      // müqavilə "yalnız biri" deyir — amma sıra yenə vacibdir: model hər
      // ikisini yazmağa çalışsa ucuz yol seçilməlidir.
      if (phase.askEnabled && this.interaction?.questions !== undefined) {
        const ask = parseAsk(this.answerOf(exec.runId))
        if (ask !== null) {
          const answer = await this.interaction.questions.ask({
            taskId: input.task.id,
            runId: exec.runId,
            contextId: input.context.id,
            maxParallel: input.context.maxParallel ?? 1,
            question: ask.question,
            kind: ask.kind,
            options: ask.options,
          })
          if (answer === null) {
            // Cavab gəlmədi (ləğv). Nəticə OLDUĞU KİMİ qaytarılır — mexanizmin
            // uğursuzluğu taskı öldürməməlidir (qayda 32).
            return { kind: 'result', result: { ...base, status: 'interrupted' } }
          }
          // Sessiya davam etdirilir: işçinin oxuduğu fayllar və prompt keşi
          // qorunur. Sıfırdan başlatsaydıq sual verməyin qiyməti TAM icranın
          // qiyməti olardı.
          phase.resumeSessionId = getRun(this.db, exec.runId)?.sessionId ?? undefined
          prompt = buildAnswerPrompt(ask.question, answer)
          continue
        }
      }
```

**DİQQƏT:** `attempts` sayğacı sual dövrəsində ARTIR. `MAX_ATTEMPTS` (3) sual
dövrəsini də məhdudlaşdırır — bu, qəsdəndir və spesifikasiyadakı «sual dövrəsi»
riskinin ilk müdafiəsidir.

- [ ] **Addım 6: `runOnce`-a `resumeSessionId` ötür**

```ts
      ...(phase.resumeSessionId !== undefined
        ? { resumeSessionId: phase.resumeSessionId }
        : {}),
```

`ExecuteInput`-da `resumeSessionId` ARTIQ var — əlavə iş yoxdur.

- [ ] **Addım 7: Keş açarını icra sətrinə yaz**

`storeInCache`-də:

```ts
    setRunCacheKey(this.db, runId, phase.cacheKey)
```

**Sual-cavab və review icraları KEŞƏ YAZILMIR:** `storeInCache` çağırışından
əvvəl yoxlama:

```ts
  private storeInCache(phase: Phase, runId: string): void {
    if (phase.cacheKey === null) return
    // Sual-cavab və rəy icraları keşlənmir (qayda 33 prinsipi): açar nə sualı,
    // nə də rəyi əks etdirir — onları adi icranın açarı altında saxlamaq
    // girişi YALANÇI edərdi və sonrakı adi task səhv cavab alardı.
    if (phase.resumeSessionId !== undefined || phase.reviews.length > 0) return
    …
  }
```

- [ ] **Addım 8: Testi yaz**

`apps/server/src/exec/ladder-interaction.test.ts` — `ladder-file-access.test.ts`
naxışı ilə. Ən azı bu iddialar:

```ts
import type { RunEvent, RunRequest, Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client.js'
import { createContext, createTask, listRunsForTask } from '../db/repo.js'
import { createReview } from '../db/interaction-repo.js'
import { FakeRunner } from '../runners/fake.js'
import { Ladder } from './ladder.js'
import { RunSupervisor } from './supervisor.js'
import type { QuestionGate, ReviewQueue } from './interaction.js'
import { DbReviewQueue } from './review-queue.js'

const ASK_JSON = JSON.stringify({
  ask: { question: 'Hansı?', kind: 'single', options: ['a', 'b'] },
})

/** İlk icrada sual, ikincidə normal cavab verən runner. */
function scriptedRunner(answers: string[], sink: RunRequest[]): Runner {
  let i = 0
  const inner = new FakeRunner({ events: [] })
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: { ...inner.capabilities, sessions: true },
    detect: () => inner.detect(),
    // eslint-disable-next-line @typescript-eslint/require-await
    run: async function* (req): AsyncIterable<RunEvent> {
      sink.push(req)
      const text = answers[Math.min(i, answers.length - 1)] ?? ''
      i += 1
      yield { t: 'start', sessionId: 'sess-1' }
      yield { t: 'text', delta: text }
      yield { t: 'done', stopReason: 'end_turn' }
    },
  }
}

function setup(over: { questionsEnabled?: boolean; interactive?: boolean } = {}) {
  const db = openDb(':memory:')
  const row = createContext(db, { name: 'C' })
  const ctx = {
    ...row,
    cwd: null,
    amplificationProfile: 'cheap',
    maxParallel: 1,
    questionsEnabled: over.questionsEnabled ?? true,
  }
  return { db, ctx }
}

describe('Ladder — agentin sualı', () => {
  it('sual verilir, cavabdan sonra --resume ilə davam edir', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const runner = scriptedRunner([ASK_JSON, 'son cavab'], seen)
    const questions: QuestionGate = { ask: vi.fn(async () => 'a') }
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })

    const result = await ladder.run({ task, context: ctx, runner, model: 'm' })

    expect(questions.ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Hansı?', kind: 'single' }),
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]?.resumeSessionId).toBe('sess-1')
    expect(seen[1]?.prompt).toContain('Cavab: a')
    expect(result.status).toBe('succeeded')
  })

  it('cavab gəlməsə task interrupted olur — nəticə itmir', async () => {
    const { db, ctx } = setup()
    const runner = scriptedRunner([ASK_JSON], [])
    const questions: QuestionGate = { ask: vi.fn(async () => null) }
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    expect((await ladder.run({ task, context: ctx, runner, model: 'm' })).status).toBe(
      'interrupted',
    )
  })

  it('questionsEnabled false olanda müqavilə promptda YOXDUR', async () => {
    const { db, ctx } = setup({ questionsEnabled: false })
    const seen: RunRequest[] = []
    const runner = scriptedRunner(['cavab'], seen)
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask: vi.fn() },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner, model: 'm' })
    expect(seen[0]?.prompt).not.toContain('"ask"')
  })

  it('interactive false (cədvəl) sualı söndürür', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const runner = scriptedRunner([ASK_JSON, 'x'], seen)
    const ask = vi.fn(async () => 'a')
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    await ladder.run({ task, context: ctx, runner, model: 'm', interactive: false })
    // Orada cavab verəcək insan yoxdur — task əbədi gözləməməlidir.
    expect(ask).not.toHaveBeenCalled()
  })

  it('rədd olunan sual ADİ cavab kimi qəbul edilir', async () => {
    const { db, ctx } = setup()
    const bad = JSON.stringify({ ask: { question: 'Q', kind: 'dropdown' } })
    const runner = scriptedRunner([bad], [])
    const ask = vi.fn()
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      questions: { ask },
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    expect((await ladder.run({ task, context: ctx, runner, model: 'm' })).status).toBe(
      'succeeded',
    )
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('Ladder — canlı review', () => {
  it('rəy işçinin promptuna qoşulur', async () => {
    const { db, ctx } = setup()
    const seen: RunRequest[] = []
    const runner = scriptedRunner(['cavab'], seen)
    const reviews: ReviewQueue = new DbReviewQueue(db)
    const ladder = new Ladder(db, new RunSupervisor(db), undefined, undefined, undefined, {
      reviews,
    })
    const task = createTask(db, { contextId: ctx.id, prompt: 'p' })
    createReview(db, { taskId: task.id, text: 'httpOnly cookie işlət', mode: 'next' })

    await ladder.run({ task, context: ctx, runner, model: 'm' })
    expect(seen[0]?.prompt).toContain('httpOnly cookie işlət')
  })
})
```

- [ ] **Addım 9: Testləri qaçır**

Əmr: `npx vitest run apps/server/src/exec/`
Gözlənilən: hamısı PASS

- [ ] **Addım 10: Commit**

```bash
git add apps/server/src/exec/ladder.ts apps/server/src/exec/ladder-interaction.test.ts
git commit -m "feat(server): nərdivan sual və rəy mexanizmlərini işlədir"
```

---

## Task 7: Paylaşılan API sxemi

**Fayllar:**
- Dəyişir: `packages/shared/src/api.ts`
- Test: `packages/shared/src/api.test.ts`

- [ ] **Addım 1: Sxemləri yaz**

```ts
export const QUESTION_KINDS = ['yes_no', 'single', 'multi'] as const
export const REVIEW_MODES = ['next', 'interrupt'] as const

/**
 * Cavabın forması `kind`-dan asılıdır: `yes_no` → boolean, `single` → string,
 * `multi` → string[]. Sərhəd yoxlaması SERVERDƏDİR (`kind` orada bilinir) —
 * sxemi `kind`-a bağlı etsəydik klient sualın formasını da göndərməli olardı
 * və o, uyğunsuz göndərə bilərdi.
 */
export const AnswerQuestionBody = z.object({
  answer: z.union([z.boolean(), z.string().min(1), z.array(z.string().min(1)).min(1)]),
})
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBody>

export const CreateReviewBody = z.object({
  text: z.string().min(1).max(2000),
  /**
   * `next` — növbəti icrada nəzərə alınır, heç bir iş atılmır.
   * `interrupt` — cari icra dərhal kəsilir; yarımçıq işin ÇIXIŞ tokenləri
   * ödənilib atılır (çıxış girişdən 3–5x bahadır), əvəzində cavab dərhaldır.
   */
  mode: z.enum(REVIEW_MODES),
})
export type CreateReviewBody = z.infer<typeof CreateReviewBody>
```

`UpdateContextBody`-yə: `questionsEnabled: z.boolean().optional()`

`WsServerMessage`-a:

```ts
  /**
   * Sual hadisəsi (Faza 5B) — `activity` ilə eyni prinsip: hadisə, delta yox.
   *
   * HƏM qlobal, HƏM task kanalına yayılır: qlobal — `LiveBar` nişanı üçün,
   * task kanalı — açıq `/tasks/:id` səhifəsi üçün.
   */
  z.object({
    type: z.literal('question'),
    kind: z.enum(['asked', 'answered', 'cancelled']),
    taskId: z.string(),
    questionId: z.string(),
  }),
```

- [ ] **Addım 2: Testi yaz və qaçır**

```ts
describe('AnswerQuestionBody', () => {
  it('boolean, sətir və massiv qəbul edir', () => {
    for (const answer of [true, 'a', ['a', 'b']]) {
      expect(AnswerQuestionBody.safeParse({ answer }).success).toBe(true)
    }
  })

  it('boş massivi rədd edir', () => {
    expect(AnswerQuestionBody.safeParse({ answer: [] }).success).toBe(false)
  })

  it('boş sətri rədd edir', () => {
    expect(AnswerQuestionBody.safeParse({ answer: '' }).success).toBe(false)
  })
})

describe('CreateReviewBody', () => {
  it('iki rejimi qəbul edir', () => {
    for (const mode of ['next', 'interrupt']) {
      expect(CreateReviewBody.safeParse({ text: 'x', mode }).success).toBe(true)
    }
  })

  it('tanınmayan rejimi rədd edir', () => {
    expect(CreateReviewBody.safeParse({ text: 'x', mode: 'kill' }).success).toBe(false)
  })

  it('boş mətni rədd edir', () => {
    expect(CreateReviewBody.safeParse({ text: '', mode: 'next' }).success).toBe(false)
  })
})

describe('WsServerMessage — question', () => {
  it('üç növü qəbul edir', () => {
    for (const kind of ['asked', 'answered', 'cancelled']) {
      expect(
        WsServerMessage.safeParse({ type: 'question', kind, taskId: 't', questionId: 'q' })
          .success,
      ).toBe(true)
    }
  })
})
```

Əmr: `npx vitest run packages/shared`

- [ ] **Addım 3: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): sual/rəy sxemləri və question WS mesajı"
```

---

## Task 8: Route-lar

**Fayllar:**
- Dəyişir: `apps/server/src/routes/tasks.ts`
- Test: `apps/server/src/routes/interaction-routes.test.ts`

- [ ] **Addım 1: Route-ları yaz**

`registerTaskRoutes` girişinə `questions?: DbQuestionGate` və
`startTask: (taskId) => void` (review-un yeni icra başlatması üçün — mövcud task
başlatma funksiyasını təkrar istifadə et; `POST /api/tasks`-dakı icra başlatma
məntiqini ayrıca funksiyaya çıxar).

```ts
  app.post<{ Params: { id: string; qid: string } }>(
    '/api/tasks/:id/questions/:qid/answer',
    async (req, reply) => {
      const parsed = AnswerQuestionBody.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

      const question = getQuestion(db, req.params.qid)
      if (question === undefined || question.taskId !== req.params.id) {
        return reply.code(404).send({ error: 'Sual tapılmadı' })
      }
      if (question.status !== 'pending') {
        // 409: cavab GECİKDİ. 400 yazsaydıq istifadəçi öz göndərişini səhv
        // sayardı, halbuki səhv yoxdur — sual artıq bağlanıb.
        return reply.code(409).send({ error: 'Sual artıq bağlanıb' })
      }

      const answer = parsed.data.answer
      // Forma yoxlaması BURADADIR, sxemdə yox: `kind` yalnız serverdə bilinir.
      const problem = answerProblem(question.kind, JSON.parse(question.optionsJson), answer)
      if (problem !== null) return reply.code(400).send({ error: problem })

      answerQuestion(db, question.id, answer)
      const delivered = questions?.resolve(question.id, answer) ?? false
      // `delivered: false` = gözləyən proses yoxdur (server yenidən
      // başladılıb). Cavab DB-yə yazılır, amma icra davam etməyəcək —
      // istifadəçi bunu bilməlidir.
      return { ok: true, delivered }
    },
  )

  app.post<{ Params: { id: string } }>('/api/tasks/:id/review', async (req, reply) => {
    const parsed = CreateReviewBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })

    const active = listRunsForTask(db, task.id).filter((r) => r.status === 'running')
    createReview(db, {
      taskId: task.id,
      runId: active[0]?.id ?? null,
      text: parsed.data.text,
      mode: parsed.data.mode,
    })

    // Review keş sətrini LƏĞV EDİR: istifadəçi rəy yazırsa cavab səhv idi,
    // amma o cavab keşə ARTIQ düşüb və eyni prompt bir daha göndəriləndə
    // qaytarılardı. Açar `runs.cache_key`-dədir — yenidən hesablanmır.
    for (const run of listRunsForTask(db, task.id)) {
      if (run.cacheKey !== null) deleteCacheEntry(db, run.cacheKey)
    }

    if (active.length > 0) {
      if (parsed.data.mode === 'interrupt') {
        for (const r of active) supervisor.cancel(r.id)
      }
      return { ok: true, applied: 'queued' }
    }

    // İcra işləmir — "növbəti icra" yoxdur, ona görə route YENİSİNİ başladır.
    // Sərhəd BURADADIR, nərdivanda yox: nərdivanın içində dövrə qursaydıq
    // ard-arda yazılan rəylər bir çağırışı sonsuz uzada bilərdi və büdcə
    // hesabı mənasını itirərdi.
    startTask(task.id)
    return { ok: true, applied: 'restarted' }
  })

  app.get('/api/questions/pending', async () => ({
    questions: listPendingQuestions(db).map((q) => ({
      ...q,
      options: JSON.parse(q.optionsJson) as string[],
    })),
  }))
```

`answerProblem` saf funksiyası (`exec/ask.ts`-ə əlavə et):

```ts
/**
 * Cavabın sualın formasına uyğunluğu.
 *
 * Zod sxemində EDİLƏ BİLMƏZ: `kind` yalnız serverdə, DB sətrində bilinir.
 * Klientdən `kind` istəsəydik o, uyğunsuz göndərə bilərdi və yoxlama özünü
 * yoxlayardı.
 */
export function answerProblem(
  kind: string,
  options: readonly string[],
  answer: unknown,
): string | null {
  if (kind === 'yes_no') {
    return typeof answer === 'boolean' ? null : 'Bəli/xeyr sualı boolean cavab gözləyir'
  }
  if (kind === 'single') {
    if (typeof answer !== 'string') return 'Təkseçimli sual bir variant gözləyir'
    return options.includes(answer) ? null : `Tanınmayan variant: ${answer}`
  }
  if (kind === 'multi') {
    if (!Array.isArray(answer)) return 'Çoxseçimli sual massiv gözləyir'
    const bad = answer.find((a) => typeof a !== 'string' || !options.includes(a))
    return bad === undefined ? null : `Tanınmayan variant: ${String(bad)}`
  }
  return `Tanınmayan sual növü: ${kind}`
}
```

- [ ] **Addım 2: `GET /api/tasks/:id` cavabına əlavə et**

```ts
      // Sual və rəylər (Faza 5B). Ayrıca endpoint kimi YOX: task səhifəsi
      // onsuz da bu cavabı çəkir və ikinci sorğu eyni məlumatın iki mənbəyini
      // yaradardı (eyni mühakimə: `subtasks`, `memory`).
      questions: listQuestions(db, task.id).map((q) => ({
        ...q,
        options: JSON.parse(q.optionsJson) as string[],
      })),
      reviews: listReviews(db, task.id),
```

- [ ] **Addım 3: `cancel` route-u sualları da bağlasın**

```ts
    // Gözləyən suallar da ləğv olunur: task dayandırılırsa cavab heç yerə
    // çatmayacaq və UI əbədi "cavab gözləyir" göstərərdi.
    for (const q of listQuestions(db, task.id)) {
      if (q.status === 'pending') questions?.cancel(q.id)
    }
```

- [ ] **Addım 4: Testi yaz**

`apps/server/src/routes/interaction-routes.test.ts` — `runs-routes.test.ts`
naxışı ilə. İddialar:

- cavab yazılır, `delivered: false` (gate yoxdur)
- tanınmayan variant → 400
- `yes_no`-ya sətir cavab → 400
- cavablanmış suala təkrar cavab → 409
- başqa taskın sualı → 404
- review yazılır və keş sətri SİLİNİR
- `GET /api/questions/pending` gözləyəni qaytarır
- `GET /api/tasks/:id` `questions` və `reviews` daşıyır

- [ ] **Addım 5: Testləri qaçır və commit**

```bash
npx vitest run apps/server/src/routes/
git add apps/server/src/routes apps/server/src/exec/ask.ts
git commit -m "feat(server): sual cavabı, rəy və gözləyən suallar route-ları"
```

---

## Task 9: `app.ts` qoşulması

**Fayllar:**
- Dəyişir: `apps/server/src/app.ts`

- [ ] **Addım 1: Gate və queue qur**

```ts
  const questionGate = new DbQuestionGate({
    db,
    pool,
    broadcast: (e) => {
      const msg = {
        type: 'question' as const,
        kind: e.kind,
        taskId: e.taskId,
        questionId: e.questionId,
      }
      // HƏR İKİ kanala: qlobal — `LiveBar` nişanı, task — açıq səhifə.
      hub.broadcastGlobal(msg)
      hub.broadcast(e.taskId, msg)
    },
  })
  const reviewQueue = new DbReviewQueue(db)
```

`Ladder` konstruktoruna `{ questions: questionGate, reviews: reviewQueue }`
ötür; `registerTaskRoutes`-a `questions: questionGate`.

- [ ] **Addım 2: Yetim sualları təmizlə**

`markOrphanedRunsInterrupted` yanında:

```ts
  const orphanQuestions = cancelOrphanQuestions(db)
  if (orphanQuestions > 0) {
    app.log.warn(`${orphanQuestions} yetim sual ləğv edildi`)
  }
```

- [ ] **Addım 3: Bağlanmada gözləyənləri burax**

`onClose` hook-una:

```ts
    questionGate.cancelAll()
```

Səbəb: gözləyən `Promise` prosesi asılı saxlayardı və `SIGINT`-dən sonra server
bağlanmazdı.

- [ ] **Addım 4: Cədvəl və zəncirdə `interactive: false`**

`WorkflowEngine` və `Scheduler` yolunda `ladder.run` çağırışlarına
`interactive: false` əlavə et.

- [ ] **Addım 5: Testləri qaçır və commit**

```bash
npx vitest run apps/server && npx pnpm typecheck
git add apps/server/src
git commit -m "feat(server): sual qapısının qoşulması və yetim sual təmizliyi"
```

---

## Task 10: Web — API klienti

**Fayllar:**
- Dəyişir: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Addım 1: Tiplər və metodlar**

```ts
export interface QuestionRow {
  id: string
  taskId: string
  runId: string
  question: string
  kind: string
  options: string[]
  answerJson: string | null
  status: string
  askedAt: number
  answeredAt: number | null
}

export interface ReviewRow {
  id: string
  taskId: string
  runId: string | null
  text: string
  mode: string
  appliedAt: number | null
  createdAt: number
}
```

```ts
  answerQuestion: (taskId: string, questionId: string, answer: boolean | string | string[]) =>
    request<{ ok: boolean; delivered: boolean }>(
      `/api/tasks/${taskId}/questions/${questionId}/answer`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),

  createReview: (taskId: string, body: CreateReviewBody) =>
    request<{ ok: boolean; applied: string }>(`/api/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listPendingQuestions: () =>
    request<{ questions: QuestionRow[] }>('/api/questions/pending'),
```

- [ ] **Addım 2: Test və commit**

Test: `listPendingQuestions` gövdəsiz GET-dir (content-type qoymur — qayda 64);
`answerQuestion` gövdə ilə POST-dur və content-type QOYUR.

```bash
npx vitest run apps/web/src/lib/api.test.ts
git add apps/web/src/lib
git commit -m "feat(web): sual/rəy API klienti"
```

---

## Task 11: Web — `QuestionPanel` və `ReviewBox`

**Fayllar:**
- Yaradılır: `apps/web/src/components/QuestionPanel.tsx`
- Yaradılır: `apps/web/src/components/ReviewBox.tsx`
- Test: hər ikisi üçün

- [ ] **Addım 1: `QuestionPanel` testini yaz**

İddialar (mövcud `fireEvent` naxışı ilə — `user-event` asılılığı ƏLAVƏ
EDİLMİR):

- `yes_no` → iki düymə («Bəli», «Xeyr»); klik `onAnswer(true/false)` çağırır
- `single` → radio; seçim + «Göndər» → `onAnswer('a')`
- `multi` → **checkbox**; iki seçim + «Göndər» → `onAnswer(['a','b'])`
- `multi`-də heç nə seçilməyibsə «Göndər» SÖNÜKDÜR (server onsuz da boş massivi
  rədd edir — düymə aktiv olsaydı istifadəçi səbəbsiz xəta görərdi)
- `status !== 'pending'` olan sual cavabı ilə birlikdə göstərilir, forma yox

- [ ] **Addım 2: `QuestionPanel`-i yaz**

```tsx
import { useState } from 'react'
import type { QuestionRow } from '../lib/api.js'

interface Props {
  question: QuestionRow
  onAnswer: (answer: boolean | string | string[]) => void
  pending?: boolean
}

/**
 * İşçinin sualı (Faza 5B).
 *
 * Üç forma bir komponentdədir: `yes_no` → iki düymə, `single` → radio,
 * `multi` → checkbox. Ayrı komponentlərə bölsəydik üçü də eyni "cavablanmış
 * sual" görünüşünü təkrarlayardı.
 */
export default function QuestionPanel({ question, onAnswer, pending }: Props): React.JSX.Element {
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])

  if (question.status !== 'pending') {
    const answer = question.answerJson === null ? null : (JSON.parse(question.answerJson) as unknown)
    return (
      <div className="rounded border border-white/10 bg-surface-2 p-3 text-sm">
        <div className="text-ink-dim">{question.question}</div>
        <div className="mt-1">
          {question.status === 'cancelled'
            ? '(ləğv edildi)'
            : Array.isArray(answer)
              ? answer.join(', ')
              : typeof answer === 'boolean'
                ? answer
                  ? 'bəli'
                  : 'xeyr'
                : String(answer)}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 text-sm font-medium">{question.question}</div>

      {question.kind === 'yes_no' && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onAnswer(true)}
            className="rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Bəli
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onAnswer(false)}
            className="rounded border border-white/15 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Xeyr
          </button>
        </div>
      )}

      {question.kind === 'single' && (
        <>
          {question.options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`q-${question.id}`}
                aria-label={o}
                checked={single === o}
                onChange={() => setSingle(o)}
              />
              {o}
            </label>
          ))}
          <button
            type="button"
            disabled={pending || single === ''}
            onClick={() => onAnswer(single)}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Göndər
          </button>
        </>
      )}

      {question.kind === 'multi' && (
        <>
          {question.options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={o}
                checked={multi.includes(o)}
                onChange={(e) =>
                  setMulti((prev) =>
                    e.target.checked ? [...prev, o] : prev.filter((x) => x !== o),
                  )
                }
              />
              {o}
            </label>
          ))}
          {/* Boş seçimlə göndərmək OLMAZ: server onu rədd edir və istifadəçi
              səbəbsiz xəta görərdi. */}
          <button
            type="button"
            disabled={pending || multi.length === 0}
            onClick={() => onAnswer(multi)}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Göndər
          </button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Addım 3: `ReviewBox`-u yaz**

İki düymə: «Növbəti icrada» (`next`) və «İndi kəs» (`interrupt`). İkinci düymə
altında bir sətirlik xəbərdarlıq: *«yarımçıq işin çıxış tokenləri itir»* —
qiymət gizlədilməməlidir.

Boş mətnlə hər iki düymə sönükdür.

- [ ] **Addım 4: Testləri qaçır və commit**

---

## Task 12: Web — `TaskView` və `LiveBar` nişanı

**Fayllar:**
- Dəyişir: `apps/web/src/pages/TaskView.tsx`
- Dəyişir: `apps/web/src/components/LiveBar.tsx`
- Dəyişir: `apps/web/src/lib/useActivity.ts`
- Test: `apps/web/src/components/LiveBar.test.tsx`

- [ ] **Addım 1: `useActivity`-yə sual sayğacı əlavə et**

```ts
export function useActivity(): {
  runs: ActiveRunRow[]
  pendingQuestions: number
  connected: boolean
}
```

`GET /api/questions/pending` anlıq şəkil kimi çəkilir; `question` WS mesajı
gələndə react-query açarı invalidasiya olunur.

**Sual sayğacı `runs`-dan HESABLANA BİLMƏZ:** sualı verən icra ARTIQ bitib
(`status = 'succeeded'`), yəni `/api/runs/active` onu görmür.

- [ ] **Addım 2: `LiveBar`-a nişan**

Zolaq indi icra YOXDURSA da görünür — gözləyən sual varsa:

```tsx
  if (runs.length === 0 && pendingQuestions === 0) return null
```

Nişan: `⚠ N sual cavab gözləyir`.

- [ ] **Addım 3: `TaskView`-a komponentləri qoş**

- `questions` massivi → hər biri üçün `QuestionPanel`
- `ReviewBox` — task `pending`/`running`/`waiting_input` olduqda görünür
- cavab/rəy göndərildikdən sonra `['task', id]` invalidasiya olunur

- [ ] **Addım 4: Testləri qaçır və commit**

---

## Task 13: Sənədləşmə və yekun yoxlama

**Fayllar:**
- Dəyişir: `CLAUDE.md`

- [ ] **Addım 1: Qaydaları yaz (69–72)**

- **69. Sual siqnalı da cavabın BÜTÜNÜ olmalıdır** — qayda 28-in ailəsindən,
  amma nəticəsi daha pisdir: yanlış-müsbət eskalasiya bahalı icra doğurur,
  yanlış-müsbət SUAL isə taskı ƏBƏDİ dondurur. Müqavilə eskalasiya ilə
  BİRLƏŞDİRİLİB: iki ayrı blok həm ikiqat token, həm də oxşar JSON formaları
  ilə modeli çaşdırırdı.
- **70. Gözləyən task hovuz slotunu SAXLAMIR** — `max_parallel = 1`-də bir
  cavabsız sual bütün iş sahəsini kilidləyərdi. `TaskPool.yield` slotu buraxır
  və cavabdan sonra ADİ növbəyə qaytarır. Timeout YOXDUR: hər iki avtomatik
  davranış (təxmin etdirmək / uğursuz saymaq) pisdir, gözləmənin qiyməti isə
  artıq sıfırdır.
- **71. Suallar avtomatik icralarda SÖNDÜRÜLÜR** — cədvəl və zəncirdə cavab
  verəcək insan yoxdur; üstəlik cədvəlin növbəti tiki yeni icra başladar və
  gözləyənlər yığılardı (qayda 57 ailəsi).
- **72. Review keş sətrini LƏĞV EDİR** — istifadəçi rəy yazırsa cavab səhv idi,
  amma o cavab Pillə 0 keşinə ARTIQ düşüb. Açar `runs.cache_key`-dədir və
  route-da YENİDƏN HESABLANMIR: o, model, runner, şablon və yaddaş
  digest-indən asılıdır və hesablamanı iki yerdə təkrarlamaq səssiz uyğunsuzluq
  mənbəyidir. Review icrasının nəticəsi də keşlənmir və keşdən oxunmur.

- [ ] **Addım 2: Amplification Ladder bölməsinə kəsişən mexanizm əlavə et**

```
Yeddinci kəsişən mexanizm — insan-döngədə (`exec/ask.ts`, `exec/question-gate.ts`):

işçi məlumat istədi   → task `waiting_input`, HOVUZ SLOTU BURAXILIR
istifadəçi cavab verdi → `--resume` ilə davam, sessiya qorunur
istifadəçi rəy yazdı   → növbəyə düşür; `interrupt` rejimində proses öldürülür
rəy yazıldı            → taskın KEŞ sətri silinir
cədvəl/zəncir icrası   → suallar SÖNDÜRÜLÜR (insan yoxdur)
```

- [ ] **Addım 3: Fazalar və bilinən boşluqlar**

`5B (bitdi)` sətri; spesifikasiyanın §12-dəki altı boşluğu köçür.

- [ ] **Addım 4: Yekun yoxlama**

```bash
npx pnpm test        # hamısı yaşıl
npx pnpm typecheck   # təmiz
npx pnpm lint        # təmiz
npx pnpm --filter @orchestris/server db:generate   # yeni fayl YARATMIR
```

- [ ] **Addım 5: Real serverlə smoke-test**

Server qaldır, `POST /api/tasks/:id/review` və `GET /api/questions/pending`
brauzer formasında yoxla (qayda 64: `app.inject` brauzeri təmsil etmir).

- [ ] **Addım 6: Commit**

---

## Yekun yoxlama siyahısı

- [ ] `pnpm test` / `typecheck` / `lint` — təmiz
- [ ] `db:generate` yeni fayl yaratmır
- [ ] `CLAUDE_STABLE_FLAGS` dəyişməyib
- [ ] `waiting_input` `TERMINAL_TASK_STATUSES`-də YOXDUR
- [ ] Cavabsız sual `max_parallel = 1` kontekstini kilidləmir (test var)
- [ ] Review keş sətrini silir (test var)
- [ ] Cədvəl icrasında sual verilmir (test var)
