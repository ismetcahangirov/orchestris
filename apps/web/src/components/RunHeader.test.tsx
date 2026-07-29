import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RunHeader from './RunHeader.js'
import type { RunRow } from '../lib/api.js'

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run1',
    taskId: 'task1',
    runnerId: 'api:anthropic',
    modelId: 'haiku',
    status: 'succeeded',
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUsd: 0,
    subscriptionBilled: false,
    sessionId: null,
    errorClass: null,
    errorMessage: null,
    startedAt: 0,
    endedAt: null,
    events: [],
    ladderRung: 2,
    attempt: 1,
    cachedHit: false,
    escalatedFromRunId: null,
    verifications: [],
    ...over,
  } as RunRow
}

describe('RunHeader — pillə nişanı', () => {
  it('Pillə 4-ü ipucu (shepherding) kimi adlandırır', () => {
    // Nişan olmasa istifadəçi başçının qısa ipucu icrasını adi başçı icrası
    // kimi oxuyar və "niyə iki başçı icrası var?" sualı cavabsız qalar.
    render(<RunHeader run={run({ ladderRung: 4 })} />)

    expect(screen.getByText(/Pillə 4 — ipucu/)).toBeTruthy()
  })

  it('naməlum pilləni nömrəsi ilə göstərir', () => {
    render(<RunHeader run={run({ ladderRung: 5 })} />)

    expect(screen.getByText('Pillə 5')).toBeTruthy()
  })
})
