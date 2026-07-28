import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import {
  setProviderCredentialRef,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { credentialRef, MemoryStore } from '../secrets/keychain.js'
import { createApiRunners } from './api-factory.js'

const KEY = 'sk-ant-api03-TEST-KEY-0123456789'

function seed(): { db: Db; store: MemoryStore } {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  return { db, store: new MemoryStore() }
}

function model(over: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Haiku',
    price: { input: 1, output: 5 },
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    inputModalities: ['text'],
    source: 'models.dev',
    ...over,
  }
}

describe('createApiRunners', () => {
  it('dəstəklənən hər provayder üçün bir runner qurur', () => {
    const { db, store } = seed()
    const { runners } = createApiRunners({ db, credentials: store })
    expect([...runners.keys()]).toEqual(['api:anthropic', 'api:openai', 'api:google'])
  })

  it('açar yoxdursa runner authenticated deyil', async () => {
    const { db, store } = seed()
    const { runners } = createApiRunners({ db, credentials: store })
    const runner = runners.get('api:anthropic')
    expect(await runner?.detect()).toMatchObject({ authenticated: false })
  })

  it('açar OS anbarındadırsa runner onu tapır', async () => {
    const { db, store } = seed()
    await store.set(credentialRef('anthropic'), KEY)
    setProviderCredentialRef(db, 'anthropic', credentialRef('anthropic'))

    const { runners } = createApiRunners({ db, credentials: store })
    const runner = runners.get('api:anthropic')
    expect(await runner?.detect()).toMatchObject({ authenticated: true })
  })

  it('DB-də credentialRef yoxdursa anbara BAXMIR', async () => {
    // Anbarda qalıq qeyd ola bilər (istifadəçi açarı sildi, OS qeydi qaldı).
    // Həqiqət mənbəyi DB-dəki `credential_ref`-dir.
    const { db, store } = seed()
    await store.set(credentialRef('anthropic'), KEY)

    const { runners } = createApiRunners({ db, credentials: store })
    const runner = runners.get('api:anthropic')
    expect(await runner?.detect()).toMatchObject({ authenticated: false })
  })
})

describe('createApiRunners — qiymət axtarışı', () => {
  it('DB-dəki modelin qiymətini qaytarır', () => {
    const { db, store } = seed()
    upsertModels(db, 'anthropic', [model()])

    const { resolvePrice } = createApiRunners({ db, credentials: store })
    expect(resolvePrice('anthropic', 'claude-haiku-4-5')).toEqual({ input: 1, output: 5 })
  })

  it('model DB-də yoxdursa undefined qaytarır — 0 YOX', () => {
    const { db, store } = seed()
    const { resolvePrice } = createApiRunners({ db, credentials: store })
    expect(resolvePrice('anthropic', 'bilinməyən-model')).toBeUndefined()
  })

  it('qiyməti olmayan model üçün boş qiymət qaytarır, uydurmur', () => {
    // models.dev-də olmayan model `price: {}` ilə yazılır. `computeCostUsd`
    // bunu görüb `undefined` verir → UI "xərc bilinmir" deyir (qayda 4).
    const { db, store } = seed()
    upsertModels(db, 'anthropic', [model({ modelId: 'yeni-model', price: {} })])

    const { resolvePrice } = createApiRunners({ db, credentials: store })
    expect(resolvePrice('anthropic', 'yeni-model')).toEqual({})
  })
})
