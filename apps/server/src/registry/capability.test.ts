import { describe, expect, it } from 'vitest'
import { isTaskCapableModel } from './capability.js'

/**
 * Bütün hallar REAL kataloqdan götürülmüşdür (models.dev keşi, 2026-07-30,
 * 175 provayder / 5892 model) — uydurulmamışdır. Ölçmənin özü issue #47-dədir.
 */
describe('isTaskCapableModel', () => {
  it('mətn→mətn modelini qəbul edir', () => {
    expect(
      isTaskCapableModel({
        modelId: 'gpt-5.6',
        displayName: 'GPT-5.6',
        inputModalities: ['text', 'image', 'pdf'],
        outputModalities: ['text'],
      }),
    ).toBe(true)
  })

  it('şəkil çıxaran modeli rədd edir', () => {
    expect(
      isTaskCapableModel({
        modelId: 'gpt-image-2',
        inputModalities: ['text', 'image'],
        outputModalities: ['image'],
      }),
    ).toBe(false)
  })

  it('mətnLƏ YANAŞI şəkil çıxaran modeli də rədd edir', () => {
    // `gpt-image-1.5` çıxışında `text` VAR — "mətn çıxarırsa yararlıdır"
    // qaydası onu buraxardı, halbuki `limit.output` sıfırdır.
    expect(
      isTaskCapableModel({
        modelId: 'gpt-image-1.5',
        inputModalities: ['text', 'image'],
        outputModalities: ['text', 'image'],
      }),
    ).toBe(false)
  })

  it('audio çıxaran (realtime) modeli rədd edir', () => {
    // İssue #47-nin ən çətin halı: `toolCall=true`, yəni `toolCall` süzgəci
    // ondan sızır.
    expect(
      isTaskCapableModel({
        modelId: 'gpt-realtime-2.1',
        inputModalities: ['text', 'audio', 'image'],
        outputModalities: ['text', 'audio'],
      }),
    ).toBe(false)
  })

  it('mətn QƏBUL ETMƏYƏN modeli rədd edir', () => {
    // `whisper-large-v3` mətn çıxarır, amma girişi audiodur — prompt verə
    // bilmirik.
    expect(
      isTaskCapableModel({
        modelId: 'openai/whisper-large-v3',
        inputModalities: ['audio'],
        outputModalities: ['text'],
      }),
    ).toBe(false)
  })

  it('embedding modelini ADINA görə rədd edir — modalitlər onu TUTMUR', () => {
    // Ölçülmüş: models.dev embedding modellərini `out: ["text"]` kimi bildirir,
    // yəni modality süzgəci onları buraxır. Kataloqda embedding üçün heç bir
    // struktur bayraq YOXDUR (`family: "text-embedding"` sərbəst mətndir).
    expect(
      isTaskCapableModel({
        modelId: 'text-embedding-3-small',
        inputModalities: ['text'],
        outputModalities: ['text'],
      }),
    ).toBe(false)
  })

  it('`structuredOutput` bilinməyən İŞLƏK modeli rədd ETMİR', () => {
    // İssue #47-nin 1-ci variantı (`toolCall && structuredOutput`) MƏHZ burada
    // sınır: ölçülmüş — `azure/claude-opus-4-5` üçün models.dev
    // `structured_output` sahəsini ÜMUMİYYƏTLƏ vermir (normalizasiya onu
    // `false` edir). Həmin süzgəc 5686 mətn modelindən 3288-ni səssizcə
    // siyahıdan atardı.
    expect(
      isTaskCapableModel({
        modelId: 'claude-opus-4-5',
        inputModalities: ['text', 'image', 'pdf'],
        outputModalities: ['text'],
      }),
    ).toBe(true)
  })

  it('köhnə çat modelini rədd ETMİR', () => {
    // `gpt-3.5-turbo` models.dev-də `tool_call: false`-dur, amma task icra
    // EDƏ BİLİR. `toolCall` süzgəci onunla yanaşı 1000 mətn modelini atardı.
    expect(
      isTaskCapableModel({
        modelId: 'gpt-3.5-turbo',
        inputModalities: ['text'],
        outputModalities: ['text'],
      }),
    ).toBe(true)
  })

  it('modalitlər BİLİNMİRSƏ modeli buraxır', () => {
    // Kəşf edilmiş, amma models.dev-də olmayan model (`source: 'api'`).
    // Səhvin ucuz istiqaməti budur: yararsız model siyahıda görünsə istifadəçi
    // onu seçib xətanı görür; işlək model siyahıdan səssizcə düşsə səbəbi heç
    // yerdə tapa bilmir.
    expect(
      isTaskCapableModel({ modelId: 'my-local-model', displayName: 'my-local-model' }),
    ).toBe(true)
  })

  it('modalitlər bilinməsə DƏ embedding adını tutur', () => {
    // Ollama/LM Studio modelləri kataloqda yoxdur — ad yeganə siqnaldır.
    expect(isTaskCapableModel({ modelId: 'nomic-embed-text' })).toBe(false)
  })

  it('ad yoxlaması BÖYÜK hərfli adı da tutur', () => {
    expect(isTaskCapableModel({ modelId: 'Qwen/Qwen3-Embedding-8B' })).toBe(false)
  })
})
