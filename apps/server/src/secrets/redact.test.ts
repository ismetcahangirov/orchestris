import { describe, expect, it } from 'vitest'
import { redactAll, redactApiKeys, redactSecret } from './redact.js'

const ANTHROPIC = 'sk-ant-api03-AbCdEf0123456789_-XyZ'
const OPENAI_PROJ = 'sk-proj-QWERTYuiop1234567890asdf'
const GOOGLE = 'AIzaSyA1B2C3D4E5F6G7H8I9J0KlMnOpQrStUv'

describe('redactApiKeys', () => {
  it('Anthropic açarını maskalayır', () => {
    const out = redactApiKeys(`Xəta: invalid key ${ANTHROPIC} göndərildi`)
    expect(out).not.toContain(ANTHROPIC)
    expect(out).toContain('[API-ACARI-KESILDI]')
  })

  it('OpenAI proyekt açarını maskalayır və qalıq buraxmır', () => {
    const out = redactApiKeys(`Incorrect API key provided: ${OPENAI_PROJ}`)
    expect(out).not.toContain(OPENAI_PROJ)
    // Ümumi `sk-` naxışı spesifik naxışdan sonra işləsəydi, `-proj-...`
    // hissəsi mətndə qalardı. Qalıq yoxlanılır.
    expect(out).not.toContain('QWERTYuiop')
  })

  it('Google açarını maskalayır', () => {
    expect(redactApiKeys(`key=${GOOGLE}`)).not.toContain(GOOGLE)
  })

  it('bir mətndə bir neçə açarı maskalayır', () => {
    const out = redactApiKeys(`${ANTHROPIC} və ${GOOGLE}`)
    expect(out).not.toContain(ANTHROPIC)
    expect(out).not.toContain(GOOGLE)
  })

  it('açar olmayan mətnə toxunmur', () => {
    const text = '429 rate limit exceeded, cf-ray: a2140175bd9ce8ee'
    expect(redactApiKeys(text)).toBe(text)
  })
})

describe('redactSecret', () => {
  it('naxış tanınmasa da KONKRET açarı kəsir', () => {
    const weird = 'tamamile-ozune-mexsus-acar-formati-12345'
    const out = redactSecret(`Auth failed for ${weird}`, weird)
    expect(out).not.toContain(weird)
  })

  it('eyni açarın bütün təkrarlarını kəsir', () => {
    const key = 'gizli-acar-123456'
    const out = redactSecret(`${key} ... yenə ${key}`, key)
    expect(out).not.toContain(key)
    expect(out.match(/\[API-ACARI-KESILDI\]/g)).toHaveLength(2)
  })

  it('null/undefined açarla mətni dəyişmir', () => {
    expect(redactSecret('salam', null)).toBe('salam')
    expect(redactSecret('salam', undefined)).toBe('salam')
  })

  it('çox qısa açarı gözardı edir — mətni oxunmaz etmir', () => {
    // Açar `test` olsaydı, `latest` sözü də kəsilərdi.
    expect(redactSecret('npm install latest', 'test')).toBe('npm install latest')
  })
})

describe('redactAll', () => {
  it('həm konkret açarı, həm naxışı tətbiq edir', () => {
    const custom = 'ozel-acar-abcdefgh'
    const out = redactAll(`${custom} və ${ANTHROPIC}`, custom)
    expect(out).not.toContain(custom)
    expect(out).not.toContain(ANTHROPIC)
  })

  it('açar verilməsə də naxışlar işləyir', () => {
    expect(redactAll(`key ${ANTHROPIC}`)).not.toContain(ANTHROPIC)
  })
})
