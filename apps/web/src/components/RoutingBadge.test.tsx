import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RoutingBadge from './RoutingBadge.js'
import type { RoutingDecisionRow } from '../lib/api.js'

function decision(over: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    id: 1,
    taskId: 't1',
    strategy: 'rule',
    chosenModelId: 'cli:claude:claude-haiku-4-5',
    runnerId: 'cli:claude',
    modelId: 'claude-haiku-4-5',
    confidence: 0.9,
    decisionTokens: 0,
    decisionCostUsd: 0,
    ruleId: 'file-work-to-cli',
    reason: 'qayda "file-work-to-cli": fayl yolu var → CLI',
    at: 1_700_000_000_000,
    ...over,
  }
}

describe('RoutingBadge', () => {
  it('qərar yoxdursa heç nə göstərmir', () => {
    const { container } = render(<RoutingBadge decision={null} />)
    expect(container.textContent).toBe('')
  })

  it('seçilmiş işçini və səbəbi göstərir', () => {
    render(<RoutingBadge decision={decision()} />)
    expect(screen.getByText(/cli:claude/)).toBeTruthy()
    expect(screen.getByText(/file-work-to-cli/)).toBeTruthy()
  })

  it('qayda qərarını "0 token" kimi göstərir', () => {
    // Qəbul kriteriyası: qayda routing-i sıfır token xərcləyir və istifadəçi
    // bunu GÖRMƏLİDİR — iddianın yoxlanabilməsi üçün.
    render(<RoutingBadge decision={decision()} />)
    expect(screen.getByText(/0 token/)).toBeTruthy()
  })

  it('klassifikatorun öz xərcini göstərir', () => {
    render(
      <RoutingBadge
        decision={decision({ strategy: 'classifier', decisionTokens: 52, decisionCostUsd: 0.00002 })}
      />,
    )
    expect(screen.getByText(/52 token/)).toBeTruthy()
  })

  it('xərc bilinmirsə "$0" GÖSTƏRMİR', () => {
    // `null` = bilinmir. `$0.0000` yazsaq istifadəçi qərarın pulsuz olduğuna
    // inanardı (CLAUDE.md qayda 4).
    render(
      <RoutingBadge decision={decision({ strategy: 'classifier', decisionTokens: 52, decisionCostUsd: null })} />,
    )
    expect(screen.queryByText(/\$0/)).toBeNull()
    expect(screen.getByText(/xərc bilinmir/i)).toBeTruthy()
  })

  it('əl ilə seçimi router qərarı kimi göstərmir', () => {
    render(<RoutingBadge decision={decision({ strategy: 'manual', ruleId: null, reason: 'istifadəçi əl ilə seçdi' })} />)
    // Həm nişan, həm də səbəb "əl ilə" deyir — ikisi də görünməlidir.
    expect(screen.getAllByText(/əl ilə/i).length).toBeGreaterThanOrEqual(2)
  })
})
