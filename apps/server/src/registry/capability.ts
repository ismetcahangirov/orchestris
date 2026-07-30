/**
 * "Bu model task icra edə bilər?" — model seçicisinin süzgəci (issue #47).
 *
 * Kataloq embedding/şəkil/audio modellərini adi çat modelləri ilə YANAŞI
 * saxlayır. Onlar başçı və ya işçi ola bilməz: seçilsələr task icra anında
 * sınır.
 *
 * ÖLÇÜLMÜŞ (models.dev keşi, 2026-07-30, 175 provayder / 5892 model) — issue-də
 * təklif olunan hər iki sadə siqnal TƏKBAŞINA YANLIŞDIR:
 *
 * | Siqnal | Nə edir |
 * |---|---|
 * | `toolCall` | 5686 mətn modelindən **1000**-ni atır (`gpt-3.5-turbo`, lokal modellər) |
 * | `structuredOutput` | **3288**-ni atır (`azure/claude-opus-4-5`-də sahə YOXDUR) |
 * | modality | embedding-i TUTMUR — models.dev onları `out: ["text"]` bildirir |
 *
 * Ona görə iki MÜSTƏQİL qapı işlədilir və hər biri ayrıca bir yararsızlıq
 * növünü kəsir. Bayraqlar (`toolCall`/`structuredOutput`) İSTİFADƏ OLUNMUR.
 */
export interface TaskCapabilityInput {
  modelId: string
  displayName?: string
  /**
   * models.dev-in bildirdiyi modalitlər. BOŞ/YOXDUR = **bilinmir** — kəşf
   * edilmiş, amma kataloqda olmayan model (`source: 'api'`).
   */
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
}

/**
 * Ad üzrə embedding aşkarlanması.
 *
 * Ölçülmüş: kataloqdaki 58 modelin adında `embed` var və onların HEÇ BİRİ
 * `tool_call: true` deyil — yəni bu siqnal işlək çat modelinə dəymir. Ad
 * yoxlaması həm də modalitlər bilinmədikdə (Ollama, LM Studio) yeganə
 * siqnaldır.
 */
const EMBEDDING_NAME = /embed/i

/** Mətn olmayan modalitlər — task nə oxunur, nə də yazılır. */
function hasNonText(modalities: readonly string[]): boolean {
  return modalities.some((m) => m !== 'text')
}

export function isTaskCapableModel(model: TaskCapabilityInput): boolean {
  if (EMBEDDING_NAME.test(model.modelId) || EMBEDDING_NAME.test(model.displayName ?? '')) {
    return false
  }

  const out = model.outputModalities ?? []
  // Mətnlə YANAŞI şəkil/audio çıxaran model də rədd olunur: `gpt-image-1.5`
  // çıxışında `text` var, `limit.output` isə sıfırdır.
  if (out.length > 0 && hasNonText(out)) return false

  const input = model.inputModalities ?? []
  // Prompt MƏTNDİR — mətn qəbul etməyən modelə (whisper) onu verə bilmirik.
  if (input.length > 0 && !input.includes('text')) return false

  // Modalitlər bilinmirsə model BURAXILIR. Səhvin ucuz istiqaməti budur:
  // yararsız model siyahıda görünsə istifadəçi onu seçib xətanı görür, işlək
  // model səssizcə düşsə səbəbi heç yerdə tapa bilmir.
  return true
}
