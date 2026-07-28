import type { Capabilities, RunEvent } from '@orchestris/shared'
import { describe, expect, it } from 'vitest'
import { FakeRunner } from '../runners/fake.js'
import { classifyTask } from './classify.js'
import { runClassifier, CLASSIFIER_MAX_OUTPUT_TOKENS } from './classifier.js'
import type { WorkerCandidate } from './router.js'

const API_CAPS: Capabilities = {
  fileAccess: false,
  toolUse: true,
  sessions: false,
  structuredOutput: true,
  subscriptionBilled: false,
}

function candidate(rowId: string, over: Partial<WorkerCandidate> = {}): WorkerCandidate {
  return {
    rowId,
    runnerId: 'api:anthropic',
    modelId: rowId.split(':')[1] ?? rowId,
    displayName: rowId,
    kind: 'api',
    capabilities: API_CAPS,
    contextLimit: 200_000,
    priceIn: 1,
    priceOut: 5,
    ...over,
  }
}

function runnerSaying(text: string, usage?: Partial<Extract<RunEvent, { t: 'usage' }>>): FakeRunner {
  return new FakeRunner({
    events: [
      { t: 'start', model: 'klassifikator' },
      { t: 'text', delta: text },
      {
        t: 'usage',
        inputTokens: 40,
        outputTokens: 12,
        costUsd: 0.00002,
        billed: 'real',
        ...usage,
      },
      { t: 'done', stopReason: 'end_turn' },
    ],
  })
}

const BASE = {
  modelId: 'claude-haiku-4-5',
  prompt: 'Bu mətni yenidən yaz',
  features: classifyTask({ prompt: 'Bu mətni yenidən yaz' }),
  candidates: [candidate('anthropic:ucuz'), candidate('openai:baha')],
}

describe('runClassifier — qərar', () => {
  it('modelin seçdiyi namizədi qaytarır', async () => {
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('{"model":"openai:baha","confidence":0.9}'),
    })
    expect(out.decision).toMatchObject({
      strategy: 'classifier',
      chosenRowId: 'openai:baha',
      confidence: 0.9,
    })
  })

  it('cavabın ətrafındakı artıq mətni tolerantlıqla keçir', async () => {
    // Kiçik modellər "Əlbəttə! İşdə cavab:" kimi müqəddimə yazır. Bunu xəta
    // saysaq klassifikator praktikada heç vaxt işləməzdi.
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('Əlbəttə!\n```json\n{"model":"anthropic:ucuz","confidence":0.8}\n```'),
    })
    expect(out.decision?.chosenRowId).toBe('anthropic:ucuz')
  })

  it('namizəd olmayan modeli seçsə qərarı RƏDD edir', async () => {
    // Model uydurma id qaytara bilər. Onu qəbul etsək istifadəçinin icazə
    // vermədiyi (və ya ümumiyyətlə mövcud olmayan) modelə keçərdik.
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('{"model":"google:uydurma","confidence":0.99}'),
    })
    expect(out.decision).toBeNull()
  })

  it('inamlılıq aşağıdırsa qərar vermir', async () => {
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('{"model":"anthropic:ucuz","confidence":0.2}'),
    })
    expect(out.decision).toBeNull()
  })

  it('JSON olmayan cavabda çökmür, qərar vermir', async () => {
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('bilmirəm, bəlkə birincisi?'),
    })
    expect(out.decision).toBeNull()
  })

  it('klassifikator xəta versə qərar vermir', async () => {
    const runner = new FakeRunner({
      events: [{ t: 'error', class: 'rate_limit', message: '429' }],
    })
    const out = await runClassifier({ ...BASE, runner })
    expect(out.decision).toBeNull()
  })
})

describe('runClassifier — öz xərci (issue #7 tələbi)', () => {
  it('sərf etdiyi tokenləri qaytarır', async () => {
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('{"model":"anthropic:ucuz","confidence":0.9}'),
    })
    expect(out.tokens).toBe(52) // 40 giriş + 12 çıxış
    expect(out.costUsd).toBe(0.00002)
  })

  it('QƏRAR VERMƏSƏ DƏ xərci qaytarır', async () => {
    // Uğursuz klassifikator çağırışı da pul yandırır. Onu saymasaq
    // "orkestrasiya xərci" rəqəmi olduğundan az görünərdi (issue #8).
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('cəfəngiyat'),
    })
    expect(out.decision).toBeNull()
    expect(out.tokens).toBe(52)
  })

  it('xərc bilinmirsə costUsd BURAXILIR, 0 yazılmır', async () => {
    const runner = new FakeRunner({
      events: [
        { t: 'text', delta: '{"model":"anthropic:ucuz","confidence":0.9}' },
        { t: 'usage', inputTokens: 40, outputTokens: 12, billed: 'subscription' },
        { t: 'done', stopReason: 'end_turn' },
      ],
    })
    const out = await runClassifier({ ...BASE, runner })
    expect(out.costUsd).toBeUndefined()
    expect(out.decision?.decisionCostUsd).toBeUndefined()
  })

  it('qərarın içində öz xərci qeyd olunur', async () => {
    const out = await runClassifier({
      ...BASE,
      runner: runnerSaying('{"model":"anthropic:ucuz","confidence":0.9}'),
    })
    expect(out.decision).toMatchObject({ decisionTokens: 52, decisionCostUsd: 0.00002 })
  })
})

describe('runClassifier — ucuzluq zəmanəti', () => {
  it('çıxış limiti sərtdir — klassifikator esse yazmamalıdır', async () => {
    let seenLimit: number | undefined
    const runner = new FakeRunner({
      events: [{ t: 'text', delta: '{}' }, { t: 'done', stopReason: 'end_turn' }],
    })
    const spy = {
      ...runner,
      id: runner.id,
      kind: runner.kind,
      capabilities: runner.capabilities,
      detect: () => runner.detect(),
      run: (req: Parameters<typeof runner.run>[0], opts?: Parameters<typeof runner.run>[1]) => {
        seenLimit = opts?.maxOutputTokens
        return runner.run(req, opts)
      },
    }
    await runClassifier({ ...BASE, runner: spy })
    expect(seenLimit).toBe(CLASSIFIER_MAX_OUTPUT_TOKENS)
    expect(CLASSIFIER_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(128)
  })

  it('uzun taskı promptu kəsir — klassifikator bütün mətni oxumamalıdır', async () => {
    let seenPrompt = ''
    const runner = new FakeRunner({
      events: [{ t: 'text', delta: '{}' }, { t: 'done', stopReason: 'end_turn' }],
    })
    const spy = {
      id: runner.id,
      kind: runner.kind,
      capabilities: runner.capabilities,
      detect: () => runner.detect(),
      run: (req: Parameters<typeof runner.run>[0], opts?: Parameters<typeof runner.run>[1]) => {
        seenPrompt = req.prompt
        return runner.run(req, opts)
      },
    }
    await runClassifier({ ...BASE, prompt: 'x'.repeat(10_000), runner: spy })
    expect(seenPrompt.length).toBeLessThan(2000)
  })
})
