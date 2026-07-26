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
