import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunStream } from './useRunStream.js'

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent<string>)
  }
}

describe('useRunStream', () => {
  const originalWebSocket = globalThis.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error - test double, real WebSocket sinifi əvəz olunur
    globalThis.WebSocket = MockWebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.restoreAllMocks()
  })

  it('taskId olmadıqda qoşulmur', () => {
    const { result } = renderHook(() => useRunStream(undefined))
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(result.current.connected).toBe(false)
    expect(result.current.runs.size).toBe(0)
  })

  it('açılışda subscribe göndərir və connected=true olur', () => {
    const { result } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!

    act(() => ws.open())

    expect(result.current.connected).toBe(true)
    expect(ws.sent).toEqual([JSON.stringify({ type: 'subscribe', taskId: 'task-1' })])
  })

  it('eyni seq təkrar gəldikdə hadisə bir dəfə əlavə olunur', () => {
    const { result } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!
    act(() => ws.open())

    const msg = {
      type: 'event',
      taskId: 'task-1',
      runId: 'run-1',
      seq: 1,
      at: 100,
      event: { t: 'text', delta: 'salam' },
    }

    act(() => ws.emit(msg))
    act(() => ws.emit(msg))

    expect(result.current.runs.get('run-1')?.events).toHaveLength(1)
  })

  it('fərqli seq-lər eyni run altında toplanır', () => {
    const { result } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!
    act(() => ws.open())

    act(() =>
      ws.emit({
        type: 'event',
        taskId: 'task-1',
        runId: 'run-1',
        seq: 1,
        at: 100,
        event: { t: 'start', model: 'x' },
      }),
    )
    act(() =>
      ws.emit({
        type: 'event',
        taskId: 'task-1',
        runId: 'run-1',
        seq: 2,
        at: 200,
        event: { t: 'done', stopReason: 'end_turn' },
      }),
    )

    expect(result.current.runs.get('run-1')?.events).toHaveLength(2)
  })

  it('type !== "event" olan mesajlar atılır', () => {
    const { result } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!
    act(() => ws.open())

    act(() => ws.emit({ type: 'error', message: 'boom' }))

    expect(result.current.runs.size).toBe(0)
  })

  it('pozulan JSON səssizcə atılır, hook çökmür', () => {
    const { result } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!
    act(() => ws.open())

    act(() => ws.onmessage?.({ data: '{not json' } as MessageEvent<string>))

    expect(result.current.runs.size).toBe(0)
  })

  it('taskId dəyişəndə köhnə soket unsubscribe göndərib bağlanır, vəziyyət sıfırlanır', () => {
    const { result, rerender } = renderHook(({ taskId }) => useRunStream(taskId), {
      initialProps: { taskId: 'task-1' },
    })
    const first = MockWebSocket.instances[0]!
    act(() => first.open())
    act(() =>
      first.emit({
        type: 'event',
        taskId: 'task-1',
        runId: 'run-1',
        seq: 1,
        at: 100,
        event: { t: 'start' },
      }),
    )
    expect(result.current.runs.size).toBe(1)

    rerender({ taskId: 'task-2' })

    expect(first.sent).toEqual([
      JSON.stringify({ type: 'subscribe', taskId: 'task-1' }),
      JSON.stringify({ type: 'unsubscribe', taskId: 'task-1' }),
    ])
    expect(first.readyState).toBe(MockWebSocket.CLOSED)
    expect(result.current.runs.size).toBe(0)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('unmount zamanı bağlı olmayan soketə unsubscribe göndərilmir', () => {
    const { unmount } = renderHook(() => useRunStream('task-1'))
    const ws = MockWebSocket.instances[0]!
    // ws.open() heç vaxt çağırılmayıb — readyState hələ 0 (CONNECTING)

    unmount()

    expect(ws.sent).toEqual([])
  })
})
