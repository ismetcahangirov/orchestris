import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunRow } from '../lib/api.js'
import UsageBadge from './UsageBadge.js'

function makeRun(overrides: Partial<RunRow>): RunRow {
  return {
    id: 'run-1',
    runnerId: 'cli:claude',
    modelId: 'sonnet',
    status: 'done',
    tokensIn: 100,
    tokensOut: 50,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUsd: null,
    subscriptionBilled: false,
    sessionId: null,
    errorClass: null,
    errorMessage: null,
    startedAt: 0,
    endedAt: null,
    events: [],
    ladderRung: 0,
    attempt: 1,
    cachedHit: false,
    verifications: [],
    ...overrides,
  }
}

describe('UsageBadge', () => {
  it('keş yoxdursa effektivlik 0% göstərir', () => {
    render(<UsageBadge run={makeRun({})} />)
    expect(screen.getByText('keş effektivliyi 0%')).toBeInTheDocument()
  })

  it('keş nisbətini düzgün faizləyir', () => {
    render(<UsageBadge run={makeRun({ tokensCacheRead: 90, tokensCacheWrite: 10 })} />)
    expect(screen.getByText('keş effektivliyi 90%')).toBeInTheDocument()
  })

  it('costUsd null-dursa "$0" YOX, "xərc bilinmir" göstərir', () => {
    render(<UsageBadge run={makeRun({ costUsd: null })} />)
    expect(screen.getByText('xərc bilinmir')).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.00000/)).not.toBeInTheDocument()
  })

  it('abunəlik xərci "xərcləndi" kimi YOX, istinad kimi göstərilir', () => {
    render(<UsageBadge run={makeRun({ costUsd: 0.0085, subscriptionBilled: true })} />)
    expect(screen.getByText('abunəlik (istinad $0.00850)')).toBeInTheDocument()
    expect(screen.queryByText(/xərcləndi/)).not.toBeInTheDocument()
  })

  it('real xərc birbaşa $ ilə göstərilir', () => {
    render(<UsageBadge run={makeRun({ costUsd: 0.0251, subscriptionBilled: false })} />)
    expect(screen.getByText('$0.02510')).toBeInTheDocument()
  })
})
