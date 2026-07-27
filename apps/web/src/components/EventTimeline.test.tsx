import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@orchestris/shared'
import EventTimeline from './EventTimeline.js'
import type { StoredEventRow } from '../lib/api.js'

function row(seq: number, event: RunEvent): StoredEventRow {
  return { seq, at: 1000, event }
}

describe('EventTimeline', () => {
  it('hadisə yoxdursa boş mesaj göstərir', () => {
    render(<EventTimeline events={[]} />)
    expect(screen.getByText('Hələ hadisə yoxdur.')).toBeInTheDocument()
  })

  it('start: model və sessiya göstərir, yoxdursa "bilinmir"/"yoxdur"', () => {
    render(<EventTimeline events={[row(1, { t: 'start', model: 'sonnet', sessionId: 'sess-1' })]} />)
    expect(screen.getByText('model: sonnet · sessiya: sess-1')).toBeInTheDocument()
  })

  it('start: sahələr yoxdursa fallback mətnləri', () => {
    render(<EventTimeline events={[row(1, { t: 'start' })]} />)
    expect(screen.getByText('model: bilinmir · sessiya: yoxdur')).toBeInTheDocument()
  })

  it('text: delta olduğu kimi göstərilir', () => {
    render(<EventTimeline events={[row(1, { t: 'text', delta: 'salam dünya' })]} />)
    expect(screen.getByText('salam dünya')).toBeInTheDocument()
  })

  it('think: standart olaraq gizlədilir, sayğac görünür', () => {
    render(
      <EventTimeline
        events={[row(1, { t: 'text', delta: 'görünən' }), row(2, { t: 'think', delta: 'gizli fikir' })]}
      />,
    )
    expect(screen.queryByText('gizli fikir')).not.toBeInTheDocument()
    expect(screen.getByText(/Düşünmə addımlarını göstər \(1\)/)).toBeInTheDocument()
  })

  it('think: checkbox işarələnəndə görünür', () => {
    render(<EventTimeline events={[row(1, { t: 'think', delta: 'gizli fikir' })]} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByText('gizli fikir')).toBeInTheDocument()
  })

  it('tool: obyekt input JSON.stringify ilə çökmədən göstərilir', () => {
    render(
      <EventTimeline
        events={[row(1, { t: 'tool', id: 't1', name: 'read_file', input: { path: '/a.ts' } })]}
      />,
    )
    expect(screen.getByText('read_file({"path":"/a.ts"})')).toBeInTheDocument()
  })

  it('result: uğurlu və uğursuz çıxışı fərqli göstərir', () => {
    render(
      <EventTimeline
        events={[
          row(1, { t: 'result', id: 't1', ok: true, output: 'tamam' }),
          row(2, { t: 'result', id: 't2', ok: false, output: 'səhv oldu' }),
        ]}
      />,
    )
    expect(screen.getByText('OK — tamam')).toBeInTheDocument()
    expect(screen.getByText('XƏTA — səhv oldu')).toBeInTheDocument()
  })

  it('usage: costUsd yoxdursa "xərc bilinmir" yazır, $0 YAZMIR', () => {
    render(
      <EventTimeline
        events={[row(1, { t: 'usage', inputTokens: 10, outputTokens: 5, billed: 'real' })]}
      />,
    )
    expect(screen.getByText(/xərc bilinmir/)).toBeInTheDocument()
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument()
  })

  it('usage: abunəlik xərci "xərcləndi" kimi YOX, "abunəlik (istinad ...)" kimi göstərilir', () => {
    render(
      <EventTimeline
        events={[
          row(1, {
            t: 'usage',
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.0085,
            billed: 'subscription',
          }),
        ]}
      />,
    )
    expect(screen.getByText(/abunəlik \(istinad \$0\.00850\)/)).toBeInTheDocument()
  })

  it('usage: real xərc birbaşa $ ilə göstərilir', () => {
    render(
      <EventTimeline
        events={[
          row(1, {
            t: 'usage',
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.0251,
            billed: 'real',
            cacheReadTokens: 3,
          }),
        ]}
      />,
    )
    expect(screen.getByText(/giriş 10 · çıxış 5 · keş oxunuş 3 · \$0\.02510/)).toBeInTheDocument()
  })

  it('rate_limit: bloklanmadıqda BLOKLANDI yazmır', () => {
    render(
      <EventTimeline
        events={[row(1, { t: 'rate_limit', status: 'allowed', blocked: false, limitType: 'requests' })]}
      />,
    )
    expect(screen.getByText('requests: allowed')).toBeInTheDocument()
  })

  it('rate_limit: bloklandıqda BLOKLANDI göstərir', () => {
    render(
      <EventTimeline
        events={[
          row(1, {
            t: 'rate_limit',
            status: 'rejected',
            blocked: true,
            limitType: 'tokens',
            resetsAtUnixSec: 1700000000,
          }),
        ]}
      />,
    )
    expect(screen.getByText(/tokens: rejected \(BLOKLANDI\)/)).toBeInTheDocument()
  })

  it('done: stopReason göstərir', () => {
    render(<EventTimeline events={[row(1, { t: 'done', stopReason: 'end_turn' })]} />)
    expect(screen.getByText('end_turn')).toBeInTheDocument()
  })

  it('error: sinif və mesaj göstərir', () => {
    render(<EventTimeline events={[row(1, { t: 'error', class: 'timeout', message: 'vaxt bitdi' })]} />)
    expect(screen.getByText('[timeout] vaxt bitdi')).toBeInTheDocument()
  })
})
