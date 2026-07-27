import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFeedbackPrompt, runVerifications } from './verify.js'

const NODE = process.execPath
const okCmd = `"${NODE}" -e "console.log('hamisi yaxsidir')"`
const failCmd = `"${NODE}" -e "console.error('TS2345: tip uygunsuzlugu');process.exit(2)"`
const slowCmd = `"${NODE}" -e "setTimeout(()=>{},60000)"`

const tmp = (): string => mkdtempSync(join(tmpdir(), 'orch-verify-'))

describe('runVerifications', () => {
  it('boş əmr siyahısı üçün keçmiş sayılır', async () => {
    const r = await runVerifications([], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results).toEqual([])
    expect(r.aborted).toBe(false)
  })

  it('uğurlu əmri passed:true kimi yazır', async () => {
    const r = await runVerifications([okCmd], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results[0]?.exitCode).toBe(0)
    expect(r.results[0]?.output).toContain('hamisi yaxsidir')
  })

  it('uğursuz əmri passed:false kimi yazır və stderr-i saxlayır', async () => {
    const r = await runVerifications([failCmd], { cwd: tmp() })
    expect(r.passed).toBe(false)
    expect(r.results[0]?.exitCode).toBe(2)
    expect(r.results[0]?.output).toContain('TS2345')
  })

  it('bir əmr uğursuz olsa qalanları QAÇIRMIR — tez dayanır', async () => {
    // Səbəb: tsc sınıbsa test qaçırmaq mənasızdır və vaxt itkisidir.
    const r = await runVerifications([failCmd, okCmd], { cwd: tmp() })
    expect(r.passed).toBe(false)
    expect(r.results).toHaveLength(1)
  })

  it('bütün əmrlər uğurlu olsa hamısını qaçırır', async () => {
    const r = await runVerifications([okCmd, okCmd], { cwd: tmp() })
    expect(r.passed).toBe(true)
    expect(r.results).toHaveLength(2)
  })

  it('müddəti ölçür', async () => {
    const r = await runVerifications([okCmd], { cwd: tmp() })
    expect(r.results[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('timeout-a düşən əmri uğursuz sayır və prosesi öldürür', async () => {
    const r = await runVerifications([slowCmd], { cwd: tmp(), timeoutMs: 500 })
    expect(r.passed).toBe(false)
    expect(r.results[0]?.output).toMatch(/timeout|vaxt/i)
    // Timeout ləğv (abort) DEYİL — səbəb səhv yazılmamalıdır.
    expect(r.results[0]?.output).not.toMatch(/ləğv/i)
    expect(r.aborted).toBe(false)
  }, 15_000)

  it('mövcud olmayan əmr üçün uğursuz qaytarır, çökmür', async () => {
    const r = await runVerifications(['orchestris-nosuchcommand-xyz'], { cwd: tmp() })
    expect(r.passed).toBe(false)
  })

  it('signal ilə yarıda kəsilir', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runVerifications([okCmd], { cwd: tmp(), signal: ac.signal })
    expect(r.results).toHaveLength(0)
    // Heç nə qaçmadı — bu "hamısı keçdi" demək deyil, çağıran `aborted`-u
    // yoxlamalıdır ki, boş massivdəki vacuous `passed:true`-a aldanmasın.
    expect(r.aborted).toBe(true)
  })

  it('bir əmr artıq keçdikdən sonra siqnal ləğv edilsə qalanı işə salmır', async () => {
    const ac = new AbortController()
    // okCmd dərhal bitir; slowCmd başlayandan qısa müddət sonra ləğv edirik
    // ki, "bir əmr keçib, sonra ikinci əmr icra ZAMANI ləğv olunub" halını
    // yoxlayaq (fərqli path: mid-loop abort, siqnal əvvəldən aktiv deyil).
    setTimeout(() => ac.abort(), 200)
    const r = await runVerifications([okCmd, slowCmd, okCmd], {
      cwd: tmp(),
      signal: ac.signal,
    })
    expect(r.results).toHaveLength(2)
    expect(r.results[0]?.passed).toBe(true)
    expect(r.results[1]?.passed).toBe(false)
    expect(r.results[1]?.output).toMatch(/ləğv/i)
    expect(r.aborted).toBe(true)
    expect(r.passed).toBe(false)
  })
})

describe('buildFeedbackPrompt', () => {
  it('uğursuz əmri və çıxışını promptda göstərir', () => {
    const p = buildFeedbackPrompt([
      { command: 'pnpm typecheck', exitCode: 2, passed: false, output: 'TS2345 xəta', durationMs: 1 },
    ])
    expect(p).toContain('pnpm typecheck')
    expect(p).toContain('TS2345 xəta')
  })

  it('yalnız uğursuz əmrləri daxil edir', () => {
    const p = buildFeedbackPrompt([
      { command: 'ok-cmd', exitCode: 0, passed: true, output: 'fine', durationMs: 1 },
      { command: 'bad-cmd', exitCode: 1, passed: false, output: 'boom', durationMs: 1 },
    ])
    expect(p).not.toContain('ok-cmd')
    expect(p).toContain('bad-cmd')
  })

  it('çox uzun çıxışı kəsir ki, kontekst şişməsin', () => {
    const p = buildFeedbackPrompt([
      { command: 'c', exitCode: 1, passed: false, output: 'x'.repeat(20_000), durationMs: 1 },
    ])
    expect(p.length).toBeLessThan(5000)
  })

  it('heç bir uğursuzluq yoxdursa boş sətir qaytarır', () => {
    expect(
      buildFeedbackPrompt([
        { command: 'c', exitCode: 0, passed: true, output: '', durationMs: 1 },
      ]),
    ).toBe('')
  })
})
