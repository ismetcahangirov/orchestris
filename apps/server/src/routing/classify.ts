/**
 * Pillə 1-in birinci yarısı: **LLM-siz** xüsusiyyət çıxarışı.
 *
 * Bu modul SIFIR token xərcləyir və saf funksiyadır. Məqsəd taskı mükəmməl
 * anlamaq deyil — ucuz və DÜRÜST siqnal verməkdir. Siqnal zəifdirsə
 * `confidence` aşağı olur və router özündən qərar uydurmaq əvəzinə
 * klassifikatora və ya kontekstin default işçisinə keçir.
 */

export const TASK_TYPES = [
  'code',
  'test',
  'explain',
  'translate',
  'summarize',
  'chat',
  'unknown',
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export interface TaskFeatures {
  taskType: TaskType
  /** Fayl sistemi oxumaq/yazmaq lazımdırmı (CLI runner tələb edir). */
  needsFileAccess: boolean
  needsToolUse: boolean
  needsStructuredOutput: boolean
  /** 0..1. Aşağı dəyər "bilmirəm" deməkdir və bu, dürüst cavabdır. */
  confidence: number
  /** İşə düşən siqnallar — UI-da qərarın səbəbi kimi göstərilir. */
  signals: string[]
  /** Promptun simvol sayı — kontekst limiti filtri üçün. */
  promptChars: number
}

/**
 * Söz sərhədləri UNICODE-a həssasdır — `\b` İŞLƏMİR.
 *
 * SƏBƏB (testlə tutulub): `\b` ASCII `\w` üzərində qurulub. `xülasə` sözünün
 * sonundakı `ə` ASCII söz simvolu deyil, ona görə `/\bxülasə\b/` "xülasə et"
 * mətninə UYĞUN GƏLMİR — Azərbaycan dilindəki hər ikinci söz siqnal
 * siyahısından səssizcə düşərdi. `\p{L}` sinfi ilə qurulmuş lookaround-lar
 * həm bunu, həm də şəkilçiləri (`testləri`, `tests`) düzgün tutur.
 */
const L = '\\p{L}\\p{N}_'
const LEFT = `(?<![${L}])`
const RIGHT = `(?![${L}])`
/** Söz kökü + istənilən hərf şəkilçisi (`test` → `testləri`, `tests`). */
const stem = (...words: string[]): RegExp =>
  new RegExp(`${LEFT}(?:${words.join('|')})\\p{L}*${RIGHT}`, 'iu')
/**
 * Fayl adı naxışı. Uzantı siyahısı QƏSDƏN məhduddur: `\w+\.\w+` yazsaydıq
 * `node.js`, `models.dev`, `v1.2` kimi adi mətnlər fayl yolu sayılardı və
 * hər söhbət sualı bahalı CLI-a düşərdi.
 */
const FILE_PATH =
  /(?<![\p{L}\p{N}_])[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|h|cpp|cs|sql|json|ya?ml|toml|md|css|scss|html|sh|ps1)(?![\p{L}\p{N}_])/iu

/** İş qovluğuna istinad: "bu layihədə", "repoda", "in this codebase". */
const REPO_REFERENCE =
  /(?<![\p{L}\p{N}_])(?:bu (?:layihə|repo|proyekt|kod baz)\p{L}*|repoda|layihədə|kod bazasında|this (?:repo|project|codebase)|in the (?:repo|codebase|project))/iu

const CODE_FENCE = /```/

const WRITE_VERB = new RegExp(
  [
    // Azərbaycanca köklər — şəkilçi sərbəstdir (`yazmaq`, `düzəltsin`).
    `${LEFT}(?:yaz|düzəlt|dəyiş|refaktor|təmizlə|yenilə|silin|əlavə|implement|migrasiya)\\p{L}*${RIGHT}`,
    // İngiliscə fellər — şəkilçisiz. `add\\p{L}*` "address"-ə uyğun gələrdi.
    `${LEFT}(?:write|fix|fixes|add|adds|change|update|refactor|create|remove|delete|migrate|rename)${RIGHT}`,
  ].join('|'),
  'iu',
)

const TEST_WORD = stem('test', 'vitest', 'jest', 'pytest', 'snapshot')

const EXPLAIN_VERB = new RegExp(
  [
    `${LEFT}(?:izah|nədir|nə üçün)\\p{L}*${RIGHT}`,
    `${LEFT}necə işlə\\p{L}*${RIGHT}`,
    `${LEFT}(?:explain|explains|describe|describes)${RIGHT}`,
    `${LEFT}(?:what|how|why) (?:is|are|does|do)${RIGHT}`,
  ].join('|'),
  'iu',
)

const TRANSLATE_VERB = stem('tərcümə', 'translate', 'çevir')

const SUMMARIZE_VERB = new RegExp(
  [
    `${LEFT}(?:xülasə|yekunlaş|qısaca|summar)\\p{L}*${RIGHT}`,
    'tl;dr',
  ].join('|'),
  'iu',
)

/** Kod haqqında danışan, amma fayl yolu olmayan promptlar. */
const CODE_WORD = stem(
  'funksiya',
  'sinif',
  'klass',
  'komponent',
  'api',
  'endpoint',
  'regex',
  'sql',
  'interfeys',
  'function',
  'class',
  'component',
  'method',
  'interface',
  'query',
  'bug',
  'xəta',
  'route',
  'import',
)

const STRUCTURED_OUTPUT = new RegExp(
  [
    `${LEFT}(?:json|sxem|schema|yaml|csv)\\p{L}*${RIGHT}`,
    `${LEFT}structured output${RIGHT}`,
  ].join('|'),
  'iu',
)

/** Bundan qısa promptlar "söhbət" sayılır (siqnal yoxdursa). */
const CHAT_MAX_CHARS = 200

export interface ClassifyInput {
  prompt: string
  /** Kontekstin iş qovluğu. TƏK BAŞINA fayl işi siqnalı DEYİL. */
  cwd?: string
}

export function classifyTask(input: ClassifyInput): TaskFeatures {
  const prompt = input.prompt
  const signals: string[] = []

  const hasFilePath = FILE_PATH.test(prompt)
  const hasRepoRef = REPO_REFERENCE.test(prompt)
  const hasFence = CODE_FENCE.test(prompt)
  const hasWriteVerb = WRITE_VERB.test(prompt)
  const hasTestWord = TEST_WORD.test(prompt)
  const hasExplain = EXPLAIN_VERB.test(prompt)
  const hasTranslate = TRANSLATE_VERB.test(prompt)
  const hasSummarize = SUMMARIZE_VERB.test(prompt)
  const hasCodeWord = CODE_WORD.test(prompt)

  if (hasFilePath) signals.push('file_path')
  if (hasRepoRef) signals.push('repo_reference')
  if (hasFence) signals.push('code_fence')
  if (hasWriteVerb) signals.push('write_verb')
  if (hasTestWord) signals.push('test_word')
  if (hasExplain) signals.push('explain_verb')
  if (hasTranslate) signals.push('translate_verb')
  if (hasSummarize) signals.push('summarize_verb')
  if (input.cwd !== undefined) signals.push('has_cwd')

  // Yapışdırılmış kod bloku fayl girişi TƏLƏB ETMİR — istifadəçi kodu onsuz
  // da verib. Bunu qarışdırsaq hər kod sualı ~21.7k token döşəməsi olan
  // CLI-a düşərdi (ölçülmüş, CLAUDE.md qayda 1).
  const needsFileAccess = hasFilePath || hasRepoRef
  const needsToolUse = needsFileAccess
  const needsStructuredOutput = STRUCTURED_OUTPUT.test(prompt)

  const taskType = pickType({
    hasFilePath,
    hasRepoRef,
    hasFence,
    hasWriteVerb,
    hasTestWord,
    hasExplain,
    hasTranslate,
    hasSummarize,
    hasCodeWord,
    length: prompt.length,
  })

  return {
    taskType,
    needsFileAccess,
    needsToolUse,
    needsStructuredOutput,
    confidence: confidenceFor(taskType, signals, needsFileAccess),
    signals,
    promptChars: prompt.length,
  }
}

interface TypeInput {
  hasFilePath: boolean
  hasRepoRef: boolean
  hasFence: boolean
  hasWriteVerb: boolean
  hasTestWord: boolean
  hasExplain: boolean
  hasTranslate: boolean
  hasSummarize: boolean
  hasCodeWord: boolean
  length: number
}

/**
 * SIRA ƏHƏMİYYƏTLİDİR. `test` `code`-dan əvvəl gəlir, çünki "test yaz" eyni
 * zamanda kod tapşırığıdır — daha spesifik tip qazanmalıdır. İzah/tərcümə
 * felləri isə kod siqnallarından SONRA yoxlanılır: "src/a.ts-i düzəlt və nə
 * etdiyini izah et" kod taskıdır, izah deyil.
 */
function pickType(f: TypeInput): TaskType {
  const codeContext = f.hasFilePath || f.hasRepoRef || f.hasFence || f.hasCodeWord

  if (f.hasTestWord && (f.hasWriteVerb || f.hasFilePath)) return 'test'
  if (f.hasWriteVerb && codeContext) return 'code'
  if (f.hasTranslate) return 'translate'
  if (f.hasSummarize) return 'summarize'
  if (f.hasExplain) return 'explain'
  if (f.length > 0 && f.length <= CHAT_MAX_CHARS) return 'chat'
  return 'unknown'
}

/**
 * İnamlılıq siqnalların GÜCÜNDƏN gəlir, sayından yox.
 *
 * `unknown` həmişə aşağıdır: router bunu görüb klassifikatora və ya default
 * işçiyə keçir. Uydurma "əminəm" cavabı vermək qərarı səhv modelə bağlayardı
 * və səhv, təkrarlanan xərcə çevrilərdi.
 */
function confidenceFor(
  taskType: TaskType,
  signals: readonly string[],
  needsFileAccess: boolean,
): number {
  if (taskType === 'unknown') return 0.2

  // Fayl/kod tapşırığı: fayl yolu və ya repo istinadı görünübsə bu, ən güclü
  // siqnaldır — hansı runner-in lazım olduğu birmənalıdır.
  if (needsFileAccess) return 0.9

  const strongVerb =
    signals.includes('translate_verb') ||
    signals.includes('summarize_verb') ||
    signals.includes('explain_verb')
  if (strongVerb) return 0.85

  if (taskType === 'test' || taskType === 'code') return 0.7
  if (taskType === 'chat') return 0.6
  return 0.5
}
