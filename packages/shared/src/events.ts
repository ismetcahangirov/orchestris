import { z } from 'zod'
import { ERROR_CLASSES } from './errors.js'

/**
 * Vahid hadisə axını. Hər Runner (CLI və ya API) çıxışını bu formata
 * çevirir. Router, ledger, WebSocket və UI YALNIZ bunu görür — CLI-a və
 * ya provayderə xas heç bir sahə buradan kənara çıxmır.
 */
export const RunEventSchema = z.discriminatedUnion('t', [
  /**
   * İcranın başlanğıcı. Ən çox BİR DƏFƏ, ilk hadisə kimi.
   *
   * `sessionId` burada verilir, `done`-da gözlənilmir: icra xəta ilə bitsə
   * və ya büdcə limiti onu kəssə, `done` heç vaxt gəlməyəcək — halbuki
   * `--resume` ilə davam etdirmək məhz o hallarda lazımdır.
   *
   * `model` FAKTİKİ işlədilən modeldir. CLI `--fallback-model` səbəbindən
   * istənilən modeldən fərqli model işlədə bilər; qiymət hesablaması bunu
   * bilməlidir.
   */
  z.object({
    t: z.literal('start'),
    sessionId: z.string().optional(),
    model: z.string().optional(),
  }),

  z.object({ t: z.literal('text'), delta: z.string() }),
  z.object({ t: z.literal('think'), delta: z.string() }),

  z.object({
    t: z.literal('tool'),
    id: z.string(),
    name: z.string(),
    /**
     * Alət arqumentləri. `z.record` istifadə olunur, `z.unknown()` YOX.
     *
     * SƏBƏB (təsdiqlənib): zod-da `z.unknown()` açarı OPSİONAL edir —
     * `parse({t:'tool',id,name})` uğurlu olur və `input` açarı heç olmur.
     * Nəticədə UI-da `JSON.stringify(input).slice(...)` TypeError atır və
     * TypeScript bunu tuta bilmir (`JSON.stringify` `string` qaytarır kimi
     * tiplənib).
     *
     * Dəyər JSON-serializable OLMALIDIR: SQLite-a yazılır və WebSocket ilə
     * göndərilir. İçində `BigInt` olsa `JSON.stringify` hub-ı çökdürər.
     */
    input: z.record(z.string(), z.unknown()),
  }),

  z.object({
    t: z.literal('result'),
    id: z.string(),
    ok: z.boolean(),
    /** `ok: true` → alətin çıxışı. `ok: false` → xəta mətni. */
    output: z.string().optional(),
  }),

  /**
   * BÜTÜN İCRA ÜÇÜN KUMULYATİV ANLIQ GÖRÜNTÜ — delta DEYİL.
   *
   * MÜQAVİLƏ (pozulması səssiz pul itkisi deməkdir):
   *  - Runner bunu ən çox BİR DƏFƏ, icranın sonunda emit edir.
   *  - Dəyərlər MÜTLƏQDİR, artımlı deyil.
   *  - İstehlakçı bunları TOPLAMAMALIDIR.
   *
   * Niyə bu qədər sərt: `claude` CLI hər `assistant` hadisəsində yekun
   * `usage` verir — toplamaq ikiqat sayma verər. Əksinə, addım-addım
   * (per-step) emit etmək isə `BudgetGuard`-ı (son-dəyər-qalib semantikası)
   * səssizcə yan keçər: mühafizə yalnız son kiçik addımı görər və heç vaxt
   * işə düşməz. Az saymaq təhlükəli istiqamətdir.
   */
  z.object({
    t: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    /**
     * YOXLUĞU "bilinmir" deməkdir; `0` isə "həqiqətən pulsuz" deməkdir.
     * `codex` xərc bildirmir — orada bu sahə OLMAMALIDIR, `0` yazılmamalıdır,
     * yoxsa büdcə mühafizəsi heç vaxt işə düşməz və qənaət hesabatı yalan olar.
     */
    costUsd: z.number().nonnegative().optional(),
    /**
     * `'subscription'` → xərc abunəlikdən gedir, kartdan real pul çıxmır və
     * `costUsd` yalnız İSTİNAD qiymətidir. UI bunu "$0.0085 xərcləndi" kimi
     * göstərməməlidir. `'real'` → həqiqətən ödənilir.
     */
    billed: z.enum(['real', 'subscription']),
  }),

  z.object({
    t: z.literal('rate_limit'),
    /**
     * Xam CLI dəyəri (məs. `'allowed'`, `'rejected'`). Enum DEYİL, çünki
     * CLI yeni dəyər əlavə edə bilər və o zaman parse sınmamalıdır.
     */
    status: z.string(),
    /**
     * DİQQƏT: bu hadisə NORMAL uğurlu icrada da gəlir (`status: 'allowed'`).
     * Yalnız `blocked === true` olduqda gözləmək lazımdır. Bunu nəzərə
     * almadan `resetsAtUnixSec`-ə qədər yatmaq hər sağlam icrada saatlarla
     * gözləmə deməkdir.
     */
    blocked: z.boolean(),
    limitType: z.string(),
    /** Unix SANİYƏ, millisaniyə DEYİL. Tarixə çevirmək: `v * 1000`. */
    resetsAtUnixSec: z.number().int().optional(),
  }),

  /** İcranın normal bitməsi. Ən çox BİR DƏFƏ, terminal hadisə. */
  z.object({
    t: z.literal('done'),
    sessionId: z.string().optional(),
    /** Xam vendor dəyəri (`'end_turn'`, `'max_tokens'`, ...). */
    stopReason: z.string(),
  }),

  /**
   * `retryable` sahəsi QƏSDƏN yoxdur — o, `class`-ın saf funksiyasıdır.
   * Sahə kimi saxlanılsa iki istehlakçı fərqli qərar verə bilər (biri
   * "təkrar edirəm" göstərir, digəri təslim olur) və sxem heç birini
   * səhv saymaz. İstehlakçı `isRetryable(e.class)` çağırır.
   */
  z.object({
    t: z.literal('error'),
    class: z.enum(ERROR_CLASSES),
    message: z.string(),
    /** Uğursuz icranı `--resume` ilə davam etdirmək üçün. */
    sessionId: z.string().optional(),
  }),
])

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventKind = RunEvent['t']
