import { createHash } from 'node:crypto'

/**
 * Pillə 3 — Best-of-N + razılaşma (Agreement-Based Cascading).
 *
 * Fikir: zəif modeli bir neçə dəfə qaçır. Nüsxələr eyni cavabda RAZILAŞIRSA
 * cavab çox güman doğrudur; dağılırsa model bu taskı bilmir və yuxarı pillə
 * lazımdır. Təlim tələb etmir, əlavə model tələb etmir — yalnız təkrar icra.
 *
 * NİYƏ ADAPTİVDİR: sabit N=5 israfdır — tasklarının böyük hissəsi ilk cəhddə
 * həll olunur və qalan 4 icra sırf pul yandırır. Compute-optimal strategiya
 * N-i ÇƏTİNLİYƏ görə artırır (1 → 3 → 5) və naive best-of-N-dən ~4x səmərəlidir.
 *
 * NİYƏ YALNIZ YOXLAMA ƏMRİ OLMAYANDA: determinist yoxlama (`tsc`, testlər)
 * PULSUZ həqiqət mənbəyidir və razılaşmadan güclüdür — üç nüsxə eyni SƏHV
 * cavabda da razılaşa bilər, `tsc` isə səhvi görür. Ona görə yoxlama əmri
 * varsa Pillə 2 qalib gəlir və Pillə 3 ümumiyyətlə işə düşmür (bax `ladder.ts`).
 */

/**
 * Nüsxə sayının ADAPTİV pillələri — KUMULYATİV cəmi göstərir.
 *
 * İlk icra onsuz da edilib (Pillə 2), ona görə `3` ikinci mərhələdə cəmi 2
 * ƏLAVƏ icra deməkdir. Razılaşma olmasa `5`-ə qalxılır (yenə 2 əlavə).
 * Sonra dayanılır: 7-yə qalxmaq başçının bir icrasından baha başa gələ bilər
 * və pillənin bütün mənası itər.
 */
export const AGREEMENT_STEPS: readonly number[] = [3, 5]

/** Çoxluq həddi: 3 → 2, 5 → 3. */
export function majorityThreshold(n: number): number {
  return Math.floor(n / 2) + 1
}

/**
 * Cavabı müqayisə üçün normallaşdırır.
 *
 * Modellər eyni cavabı fərqli BƏZƏKLƏ verir: kod çərçivəsi, sətir sonu, artıq
 * boşluq, sondakı nöqtə. Bunları saxlasaq eyni cavabın iki nüsxəsi "razılaşmır"
 * kimi görünər və hər task boş yerə başçıya qalxardı.
 *
 * Böyük/kiçik hərf QƏSDƏN saxlanılır: kodda `Foo` və `foo` fərqli
 * identifikatorlardır — onları eyniləşdirmək səhv razılaşma yaradardı.
 *
 * MƏHDUDİYYƏT (bilinən): bu, MƏTN normallaşdırmasıdır, AST deyil. Semantik
 * eyni, amma fərqli yazılmış kod (dəyişən adı, sıralama) "razılaşmır" kimi
 * oxunur — yəni səhv istiqamətə, BAHA tərəfə xəta edir: task yuxarı pilləyə
 * qalxır, uydurma razılaşma yaranmır. AST normallaşdırması sonrakı işdir.
 */
export function normalizeAnswer(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    // Kod çərçivəsinin açılış/bağlanış sətirləri — dil etiketi ilə birlikdə.
    .replace(/^[ \t]*```[a-zA-Z0-9+-]*[ \t]*$/gm, '')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}

/** Normallaşdırılmış cavabın açarı. Uzun cavabları müqayisə etməyi ucuzlaşdırır. */
export function answerKey(text: string): string {
  return createHash('sha256').update(normalizeAnswer(text)).digest('hex').slice(0, 16)
}

export interface AgreementSample {
  /** Bu cavabı verən icranın id-si — qalib nüsxə məhz o run olur. */
  runId: string
  answer: string
}

export interface AgreementOutcome {
  /** Neçə nüsxə müqayisə edildi. */
  n: number
  /** Ən çox səs toplayan cavabın səsi. */
  votes: number
  /** Qəbul üçün lazım olan səs. */
  threshold: number
  agreed: boolean
  /**
   * Qalib cavabı verən İLK icra. Razılaşma olmasa da doludur: monoton qayda
   * (`Pillə N pisdirsə əvvəlki saxlanılır`) üçün əlimizdə nə isə qalmalıdır.
   */
  winnerRunId: string
  winnerAnswer: string
}

/**
 * Nüsxələri qruplaşdırır və çoxluq var-yoxdur deyir.
 *
 * BƏRABƏRLİKDƏ İLK QALİB GƏLİR: nüsxələr xronoloji sıradadır və ilk cavab
 * yeganə ödənilmişdir — bərabərlikdə sonrakını seçmək heç nə qazandırmır,
 * amma nəticəni determinist olmayan edərdi (eyni girişdə fərqli çıxış).
 */
export function measureAgreement(samples: readonly AgreementSample[]): AgreementOutcome {
  if (samples.length === 0) {
    throw new Error('measureAgreement: ən azı bir nüsxə lazımdır')
  }

  const groups = new Map<string, { votes: number; first: AgreementSample }>()
  for (const sample of samples) {
    const key = answerKey(sample.answer)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { votes: 1, first: sample })
    else existing.votes += 1
  }

  let best = { votes: 0, first: samples[0] as AgreementSample }
  for (const group of groups.values()) {
    if (group.votes > best.votes) best = group
  }

  const n = samples.length
  const threshold = majorityThreshold(n)
  return {
    n,
    votes: best.votes,
    threshold,
    agreed: best.votes >= threshold,
    winnerRunId: best.first.runId,
    winnerAnswer: best.first.answer,
  }
}
