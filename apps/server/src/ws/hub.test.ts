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

describe('qlobal kanal — canlı zolaq', () => {
  const ACTIVITY = { type: 'activity', kind: 'ended', runId: 'r1' } as const

  it('yalnız qlobal abunələr activity alır', () => {
    const hub = new WsHub()
    const globalSent: string[] = []
    const taskSent: string[] = []
    hub.subscribeGlobal({ send: (d: string) => globalSent.push(d) })
    hub.subscribe('task-1', { send: (d: string) => taskSent.push(d) })

    hub.broadcastGlobal(ACTIVITY)

    expect(globalSent).toHaveLength(1)
    expect(taskSent).toHaveLength(0)
  })

  it('task yayımı qlobal abunəyə GETMİR — deltalar zolağa düşməməlidir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    hub.subscribeGlobal({ send: (d: string) => sent.push(d) })

    hub.broadcast('task-1', {
      type: 'event',
      taskId: 'task-1',
      runId: 'r1',
      seq: 1,
      at: 1,
      event: { t: 'text', delta: 'salam' },
    })

    expect(sent).toHaveLength(0)
  })

  it('unsubscribeGlobal abunəliyi kəsir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    const g = { send: (d: string) => sent.push(d) }
    hub.subscribeGlobal(g)
    hub.unsubscribeGlobal(g)
    hub.broadcastGlobal(ACTIVITY)
    expect(sent).toHaveLength(0)
  })

  it('removeSocket qlobal dəsti də təmizləyir', () => {
    const hub = new WsHub()
    const sent: string[] = []
    const g = { send: (d: string) => sent.push(d) }
    hub.subscribeGlobal(g)
    hub.removeSocket(g)
    hub.broadcastGlobal(ACTIVITY)
    expect(sent).toHaveLength(0)
    expect(hub.globalCount()).toBe(0)
  })

  it('sınıq socket digərlərini dayandırmır', () => {
    const hub = new WsHub()
    const ok: string[] = []
    hub.subscribeGlobal({
      send: () => {
        throw new Error('bağlı')
      },
    })
    hub.subscribeGlobal({ send: (d: string) => ok.push(d) })
    hub.broadcastGlobal(ACTIVITY)
    expect(ok).toHaveLength(1)
  })
})
