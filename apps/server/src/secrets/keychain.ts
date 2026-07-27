import { AsyncEntry } from '@napi-rs/keyring'

/**
 * API açarları OS-in öz anbarında saxlanılır: Windows Credential Manager,
 * macOS Keychain, Linux Secret Service.
 *
 * DƏYİŞMƏZ QAYDA (CLAUDE.md 13): açar nə `~/.orchestris/` içinə, nə `.env`-ə,
 * nə də DB-yə yazılır. DB-də yalnız `credential_ref` — anbardakı qeydin adı.
 */
export interface CredentialStore {
  set(ref: string, secret: string): Promise<void>
  /** Qeyd yoxdursa `null` — ATMIR. */
  get(ref: string): Promise<string | null>
  /** Silinən qeyd var idisə `true`. */
  delete(ref: string): Promise<boolean>
  /** Anbarın həqiqətən işlədiyini yoxlayır — `/providers` səhifəsi bunu göstərir. */
  health(): Promise<CredentialStoreHealth>
}

export interface CredentialStoreHealth {
  ok: boolean
  detail: string
}

/** OS anbarında bütün qeydlərimizin altında durduğu ad. */
export const KEYCHAIN_SERVICE = 'orchestris'

/**
 * `health()` yoxlaması üçün istifadə olunan müvəqqəti qeydin adı. Yoxlamadan
 * sonra silinir — istifadəçinin Credential Manager-ində zibil qalmır.
 */
const HEALTH_PROBE_REF = '__orchestris_health_probe__'

/** `credential_ref` düzəldir. Provayder başına bir açar. */
export function credentialRef(providerId: string): string {
  return `provider:${providerId}`
}

export class KeyringStore implements CredentialStore {
  private readonly service: string

  constructor(service = KEYCHAIN_SERVICE) {
    this.service = service
  }

  private entry(ref: string): AsyncEntry {
    return new AsyncEntry(this.service, ref)
  }

  async set(ref: string, secret: string): Promise<void> {
    await this.entry(ref).setPassword(secret)
  }

  async get(ref: string): Promise<string | null> {
    try {
      // Sinxron `Entry` yoxluqda `null` qaytarır, `AsyncEntry` isə tipdə
      // `undefined` vəd edir və bəzi platformalarda `NoEntry` ATIR.
      // Hər üç davranış burada `null`-a yığılır ki, çağıran bir hal bilsin.
      return (await this.entry(ref).getPassword()) ?? null
    } catch {
      return null
    }
  }

  async delete(ref: string): Promise<boolean> {
    try {
      return await this.entry(ref).deleteCredential()
    } catch {
      return false
    }
  }

  /**
   * Anbara REAL yazıb-oxuyub-silərək yoxlayır.
   *
   * Səthi yoxlama (məs. yalnız modulun yüklənməsi) kifayət deyil: başsız
   * Linux mühitində `@napi-rs/keyring` problemsiz yüklənir, amma Secret
   * Service D-Bus-da olmadığı üçün ilk YAZMA sınır. İstifadəçi bunu açarı
   * əlavə edəndə yox, indi bilməlidir.
   *
   * Uğursuzluqda sistem AÇIQ şəkildə xəta verir — səssizcə fayla yazmır.
   */
  async health(): Promise<CredentialStoreHealth> {
    const probe = this.entry(HEALTH_PROBE_REF)
    try {
      await probe.setPassword('probe')
      const read = await probe.getPassword()
      await probe.deleteCredential()
      if (read !== 'probe') {
        return { ok: false, detail: 'OS açar anbarı yazılanı geri qaytarmadı' }
      }
      return { ok: true, detail: `OS açar anbarı işləyir (${this.service})` }
    } catch (err) {
      // Xəta mətnində açar olmur (yalnız "probe" yazdıq), amma yol/servis adı
      // ola bilər — o, həssas deyil.
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        detail: `OS açar anbarı əlçatan deyil: ${message}. Açarlar fayla YAZILMIR — bu mühitdə API provayderləri işlədilə bilməz.`,
      }
    }
  }
}

/**
 * YALNIZ TESTLƏR ÜÇÜN. Real açar saxlamır — proses bitəndə itir.
 *
 * Testlərdə `KeyringStore` işlətmək OLMAZ: o, istifadəçinin real Credential
 * Manager-inə yazardı və CI-da (başsız runner) sınardı.
 */
export class MemoryStore implements CredentialStore {
  private readonly map = new Map<string, string>()

  async set(ref: string, secret: string): Promise<void> {
    this.map.set(ref, secret)
  }

  async get(ref: string): Promise<string | null> {
    return this.map.get(ref) ?? null
  }

  async delete(ref: string): Promise<boolean> {
    return this.map.delete(ref)
  }

  async health(): Promise<CredentialStoreHealth> {
    return { ok: true, detail: 'Yaddaş anbarı (yalnız test)' }
  }
}
