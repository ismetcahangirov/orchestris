/**
 * Yaddaş adapteri — Faza 3.
 *
 * NİYƏ ADAPTER MƏCBURİDİR: yaddaşı verən xarici layihə (claude-mem) sürətlə
 * dəyişir. Onu birbaşa nərdivana tikməkdənsə arxasına bir interfeys qoyulur —
 * sınsa BİR fayl dəyişir, sistem işləməyə davam edir. Default `NullProvider`-dir:
 * yaddaş OPTİMALLAŞDIRMADIR, tələb deyil (eyni prinsip: worktree izolyasiyası,
 * CLAUDE.md qayda 41).
 *
 * İKİ SƏRT QAYDA BÜTÜN İNTERFEYSİ ŞƏKİLLƏNDİRİR:
 *
 * 1. **`recall` MƏCBURİ `tokenBudget` alır.** Yaddaş konteksti şişirdə bilməz.
 *    Şişirtsə, layihənin bütün iddiası ("zəif model + az token") öz-özünü
 *    yeyərdi: hər icraya əlavə min token qatmaq başçı icrasından qənaət
 *    etdiyimizi geri qaytarardı. Büdcə OPSİONAL olsaydı, çağırışın birində
 *    unudulub səssizcə limitsiz qalardı.
 * 2. **Hər əməliyyat öz xərcini QAYTARIR.** Yaddaş sıxılması model çağırışıdır
 *    — pulsuz deyil. Onu ölçmədən "qənaət etdik" demək uydurma olardı
 *    (`savings_ledger.memory_cost_usd`, issue #8).
 */

/** Yaddaşdakı bir qeyd. */
export interface MemoryItem {
  /** Provayderin öz id-si — təkrar yazılışın qarşısını almaq üçün. */
  id: string
  text: string
  /**
   * Relevantlıq (0..1). Büdcə kəsimi MƏHZ buna görədir: budget aşılanda ən az
   * uyğun qeyd atılır, sonuncu gələn yox.
   */
  score?: number
  /** Qeydin yaranma vaxtı (unix ms). */
  at?: number
}

/**
 * Bir yaddaş əməliyyatının xərci.
 *
 * `costUsd === null` "BİLİNMİR" deməkdir, `0` deyil (CLAUDE.md qayda 4).
 * Fərq vacibdir: lokal FTS5 axtarışı HƏQİQƏTƏN pulsuzdur (`0`), sıxma isə
 * model çağırışıdır və provayder onu bildirməyə bilər (`null`). İkisini
 * qarışdırsaq büdcə mühafizəsi naməlum xərci "pulsuz" sayardı.
 */
export interface MemoryUsage {
  costUsd: number | null
}

export interface RecallResult extends MemoryUsage {
  items: MemoryItem[]
}

export interface MemoryHealth {
  ok: boolean
  /** Niyə işləmir — UI-da göstərilir. Xarici mətn olduğu üçün KƏSİLMİŞ olmalıdır. */
  detail?: string
}

export interface MemoryProvider {
  /** `null` | `claude-mem` — `memory_ops.provider` sütununa yazılır. */
  readonly id: string

  /**
   * Yeni qeydləri yazır.
   *
   * NİYƏ AÇIQ ÇAĞIRILIR: claude-mem-in öz hook-ları bizim CLI icralarımızda
   * İŞƏ DÜŞMÜR — `CLAUDE_STABLE_FLAGS` `--safe-mode` daşıyır və o, məhz
   * istifadəçinin hook/skill/MCP yükünü söndürmək üçündür (qayda 1, ölçülmüş:
   * $0.0251 → $0.0085). Yəni yaddaşı biz yazmasaq, HEÇ KİM yazmır — nə CLI, nə
   * API işçiləri üçün.
   */
  remember(scope: string, items: readonly MemoryItem[]): Promise<MemoryUsage>

  /**
   * Uyğun qeydləri gətirir.
   *
   * `tokenBudget` TÖVSİYƏ deyil, HƏDDİR. Provayder ondan çox qaytarsa da
   * `MemorySession` kəsir — amma provayderə ötürülür ki, uzaq tərəf lazımsız
   * mətni ümumiyyətlə göndərməsin.
   */
  recall(query: string, scope: string, tokenBudget: number): Promise<RecallResult>

  health(): Promise<MemoryHealth>
}

/**
 * Yaddaşsız iş — default.
 *
 * Testlər və açıq opt-out üçün. `health()` `ok: true` qaytarır: yaddaşın
 * söndürülməsi XƏTA DEYİL, seçimdir — `false` qaytarsaydı UI hər quraşdırmada
 * qırmızı xəbərdarlıq göstərərdi.
 */
export class NullProvider implements MemoryProvider {
  readonly id = 'null'

  async remember(): Promise<MemoryUsage> {
    return { costUsd: 0 }
  }

  async recall(): Promise<RecallResult> {
    return { items: [], costUsd: 0 }
  }

  async health(): Promise<MemoryHealth> {
    return { ok: true, detail: 'yaddaş söndürülüb (NullProvider)' }
  }
}
