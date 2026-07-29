/**
 * Task dekompozisiyası (Faza 4) — kəsişən mexanizm, nərdivanın pilləsi DEYİL.
 *
 * Fikir: zəif model böyük taskı bütöv halda həll edə bilmir, amma onun HƏR
 * PARÇASINI ayrıca həll edə bilir. Başçı BİR DƏFƏ bölgünü yazır, sonra hər
 * alt-task öz Amplifikasiya Nərdivanından keçir — yəni keş, qayda routing,
 * alət yoxlaması və best-of-N alt-task səviyyəsində yenidən işləyir.
 *
 * ```
 * bir böyük task  →  başçı: bölgü        [bir dəfə, ~300 token]
 *                 →  alt-task 1 → nərdivan (zəif model)
 *                 →  alt-task 2 → nərdivan (zəif model)
 *                 →  ...
 * ```
 *
 * ÜÇ QAYDA BU MODULUN BÜTÜN İQTİSADİYYATIDIR:
 *
 * 1. **Dekompozisiya AÇIQ istənilir.** Faydası hələ ölçülməyib, xərci isə
 *    dəqiqdir: bir başçı icrası + N nərdivan dövrəsi. Avtomatik açsaydıq hər
 *    çoxaddımlı task bir başçı icrası ödəyərdi — halbuki eyni hal üçün onsuz
 *    da Pillə 5 (plan) var və o, CƏMİ bir işçi icrası ödəyir. Qapı istifadəçinin
 *    açıq seçimidir (eyni prinsip: yaddaş, CLAUDE.md qayda 50).
 * 2. **Bölgü ən azı İKİ parça verməlidir.** Bir parça bölgü deyil — başçının
 *    icrası ödənilib, əvəzində heç nə alınmayıb. Belə halda mexanizm geri çəkilir
 *    və task adi nərdivandan keçir.
 * 3. **Uzun və ya çox parça RƏDD edilir, KƏSİLMİR.** Yarımçıq kəsilmiş alt-task
 *    mətni yanıldıcıdır və onu icra etmək pulu iki dəfə yandırar: bir dəfə səhv
 *    işə, bir dəfə də düzəlişə (eyni prinsip: qayda 39 — uzun şablon).
 */

/**
 * Bölgü icrasının `runs.ladder_rung` dəyəri — **mənfi, çünki pillə deyil**.
 *
 * `DISTILL_RUNG` (-1) ilə eyni səbəb (qayda 37): 0–7 aralığından nömrə
 * seçsəydik "taskların <20%-i 7-yə çatsın" hədəfi (qayda 31) bölgü icrasını tam
 * başçı icrası kimi sayardı, `byRung` bölgüsü isə orkestrasiya xərcini taskın
 * öz həll xərcinin içində gizlədərdi.
 */
export const DECOMPOSE_RUNG = -2

/**
 * Bölgüdən çıxa biləcək ən çox alt-task.
 *
 * Hər alt-task tam nərdivan dövrəsidir — yəni ən azı bir icra, ~21.7k token
 * prompt döşəməsi ilə (qayda 1). Həddi yuxarı qaldırmaq bir taskı onlarla
 * icraya çevirməyin ən asan yoludur.
 */
export const MAX_SUBTASKS = 6

/**
 * Bölgü sayılması üçün lazım olan ən az parça.
 *
 * `1` qəbul etsəydik başçının icrası ödənilər, task isə eyni qalardı — yəni
 * mexanizm təmiz zərər olardı.
 */
export const MIN_SUBTASKS = 2

/** Bir alt-task mətninin ən çox uzunluğu (simvol). */
export const SUBTASK_CHAR_LIMIT = 600

/** Başçıya göstərilən task mətninin limiti — bölgü istəyi promptu şişirtməsin. */
const TASK_EXCERPT_LIMIT = 4000

/**
 * Başçıya gedən prompt — "taskı BÖL, HƏLL ETMƏ".
 *
 * MEXANİZMİN BÜTÜN QƏNAƏTİ MƏHDUDİYYƏTDƏDİR (eyni yanaşma: `plan.ts`): başçı
 * parçaları həll etməyə başlasa, bölgü elə Pillə 7 olar — üstəlik alt-taskların
 * icraları da ödənilər, yəni mexanizm ZƏRƏRƏ işləyər. Ona görə "həlli YAZMA"
 * tələbi açıq və təkrar deyilir.
 *
 * Uzunluq büdcə ilə DEYİL, promptla məhdudlaşdırılır (qayda 35): CLI
 * runner-ləri `usage`-i yalnız SONDA verir, ona görə sərt `maxOutputTokens`
 * uzun cavabı kəsməz — sadəcə ödədiyimiz mətni atardıq.
 */
export function buildDecomposeRequestPrompt(task: string): string {
  return [
    'AŞAĞIDAKI TASKI HƏLL ETMƏ. Yalnız onu müstəqil icra oluna bilən',
    'alt-tasklara BÖL.',
    '',
    'TASK:',
    task.slice(0, TASK_EXCERPT_LIMIT),
    '',
    '---',
    'QAYDALAR:',
    `- ${MIN_SUBTASKS}–${MAX_SUBTASKS} alt-task yaz; hər biri AYRICA icra olunacaq`,
    '- alt-tasklar SIRA İLƏ icra olunur: sonrakı əvvəlkinin nəticəsi üzərində işləyir',
    '- hər alt-task öz-özünə anlaşılan olmalıdır (kontekst daşıyır, "yuxarıdakı" demir)',
    `- hər alt-task ən çoxu ${SUBTASK_CHAR_LIMIT} simvol`,
    '- HƏLLİ YAZMA: nə kod, nə cavab, nə izah — yalnız NƏ EDİLMƏLİ olduğu',
    '- taskı bölmək mənasızdırsa (təkaddımlıdır) bir elementli siyahı qaytar',
    '',
    'CAVAB OLARAQ YALNIZ BU JSON-U QAYTAR, başqa heç nə:',
    '{"subtasks": ["birinci alt-task", "ikinci alt-task"]}',
  ].join('\n')
}

export interface Decomposition {
  subtasks: string[]
}

/** ```json ... ``` və ya ``` ... ``` çərçivəsini soyur. */
function stripCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim())
  return fence?.[1]?.trim() ?? text.trim()
}

/**
 * Başçının cavabını bölgüyə çevirir, və ya `null`.
 *
 * SƏRT PARSE QƏSDƏNDİR (qayda 28 ilə eyni prinsip): JSON cavabın BÜTÜNÜ
 * olmalıdır (ən çoxu bir kod çərçivəsi içində). "Cavabın içində belə bir JSON
 * keçir" qaydası bu sistemin ÖZ SƏNƏDİNİ izah edən hər taskı bölünmüş kimi
 * oxuyardı — model həmin JSON-u nümunə kimi sitat gətirir.
 *
 * `null` TƏHLÜKƏSİZ cavabdır: çağıran adi nərdivana düşür və task normal həll
 * olunur. Yəni səhv parse nəticəni İTİRMİR, yalnız bölgünü ləğv edir.
 */
export function parseDecomposition(answer: string): Decomposition | null {
  const body = stripCodeFence(answer)
  if (!body.startsWith('{') || !body.endsWith('}')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = (parsed as Record<string, unknown>)['subtasks']
  if (!Array.isArray(raw)) return null

  const subtasks: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const text = item.trim()
    if (text === '') return null
    // KƏSMİRİK, RƏDD EDİRİK (yuxarıdakı 3-cü qayda): yarımçıq alt-task mətni
    // icra olunanda pul iki dəfə yanar — səhv işə və sonra düzəlişə.
    if (text.length > SUBTASK_CHAR_LIMIT) return null
    subtasks.push(text)
  }

  // Bir parça bölgü deyil; sıfır parça isə ümumiyyətlə cavab deyil. Hər iki
  // halda çağıran adi nərdivana düşür.
  if (subtasks.length < MIN_SUBTASKS) return null
  if (subtasks.length > MAX_SUBTASKS) return null

  return { subtasks }
}

export interface DecomposeGate {
  /** Kontekstin amplifikasiya profili. */
  profile: string
  /** İstifadəçi `POST /api/tasks` gövdəsində açıq şəkildə istədimi. */
  requested: boolean
  /** Başçını təyin edə biləcək router varmı (əl ilə seçimdə yoxdur). */
  hasRouter: boolean
}

export interface DecomposeVerdict {
  decompose: boolean
  /** Niyə — log-a və testə gedir; qərar səbəbsiz qalmasın. */
  reason: string
}

/**
 * Task bölünsünmü — **sıfır token** ilə verilən qərar.
 *
 * `boss-only` QƏSDƏN kənardadır: o profil baseline ölçməsidir (qayda 25) və
 * oraya bölgü qatmaq ölçünün özünü korlayardı — bir task birdən N task olardı
 * və "proqnoz == real" müqayisəsi mənasız qalardı.
 */
export function shouldDecompose(gate: DecomposeGate): DecomposeVerdict {
  if (!gate.requested) {
    return { decompose: false, reason: 'dekompozisiya istənilməyib' }
  }
  if (gate.profile === 'boss-only') {
    return {
      decompose: false,
      reason: 'boss-only profili: baseline ölçməsi korlanmamalıdır',
    }
  }
  if (!gate.hasRouter) {
    return { decompose: false, reason: 'başçı təyin edilə bilmir (əl ilə seçim)' }
  }
  return { decompose: true, reason: 'istifadəçi dekompozisiya istədi' }
}
