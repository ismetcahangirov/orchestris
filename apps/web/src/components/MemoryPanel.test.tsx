import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MemoryPanel from './MemoryPanel.js'
import type { MemoryOpRow } from '../lib/api.js'

function op(over: Partial<MemoryOpRow> = {}): MemoryOpRow {
  return {
    id: 1,
    provider: 'claude-mem',
    kind: 'recall',
    scope: 'orchestris',
    items: 3,
    tokens: 120,
    costUsd: 0,
    ok: true,
    detail: null,
    at: 0,
    ...over,
  }
}

describe('MemoryPanel', () => {
  it('əməliyyat yoxdursa GÖSTƏRİLMİR — boş "yaddaş: 0" sətri səs-küydür', () => {
    const { container } = render(<MemoryPanel ops={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('oxunan qeydləri və token dəyərini göstərir', () => {
    render(<MemoryPanel ops={[op()]} />)

    expect(screen.getByText('recall')).toBeTruthy()
    expect(screen.getByText('120')).toBeTruthy()
    expect(screen.getByText('orchestris')).toBeTruthy()
  })

  it('naməlum xərc `$0` kimi GÖSTƏRİLMİR', () => {
    // `$0.0000` "pulsuz" kimi oxunardı — halbuki sıxma model çağırışıdır.
    render(<MemoryPanel ops={[op({ kind: 'remember', costUsd: null })]} />)

    expect(screen.getByText('bilinmir')).toBeTruthy()
  })

  it('sınmış əməliyyatın SƏBƏBİ görünür', () => {
    render(<MemoryPanel ops={[op({ ok: false, detail: 'ECONNREFUSED' })]} />)

    expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy()
  })
})
