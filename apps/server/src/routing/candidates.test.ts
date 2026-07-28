import type { Runner } from '@orchestris/shared'
import { asc } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.js'
import {
  listModels,
  setModelEnabled,
  setWorkerRole,
  setProviderCredentialRef,
  upsertProvider,
  upsertModels,
  modelRowId,
  type ModelUpsert,
} from '../db/registry-repo.js'
import { providers } from '../db/schema.js'
import type { Catalog } from '../registry/models-dev.js'
import { ApiRunner } from '../runners/api.js'
import { ClaudeCliRunner } from '../runners/claude.js'
import { FakeRunner } from '../runners/fake.js'
import { listWorkerCandidates, seedCliProviders } from './candidates.js'

const CATALOG: Catalog = {
  source: 'bundled',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      envVars: [],
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-haiku-4-5',
          displayName: 'Claude Haiku 4.5',
          price: { input: 1, output: 5 },
          contextLimit: 200_000,
          toolCall: true,
          structuredOutput: true,
          reasoning: false,
          inputModalities: ['text'],
        },
      ],
    },
  ],
}

function runners(): Map<string, Runner> {
  return new Map<string, Runner>([
    ['cli:claude', new ClaudeCliRunner()],
    [
      'api:anthropic',
      new ApiRunner({ providerId: 'anthropic', getApiKey: async () => null }),
    ],
  ])
}

function apiModel(over: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    price: { input: 1, output: 5 },
    contextLimit: 200_000,
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    inputModalities: ['text'],
    source: 'models.dev',
    ...over,
  }
}

function seededDb(): Db {
  const db = openDb(':memory:')
  upsertProvider(db, { id: 'anthropic', displayName: 'Anthropic' })
  upsertModels(db, 'anthropic', [apiModel()])
  seedCliProviders(db, runners(), CATALOG)
  return db
}

describe('seedCliProviders', () => {
  it('CLI runner-i üçün kind=cli provayder sətri yaradır', () => {
    const db = seededDb()
    const rows = db
      .select({ id: providers.id, kind: providers.kind })
      .from(providers)
      .orderBy(asc(providers.id))
      .all()
    expect(rows).toEqual([
      { id: 'anthropic', kind: 'api' },
      { id: 'cli:claude', kind: 'cli' },
    ])
  })

  it('CLI modellərini kataloqdan qiymətləri ilə yazır', () => {
    const db = seededDb()
    const cliModels = listModels(db, 'cli:claude')
    expect(cliModels).toHaveLength(1)
    expect(cliModels[0]).toMatchObject({
      id: 'cli:claude:claude-haiku-4-5',
      modelId: 'claude-haiku-4-5',
      priceIn: 1,
      contextLimit: 200_000,
    })
  })

  it('runner qeydiyyatda yoxdursa provayder yaratmır', () => {
    // `cli:codex` runner siyahısında yoxdur — onu siyahıya salmaq
    // istifadəçiyə seçə bilməyəcəyi işçi göstərmək olardı.
    const db = seededDb()
    expect(listModels(db, 'cli:codex')).toHaveLength(0)
  })

  it('istifadəçinin rol/aktivlik seçimlərini sıfırlamır', () => {
    const db = seededDb()
    const id = modelRowId('cli:claude', 'claude-haiku-4-5')
    setWorkerRole(db, id, true)
    setModelEnabled(db, id, false)

    seedCliProviders(db, runners(), CATALOG)

    const row = listModels(db, 'cli:claude')[0]
    expect(row).toMatchObject({ roleWorker: true, enabled: false })
  })
})

describe('listWorkerCandidates — icazə filtri', () => {
  it('işçi kimi işarələnməmiş modeli namizəd saymır', () => {
    // Spesifikasiya: "Auto YALNIZ istifadəçinin icazə verdiyi işçilər
    // arasından seçir."
    const db = seededDb()
    expect(listWorkerCandidates({ db, runners: runners() })).toHaveLength(0)
  })

  it('işçi kimi işarələnmiş CLI modelini namizəd sayır', () => {
    const db = seededDb()
    setWorkerRole(db, modelRowId('cli:claude', 'claude-haiku-4-5'), true)

    const list = listWorkerCandidates({ db, runners: runners() })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      rowId: 'cli:claude:claude-haiku-4-5',
      runnerId: 'cli:claude',
      modelId: 'claude-haiku-4-5',
      kind: 'cli',
      priceIn: 1,
    })
  })

  it('söndürülmüş modeli namizəd saymır', () => {
    const db = seededDb()
    const id = modelRowId('cli:claude', 'claude-haiku-4-5')
    setWorkerRole(db, id, true)
    setModelEnabled(db, id, false)
    expect(listWorkerCandidates({ db, runners: runners() })).toHaveLength(0)
  })

  it('açarı olmayan API provayderinin modelini namizəd saymır', () => {
    // Açarsız model seçilsə icra dərhal `auth` xətası ilə sınardı.
    const db = seededDb()
    setWorkerRole(db, modelRowId('anthropic', 'claude-haiku-4-5'), true)
    expect(listWorkerCandidates({ db, runners: runners() })).toHaveLength(0)
  })

  it('açar təyin olunandan sonra API modelini namizəd sayır', () => {
    const db = seededDb()
    setWorkerRole(db, modelRowId('anthropic', 'claude-haiku-4-5'), true)
    setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')

    const list = listWorkerCandidates({ db, runners: runners() })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ runnerId: 'api:anthropic', kind: 'api' })
  })

  it('runner-i olmayan modeli namizəd saymır', () => {
    const db = seededDb()
    setWorkerRole(db, modelRowId('anthropic', 'claude-haiku-4-5'), true)
    setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')

    const withoutApi = new Map<string, Runner>([['cli:claude', new ClaudeCliRunner()]])
    expect(listWorkerCandidates({ db, runners: withoutApi })).toHaveLength(0)
  })

  it('hazır olmayan CLI runner-ini namizəd saymır', () => {
    // `isRunnerReady` çağıran tərəfindən keşlənir: `detect()` proses spawn
    // edir və hər taskda çağırmaq bahalıdır.
    const db = seededDb()
    setWorkerRole(db, modelRowId('cli:claude', 'claude-haiku-4-5'), true)

    const list = listWorkerCandidates({
      db,
      runners: runners(),
      isRunnerReady: (id) => id !== 'cli:claude',
    })
    expect(list).toHaveLength(0)
  })
})

describe('listWorkerCandidates — qabiliyyətlər', () => {
  it('CLI namizədi fayl girişi bacarır', () => {
    const db = seededDb()
    setWorkerRole(db, modelRowId('cli:claude', 'claude-haiku-4-5'), true)
    expect(listWorkerCandidates({ db, runners: runners() })[0]?.capabilities).toMatchObject({
      fileAccess: true,
      subscriptionBilled: true,
    })
  })

  it('API namizədinin qabiliyyəti model bayraqları ilə KƏSİŞİR', () => {
    // models.dev "bu model alət çağıra bilmir" deyirsə, runner-in ümumi
    // `toolUse: true` qabiliyyəti bunu üstələməməlidir.
    const db = seededDb()
    upsertModels(db, 'anthropic', [
      apiModel({ modelId: 'sadə', toolCall: false, structuredOutput: false }),
    ])
    setWorkerRole(db, modelRowId('anthropic', 'sadə'), true)
    setProviderCredentialRef(db, 'anthropic', 'provider:anthropic')

    const cand = listWorkerCandidates({ db, runners: runners() })[0]
    expect(cand?.capabilities).toMatchObject({
      toolUse: false,
      structuredOutput: false,
      fileAccess: false,
    })
  })

  it('fake runner də namizəd ola bilər — testlər üçün', () => {
    const db = openDb(':memory:')
    upsertProvider(db, { id: 'fake', displayName: 'Fake' })
    upsertModels(db, 'fake', [apiModel({ providerId: 'fake', modelId: 'fake-model' })])
    setProviderCredentialRef(db, 'fake', 'provider:fake')
    setWorkerRole(db, modelRowId('fake', 'fake-model'), true)

    const list = listWorkerCandidates({
      db,
      runners: new Map<string, Runner>([
        ['api:fake', new FakeRunner({ events: [] })],
      ]),
    })
    expect(list[0]?.kind).toBe('fake')
  })
})
