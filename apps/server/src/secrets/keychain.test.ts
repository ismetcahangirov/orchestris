import { describe, expect, it } from 'vitest'
import { credentialRef, KeyringStore, MemoryStore } from './keychain.js'

// DİQQƏT: burada `KeyringStore` REAL OS anbarına yazmır — yalnız interfeys
// uyğunluğu və `credentialRef` yoxlanılır. Real anbar testi CI-da (başsız
// runner) sınardı və istifadəçinin Credential Manager-ini zibilləyərdi.

describe('credentialRef', () => {
  it('provayder üçün sabit ad verir', () => {
    expect(credentialRef('anthropic')).toBe('provider:anthropic')
    expect(credentialRef('anthropic')).toBe(credentialRef('anthropic'))
  })

  it('fərqli provayderlər fərqli ad alır', () => {
    expect(credentialRef('openai')).not.toBe(credentialRef('google'))
  })
})

describe('MemoryStore', () => {
  it('yazır və oxuyur', async () => {
    const store = new MemoryStore()
    await store.set('provider:x', 'gizli')
    expect(await store.get('provider:x')).toBe('gizli')
  })

  it('olmayan qeyd üçün null qaytarır — ATMIR', async () => {
    expect(await new MemoryStore().get('yoxdur')).toBeNull()
  })

  it('silir və silindikdən sonra null qaytarır', async () => {
    const store = new MemoryStore()
    await store.set('provider:x', 'gizli')
    expect(await store.delete('provider:x')).toBe(true)
    expect(await store.get('provider:x')).toBeNull()
  })

  it('olmayan qeydin silinməsi false qaytarır', async () => {
    expect(await new MemoryStore().delete('yoxdur')).toBe(false)
  })

  it('üzərinə yazma köhnə dəyəri əvəz edir', async () => {
    const store = new MemoryStore()
    await store.set('provider:x', 'birinci')
    await store.set('provider:x', 'ikinci')
    expect(await store.get('provider:x')).toBe('ikinci')
  })

  it('health hər zaman ok-dur', async () => {
    expect((await new MemoryStore().health()).ok).toBe(true)
  })
})

describe('KeyringStore', () => {
  it('CredentialStore interfeysini tam qarşılayır', () => {
    const store = new KeyringStore('orchestris-test-service')
    expect(typeof store.set).toBe('function')
    expect(typeof store.get).toBe('function')
    expect(typeof store.delete).toBe('function')
    expect(typeof store.health).toBe('function')
  })

  it('olmayan qeyd üçün null qaytarır — ATMIR', async () => {
    // Bu, anbara yazmır; yalnız oxuma yolunu yoxlayır. Platformadan asılı
    // olaraq `getPassword` ya `undefined` qaytarır, ya `NoEntry` atır —
    // hər iki hal `null`-a yığılmalıdır.
    const store = new KeyringStore('orchestris-test-service-yoxdur')
    expect(await store.get('heç-vaxt-yazılmayıb')).toBeNull()
  })

  it('olmayan qeydin silinməsi ATMIR', async () => {
    const store = new KeyringStore('orchestris-test-service-yoxdur')
    expect(typeof (await store.delete('heç-vaxt-yazılmayıb'))).toBe('boolean')
  })
})
