import type { Runner } from '@orchestris/shared'
import { describe, expect, it, vi } from 'vitest'
import { FakeRunner } from '../runners/fake.js'
import { RunnerReadiness } from './readiness.js'

function runner(authenticated: boolean): FakeRunner {
  return new FakeRunner({
    events: [],
    detect: { installed: true, authenticated, detail: 'test' },
  })
}

function map(entries: Record<string, Runner>): Map<string, Runner> {
  return new Map(Object.entries(entries))
}

describe('RunnerReadiness', () => {
  it('yoxlamadan ƏVVƏL hamısını hazır sayır', () => {
    // İlk taskı bloklamamaq üçün: `detect()` proses spawn edir və nəticə hələ
    // yoxdursa optimist davranmaq icra xətası ilə bitir, gözləmə ilə yox.
    const readiness = new RunnerReadiness(map({ 'cli:x': runner(false) }))
    expect(readiness.isReady('cli:x')).toBe(true)
  })

  it('yoxlamadan sonra auth olmayanı hazır saymır', async () => {
    const readiness = new RunnerReadiness(map({ 'cli:x': runner(false) }))
    await readiness.refresh()
    expect(readiness.isReady('cli:x')).toBe(false)
  })

  it('auth olanı hazır sayır', async () => {
    const readiness = new RunnerReadiness(map({ 'cli:x': runner(true) }))
    await readiness.refresh()
    expect(readiness.isReady('cli:x')).toBe(true)
  })

  it('TTL bitməmiş TƏKRAR detect ÇAĞIRMIR', async () => {
    // `ClaudeCliRunner.detect()` hər çağırışda proses spawn edir. Hər taskda
    // çağırmaq routing-i ödənişsiz, amma yavaş edərdi.
    const r = runner(true)
    const spy = vi.spyOn(r, 'detect')
    const readiness = new RunnerReadiness(map({ 'cli:x': r }), { ttlMs: 60_000 })

    await readiness.refresh()
    await readiness.refresh()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('TTL bitəndən sonra yenidən yoxlayır', async () => {
    const r = runner(true)
    const spy = vi.spyOn(r, 'detect')
    let clock = 1000
    const readiness = new RunnerReadiness(map({ 'cli:x': r }), {
      ttlMs: 100,
      now: () => clock,
    })

    await readiness.refresh()
    clock += 500
    await readiness.refresh()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('detect ATSA runner-i hazır saymır və çökmür', async () => {
    const broken: Runner = {
      id: 'cli:broken',
      kind: 'cli',
      capabilities: runner(true).capabilities,
      detect: async () => {
        throw new Error('spawn ENOENT')
      },
      run: runner(true).run.bind(runner(true)),
    }
    const readiness = new RunnerReadiness(map({ 'cli:broken': broken }))
    await readiness.refresh()
    expect(readiness.isReady('cli:broken')).toBe(false)
  })

  it('paralel refresh çağırışları bir dəfə yoxlayır', async () => {
    const r = runner(true)
    const spy = vi.spyOn(r, 'detect')
    const readiness = new RunnerReadiness(map({ 'cli:x': r }))

    await Promise.all([readiness.refresh(), readiness.refresh(), readiness.refresh()])
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
