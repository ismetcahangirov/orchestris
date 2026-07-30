import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../registry/models-dev.js'
import { openDb, type Db } from './client.js'
import {
  clearProviderCredentialRef,
  getModel,
  listModels,
  listProviders,
  listWorkerModels,
  modelPrice,
  modelRowId,
  setExclusiveRole,
  setModelEnabled,
  setProviderCredentialRef,
  setProviderDiscoveryResult,
  setWorkerRole,
  upsertModels,
  upsertProvider,
  type ModelUpsert,
} from './registry-repo.js'

function db(): Db {
  return openDb(':memory:')
}

function model(overrides: Partial<CatalogModel> = {}): ModelUpsert {
  return {
    providerId: 'anthropic',
    modelId: 'claude-x',
    displayName: 'Claude X',
    price: { input: 3, output: 15 },
    contextLimit: 200000,
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    source: 'models.dev',
    ...overrides,
  }
}

function seeded(): Db {
  const d = db()
  upsertProvider(d, { id: 'anthropic', displayName: 'Anthropic' })
  return d
}

describe('upsertProvider', () => {
  it('provayder yaradır', () => {
    const d = db()
    const p = upsertProvider(d, { id: 'anthropic', displayName: 'Anthropic' })
    expect(p.id).toBe('anthropic')
    expect(p.credentialRef).toBeNull()
    expect(p.enabled).toBe(true)
  })

  it('təkrar çağırış açarı və createdAt-ı İTİRMİR', () => {
    const d = seeded()
    setProviderCredentialRef(d, 'anthropic', 'provider:anthropic')
    const before = listProviders(d)[0]

    upsertProvider(d, { id: 'anthropic', displayName: 'Anthropic (yeni ad)' })

    const after = listProviders(d)[0]
    expect(after?.displayName).toBe('Anthropic (yeni ad)')
    expect(after?.credentialRef).toBe('provider:anthropic')
    expect(after?.createdAt).toBe(before?.createdAt)
  })
})

describe('credential_ref', () => {
  it('yalnız ADI saxlayır — cədvəldə açar sütunu yoxdur', () => {
    const d = seeded()
    setProviderCredentialRef(d, 'anthropic', 'provider:anthropic')
    const row = listProviders(d)[0]
    expect(row?.credentialRef).toBe('provider:anthropic')
    // Sxemdə açarı saxlaya biləcək sahə olmadığını təsdiqlə.
    expect(Object.keys(row ?? {})).not.toContain('apiKey')
    expect(Object.keys(row ?? {})).not.toContain('secret')
  })

  it('silinmə həm ref-i, həm kəşf vəziyyətini təmizləyir', () => {
    const d = seeded()
    setProviderCredentialRef(d, 'anthropic', 'provider:anthropic')
    setProviderDiscoveryResult(d, 'anthropic', { ok: true })
    clearProviderCredentialRef(d, 'anthropic')

    const row = listProviders(d)[0]
    expect(row?.credentialRef).toBeNull()
    expect(row?.lastDiscoveryAt).toBeNull()
    expect(row?.lastDiscoveryError).toBeNull()
  })

  it('kəşf xətası saxlanılır, uğur onu təmizləyir', () => {
    const d = seeded()
    setProviderDiscoveryResult(d, 'anthropic', { ok: false, error: '401 unauthorized' })
    expect(listProviders(d)[0]?.lastDiscoveryError).toBe('401 unauthorized')

    setProviderDiscoveryResult(d, 'anthropic', { ok: true })
    expect(listProviders(d)[0]?.lastDiscoveryError).toBeNull()
    expect(listProviders(d)[0]?.lastDiscoveryAt).not.toBeNull()
  })
})

describe('upsertModels', () => {
  it('modeli qiymətləri ilə yazır', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ price: { input: 3, output: 15, cacheRead: 0.3 } })])

    const row = getModel(d, modelRowId('anthropic', 'claude-x'))
    expect(row?.priceIn).toBe(3)
    expect(row?.priceOut).toBe(15)
    expect(row?.priceCacheRead).toBe(0.3)
    expect(row?.priceCacheWrite).toBeNull()
  })

  it('qiyməti olmayan model üçün NULL yazır — 0 YOX', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ price: {} })])

    const row = getModel(d, modelRowId('anthropic', 'claude-x'))
    expect(row?.priceIn).toBeNull()
    expect(row?.priceIn).not.toBe(0)
    expect(row?.priceOut).toBeNull()
  })

  it('təkrar kəşf metadatanı yeniləyir', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ displayName: 'Köhnə', price: { input: 3, output: 15 } })])
    upsertModels(d, 'anthropic', [model({ displayName: 'Yeni', price: { input: 4, output: 20 } })])

    const row = getModel(d, modelRowId('anthropic', 'claude-x'))
    expect(row?.displayName).toBe('Yeni')
    expect(row?.priceIn).toBe(4)
    expect(listModels(d)).toHaveLength(1)
  })

  it('təkrar kəşf istifadəçinin rol və enabled seçimini SIFIRLAMIR', () => {
    const d = seeded()
    const id = modelRowId('anthropic', 'claude-x')
    upsertModels(d, 'anthropic', [model()])
    setWorkerRole(d, id, true)
    setModelEnabled(d, id, false)
    setExclusiveRole(d, 'boss', id)

    upsertModels(d, 'anthropic', [model({ displayName: 'Yenilənmiş' })])

    const row = getModel(d, id)
    expect(row?.displayName).toBe('Yenilənmiş')
    expect(row?.roleWorker).toBe(true)
    expect(row?.enabled).toBe(false)
    expect(row?.roleBoss).toBe(true)
  })

  it('kəşfdə görünməyən köhnə model SİLİNMİR', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ modelId: 'birinci' }), model({ modelId: 'ikinci' })])
    // Provayder natamam cavab verdi — yalnız bir model gəldi.
    upsertModels(d, 'anthropic', [model({ modelId: 'birinci' })])

    expect(listModels(d).map((m) => m.modelId).sort()).toEqual(['birinci', 'ikinci'])
  })

  it('provayder silinəndə modelləri kaskadla gedir', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model()])
    expect(listModels(d)).toHaveLength(1)
  })
})

describe('modelPrice', () => {
  it('NULL sütunları buraxır, sıfırlamır', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ price: { input: 3, output: 15 } })])
    const row = getModel(d, modelRowId('anthropic', 'claude-x'))

    const price = modelPrice(row as NonNullable<typeof row>)
    expect(price).toEqual({ input: 3, output: 15 })
    expect('cacheRead' in price).toBe(false)
  })

  it('pulsuz modelin 0 qiymətini SAXLAYIR', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ price: { input: 0, output: 0 } })])
    const row = getModel(d, modelRowId('anthropic', 'claude-x'))

    expect(modelPrice(row as NonNullable<typeof row>)).toEqual({ input: 0, output: 0 })
  })
})

describe('setExclusiveRole', () => {
  it('başçı rolunu köçürür — köhnə sahibdən alır', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ modelId: 'bir' }), model({ modelId: 'iki' })])
    const idBir = modelRowId('anthropic', 'bir')
    const idIki = modelRowId('anthropic', 'iki')

    setExclusiveRole(d, 'boss', idBir)
    expect(getModel(d, idBir)?.roleBoss).toBe(true)

    setExclusiveRole(d, 'boss', idIki)
    expect(getModel(d, idBir)?.roleBoss).toBe(false)
    expect(getModel(d, idIki)?.roleBoss).toBe(true)
    expect(listModels(d).filter((m) => m.roleBoss)).toHaveLength(1)
  })

  it('başçı və klassifikator bir-birindən asılı deyil', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model({ modelId: 'bir' }), model({ modelId: 'iki' })])
    setExclusiveRole(d, 'boss', modelRowId('anthropic', 'bir'))
    setExclusiveRole(d, 'classifier', modelRowId('anthropic', 'iki'))

    expect(getModel(d, modelRowId('anthropic', 'bir'))?.roleBoss).toBe(true)
    expect(getModel(d, modelRowId('anthropic', 'iki'))?.roleClassifier).toBe(true)
  })

  it('eyni model həm başçı, həm klassifikator ola bilər', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [model()])
    const id = modelRowId('anthropic', 'claude-x')
    setExclusiveRole(d, 'boss', id)
    setExclusiveRole(d, 'classifier', id)

    const row = getModel(d, id)
    expect(row?.roleBoss).toBe(true)
    expect(row?.roleClassifier).toBe(true)
  })
})

describe('listWorkerModels', () => {
  it('yalnız işçi VƏ aktiv modelləri qaytarır', () => {
    const d = seeded()
    upsertModels(d, 'anthropic', [
      model({ modelId: 'isci-aktiv' }),
      model({ modelId: 'isci-sonuk' }),
      model({ modelId: 'isci-deyil' }),
    ])
    setWorkerRole(d, modelRowId('anthropic', 'isci-aktiv'), true)
    setWorkerRole(d, modelRowId('anthropic', 'isci-sonuk'), true)
    setModelEnabled(d, modelRowId('anthropic', 'isci-sonuk'), false)

    expect(listWorkerModels(d).map((m) => m.modelId)).toEqual(['isci-aktiv'])
  })
})

describe('listModels', () => {
  it('provayderə görə süzür', () => {
    const d = seeded()
    upsertProvider(d, { id: 'openai', displayName: 'OpenAI' })
    upsertModels(d, 'anthropic', [model()])
    upsertModels(d, 'openai', [model({ providerId: 'openai', modelId: 'gpt-x' })])

    expect(listModels(d, 'openai').map((m) => m.modelId)).toEqual(['gpt-x'])
    expect(listModels(d)).toHaveLength(2)
  })
})
