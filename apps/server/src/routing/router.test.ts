import type { Capabilities } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { classifyTask } from './classify.js'
import { BUILTIN_RULES, matchRule } from './rules.js'
import { routeByRules, pickFallback, type WorkerCandidate } from './router.js'

const CLI_CAPS: Capabilities = {
  fileAccess: true,
  toolUse: true,
  sessions: true,
  structuredOutput: true,
  subscriptionBilled: true,
}
const API_CAPS: Capabilities = {
  fileAccess: false,
  toolUse: true,
  sessions: false,
  structuredOutput: true,
  subscriptionBilled: false,
}

function cli(over: Partial<WorkerCandidate> = {}): WorkerCandidate {
  return {
    rowId: 'cli:claude:claude-haiku-4-5',
    runnerId: 'cli:claude',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5 (CLI)',
    kind: 'cli',
    capabilities: CLI_CAPS,
    contextLimit: 200_000,
    priceIn: 1,
    priceOut: 5,
    ...over,
  }
}

function api(over: Partial<WorkerCandidate> = {}): WorkerCandidate {
  return {
    rowId: 'anthropic:claude-haiku-4-5',
    runnerId: 'api:anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    kind: 'api',
    capabilities: API_CAPS,
    contextLimit: 200_000,
    priceIn: 1,
    priceOut: 5,
    ...over,
  }
}

describe('qaydalar — ölçülmüş əsas', () => {
  it('fayl işini CLI-a yönləndirir', () => {
    // CLI-nın ~21.7k token döşəməsi var, amma alətləri var. Fayl işində
    // alətsiz model taskı ümumiyyətlə edə bilmir.
    const rule = matchRule(classifyTask({ prompt: 'src/app.ts faylını düzəlt' }))
    expect(rule?.prefer).toBe('cli')
  })

  it('qısa mətn taskını API-yə yönləndirir', () => {
    // ÖLÇÜLMÜŞ: CLI hər çağırışda ~21.7k token döşəməsi daşıyır, API ~0.
    // Bir cümlə tərcüməsi üçün o döşəməni ödəmək mənasızdır.
    const rule = matchRule(classifyTask({ prompt: 'Bu cümləni ingiliscəyə tərcümə et: salam' }))
    expect(rule?.prefer).toBe('api')
  })

  it('yapışdırılmış kodla bağlı sualı API-yə yönləndirir', () => {
    const rule = matchRule(
      classifyTask({ prompt: 'Bu funksiyanı düzəlt:\n```ts\nconst a=1\n```' }),
    )
    expect(rule?.prefer).toBe('api')
  })

  it('siqnalsız promptda heç bir qaydaya uyğun gəlmir', () => {
    expect(matchRule(classifyTask({ prompt: 'x'.repeat(600) }))).toBeUndefined()
  })

  it('hər qaydanın insan üçün izahı var — UI onu göstərir', () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.description.length).toBeGreaterThan(10)
      expect(rule.id).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

describe('routeByRules — qərar', () => {
  it('qayda uyğun gəldikdə SIFIR token xərcləyir', () => {
    const decision = routeByRules({
      features: classifyTask({ prompt: 'src/app.ts faylını düzəlt' }),
      candidates: [cli(), api()],
    })
    expect(decision).toMatchObject({ strategy: 'rule', runnerId: 'cli:claude' })
    expect(decision?.decisionTokens).toBe(0)
    expect(decision?.decisionCostUsd).toBe(0)
  })

  it('qərarın səbəbi insan üçün oxunandır', () => {
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Bu cümləni tərcümə et: salam' }),
      candidates: [cli(), api()],
    })
    expect(decision?.reason).toContain('qayda')
    expect(decision?.ruleId).toBeTruthy()
  })

  it('fayl girişi bacarmayan modeli fayl taskına SEÇMİR', () => {
    // Qabiliyyət filtri qaydadan üstündür: API modelinin faylı yoxdur.
    const decision = routeByRules({
      features: classifyTask({ prompt: 'src/app.ts faylını düzəlt' }),
      candidates: [api()],
    })
    expect(decision).toBeNull()
  })

  it('qayda API deyir, amma API namizədi yoxdursa qərar vermir', () => {
    // Uydurma qərar vermək əvəzinə növbəti pilləyə (klassifikator/default)
    // ötürülür — bu, dürüst davranışdır.
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Bu cümləni tərcümə et: salam' }),
      candidates: [cli()],
    })
    expect(decision).toBeNull()
  })

  it('eyni növdə bir neçə namizəd varsa UCUZUNU seçir', () => {
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Bu cümləni tərcümə et: salam' }),
      candidates: [
        api({ rowId: 'openai:gpt-baha', priceIn: 10, priceOut: 30 }),
        api({ rowId: 'anthropic:ucuz', priceIn: 0.5, priceOut: 2 }),
      ],
    })
    expect(decision?.chosenRowId).toBe('anthropic:ucuz')
  })

  it('qiyməti bilinməyən modeli qiyməti bilinəndən SONRA sıralayır', () => {
    // Qiyməti bilinməyən modeldə büdcə mühafizəsi kor qalır (qayda 4) —
    // eyni şərtlərdə bilinən qiymət seçilməlidir.
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Bu cümləni tərcümə et: salam' }),
      candidates: [
        api({ rowId: 'openai:naməlum', priceIn: null, priceOut: null }),
        api({ rowId: 'anthropic:bilinən', priceIn: 3, priceOut: 15 }),
      ],
    })
    expect(decision?.chosenRowId).toBe('anthropic:bilinən')
  })

  it('kontekst limiti çatmayan modeli namizəd saymır', () => {
    const longPrompt = 'x'.repeat(40_000) // ≈10k token
    const decision = routeByRules({
      features: classifyTask({ prompt: `${longPrompt} tərcümə et` }),
      candidates: [api({ contextLimit: 4096 })],
    })
    expect(decision).toBeNull()
  })

  it('kontekst limiti BİLİNMİRSƏ namizədi atmır', () => {
    // `null` = "bilinmir". Atmaq models.dev-də limiti olmayan modelləri
    // həmişəlik sıradan çıxarardı.
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Bu cümləni tərcümə et: salam' }),
      candidates: [api({ contextLimit: null })],
    })
    expect(decision?.strategy).toBe('rule')
  })

  it('strukturlaşmış çıxış tələb olunanda onu bacarmayanı seçmir', () => {
    const decision = routeByRules({
      features: classifyTask({ prompt: 'Cavabı JSON kimi qaytar: paytaxtlar' }),
      candidates: [
        api({ capabilities: { ...API_CAPS, structuredOutput: false } }),
      ],
    })
    expect(decision).toBeNull()
  })
})

describe('pickFallback — qayda işləmədikdə', () => {
  it('kontekstin default işçisini seçir', () => {
    const decision = pickFallback({
      features: classifyTask({ prompt: 'x'.repeat(600) }),
      candidates: [cli(), api({ rowId: 'anthropic:default' })],
      defaultWorkerRowId: 'anthropic:default',
    })
    expect(decision).toMatchObject({ strategy: 'default', chosenRowId: 'anthropic:default' })
    expect(decision?.decisionTokens).toBe(0)
  })

  it('default işçi namizəd deyilsə ona KEÇMİR', () => {
    // Söndürülmüş və ya uyğun gəlməyən modeli "default belədir" deyə seçmək
    // istifadəçinin icazə vermədiyi modelə keçmək olardı.
    const decision = pickFallback({
      features: classifyTask({ prompt: 'src/a.ts düzəlt' }),
      candidates: [cli()],
      defaultWorkerRowId: 'anthropic:söndürülmüş',
    })
    expect(decision?.chosenRowId).toBe('cli:claude:claude-haiku-4-5')
    expect(decision?.strategy).toBe('fallback')
  })

  it('namizəd yoxdursa null qaytarır — uydurmur', () => {
    expect(
      pickFallback({
        features: classifyTask({ prompt: 'salam' }),
        candidates: [],
      }),
    ).toBeNull()
  })

  it('fallback da qabiliyyət filtrindən keçir', () => {
    const decision = pickFallback({
      features: classifyTask({ prompt: 'bu layihədə importları təmizlə' }),
      candidates: [api()],
    })
    expect(decision).toBeNull()
  })
})
