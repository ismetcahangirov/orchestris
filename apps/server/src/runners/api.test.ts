import { describe, expect, it } from 'vitest'
import { RunEventSchema, type RunEvent } from '@orchestris/shared'
import { ApiRunner, createProviderModel, API_PROVIDER_IDS } from './api.js'
import type { ApiStreamPart } from './parse-api.js'

const KEY = 'sk-ant-api03-TEST-KEY-0123456789'

function stream(parts: readonly ApiStreamPart[]): AsyncIterable<ApiStreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p
    },
  }
}

function finishPart(over: Record<string, unknown> = {}): ApiStreamPart {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: 'end_turn',
    totalUsage: {
      inputTokens: 120,
      inputTokenDetails: { noCacheTokens: 120 },
      outputTokens: 30,
    },
    ...over,
  }
}

interface RunnerOverrides {
  apiKey?: string | null
  parts?: readonly ApiStreamPart[]
  streamText?: ConstructorParameters<typeof ApiRunner>[0]['streamText']
  resolvePrice?: ConstructorParameters<typeof ApiRunner>[0]['resolvePrice']
}

function makeRunner(over: RunnerOverrides = {}): ApiRunner {
  const parts = over.parts ?? [{ type: 'text-delta', id: '1', text: 'salam' }, finishPart()]
  return new ApiRunner({
    providerId: 'anthropic',
    getApiKey: async () => (over.apiKey === undefined ? KEY : over.apiKey),
    // Model qurmaq şəbəkəyə çıxmır, amma testdə real SDK-nı da işə salmırıq.
    createModel: () => ({ fake: true }),
    streamText: over.streamText ?? (() => ({ fullStream: stream(parts) })),
    ...(over.resolvePrice !== undefined ? { resolvePrice: over.resolvePrice } : {}),
  })
}

async function collect(runner: ApiRunner, signal?: AbortSignal): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of runner.run(
    { prompt: 'salam de', model: 'claude-haiku-4-5' },
    signal !== undefined ? { signal } : {},
  )) {
    out.push(e)
  }
  return out
}

describe('ApiRunner — qabiliyyətlər', () => {
  it('fayl sistemi yoxdur və abunəlikdən GETMİR', () => {
    // `subscriptionBilled: false` → `BudgetGuard` dollar limitini tətbiq edir.
    // Bunu `true` qoysaq API icraları büdcə mühafizəsindən azad olardı.
    expect(makeRunner().capabilities).toEqual({
      fileAccess: false,
      toolUse: true,
      sessions: false,
      structuredOutput: true,
      subscriptionBilled: false,
    })
  })

  it('id provayderi göstərir və kind api-dir', () => {
    const runner = makeRunner()
    expect(runner.id).toBe('api:anthropic')
    expect(runner.kind).toBe('api')
  })
})

describe('ApiRunner — detect', () => {
  it('açar yoxdursa authenticated false qaytarır', async () => {
    const result = await makeRunner({ apiKey: null }).detect()
    expect(result).toMatchObject({ installed: true, authenticated: false })
    expect(result.detail).toContain('açar')
  })

  it('açar varsa authenticated true qaytarır', async () => {
    const result = await makeRunner().detect()
    expect(result).toMatchObject({ installed: true, authenticated: true })
  })

  it('detect açarın ÖZÜNÜ detail-a qoymur', async () => {
    const result = await makeRunner().detect()
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe('ApiRunner — icra', () => {
  it('ilk hadisə start-dır və istənilən modeli göstərir', async () => {
    const events = await collect(makeRunner())
    expect(events[0]).toEqual({ t: 'start', model: 'claude-haiku-4-5' })
  })

  it('axın hissələrini RunEvent-ə çevirir', async () => {
    const events = await collect(makeRunner())
    expect(events.map((e) => e.t)).toEqual(['start', 'text', 'usage', 'done'])
  })

  it('emit etdiyi hər hadisə RunEvent sxemini keçir', async () => {
    const events = await collect(makeRunner())
    for (const e of events) expect(() => RunEventSchema.parse(e)).not.toThrow()
  })

  it('usage yalnız BİR DƏFƏ emit olunur', async () => {
    const events = await collect(
      makeRunner({
        parts: [
          {
            type: 'finish-step',
            response: { modelId: 'claude-haiku-4-5-20251001' },
            usage: { inputTokens: 10, outputTokens: 5 },
            finishReason: 'stop',
          },
          finishPart(),
        ],
      }),
    )
    expect(events.filter((e) => e.t === 'usage')).toHaveLength(1)
  })

  it('promptu, modeli və büdcə limitini streamText-ə ötürür', async () => {
    let seen: Record<string, unknown> | undefined
    const runner = makeRunner({
      streamText: (call) => {
        seen = call as unknown as Record<string, unknown>
        return { fullStream: stream([finishPart()]) }
      },
    })
    for await (const _ of runner.run(
      { prompt: 'salam de', model: 'claude-haiku-4-5' },
      { maxOutputTokens: 512 },
    )) {
      void _
    }
    expect(seen).toMatchObject({ prompt: 'salam de', maxOutputTokens: 512 })
  })

  it('abort siqnalını streamText-ə ötürür', async () => {
    const ac = new AbortController()
    let seenSignal: AbortSignal | undefined
    const runner = makeRunner({
      streamText: (call) => {
        seenSignal = call.abortSignal
        return { fullStream: stream([finishPart()]) }
      },
    })
    await collect(runner, ac.signal)
    expect(seenSignal).toBe(ac.signal)
  })
})

describe('ApiRunner — açar və xəta', () => {
  it('açar yoxdursa icra etmir, auth xətası verir', async () => {
    const events = await collect(makeRunner({ apiKey: null }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ t: 'error', class: 'auth' })
  })

  it('atılan xətanı təsnif edilmiş error hadisəsinə çevirir', async () => {
    const events = await collect(
      makeRunner({
        streamText: () => {
          throw new Error('401 Unauthorized')
        },
      }),
    )
    expect(events.at(-1)).toMatchObject({ t: 'error', class: 'auth' })
  })

  it('axının ortasında atılan xətanı da tutur', async () => {
    const runner = makeRunner({
      streamText: () => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', id: '1', text: 'başladı' }
            throw new Error('529 overloaded')
          },
        },
      }),
    })
    const events = await collect(runner)
    expect(events.map((e) => e.t)).toEqual(['start', 'text', 'error'])
    expect(events.at(-1)).toMatchObject({ class: 'overloaded' })
  })

  it('xəta mətnindəki API açarını KƏSİR', async () => {
    // Provayder xətaları göndərilən açarı əks etdirə bilir. O mətn `error`
    // hadisəsinə, oradan DB-yə və brauzerə gedir — bir dəfə jurnala düşən
    // açar orada qalır (CLAUDE.md qayda 13, 14).
    const events = await collect(
      makeRunner({
        streamText: () => {
          throw new Error(`Incorrect API key provided: ${KEY}`)
        },
      }),
    )
    const message = (events.at(-1) as { message: string }).message
    expect(message).not.toContain(KEY)
    expect(message).toContain('[API-ACARI-KESILDI]')
  })

  it('kəsilmə (abort) uydurma xəta hadisəsi yaratmır', async () => {
    // Kəsilmiş icranı `crashed` kimi göstərsək istifadəçi öz ləğvini xəta
    // kimi görərdi; supervisor onu onsuz da `interrupted` sayır.
    const ac = new AbortController()
    const runner = makeRunner({
      streamText: () => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', id: '1', text: 'yarım' }
            ac.abort()
            throw Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            })
          },
        },
      }),
    })
    const events = await collect(runner, ac.signal)
    expect(events.filter((e) => e.t === 'error')).toHaveLength(0)
  })
})

describe('ApiRunner — xərc', () => {
  it('qiyməti provayder + faktiki model üçün soruşur', async () => {
    const asked: string[][] = []
    const events = await collect(
      makeRunner({
        parts: [
          {
            type: 'finish-step',
            response: { modelId: 'claude-haiku-4-5-20251001' },
            usage: {},
            finishReason: 'stop',
          },
          finishPart({
            totalUsage: {
              inputTokens: 1_000_000,
              inputTokenDetails: { noCacheTokens: 1_000_000 },
              outputTokens: 0,
            },
          }),
        ],
        resolvePrice: (providerId, modelId) => {
          asked.push([providerId, modelId])
          return { input: 1, output: 5 }
        },
      }),
    )
    expect(asked).toEqual([['anthropic', 'claude-haiku-4-5-20251001']])
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ costUsd: 1, billed: 'real' })
  })

  it('faktiki model bilinmirsə istənilən modelin qiymətini soruşur', async () => {
    const asked: string[][] = []
    await collect(
      makeRunner({
        parts: [finishPart()],
        resolvePrice: (providerId, modelId) => {
          asked.push([providerId, modelId])
          return undefined
        },
      }),
    )
    expect(asked).toEqual([['anthropic', 'claude-haiku-4-5']])
  })

  it('qiymət bilinmirsə costUsd yazılmır', async () => {
    const events = await collect(makeRunner({ resolvePrice: () => undefined }))
    expect(events.find((e) => e.t === 'usage')).not.toHaveProperty('costUsd')
  })
})

describe('createProviderModel — real AI SDK provayderləri', () => {
  it('anthropic, openai və google üçün model qurur (şəbəkəyə çıxmadan)', () => {
    for (const id of API_PROVIDER_IDS) {
      expect(createProviderModel(id, KEY, 'test-model')).toBeDefined()
    }
    expect([...API_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'google'])
  })

  it('dəstəklənməyən provayder üçün ATIR', () => {
    expect(() => createProviderModel('bilinməyən', KEY, 'm')).toThrow(/bilinməyən/)
  })
})
