import { describe, expect, it, vi } from 'vitest'
import { WsHub } from './hub.js'

const sock = () => ({ send: vi.fn() })

describe('WsHub', () => {
  it('yalnız abunə socket-lərə yayımlayır', () => {
    const hub = new WsHub()
    const a = sock()
    const b = sock()
    hub.subscribe('task-1', a)
    hub.subscribe('task-2', b)

    hub.broadcast('task-1', { type: 'error', message: 'x' })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(b.send).not.toHaveBeenCalled()
  })

  it('mesajı JSON kimi göndərir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t', a)
    hub.broadcast('t', { type: 'error', message: 'salam' })
    expect(a.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'salam' }))
  })

  it('eyni socket iki dəfə abunə olsa bir dəfə alır', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t', a)
    hub.subscribe('t', a)
    hub.broadcast('t', { type: 'error', message: 'x' })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(hub.subscriberCount('t')).toBe(1)
  })

  it('unsubscribe abunəliyi silir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t', a)
    hub.unsubscribe('t', a)
    hub.broadcast('t', { type: 'error', message: 'x' })
    expect(a.send).not.toHaveBeenCalled()
    expect(hub.subscriberCount('t')).toBe(0)
  })

  it('removeSocket bütün abunəlikləri təmizləyir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t1', a)
    hub.subscribe('t2', a)
    hub.removeSocket(a)
    expect(hub.subscriberCount('t1')).toBe(0)
    expect(hub.subscriberCount('t2')).toBe(0)
  })

  it('bir socket-in send xətası digərlərini bloklamır', () => {
    const hub = new WsHub()
    const bad = {
      send: vi.fn(() => {
        throw new Error('qırıldı')
      }),
    }
    const good = sock()
    hub.subscribe('t', bad)
    hub.subscribe('t', good)
    expect(() => hub.broadcast('t', { type: 'error', message: 'x' })).not.toThrow()
    expect(good.send).toHaveBeenCalledTimes(1)
  })

  it('abunəsi olmayan task üçün yayım heç nə etmir', () => {
    const hub = new WsHub()
    expect(() => hub.broadcast('yoxdur', { type: 'error', message: 'x' })).not.toThrow()
  })

  it('son abunə çıxdıqda task girişi silinir', () => {
    const hub = new WsHub()
    const a = sock()
    hub.subscribe('t', a)
    hub.unsubscribe('t', a)
    expect(hub.taskCount()).toBe(0)
  })
})
