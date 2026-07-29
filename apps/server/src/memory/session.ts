import { recordMemoryOp } from '../db/memory-repo.js'
import type { Db } from '../db/client.js'
import { estimateTokens, MEMORY_TOKEN_BUDGET, trimToBudget } from './budget.js'
import { buildRecallSuffix, envelopeTokens, memoryDigest, sanitizeMemoryText } from './prompt.js'
import type { MemoryProvider } from './provider.js'

/**
 * Nərdivanın gördüyü yaddaş qatı.
 *
 * `MemoryProvider` xam anbardır; bu sinif onun ətrafındakı BÜTÜN qaydaları
 * saxlayır: büdcə kəsimi, etibarsız mətnin çərçivəyə salınması, xərcin
 * jurnala yazılması və — ən vacibi — **heç bir yolun taskı dayandırmaması**.
 *
 * Yaddaş OPTİMALLAŞDIRMADIR, tələb deyil (eyni prinsip: worktree izolyasiyası,
 * CLAUDE.md qayda 41). Provayder sınsa, ləng olsa, cəfəngiyat qaytarsa —
 * task yaddaşsız davam edir. Ona görə burada `throw` YOXDUR.
 */

/** Yaddaşa yazılan mətnin yuxarı həddi (simvol). */
export const MEMORY_WRITE_CHAR_LIMIT = 2000

export interface RecallOutcome {
  /** İşçi promptunun SONUNA qoşulacaq mətn. Boş sətir = yaddaş qoşulmadı. */
  suffix: string
  /** Keş açarına girən barmaq izi. Yaddaş qoşulmayıbsa `null` — açar dəyişmir. */
  digest: string | null
  items: number
  tokens: number
}

const EMPTY: RecallOutcome = { suffix: '', digest: null, items: 0, tokens: 0 }

export interface MemoryContext {
  id: string
  memoryScope?: string | null
  memoryEnabled?: boolean
}

/**
 * Kontekstin yaddaş sahəsi.
 *
 * NULL = kontekstin öz `id`-si. Bu, ən təhlükəsiz default-dur: iki fərqli
 * layihənin qeydləri bir-birinə qarışmır. Paylaşmaq İSTƏYƏN istifadəçi iki
 * kontekstə eyni adı verir — yəni paylaşım AÇIQ qərardır, təsadüf deyil.
 */
export function resolveScope(ctx: MemoryContext): string {
  const scope = ctx.memoryScope?.trim()
  return scope === undefined || scope === '' ? ctx.id : scope
}

export interface MemorySessionOptions {
  /** Default `MEMORY_TOKEN_BUDGET`. Testlər üçün kiçildilə bilər. */
  tokenBudget?: number
}

export class MemorySession {
  private readonly db: Db
  private readonly provider: MemoryProvider
  private readonly tokenBudget: number

  constructor(db: Db, provider: MemoryProvider, opts: MemorySessionOptions = {}) {
    this.db = db
    this.provider = provider
    this.tokenBudget = opts.tokenBudget ?? MEMORY_TOKEN_BUDGET
  }

  get providerId(): string {
    return this.provider.id
  }

  /** Bu kontekstdə yaddaş işə düşürmü — istifadəçinin opt-out-u. */
  enabled(ctx: MemoryContext): boolean {
    return ctx.memoryEnabled !== false
  }

  /**
   * Keçmişdən uyğun qeydləri gətirir və işçi promptunun suffiksini qurur.
   *
   * BÜDCƏ İKİ DƏFƏ TƏTBİQ OLUNUR: provayderə ötürülür (uzaq tərəf lazımsız
   * mətni ümumiyyətlə göndərməsin) VƏ nəticə burada kəsilir (provayderin
   * büdcəyə əməl etdiyinə GÜVƏNMİRİK — o, bizim kodumuz deyil).
   *
   * Çərçivənin öz tokeni büdcədən ÇIXILIR: "600 token yaddaş" deyib üstünə
   * çərçivə qatmaq büdcəni yalan edərdi. Çərçivəyə belə yer qalmırsa yaddaş
   * ÜMUMİYYƏTLƏ qoşulmur — boş çərçivə ödəniş tələb edir, fayda vermir.
   */
  async recall(input: {
    taskId: string
    ctx: MemoryContext
    query: string
  }): Promise<RecallOutcome> {
    if (!this.enabled(input.ctx)) return EMPTY

    const scope = resolveScope(input.ctx)
    const itemBudget = this.tokenBudget - envelopeTokens()
    if (itemBudget <= 0) return EMPTY

    try {
      const result = await this.provider.recall(input.query, scope, itemBudget)
      const kept = trimToBudget(
        result.items
          .map((item) => ({ ...item, text: sanitizeMemoryText(item.text) }))
          .filter((item) => item.text !== ''),
        itemBudget,
      )
      const suffix = buildRecallSuffix(kept)
      const tokens = suffix === '' ? 0 : estimateTokens(suffix)

      this.record({
        taskId: input.taskId,
        kind: 'recall',
        scope,
        items: kept.length,
        tokens,
        costUsd: result.costUsd,
        ok: true,
      })

      if (suffix === '') return EMPTY
      return { suffix, digest: memoryDigest(suffix), items: kept.length, tokens }
    } catch (err) {
      this.record({
        taskId: input.taskId,
        kind: 'recall',
        scope,
        items: 0,
        tokens: 0,
        // Sınmış çağırış model işlətmir — xərci HƏQİQƏTƏN sıfırdır.
        costUsd: 0,
        ok: false,
        detail: describe(err),
      })
      return EMPTY
    }
  }

  /**
   * Taskın nəticəsini yaddaşa yazır.
   *
   * NİYƏ BİZ YAZIRIQ: claude-mem-in öz hook-ları bizim CLI icralarımızda İŞƏ
   * DÜŞMÜR — `CLAUDE_STABLE_FLAGS` `--safe-mode` daşıyır və o, məhz
   * istifadəçinin hook/skill/MCP yükünü söndürmək üçündür (qayda 1). API
   * işçilərində isə hook anlayışı onsuz da yoxdur. Yəni yazmasaq, yaddaş HEÇ
   * VAXT dolmaz.
   *
   * YALNIZ UĞURLU nəticə yazılır. Səhv cavabı yaddaşa qoymaq bir taskı deyil,
   * həmin sahədəki BÜTÜN gələcək taskları zəhərləyər — və zərəri şablondan
   * (qayda 39) daha gizlidir, çünki yaddaş mətni heç bir yerdə nəzərdən
   * keçirilmir.
   */
  async remember(input: {
    taskId: string
    ctx: MemoryContext
    prompt: string
    answer: string
  }): Promise<void> {
    if (!this.enabled(input.ctx)) return

    const text = compose(input.prompt, input.answer)
    if (text === null) return

    const scope = resolveScope(input.ctx)
    try {
      const usage = await this.provider.remember(scope, [
        { id: `task:${input.taskId}`, text, at: Date.now() },
      ])
      this.record({
        taskId: input.taskId,
        kind: 'remember',
        scope,
        items: 1,
        tokens: estimateTokens(text),
        costUsd: usage.costUsd,
        ok: true,
      })
    } catch (err) {
      this.record({
        taskId: input.taskId,
        kind: 'remember',
        scope,
        items: 0,
        tokens: 0,
        costUsd: 0,
        ok: false,
        detail: describe(err),
      })
    }
  }

  /**
   * Jurnal sətri — HEÇ NƏ ETMƏYƏN əməliyyat yazılmır.
   *
   * Default provayder `NullProvider`-dir və o, hər taskda iki boş sətir
   * yaradardı: jurnal oxunmaz olar, `memory_ops` isə heç nə ölçməzdi. Sıfır
   * qeyd + sıfır xərc + uğur = "yaddaş yoxdur", bunu yazmağa dəyməz. Sınmış
   * və ya xərcli hər əməliyyat isə HƏMİŞƏ yazılır.
   */
  private record(op: {
    taskId: string
    kind: 'recall' | 'remember'
    scope: string
    items: number
    tokens: number
    costUsd: number | null
    ok: boolean
    detail?: string
  }): void {
    const idle = op.ok && op.items === 0 && op.costUsd === 0
    if (idle) return
    recordMemoryOp(this.db, { provider: this.provider.id, ...op })
  }
}

/**
 * Yaddaşa yazılacaq mətn, və ya `null` (yazmağa dəyməz).
 *
 * Cavab KƏSİLİR — və bu, şablon qaydasına (qayda 39: uzun şablon RƏDD edilir)
 * zidd deyil: şablon GÖSTƏRİŞDİR və yarımçıq göstəriş yanıldıcıdır, yaddaş
 * qeydi isə QEYDDİR. Kəsilmiş qeyd az fayda verir, yanlış göstəriş vermir —
 * üstəlik kəsilmə açıq işarələnir. Kəsməsəydik, uzun cavab sıxma xərcini
 * qeyri-müəyyən böyüdərdi.
 */
function compose(prompt: string, answer: string): string | null {
  const clean = sanitizeMemoryText(answer)
  if (clean === '') return null

  const body =
    clean.length > MEMORY_WRITE_CHAR_LIMIT
      ? `${clean.slice(0, MEMORY_WRITE_CHAR_LIMIT)}\n…(kəsilib)`
      : clean

  return [`TASK: ${sanitizeMemoryText(prompt).slice(0, 500)}`, `NƏTİCƏ: ${body}`].join('\n')
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}
