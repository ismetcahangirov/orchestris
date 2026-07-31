import type { WsServerMessage } from '@orchestris/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ActiveRunRow } from './api.js'

/**
 * Canlı zolağın məlumat yolu: REST ANLIQ ŞƏKİL + qlobal WS.
 *
 * Polling SEÇİLMƏDİ: zolaq HƏR səhifədə mount olunur, yəni heç nə
 * işləməyəndə də daimi sorğu gedərdi. WS boş vaxtda sıfır trafik verir.
 *
 * Anlıq şəkil isə MƏCBURİDİR: WS yalnız dəyişiklikləri yayır, yəni səhifə
 * açılanda artıq işləyən icralar barədə heç bir mesaj gəlməzdi və zolaq
 * yalnız NÖVBƏTİ icra başlayanda dolardı.
 */
export function useActivity(): { runs: ActiveRunRow[]; connected: boolean } {
  const [runs, setRuns] = useState<ActiveRunRow[]>([])
  const [connected, setConnected] = useState(false)

  const snapshot = useQuery({ queryKey: ['runs', 'active'], queryFn: api.listActiveRuns })

  useEffect(() => {
    if (snapshot.data !== undefined) setRuns(snapshot.data.runs)
  }, [snapshot.data])

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'subscribe_activity' }))
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
      if (msg.type !== 'activity') return

      setRuns((prev) => {
        if (msg.kind === 'ended') return prev.filter((r) => r.runId !== msg.runId)
        if (msg.run === undefined) return prev
        // Təkrar `started` (yenidən qoşulma və ya anlıq şəkillə üst-üstə
        // düşmə) sətri İKİLƏŞDİRMƏMƏLİDİR.
        if (prev.some((r) => r.runId === msg.runId)) return prev
        return [...prev, msg.run]
      })
    }

    return () => ws.close()
  }, [])

  return { runs, connected }
}
