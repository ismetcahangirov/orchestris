import { redactAll } from '../secrets/redact.js'

/**
 * Zəncirin xarici API addımı (Faza 4) — **fail-closed**.
 *
 * BU MODULUN BÜTÜN MƏNASI QADAĞADIR, İMKAN DEYİL. Zəncir taskın nəticəsini —
 * yəni istifadəçinin kodunu, sənədini, bəzən sirrini — XARİCİ ünvana göndərir.
 * Ona görə default davranış "heç nə göndərmə"dir və icazə YALNIZ açıq env
 * dəyişəni ilə verilir (eyni prinsip: yaddaş provayderi, qayda 50).
 *
 * ```
 * ORCHESTRIS_WORKFLOW_HTTP_ALLOW=api.example.com,hooks.slack.com
 * ```
 *
 * Siyahı boşdursa HƏR HTTP addımı səhv ilə dayanır. "Siyahı boşdursa hamısına
 * icazə ver" (fail-open) yazsaydıq, dəyişəni təyin etməyi unudan istifadəçi ən
 * geniş icazəni SƏSSİZCƏ alardı — və bunu yalnız məlumat kənara çıxandan sonra
 * bilərdi.
 */

const ALLOW_ENV = 'ORCHESTRIS_WORKFLOW_HTTP_ALLOW'

/** Cavabın oxunan hissəsinin limiti — nəhəng cavab SQLite sətrini şişirtməməlidir. */
const RESPONSE_CHAR_LIMIT = 20_000

/** Bir sorğunun vaxt limiti. Zəncir bir asılı endpoint-də əbədi qala bilməz. */
const REQUEST_TIMEOUT_MS = 30_000

export interface HttpAllowList {
  hosts: readonly string[]
}

/**
 * Ağ siyahını env-dən oxuyur.
 *
 * Host müqayisəsi TAM UYĞUNLUQdur, prefiks/suffiks deyil: `example.com`
 * yazılıbsa `evil-example.com` və `example.com.attacker.net` UYĞUN GƏLMİR.
 * Suffiks müqayisəsi (`endsWith`) ən çox rast gəlinən səhvdir və məhz bu iki
 * halda sındırır.
 */
export function readHttpAllowList(env: NodeJS.ProcessEnv = process.env): HttpAllowList {
  const raw = env[ALLOW_ENV] ?? ''
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '')
  return { hosts }
}

export interface UrlVerdict {
  ok: boolean
  /** Səbəb — istifadəçi nə edəcəyini bilməlidir (env-i doldurmaq). */
  error?: string
}

/**
 * URL icazəlidirmi — **sıfır token**, saf funksiya.
 *
 * Üç yoxlama, hər biri ayrıca bir sızma yolunu bağlayır:
 *  - **sxem**: yalnız `http(s)`. `file:`, `ftp:` və s. lokal fayl oxumaq üçün
 *    yoldur.
 *  - **istifadəçi məlumatı**: `https://user:parol@host` formasında URL sirri
 *    zəncir tərifinə (yəni SQLite-a və UI-a) yazdırardı — qayda 13.
 *  - **host**: ağ siyahıda TAM uyğunluq.
 */
export function checkUrl(url: string, allow: HttpAllowList): UrlVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'URL oxunmadı' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Yalnız http(s) dəstəklənir: ${parsed.protocol}` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      error: 'URL-də istifadəçi adı/parol ola bilməz — sirr zəncir tərifinə yazılardı',
    }
  }
  if (allow.hosts.length === 0) {
    return {
      ok: false,
      error: `Xarici sorğular söndürülüb — icazə üçün ${ALLOW_ENV} təyin edin`,
    }
  }
  if (!allow.hosts.includes(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      error: `Host ağ siyahıda deyil: ${parsed.hostname} (${ALLOW_ENV})`,
    }
  }
  return { ok: true }
}

export interface HttpStepResult {
  ok: boolean
  /** Cavab mətni (kəsilmiş) və ya xəta mətni — növbəti addımın girişi olur. */
  output: string
  status?: number
}

/**
 * Sorğunu icra edir.
 *
 * Cavab `redactAll`-dan keçir (qayda 18): endpoint göndərilən məzmunu — və
 * bəzən konfiqurasiyanı — cavabda əks etdirə bilir, o mətn isə `workflow_step_runs`-a
 * yazılır və oradan UI-a gedir.
 *
 * Xəta ATILMIR, `ok: false` qaytarılır: zəncirin növbəti addımı `when` şərti ilə
 * məhz bu hala reaksiya verə bilməlidir ("sorğu sındısa xəbər ver"). Atılan xəta
 * bütün zənciri dayandırardı və budaqlanmanı mənasız edərdi.
 */
export async function executeHttpStep(
  input: { method: 'GET' | 'POST'; url: string; body?: string },
  deps: { allow: HttpAllowList; fetchImpl?: typeof fetch },
): Promise<HttpStepResult> {
  const verdict = checkUrl(input.url, deps.allow)
  if (!verdict.ok) return { ok: false, output: verdict.error ?? 'URL qadağandır' }

  const doFetch = deps.fetchImpl ?? fetch
  try {
    const res = await doFetch(input.url, {
      method: input.method,
      // Başlıq İSTİFADƏÇİDƏN alınmır (bax `HttpStep` şərhi): `Authorization`
      // yazmaq imkanı açarı zəncir tərifinə yazdırardı.
      ...(input.method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: input.body ?? '',
          }
        : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const text = await res.text()
    const capped =
      text.length > RESPONSE_CHAR_LIMIT ? `${text.slice(0, RESPONSE_CHAR_LIMIT)}…` : text
    return {
      ok: res.ok,
      status: res.status,
      output: redactAll(capped),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, output: redactAll(`Sorğu sındı: ${message}`) }
  }
}
