import { spawnLines } from '../runners/spawn.js'

export interface VerificationResult {
  command: string
  exitCode: number | null
  passed: boolean
  /** stdout + stderr birləşdirilmiş çıxış. */
  output: string
  durationMs: number
}

export interface RunVerificationsOptions {
  cwd: string
  /** Hər əmr üçün ayrıca timeout. Default 5 dəqiqə. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RunVerificationsResult {
  passed: boolean
  results: VerificationResult[]
  /**
   * `true` olduqda `passed` YALNIZ faktiki qaçırılan əmrləri əks etdirir —
   * siyahının hamısı deyil. Çağıran tərəf `passed`-a etibar etməzdən əvvəl
   * bunu yoxlamalıdır: siqnal ləğv olunubsa "heç nə qaçmadı" ilə "hamısı
   * keçdi" fərqli şeylərdir, boş massivdə `every()` isə hər ikisini eyni
   * (`true`) göstərər.
   */
  aborted: boolean
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
/** Modelə geri ötürülən çıxışın hər əmr üçün limiti. */
const FEEDBACK_OUTPUT_LIMIT = 2000

/**
 * Kontekstin yoxlama əmrlərini ardıcıl qaçırır.
 *
 * NİYƏ BU MEXANİZM: araşdırma göstərir ki, kiçik modellər öz-özünü
 * yoxlamaqda pisdir — yoxlama yaddaş-tələbkar işdir. Ona görə yoxlamanı
 * determinist alətlərə veririk: `tsc`, `eslint`, test dəsti. Onlar SIFIR
 * token xərcləyir və heç vaxt "yaxşı görünür" demirlər.
 *
 * TEZ DAYANMA: bir əmr sınırsa qalanları qaçırılmır. `tsc` sınıbsa testləri
 * qaçırmaq həm mənasızdır, həm də vaxt itkisidir.
 *
 * TƏHLÜKƏSİZLİK: əmrlər shell ilə icra olunur, çünki istifadəçi `pnpm test`
 * kimi sərbəst sətirlər yazır. Onlar istifadəçinin öz konfiqurasiyasıdır,
 * modelin uydurduğu mətn DEYİL — model bu siyahını dəyişə bilmir.
 */
export async function runVerifications(
  commands: readonly string[],
  opts: RunVerificationsOptions,
): Promise<RunVerificationsResult> {
  const results: VerificationResult[] = []
  let aborted = false

  for (const command of commands) {
    if (opts.signal?.aborted === true) {
      aborted = true
      break
    }

    const startedAt = Date.now()
    const proc = spawnLines({
      command,
      args: [],
      useShell: true,
      cwd: opts.cwd,
    })

    // Timeout və abort hər ikisi `proc.kill()` çağırır, amma modelə fərqli
    // izahat lazımdır — biri "əmr çox uzun çəkdi", digəri "istifadəçi ləğv
    // etdi". Hansı SƏBƏB əvvəl atəş edirsə o qalib gəlir; əməli olaraq bir-
    // birini istisna edirlər, çünki kill() ikinci çağırışı no-op edir.
    let killReason: 'timeout' | 'abort' | null = null

    const timeout = setTimeout(() => {
      killReason ??= 'timeout'
      void proc.kill()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = (): void => {
      killReason ??= 'abort'
      void proc.kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const stdout: string[] = []
    try {
      for await (const line of proc.lines) stdout.push(line)
    } finally {
      clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const exitCode = await proc.exitCode
    const killed = proc.killed
    const killMessage =
      killReason === 'abort'
        ? 'Əmr ləğv edildiyi üçün dayandırıldı.'
        : 'Əmr vaxt limitinə görə dayandırıldı (timeout).'
    const output = (killed
      ? `${killMessage}\n${stdout.join('\n')}\n${proc.stderrText()}`
      : `${stdout.join('\n')}\n${proc.stderrText()}`
    ).trim()

    results.push({
      command,
      exitCode,
      passed: !killed && exitCode === 0,
      output,
      durationMs: Date.now() - startedAt,
    })

    if (killReason === 'abort') aborted = true

    // Tez dayanma: sınmış yoxlamadan sonra qalanları qaçırmaq mənasızdır.
    const last = results[results.length - 1]
    if (last !== undefined && !last.passed) break
  }

  return { passed: results.every((r) => r.passed), results, aborted }
}

/**
 * Uğursuz yoxlamalardan modelə geri ötürüləcək düzəliş promptu qurur.
 *
 * Çıxış qəsdən kəsilir: bütün `tsc` çıxışını geri ötürmək kontekst şişirdər
 * və token qənaətini məhv edərdi. İlk sətirlər ən informativ olanlardır.
 */
export function buildFeedbackPrompt(results: readonly VerificationResult[]): string {
  const failed = results.filter((r) => !r.passed)
  if (failed.length === 0) return ''

  const blocks = failed.map(
    (r) =>
      `Əmr: ${r.command}\nÇıxış kodu: ${r.exitCode ?? 'yoxdur'}\nÇıxış:\n${r.output.slice(
        0,
        FEEDBACK_OUTPUT_LIMIT,
      )}`,
  )

  return [
    'Əvvəlki cəhdin avtomatik yoxlamadan keçmədi. Aşağıdaki xətaları düzəlt.',
    'Yalnız xətaları düzəlt — başqa dəyişiklik etmə.',
    '',
    ...blocks,
  ].join('\n')
}
