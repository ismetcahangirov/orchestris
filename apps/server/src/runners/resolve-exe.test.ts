import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractExeFromCmdShim, resolveExecutable } from './resolve-exe.js'

describe('extractExeFromCmdShim', () => {
  it('npm .cmd shim-indən hədəf .exe yolunu çıxarır', () => {
    // Real npm shim məzmunu (claude.cmd faylından götürülüb)
    const shim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    ].join('\r\n')

    const got = extractExeFromCmdShim(shim, 'C:\\npm')
    expect(got).toBe(
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    )
  })

  it('.exe istinadı olmayan shim üçün null qaytarır', () => {
    expect(extractExeFromCmdShim('@ECHO off\r\nnode index.js %*', 'C:\\x')).toBeNull()
  })

  it('%~dp0 formasını da qəbul edir', () => {
    const shim = '"%~dp0\\bin\\tool.exe" %*'
    expect(extractExeFromCmdShim(shim, 'D:\\apps')).toBe('D:\\apps\\bin\\tool.exe')
  })
})

describe('resolveExecutable', () => {
  it('PATH-da .exe varsa onu birbaşa qaytarır, shell tələb etmir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-exe-'))
    const exe = join(dir, 'widget.exe')
    writeFileSync(exe, '')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({ command: exe, useShell: false, via: 'direct-exe' })
  })

  it('yalnız .cmd shim varsa onu oxuyub .exe-yə çevirir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-shim-'))
    mkdirSync(join(dir, 'bin'))
    const target = join(dir, 'bin', 'widget.exe')
    writeFileSync(target, '')
    writeFileSync(join(dir, 'widget.cmd'), '"%dp0%\\bin\\widget.exe" %*')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({ command: target, useShell: false, via: 'cmd-shim' })
  })

  it('heç nə tapılmasa null qaytarır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-empty-'))
    expect(resolveExecutable('nosuchtool', [dir])).toBeNull()
  })

  it('shim hədəfi mövcud deyilsə shell fallback-ə keçir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-broken-'))
    writeFileSync(join(dir, 'widget.cmd'), '"%dp0%\\bin\\gone.exe" %*')
    const got = resolveExecutable('widget', [dir])
    expect(got).toEqual({
      command: join(dir, 'widget.cmd'),
      useShell: true,
      via: 'shell-fallback',
    })
  })
})
