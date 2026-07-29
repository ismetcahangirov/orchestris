import { createHash } from 'node:crypto'

/**
 * Prompt distilləsi — kəsişən mexanizm, nərdivanın pilləsi DEYİL.
 *
 * Fikir: başçı bir task tipi üçün BİR DƏFƏ yüksək keyfiyyətli işçi promptu +
 * qəbul rubrikası yazır; həmin tipdən gələn bütün sonrakı tasklar onu SIFIR
 * əlavə başçı tokeni ilə işlədir.
 *
 * ```
 * İlk dəfə:  başçı → işçi promptu + rubrika    [bir dəfə, ~800 token]
 * Sonra:     zəif model onu işlədir            [başçı: 0 token]
 * ```
 *
 * Bu, layihənin əsas fərziyyəsinin ən ucuz formasıdır: güclü modelin BİLİYİ
 * bir dəfə mətnə çevrilir, sonra sonsuz dəfə pulsuz təkrar istifadə olunur.
 *
 * ÜÇ QAYDA BU MODULUN BÜTÜN İQTİSADİYYATIDIR:
 *
 * 1. **Şablon yalnız TƏKRARLANAN tipə yazılır.** Bir boss icrası (~800 token)
 *    yalnız çox dəfə istifadə olunanda özünü ödəyir. Ona görə qapı ölçmə
 *    tələb edir: bu tipdə ƏN AZI iki task başçının köməyinə möhtac olmalıdır.
 * 2. **Uzun şablon qadağandır.** Şablon hər gələcək icrada giriş tokeni kimi
 *    ödənilir — yəni BİR DƏFƏLİK xərci DAİMİ vergiyə çevirir. Həddi aşan
 *    şablon saxlanılmır: bir icranı itirmək daimi vergidən ucuzdur.
 * 3. **`unknown` tipə şablon yazılmır.** O, "bilmirəm"in adıdır (`classify.ts`)
 *    — ora yazılan mətn təsnif oluna bilməyən HƏR taska yapışardı.
 */

/**
 * Distillə icrasının `runs.ladder_rung` dəyəri — **mənfi, çünki pillə deyil**.
 *
 * 0–7 aralığında bir rəqəm seçsəydik iki ölçmə birdən yalan danışardı:
 * "taskların <20%-i 7-yə çatsın" hədəfi (qayda 31) distillə icralarını tam
 * başçı icrası kimi sayardı, `byRung` bölgüsü isə bir dəfəlik investisiyanı
 * taskın öz həll xərcinin içində gizlədərdi.
 */
export const DISTILL_RUNG = -1

/**
 * Şablon yazılmazdan əvvəl bu tipdə neçə task başçının köməyinə möhtac
 * qalmalıdır.
 *
 * `1` yazsaydıq hər yeni tip ilk ilişmədə əlavə bir başçı icrası ödəyərdi —
 * halbuki o task bir dəfəlik ola bilər və şablon heç vaxt işlədilməzdi. `2`
 * "təsadüf deyil, təkrarlanır" deməkdir və qapının ən ucuz sübutudur.
 */
export const DISTILL_MIN_ASSISTED_TASKS = 2

/** Saxlanılan şablonun (prompt + rubrika) maksimum uzunluğu — simvol. */
export const TEMPLATE_CHAR_LIMIT = 1500

const WORKER_HEADER = '### İŞÇİ PROMPTU'
const RUBRIC_HEADER = '### RUBRİKA'

export interface DistillRequest {
  /** `classify.ts` → `TaskType`. `unknown` bura ÇATMIR (qapıda kəsilir). */
  taskType: string
  /** Bu tipdən REAL bir task — nümunə kimi verilir, HƏLL EDİLMƏK üçün yox. */
  examplePrompt: string
  /** İşçi həmin taskda niyə ilişdi — şablon məhz o boşluğu qapamalıdır. */
  reason: string
}

/**
 * Başçıya gedən prompt — "bu TASKI həll etmə, bu TİP üçün təlimat yaz".
 *
 * Nümunə task QƏSDƏN daxil edilir (başçı boşluqda təlimat yaza bilməz), amma
 * "bunu həll et" DEYİLMİR: şablon bir taska deyil, TİPƏ aiddir. Nümunənin
 * həlli buraya düşsə, şablon növbəti taskda faydasız (hətta yanıldıcı) olardı.
 *
 * Uzunluq tələbi prompt-dadır, büdcədə yox — səbəb `hint.ts` ilə eynidir
 * (CLAUDE.md qayda 35): CLI runner-ləri `usage`-i yalnız SONDA verir, ona görə
 * sərt `maxOutputTokens` uzun mətni kəsməz, sadəcə ödədiyimizi atardı.
 */
export function buildDistillRequestPrompt(input: DistillRequest): string {
  return [
    `Aşağıda "${input.taskType}" tipli bir task nümunəsi var. Daha zəif model onu`,
    'həll edə bilmədi.',
    '',
    'NÜMUNƏ TASK (HƏLL ETMƏ — yalnız tipi başa düşmək üçündür):',
    input.examplePrompt.slice(0, TEMPLATE_CHAR_LIMIT),
    '',
    `İşçinin ilişmə səbəbi: ${input.reason}`,
    '',
    '---',
    `SƏNDƏN BU TASKIN HƏLLİ İSTƏNMİR. Bundan sonra gələn BÜTÜN "${input.taskType}"`,
    'tipli tasklarda zəif modelə veriləcək TƏKRAR İSTİFADƏ OLUNAN təlimat yaz:',
    '',
    `${WORKER_HEADER}`,
    '- zəif modelin bu tipdə HƏMİŞƏ etməli olduğu addımlar və diqqət nöqtələri',
    '- bu nümunəyə xas heç nə yazma: fayl adı, dəyişən adı, konkret cavab YOX',
    '- 12 sətirdən çox yazma',
    '',
    `${RUBRIC_HEADER}`,
    '- cavabın ödəməli olduğu 3–5 yoxlanıla bilən şərt, hərəsi bir sətir',
    '',
    'Yalnız bu iki bölməni yaz, başqa heç nə.',
  ].join('\n')
}

export interface DistilledTemplate {
  workerPrompt: string
  rubric: string
}

/**
 * Başçının cavabını şablona çevirir, və ya `null`.
 *
 * SƏRT PARSE QƏSDƏNDİR (eyni prinsip: qayda 28 — eskalasiya siqnalı). Şablon
 * bir dəfə yazılıb SONSUZ dəfə işlədilir: səhv parse olunmuş mətn hər gələcək
 * icraya yapışar və zərəri bir taskla məhdudlaşmaz. Ona görə hər iki başlıq
 * mütləqdir və hədd aşılanda şablon SAXLANILMIR.
 */
export function parseTemplate(answer: string): DistilledTemplate | null {
  const workerAt = answer.indexOf(WORKER_HEADER)
  const rubricAt = answer.indexOf(RUBRIC_HEADER)
  if (workerAt === -1 || rubricAt === -1 || rubricAt < workerAt) return null

  const workerPrompt = answer.slice(workerAt + WORKER_HEADER.length, rubricAt).trim()
  const rubric = answer
    .slice(rubricAt + RUBRIC_HEADER.length)
    // Cavab kod çərçivəsinə salınıbsa bağlayıcı ``` sonda qalır.
    .replace(/```\s*$/, '')
    .trim()

  if (workerPrompt === '' || rubric === '') return null
  // Hədd: uzun şablon bir dəfəlik xərci daimi vergiyə çevirir (yuxarıdakı 2-ci
  // qayda). Kəsmək OLMAZ — yarımçıq təlimat yanıldıcıdır və o da sonsuz dəfə
  // təkrar oxunar.
  if (workerPrompt.length + rubric.length > TEMPLATE_CHAR_LIMIT) return null

  return { workerPrompt, rubric }
}

/**
 * Şablonun kimliyi — MƏZMUN hash-i.
 *
 * Keş açarı (`cache-key.ts`) bundan asılıdır: şablon dəyişəndə işçinin promptu
 * dəyişir, yəni köhnə keş girişi artıq həmin sualın cavabı deyil. Ardıcıl
 * nömrə işlətsəydik eyni məzmunun yenidən yazılışı bütün keşi əbəs yerə
 * sındırardı.
 */
export function templateId(template: DistilledTemplate): string {
  return createHash('sha256')
    .update('orchestris-template-v1\0')
    .update(template.workerPrompt)
    .update('\0')
    .update(template.rubric)
    .digest('hex')
    .slice(0, 32)
}

/**
 * İşçiyə gedən suffiks.
 *
 * Task mətninin ÖNÜNƏ heç nə qoyulmur (CLAUDE.md qayda 29): `claude` CLI-nın
 * prompt prefiksini dəyişmək Anthropic keşini sındırır və eyni taskı 5x
 * bahalaşdırır. Şablon suffiksdir, ona görə prefiks toxunulmaz qalır.
 *
 * Rubrika işçiyə QƏBUL ŞƏRTİ kimi verilir, öz-özünü yoxlama tapşırığı kimi
 * yox: kiçik modellər öz cavabını yoxlamaqda pisdir və həqiqət mənbəyi yenə
 * Pillə 2-nin determinist alətləridir. Rubrika sadəcə hədəfi konkretləşdirir.
 */
export function buildTemplatedPrompt(
  task: string,
  template: DistilledTemplate,
): string {
  return [
    task,
    '',
    '---',
    'İŞ ÜSULU (bu tip tasklar üçün əvvəlcədən hazırlanmış təlimat):',
    template.workerPrompt,
    '',
    'CAVAB BU ŞƏRTLƏRİ ÖDƏMƏLİDİR:',
    template.rubric,
  ].join('\n')
}

export interface DistillGate {
  /** Kontekstin amplifikasiya profili. */
  profile: string
  taskType: string
  /** Bu tip üçün şablon ARTIQ var. */
  hasTemplate: boolean
  /** Bu tipdə başçının köməyinə möhtac qalan taskların sayı. */
  assistedTasks: number
}

export interface DistillVerdict {
  distill: boolean
  /** Niyə — log-a və testə gedir; qərar səbəbsiz qalmasın. */
  reason: string
}

/**
 * Şablon yazılsınmı — **sıfır token** ilə verilən qərar.
 *
 * `boss-only` QƏSDƏN kənardadır: o profil baseline ölçməsi üçündür (qayda 25)
 * və oraya əlavə bir başçı icrası qatmaq ölçünün özünü korlayardı — sonra
 * "proqnoz == real" müqayisəsi mənasız olardı.
 */
export function shouldDistill(gate: DistillGate): DistillVerdict {
  if (gate.profile === 'boss-only') {
    return { distill: false, reason: 'boss-only profili: baseline ölçməsi korlanmamalıdır' }
  }
  if (gate.taskType === 'unknown') {
    return { distill: false, reason: 'task tipi bilinmir — şablon hər taska yapışardı' }
  }
  if (gate.hasTemplate) {
    return { distill: false, reason: 'bu tip üçün şablon artıq var' }
  }
  if (gate.assistedTasks < DISTILL_MIN_ASSISTED_TASKS) {
    return {
      distill: false,
      reason: `bu tipdə yalnız ${gate.assistedTasks} task başçıya möhtac oldu (lazım: ${DISTILL_MIN_ASSISTED_TASKS})`,
    }
  }
  return {
    distill: true,
    reason: `bu tipdə ${gate.assistedTasks} task başçıya möhtac oldu — şablon özünü ödəyəcək`,
  }
}
