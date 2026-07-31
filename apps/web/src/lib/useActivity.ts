import type { WsServerMessage } from '@orchestris/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
export function useActivity(): {
  runs: ActiveRunRow[]
  /**
   * Cavab gözləyən sualların sayı (Faza 5B).
   *
   * `runs`-dan HESABLANA BİLMƏZ: sualı verən icra ARTIQ bitib
   * (`status = 'succeeded'`), yəni `/api/runs/active` onu görmür.
   */
  pendingQuestions: number
  connected: boolean
} {
  const qc = useQueryClient()
  const [runs, setRuns] = useState<ActiveRunRow[]>([])
  const [connected, setConnected] = useState(false)

  const snapshot = useQuery({ queryKey: ['runs', 'active'], queryFn: api.listActiveRuns })
  const questions = useQuery({
    queryKey: ['questions', 'pending'],
    queryFn: api.listPendingQuestions,
  })

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
      // Sual hadisəsi (Faza 5B) — sayğac serverdən yenidən oxunur. Sayı
      // mesajdan HESABLAMIRIQ: `asked`/`answered` ardıcıllığı bağlantı
      // kəsilməsində itə bilər və sayğac səssizcə sürüşərdi.
      if (msg.type === 'question') {
        void qc.invalidateQueries({ queryKey: ['questions', 'pending'] })
        void qc.invalidateQueries({ queryKey: ['task', msg.taskId] })
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
  }, [qc])

  return {
    runs,
    pendingQuestions: questions.data?.questions.length ?? 0,
    connected,
  }
}
