import type { RunEvent } from '@orchestris/shared'
import { useState } from 'react'
import type { StoredEventRow } from '../lib/api.js'
import { mergeDeltas } from '../lib/mergeDeltas.js'

const LABEL: Record<RunEvent['t'], string> = {
  start: 'Başladı',
  text: 'Cavab',
  think: 'Düşünmə',
  tool: 'Alət',
  result: 'Alət nəticəsi',
  usage: 'İstifadə',
  rate_limit: 'Limit',
  done: 'Bitdi',
  error: 'Xəta',
}

const TONE: Record<RunEvent['t'], string> = {
  start: 'text-ink-dim',
  text: 'text-ink',
  think: 'text-ink-dim italic',
  tool: 'text-accent',
  result: 'text-ink-dim',
  usage: 'text-ink-dim',
  rate_limit: 'text-warn',
  done: 'text-good',
  error: 'text-bad',
}

function summary(e: RunEvent): string {
  switch (e.t) {
    case 'start':
      return `model: ${e.model ?? 'bilinmir'} · sessiya: ${e.sessionId ?? 'yoxdur'}`
    case 'text':
    case 'think':
      return e.delta
    case 'tool':
      // `input` sxemdə MƏCBURİ obyektdir, ona görə JSON.stringify təhlükəsizdir.
      return `${e.name}(${JSON.stringify(e.input).slice(0, 120)})`
    case 'result':
      return `${e.ok ? 'OK' : 'XƏTA'} — ${(e.output ?? '').slice(0, 160)}`
    case 'usage': {
      // `costUsd` yoxluğu "bilinmir" deməkdir — `$0` yazmaq yalan olardı.
      const cost =
        e.costUsd === undefined
          ? 'xərc bilinmir'
          : e.billed === 'subscription'
            ? `abunəlik (istinad $${e.costUsd.toFixed(5)})`
            : `$${e.costUsd.toFixed(5)}`
      return `giriş ${e.inputTokens} · çıxış ${e.outputTokens} · keş oxunuş ${
        e.cacheReadTokens ?? 0
      } · ${cost}`
    }
    case 'rate_limit': {
      const when =
        e.resetsAtUnixSec === undefined
          ? ''
          : ` · sıfırlanır ${new Date(e.resetsAtUnixSec * 1000).toLocaleTimeString('az')}`
      // Bu hadisə sağlam icrada da gəlir — yalnız `blocked` bloklayıcıdır.
      return `${e.limitType}: ${e.status}${e.blocked ? ' (BLOKLANDI)' : ''}${when}`
    }
    case 'done':
      return e.stopReason
    case 'error':
      return `[${e.class}] ${e.message}`
  }
}

export default function EventTimeline({
  events,
}: {
  events: readonly StoredEventRow[]
}): React.JSX.Element {
  const [showThinking, setShowThinking] = useState(false)
  const merged = mergeDeltas(events)
  const visible = showThinking ? merged : merged.filter((r) => r.event.t !== 'think')
  const thinkCount = merged.length - merged.filter((r) => r.event.t !== 'think').length

  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          checked={showThinking}
          onChange={(e) => setShowThinking(e.target.checked)}
        />
        Düşünmə addımlarını göstər{thinkCount > 0 ? ` (${thinkCount})` : ''}
      </label>

      <ol className="space-y-1 font-mono text-xs">
        {visible.map((row) => (
          <li key={row.seq} className="flex gap-2">
            <span className="w-8 shrink-0 text-right text-ink-dim">{row.seq}</span>
            <span className="w-28 shrink-0 text-ink-dim">{LABEL[row.event.t]}</span>
            <span className={`min-w-0 break-all ${TONE[row.event.t]}`}>
              {summary(row.event)}
            </span>
          </li>
        ))}
      </ol>

      {visible.length === 0 && <p className="text-sm text-ink-dim">Hələ hadisə yoxdur.</p>}
    </div>
  )
}
