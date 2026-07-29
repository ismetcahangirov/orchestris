/**
 * Kontekst başına paralellik hovuzu.
 *
 * NİYƏ LAZIMDIR: `POST /api/tasks` icranı fon rejimində başladır və HTTP cavabı
 * onu gözləmir. Hovuz olmasa istifadəçinin ard-arda göndərdiyi 20 task eyni anda
 * 20 CLI prosesi açardı — hər biri ~21.7k token prompt döşəməsi ödəyən
 * (CLAUDE.md qayda 1), maşını dondurub bir-birinin fayllarını korlayan proseslər.
 *
 * NİYƏ KONTEKST BAŞINA: limit `contexts.max_parallel`-dədir və mənası "bu iş
 * sahəsində eyni anda neçə agent". İki fərqli kontekst fərqli qovluqlarda işləyir
 * — birinin növbəsi digərini gözlətməməlidir.
 *
 * Növbə **FIFO**-dur: göndərilmə sırası saxlanılır. Sıra pozulsaydı, istifadəçi
 * üçün hansı taskın nə vaxt başlayacağı proqnozlaşdırıla bilməzdi.
 */
interface Lane {
  active: number
  /** Son çağırışın limiti — buraxılış anında neçə gözləyənin oyanacağını təyin edir. */
  limit: number
  waiting: (() => void)[]
}

export class TaskPool {
  private readonly lanes = new Map<string, Lane>()

  /**
   * `fn`-i növbəyə qoyur və slot boşalanda qaçırır.
   *
   * `limit` HƏR ÇAĞIRIŞDA verilir, konstruktorda yox: istifadəçi ayarı icra
   * gedərkən dəyişə bilər. Sonuncu verilən limit `lane`-də saxlanılır, ona görə
   * növbədə gözləyənlər də yeni limitdən faydalanır (növbəti buraxılışda bir
   * yerinə bir neçəsi oyanır) — əks halda ayar dəyişikliyi yalnız serverin
   * yenidən başladılmasından sonra işə düşərdi.
   *
   * SLOT ÖTÜRÜLMƏSİ: icra bitəndə sayğac azaldılıb DƏRHAL, eyni sinxron blokda
   * gözləyən üçün yenidən artırılır. Aralıqda `await` olsaydı, həmin an gələn
   * yeni task boş slot görüb keçər və limit səssizcə bir vahid aşılardı.
   */
  async run<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
    const lane = this.lane(key)
    lane.limit = Math.max(1, Math.floor(limit))

    // `waiting.length === 0` şərti ƏDALƏT üçündür: limit icra gedərkən
    // artırılsa, boş slot NÖVBƏDƏKİLƏRİN haqqıdır — yeni gələnin yox. Onsuz
    // limitin artırılması növbədə çoxdan gözləyəni daha da geri atardı.
    if (lane.active < lane.limit && lane.waiting.length === 0) {
      lane.active += 1
    } else {
      // Oyandıran tərəf sayğacı ARTIQ artırıb — burada təkrar artırmaq limiti aşardı.
      await new Promise<void>((resolve) => lane.waiting.push(resolve))
    }

    try {
      return await fn()
    } finally {
      this.release(key, lane)
    }
  }

  /** Hazırda icra olunan sayı — UI və testlər üçün. */
  activeCount(key: string): number {
    return this.lanes.get(key)?.active ?? 0
  }

  /** Növbədə gözləyən sayı. */
  waitingCount(key: string): number {
    return this.lanes.get(key)?.waiting.length ?? 0
  }

  private release(key: string, lane: Lane): void {
    lane.active -= 1
    while (lane.active < lane.limit && lane.waiting.length > 0) {
      const next = lane.waiting.shift()
      if (next === undefined) break
      lane.active += 1
      next()
    }
    if (lane.active === 0 && lane.waiting.length === 0) this.lanes.delete(key)
  }

  private lane(key: string): Lane {
    const existing = this.lanes.get(key)
    if (existing !== undefined) return existing
    const created: Lane = { active: 0, limit: 1, waiting: [] }
    this.lanes.set(key, created)
    return created
  }
}
