import { describe, expect, it } from 'vitest'
import { buildCodexArgs, CODEX_STABLE_FLAGS, parseLoginStatus } from './codex.js'

describe('CODEX_STABLE_FLAGS', () => {
  it('--json daxildir', () => {
    expect(CODEX_STABLE_FLAGS).toContain('--json')
  })

  it('--skip-git-repo-check daxildir — repo olmayan qovluqda da işləsin', () => {
    expect(CODEX_STABLE_FLAGS).toContain('--skip-git-repo-check')
  })
})

describe('buildCodexArgs', () => {
  it('exec subkomandası ilə başlayır', () => {
    expect(buildCodexArgs({ prompt: 'x', model: 'm' })[0]).toBe('exec')
  })

  it('promptu SON arqument kimi verir', () => {
    const args = buildCodexArgs({ prompt: 'salam dunya', model: 'm' })
    expect(args.at(-1)).toBe('salam dunya')
  })

  it('model bayrağını əlavə edir', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'gpt-5.2-codex' })
    const i = args.indexOf('--model')
    expect(args[i + 1]).toBe('gpt-5.2-codex')
  })

  it('default sandbox read-only-dir — təsadüfi fayl dəyişikliyi olmasın', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'm' })
    const i = args.indexOf('--sandbox')
    expect(args[i + 1]).toBe('read-only')
  })

  it('workspace-write açıq şəkildə tələb olunanda ötürülür', () => {
    const args = buildCodexArgs(
      { prompt: 'x', model: 'm' },
      { sandbox: 'workspace-write' },
    )
    const i = args.indexOf('--sandbox')
    expect(args[i + 1]).toBe('workspace-write')
  })

  it('outputSchemaPath verildikdə --output-schema əlavə edir', () => {
    const args = buildCodexArgs(
      { prompt: 'x', model: 'm' },
      { outputSchemaPath: '/tmp/s.json' },
    )
    const i = args.indexOf('--output-schema')
    expect(args[i + 1]).toBe('/tmp/s.json')
  })

  it('resumeSessionId verildikdə exec resume formasını qurur', () => {
    const args = buildCodexArgs({ prompt: 'x', model: 'm', resumeSessionId: 'th_5' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'th_5'])
  })
})

describe('parseLoginStatus', () => {
  it('"Not logged in" mətnini authenticated:false kimi oxuyur', () => {
    expect(parseLoginStatus('Not logged in', 0)).toBe(false)
  })

  it('login olunmuş cavabı authenticated:true kimi oxuyur', () => {
    expect(parseLoginStatus('Logged in using ChatGPT account', 0)).toBe(true)
  })

  it('sıfırdan fərqli çıxış kodunu authenticated:false kimi sayır', () => {
    expect(parseLoginStatus('', 1)).toBe(false)
  })

  it('böyük-kiçik hərf fərqinə həssas deyil', () => {
    expect(parseLoginStatus('NOT LOGGED IN', 0)).toBe(false)
  })
})
