import {
  STEP_OUTPUT_CHAR_LIMIT,
  type StepCondition,
  type WorkflowStep,
} from '@orchestris/shared'

/**
 * Workflow zəncirinin SAF hissəsi — **sıfır token**.
 *
 * Zəncirin bütün "ağlı" buradadır: dəyişən əvəzlənməsi və şərt qiymətləndirmə.
 * Hər ikisi determinist funksiyadır və heç bir model çağırmır.
 *
 * NİYƏ MODEL DEYİL: "bu cavab yaxşıdırmı, növbəti addıma keçək?" sualını modelə
 * vermək ən asan yol olardı, amma hər addımda ƏLAVƏ icra ödəyərdi — yəni zəncir
 * uzandıqca orkestrasiya xərci taskların öz xərcini üstələyərdi. Determinist
 * şərt eyni işi 0 token ilə görür (eyni fəlsəfə: Pillə 2 — pulsuz həqiqət
 * mənbəyi razılaşmadan güclüdür).
 */

/** Bir addımın icra nəticəsi — şərtlər və dəyişənlər buna baxır. */
export interface StepResult {
  stepId: string
  status: 'succeeded' | 'failed' | 'skipped' | 'budget_exceeded'
  output: string
}

/**
 * Dəyişənləri əvəzləyir: `{{previous}}` və `{{step:<id>}}`.
 *
 * TANINMAYAN DƏYİŞƏN BOŞ SƏTİRLƏ əvəzlənir, olduğu kimi QALMIR. Səbəb: `{{step:x}}`
 * mətni modelə çatsaydı, model onu təlimat kimi oxuyub uydurma məzmun yazardı —
 * yəni səhv addım id-si səssiz və yanıldıcı nəticə verərdi. Boş sətir isə
 * nəticədə dərhal görünür.
 *
 * Əvəzlənmə BİR keçidlidir: əvəzlənən mətnin içindəki `{{…}}` yenidən
 * emal OLUNMUR. Model çıxışı `{{step:gizli}}` yaza bilər — ikinci keçid ona
 * başqa addımın nəticəsini oxumaq imkanı verərdi (eyni prinsip: qayda 45,
 * model çıxışı ETİBARSIZ mətndir).
 */
export function substituteVariables(
  template: string,
  ctx: { previous: string; byStepId: ReadonlyMap<string, string> },
): string {
  return template.replace(/\{\{\s*(previous|step:[^}\s]+)\s*\}\}/g, (_match, name: string) => {
    if (name === 'previous') return ctx.previous
    return ctx.byStepId.get(name.slice('step:'.length)) ?? ''
  })
}

/**
 * Şərti qiymətləndirir — **sıfır token**.
 *
 * İSTİNAD OLUNAN ADDIM TAPILMASA `false` qaytarılır. "Tapılmadı" halını `true`
 * saysaydıq, səhv yazılmış (və ya sonradan silinmiş) addım id-si şərti HƏMİŞƏ
 * ödədərdi — yəni budaqlanma səssizcə söndürülərdi və zəncir hər addımı
 * qaçırardı. `false` isə addımı atlayır və bu, `detail`-də görünür.
 */
export function evaluateCondition(
  condition: StepCondition,
  ctx: { previous: StepResult | undefined; byStepId: ReadonlyMap<string, StepResult> },
): { pass: boolean; reason: string } {
  const target =
    condition.from === 'previous' ? ctx.previous : ctx.byStepId.get(condition.from)

  if (target === undefined) {
    return {
      pass: false,
      reason:
        condition.from === 'previous'
          ? 'əvvəlki icra olunmuş addım yoxdur'
          : `addım tapılmadı: ${condition.from}`,
    }
  }

  const raw = rawTest(condition, target)
  const pass = condition.negate === true ? !raw : raw
  return {
    pass,
    reason: `${condition.from}.${condition.test}${
      condition.value !== undefined ? `("${condition.value}")` : ''
    } → ${raw}${condition.negate === true ? ' (tərs)' : ''}`,
  }
}

/**
 * `contains` müqayisəsi üçün mətn normallaşdırması.
 *
 * ÖLÇÜLMÜŞ SƏBƏB (qayda 20 ilə eyni ailədən): sadə `toLowerCase()` Azərbaycan
 * mətnində SƏSSİZCƏ sınır, çünki nöqtəli/nöqtəsiz `i` cütü geri qayıtmır:
 *
 * ```
 * 'QAYDASINDA'.toLowerCase()  →  'qaydasinda'   (I → i, NÖQTƏLİ)
 * 'qaydasında'                →  'qaydasında'   (ı, NÖQTƏSİZ)   ← uyğun GƏLMİR
 * 'İSTİFADƏ'.toLowerCase()    →  'i̇sti̇fadə'      (i + U+0307 birləşən nöqtə)
 * ```
 *
 * `toLocaleLowerCase('az')` bunu Azərbaycan mətnində düzəldər, amma İNGİLİS
 * mətnini sındırardı (`API` → `apı`) — halbuki model çıxışı hər ikisini, üstəlik
 * kodu da ehtiva edir. Ona görə hər iki tərəf VAHİD forma-ya yığılır: birləşən
 * nöqtə atılır, `ı` isə `i`-yə çevrilir.
 *
 * QİYMƏTİ: `contains` artıq `ı` və `i`-ni fərqləndirmir ("sinif" mətni "sınıf"
 * axtarışına da uyğun gəlir). Bu, GENİŞLƏNMƏDİR və şüurlu seçimdir — səssizcə
 * UYĞUN GƏLMƏMƏK istifadəçi üçün qat-qat pisdir: budaq işə düşmür və səbəbi
 * heç yerdə görünmür.
 */
function foldForSearch(text: string): string {
  return text
    .toLowerCase()
    // U+0307 — `İ`.toLowerCase() məhz `i` + bu simvolu verir.
    .replace(/̇/gu, '')
    // U+0131 (`ı`) — həm mətndəki hərf, həm `I`.toLowerCase()-in cütü.
    .replace(/ı/gu, 'i')
}

function rawTest(condition: StepCondition, target: StepResult): boolean {
  switch (condition.test) {
    case 'succeeded':
      return target.status === 'succeeded'
    case 'failed':
      // `skipped` UĞURSUZLUQ DEYİL: addım icra olunmayıb, sınmayıb. İkisini
      // qarışdırsaq "sınıqda təmir et" budağı atlanan addımdan sonra da işə
      // düşərdi və heç nə olmadığı halda təmir taskı ödəyərdik.
      return target.status === 'failed' || target.status === 'budget_exceeded'
    case 'empty':
      return target.output.trim() === ''
    case 'contains':
      if (condition.value === undefined) return false
      return foldForSearch(target.output).includes(foldForSearch(condition.value))
  }
}

/**
 * Addımın çıxışını saxlanılan formaya salır.
 *
 * KƏSİLİR, RƏDD EDİLMİR (şablonun əksi — qayda 39): şablon GÖSTƏRİŞDİR və
 * yarımçıq göstəriş yanıldıcıdır, addım çıxışı isə MƏLUMATDIR — az fayda verir,
 * yanlış göstəriş vermir. Üstəlik tam mətn taskın öz jurnalında QALIR, yəni heç
 * nə itmir; kəsilmə isə `output_truncated` ilə açıq işarələnir.
 */
export function capOutput(text: string): { output: string; truncated: boolean } {
  if (text.length <= STEP_OUTPUT_CHAR_LIMIT) return { output: text, truncated: false }
  return { output: `${text.slice(0, STEP_OUTPUT_CHAR_LIMIT)}…`, truncated: true }
}

/** Addımın insan üçün qısa adı — jurnal və UI mesajlarında. */
export function describeStep(step: WorkflowStep, index: number): string {
  return `#${index + 1} ${step.id} (${step.kind})`
}
