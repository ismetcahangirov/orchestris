import { describe, expect, it } from 'vitest'
import { ClaudeMemProvider } from './claude-mem.js'
import { memoryFromEnv } from './config.js'

describe('memoryFromEnv', () => {
  it('env verilməyibsə yaddaş SÖNDÜRÜLÜDÜR', () => {
    // Default yaddaşsızdır: taskların mətnini xarici anbara yazmaq istifadəçinin
    // AÇIQ qərarı olmalıdır.
    expect(memoryFromEnv({})).toBeUndefined()
    expect(memoryFromEnv({ ORCHESTRIS_MEMORY: 'off' })).toBeUndefined()
    expect(memoryFromEnv({ ORCHESTRIS_MEMORY: '  ' })).toBeUndefined()
  })

  it('naməlum provayder SƏSSİZ keçmir', () => {
    // Səhv yazılmış ad (`claude_mem`) səssizcə "yaddaş yoxdur"a çevrilsəydi,
    // istifadəçi yaddaşın işlədiyini sanardı.
    expect(() => memoryFromEnv({ ORCHESTRIS_MEMORY: 'claude_mem' })).toThrow('naməlum provayder')
  })

  it('claude-mem provayderini qurur', () => {
    const provider = memoryFromEnv({
      ORCHESTRIS_MEMORY: 'claude-mem',
      ORCHESTRIS_CLAUDE_MEM_URL: 'http://127.0.0.1:9999',
      ORCHESTRIS_CLAUDE_MEM_MIN_VERSION: '4.2.0',
      ORCHESTRIS_MEMORY_WRITE_COST_USD: '0',
    })

    expect(provider).toBeInstanceOf(ClaudeMemProvider)
    expect((provider as ClaudeMemProvider).config).toMatchObject({
      baseUrl: 'http://127.0.0.1:9999',
      minVersion: '4.2.0',
      declaredWriteCostUsd: 0,
    })
  })

  it('minimum versiya verilməsə provayder QURULUR, amma `health` sınır', async () => {
    // Server yaddaşsız da tam işləkdir — burada xəta atmaq bütün serveri
    // dayandırardı. Qapı `health()`-dədir.
    const provider = memoryFromEnv({ ORCHESTRIS_MEMORY: 'claude-mem' })

    expect(provider).toBeInstanceOf(ClaudeMemProvider)
    expect(await provider?.health()).toMatchObject({ ok: false })
  })
})
