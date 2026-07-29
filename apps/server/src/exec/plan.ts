/**
 * Pillə 5 — Plan güclü / icra zəif.
 *
 * Fikir: çoxaddımlı taskda zəif modelin problemi "hardan başlayacağımı
 * bilmirəm" deyil, **ipi ortada itirməkdir** — 2-ci addımda 1-cinin şərtini
 * unudur, 4-cü addımda tamam başqa dizayna keçir. Ona görə güclü modeldən
 * həllin bir parçası yox, BÖLGÜSÜ istənilir: nömrələnmiş addımlar + skelet
 * (imzalar, tip adları, boş gövdələr). İcranı zəif model edir.
 *
 * Araşdırma: repo-səviyyə kod işində güclü modelə BƏRABƏR nəticə, ~40% az
 * xərclə (issue #9).
 *
 * NİYƏ PİLLƏ 4 (İPUCU) BUNU ƏVƏZ EDƏ BİLMİR: ipucu həllin ilk 10–30%-idir.
 * Beş addımlı taskda o, sadəcə 1-ci addımdır — qalan dördü barədə işçiyə HEÇ
 * NƏ demir. Tərsinə də doğrudur: təkaddımlı taskda "plan" bir sətrə yığılır və
 * elə ipucunun özünə çevrilir. Ona görə iki pillə eyni yerdə dayanır və
 * aralarında SIFIR token ilə, `detectMultiStep` ilə seçilir — ikisini ardıcıl
 * qaçırmaq eskalasiya zəncirini 6 icraya çıxarardı (kaskad riski, issue #9).
 *
 * Uzunluq büdcə ilə DEYİL, promptla məhdudlaşdırılır — səbəb `hint.ts`-dəki
 * ilə eynidir (CLAUDE.md qayda 35): CLI runner-ləri `usage`-i yalnız SONDA
 * verir, ona görə sərt `maxOutputTokens` uzun planı kəsməz, sadəcə ödədiyimiz
 * mətni atardıq.
 */

/** İşçiyə ötürülən planın maksimum uzunluğu (simvol). */
export const PLAN_CHAR_LIMIT = 3000

const L = '\\p{L}\\p{N}_'
const LEFT = `(?<![${L}])`
const RIGHT = `(?![${L}])`

/**
 * Sıra bildirən söz qrupları. Hər qrup BİR siqnal sayılır: "əvvəlcə … sonra …
 * sonra …" üç yox, iki fərqli qrupdur — təkrar söz taskı çoxaddımlı etmir.
 *
 * `\b` İŞLƏMİR (CLAUDE.md qayda 20): `əvvəlcə` sözünün sonundakı `ə` ASCII söz
 * simvolu deyil.
 */
const SEQUENCE_MARKERS: readonly { id: string; re: RegExp }[] = [
  {
    id: 'first',
    re: new RegExp(`${LEFT}(?:əvvəlcə|ilkin|birinci|first|firstly)\\p{L}*${RIGHT}`, 'iu'),
  },
  {
    id: 'then',
    re: new RegExp(`${LEFT}(?:sonra|ardınca|then|next|afterwards)\\p{L}*${RIGHT}`, 'iu'),
  },
  {
    id: 'finally',
    re: new RegExp(`${LEFT}(?:nəhayət|axırda|finally|lastly)\\p{L}*${RIGHT}`, 'iu'),
  },
  {
    id: 'step',
    re: new RegExp(`${LEFT}(?:addım|mərhələ|step|phase)\\p{L}*${RIGHT}`, 'iu'),
  },
]

/**
 * Sətir başında duran siyahı işarəsi: `1.`, `2)`, `- `, `* `, `• `.
 *
 * Sətir BAŞI şərtdir: mətnin ortasındakı "v1.2" və ya "10 - 3" siyahı deyil.
 */
const LIST_ITEM = /^[ \t]*(?:\d+[.)]|[-*•])[ \t]+\S/u

/** Bundan az bənd "a və b" cümləsidir, plan deyil. */
const MIN_LIST_ITEMS = 3
/** Bir söz təsadüf ola bilər ("üç gün sonra"); iki fərqli qrup artıq sıradır. */
const MIN_SEQUENCE_MARKERS = 2

export interface PlanShape {
  /** Task addımlara bölünə bilən görünür — Pillə 5 məhz bunun üçündür. */
  multiStep: boolean
  /** İşə düşən siqnallar — qərarın səbəbi kimi log-a və UI-a gedir. */
  signals: string[]
}

/**
 * Task çoxaddımlıdırmı — **sıfır token**, saf funksiya.
 *
 * Məqsəd taskı mükəmməl anlamaq deyil (`classify.ts` ilə eyni fəlsəfə): siqnal
 * zəifdirsə `false` qaytarılır və nərdivan köhnə davranışına (Pillə 4) düşür.
 * Yalan-müsbət burada BAHADIR — təkaddımlı taskda plan istəmək başçının
 * icrasını boş yerə ödəməkdir.
 */
export function detectMultiStep(prompt: string): PlanShape {
  const signals: string[] = []

  const listItems = prompt.split('\n').filter((line) => LIST_ITEM.test(line)).length
  if (listItems >= MIN_LIST_ITEMS) signals.push(`list_items:${listItems}`)

  const markers = SEQUENCE_MARKERS.filter((m) => m.re.test(prompt)).map((m) => m.id)
  if (markers.length >= MIN_SEQUENCE_MARKERS) signals.push(...markers.map((m) => `seq:${m}`))

  return { multiStep: signals.length > 0, signals }
}

export interface PlanRequest {
  task: string
  /** İşçi niyə ilişdi — plan məhz həmin çətinliyi nəzərə almalıdır. */
  reason: string
  /** İşçinin qismən nəticəsi (Pillə 6 müqaviləsindən gəlir). */
  partial?: string
}

/**
 * Başçıya gedən prompt — "bölgünü ver, işi görmə".
 *
 * PİLLƏNİN BÜTÜN QƏNAƏTİ MƏHDUDİYYƏTDƏDİR: başçı addımları doldurmağa
 * başlasa, pillə elə Pillə 7 olar — üstəlik işçinin əlavə icrası da ödənilər,
 * yəni ZƏRƏRƏ işləyər. Ona görə "gövdələri BOŞ saxla" tələbi açıq və təkrar
 * deyilir (eyni yanaşma: `hint.ts`).
 *
 * İşçinin qismən nəticəsi ötürülür, amma "bunu düzəlt" DEYİLMİR — zəif modelin
 * səhvi güclü modeli həmin səhvə bağlaya bilir (anchoring).
 */
export function buildPlanRequestPrompt(input: PlanRequest): string {
  const lines = [
    input.task,
    '',
    '---',
    'QEYD: bu ÇOXADDIMLI taskı daha zəif model həll edə bilmədi.',
    `Onun ilişmə səbəbi: ${input.reason}`,
    '',
    'SƏNDƏN TAM HƏLL İSTƏNMİR. Yalnız PLAN və SKELET yaz:',
    '- taskı 3–7 nömrələnmiş addıma böl; hər addım ən çoxu bir cümlə',
    '- lazım olsa skelet ver: fayl adları, funksiya/tip imzaları, açar sahələr',
    '- GÖVDƏLƏRİ BOŞ saxla (`// ...`) — addımların İCRASINI YAZMA',
    '- qalanını zəif model sənin planın üzərində dolduracaq',
    '- 25 sətirdən çox yazma',
  ]
  if (input.partial !== undefined && input.partial.trim() !== '') {
    lines.push(
      '',
      'Onun qismən nəticəsi aşağıdadır. Faydalıdırsa istifadə et, faydasızdırsa',
      'tamamilə nəzərə alma — səhv ola bilər.',
      '',
      input.partial.slice(0, PLAN_CHAR_LIMIT),
    )
  }
  return lines.join('\n')
}

/**
 * İşçiyə gedən prompt — plan ilə birlikdə EYNİ task.
 *
 * Task mətni dəyişdirilmir, yalnız suffiks əlavə olunur (CLAUDE.md qayda 29):
 * prefiksin toxunulmaz qalması prompt-keşini saxlayır.
 */
export function buildPlannedPrompt(task: string, plan: string): string {
  const trimmed = plan.trim()
  const capped =
    trimmed.length > PLAN_CHAR_LIMIT ? `${trimmed.slice(0, PLAN_CHAR_LIMIT)}…` : trimmed

  return [
    task,
    '',
    '---',
    'PLAN (daha güclü modeldən — yalnız ADDIMLAR və SKELET, icra deyil):',
    capped,
    '',
    'Bu bölgü düzgündür: addımları SIRA İLƏ icra et və hamısını SONA ÇATDIR.',
    'Planı dəyişmə, addım atlama — boş qalan gövdələri sən yaz.',
  ].join('\n')
}
