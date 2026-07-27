import type { WsServerMessage } from '@orchestris/shared'
import { useEffect, useRef, useState } from 'react'
import type { StoredEventRow } from './api.js'

export interface LiveRun {
  runId: string
  events: StoredEventRow[]
}

/**
 * Task-a WebSocket ilə abunə olur və hadisələri run-a görə qruplaşdırır.
 *
 * `seq` run daxilində unikaldır — yenidən qoşulma halında təkrar gələn
 * hadisə atılır.
 */
export function useRunStream(taskId: string | undefined): {
  runs: Map<string, LiveRun>
  connected: boolean
} {
  const [runs, setRuns] = useState<Map<string, LiveRun>>(new Map())
  const [connected, setConnected] = useState(false)
  const seenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (taskId === undefined) return
    seenRef.current = new Set()
    setRuns(new Map())

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'subscribe', taskId }))
    }
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    ws.onmessage = (raw: MessageEvent<string>) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(raw.data) as WsServerMessage
      } catch {
        return
      }
      if (msg.type !== 'event') return

      const key = `${msg.runId}#${msg.seq}`
      if (seenRef.current.has(key)) return
      seenRef.current.add(key)

      setRuns((prev) => {
        const next = new Map(prev)
        const existing = next.get(msg.runId) ?? { runId: msg.runId, events: [] }
        next.set(msg.runId, {
          runId: msg.runId,
          events: [...existing.events, { seq: msg.seq, at: msg.at, event: msg.event }],
        })
        return next
      })
    }

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', taskId }))
      }
      ws.close()
    }
  }, [taskId])

  return { runs, connected }
}
