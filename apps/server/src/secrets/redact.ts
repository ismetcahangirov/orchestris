/**
 * API açarlarının log-a, hadisə jurnalına və HTTP cavabına sızmasının
 * qarşısını alır.
 *
 * Niyə lazımdır: provayder xətaları çox vaxt göndərilən sorğunu əks etdirir
 * (`Incorrect API key provided: sk-proj-abc...`). O mətn `classifyErrorText`-dən
 * keçib `error` hadisəsinə, oradan `run_events` cədvəlinə və WebSocket ilə
 * brauzerə gedir. Bir dəfə jurnal a düşən açar orada QALIR — ona görə kəsmə
 * mənbədə, hadisə yaranmazdan ƏVVƏL edilməlidir.
 */

/**
 * Tanınan açar formatları. Sıra əhəmiyyətlidir: daha spesifik prefikslər
 * (`sk-ant-`, `sk-proj-`) ümumi `sk-`-dən ƏVVƏL gəlməlidir, yoxsa ümumi
 * naxış onları qismən yeyər və qalıq mətndə açarın bir hissəsi görünər.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-proj-[A-Za-z0-9_-]{8,}/g, // OpenAI proyekt açarı
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI klassik
  /AIza[A-Za-z0-9_-]{20,}/g, // Google
  /gsk_[A-Za-z0-9_-]{16,}/g, // Groq
  /\bxai-[A-Za-z0-9_-]{16,}/g, // xAI
]

const MASK = '[API-ACARI-KESILDI]'

/**
 * Mətndəki tanınan açar naxışlarını maskalayır.
 *
 * Bu, ikinci müdafiə xəttidir — naxış siyahısı heç vaxt tam ola bilməz.
 * Birinci xətt `redactSecret`-dir: konkret bildiyimiz açarı kəsir.
 */
export function redactApiKeys(text: string): string {
  let out = text
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, MASK)
  }
  return out
}

/**
 * KONKRET açarı mətndən kəsir. Naxış tanımasa da işləyir, ona görə əsas
 * müdafiə xətti budur.
 *
 * Çox qısa "açarlar" gözardı edilir: 8 simvoldan qısa sətir mətnin hər
 * yerində təsadüfən rast gəlinə bilər və onu maskalamaq xəta mesajını
 * oxunmaz edərdi (məs. açar `test` olsaydı, `latest` sözü də kəsilərdi).
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (secret === null || secret === undefined || secret.length < 8) return text
  return text.split(secret).join(MASK)
}

/** Hər iki xətti birlikdə tətbiq edir — xəta mətnləri üçün standart giriş nöqtəsi. */
export function redactAll(text: string, secret?: string | null): string {
  return redactApiKeys(redactSecret(text, secret))
}
