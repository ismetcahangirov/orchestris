import { describe, expect, it } from 'vitest'
import { spawnLines } from './spawn.js'

const NODE = process.execPath

describe('spawnLines', () => {
  it('stdout sətirlərini bir-bir verir', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'console.log("bir");console.log("iki");console.log("uc")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['bir', 'iki', 'uc'])
    expect(await proc.exitCode).toBe(0)
  })

  it('CRLF sətir sonlarını düzgün ayırır', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'process.stdout.write("a\\r\\nb\\r\\n")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['a', 'b'])
  })

  it('stderr-i ayrıca toplayır və stdout ilə qarışdırmır', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'console.error("xeta");console.log("normal")'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['normal'])
    expect(proc.stderrText()).toContain('xeta')
  })

  it('stdin bağlıdır — stdin oxuyan proses donmur', async () => {
    // codex exec stdin gözləyir. stdin: 'ignore' olmasa bu test timeout verər.
    const proc = spawnLines({
      command: NODE,
      args: [
        '-e',
        'process.stdin.on("end",()=>{console.log("stdin bitdi")});process.stdin.resume()',
      ],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) got.push(line)
    expect(got).toEqual(['stdin bitdi'])
  }, 10_000)

  it('kill() prosesi dayandırır və axın bitir', async () => {
    const proc = spawnLines({
      command: NODE,
      args: ['-e', 'setInterval(()=>console.log("tik"),50)'],
      useShell: false,
    })
    const got: string[] = []
    for await (const line of proc.lines) {
      got.push(line)
      if (got.length === 2) await proc.kill()
    }
    expect(got.length).toBeGreaterThanOrEqual(2)
    expect(proc.killed).toBe(true)
  }, 15_000)

  it('mövcud olmayan əmr üçün spawnError verir', async () => {
    const proc = spawnLines({
      command: 'orchestris-nosuchbinary-xyz',
      args: [],
      useShell: false,
    })
    for await (const _ of proc.lines) { /* boş */ }
    expect(await proc.exitCode).not.toBe(0)
    expect(proc.spawnError()?.message).toBeTruthy()
  })
})
