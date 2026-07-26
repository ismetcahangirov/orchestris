import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS, canHandle } from './runner.js'
import type { Capabilities } from './runner.js'

const cliCaps: Capabilities = {
  fileAccess: true,
  toolUse: true,
  sessions: true,
  structuredOutput: true,
  subscriptionBilled: true,
}

const apiCaps: Capabilities = {
  fileAccess: false,
  toolUse: true,
  sessions: false,
  structuredOutput: true,
  subscriptionBilled: false,
}

describe('canHandle', () => {
  it('fayl girişi tələb edən task API runner-ə uyğun gəlmir', () => {
    expect(canHandle(apiCaps, { needsFileAccess: true })).toBe(false)
  })

  it('fayl girişi tələb edən task CLI runner-ə uyğun gəlir', () => {
    expect(canHandle(cliCaps, { needsFileAccess: true })).toBe(true)
  })

  it('heç bir tələb yoxdursa hər ikisi uyğun gəlir', () => {
    expect(canHandle(apiCaps, {})).toBe(true)
    expect(canHandle(cliCaps, {})).toBe(true)
  })

  it('struktur çıxış tələbini yoxlayır', () => {
    const noSchema: Capabilities = { ...apiCaps, structuredOutput: false }
    expect(canHandle(noSchema, { needsStructuredOutput: true })).toBe(false)
  })

  it('sessiya davamı tələbini yoxlayır', () => {
    expect(canHandle(apiCaps, { needsSessions: true })).toBe(false)
    expect(canHandle(cliCaps, { needsSessions: true })).toBe(true)
  })

  it('alət tələbini yoxlayır', () => {
    // Mövcud testlərdə hər iki caps `toolUse: true` idi, ona görə bu şərt
    // heç vaxt icra olunmurdu — funksiya `!caps.fileAccess` oxusa da testlər
    // yaşıl qalardı.
    const noTools: Capabilities = { ...apiCaps, toolUse: false }
    expect(canHandle(noTools, { needsToolUse: true })).toBe(false)
    expect(canHandle(apiCaps, { needsToolUse: true })).toBe(true)
  })

  it('bir neçə tələbdən biri qarşılanmasa false qaytarır', () => {
    expect(
      canHandle(apiCaps, { needsToolUse: true, needsFileAccess: true }),
    ).toBe(false)
  })
})

describe('CAPABILITY_KEYS', () => {
  it('Capabilities tipinin bütün açarlarını sadalayır', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual([
      'fileAccess',
      'sessions',
      'structuredOutput',
      'subscriptionBilled',
      'toolUse',
    ])
  })
})

// Kompilyasiya vaxtı yoxlama: `CAPABILITY_KEYS` `Capabilities` tipinin bütün
// açarlarını əhatə edir. Runtime testi bunu tuta bilmir — tipə yeni sahə
// əlavə edib massivi yeniləməsən, runtime testi yaşıl qalar.
const _capabilityKeysAreExhaustive: Record<
  keyof Capabilities,
  (typeof CAPABILITY_KEYS)[number]
> = {
  fileAccess: 'fileAccess',
  toolUse: 'toolUse',
  sessions: 'sessions',
  structuredOutput: 'structuredOutput',
  subscriptionBilled: 'subscriptionBilled',
}
void _capabilityKeysAreExhaustive
