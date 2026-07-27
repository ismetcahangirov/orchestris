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
): Promise<{ passed: boolean; results: VerificationResult[] }> {
  const results: VerificationResult[] = []

  for (const command of commands) {
    if (opts.signal?.aborted === true) break

    const startedAt = Date.now()
    const proc = spawnLines({
      command,
      args: [],
      useShell: true,
      cwd: opts.cwd,
    })

    const timeout = setTimeout(() => {
      void proc.kill()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = (): void => void proc.kill()
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
    const output = killed
      ? `Əmr vaxt limitinə görə dayandırıldı (timeout).\n${stdout.join('\n')}\n${proc.stderrText()}`
      : `${stdout.join('\n')}\n${proc.stderrText()}`.trim()

    results.push({
      command,
      exitCode,
      passed: !killed && exitCode === 0,
      output,
      durationMs: Date.now() - startedAt,
    })

    // Tez dayanma: sınmış yoxlamadan sonra qalanları qaçırmaq mənasızdır.
    if (!results[results.length - 1]?.passed) break
  }

  return { passed: results.every((r) => r.passed), results }
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
