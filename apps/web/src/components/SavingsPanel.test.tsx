import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SavingsPanel from './SavingsPanel.js'
import type { SavingsSummary } from '../lib/api.js'

function summary(over: Partial<SavingsSummary> = {}): SavingsSummary {
  return {
    taskCount: 10,
    actualCostUsd: 1,
    actualSubscriptionUsd: 0,
    baselineCostUsd: 15,
    orchestrationCostUsd: 0.02,
    memoryCostUsd: 0,
    netSavingUsd: 13.98,
    cacheHits: 0,
    cacheSavingUsd: 0,
    unknownCostTasks: 0,
    subscriptionBaselineTasks: 0,
    byTaskType: [
      { taskType: 'code', tasks: 8, netSavingUsd: 13.9, actualCostUsd: 0.9 },
      { taskType: 'translate', tasks: 2, netSavingUsd: 0.08, actualCostUsd: 0.1 },
    ],
    tokensIn: 1_000_000,
    tokensOut: 20_000,
    ...over,
  }
}

describe('SavingsPanel — əsas rəqəmlər', () => {
  it('net qənaəti göstərir', () => {
    render(<SavingsPanel summary={summary()} />)
    expect(screen.getByText(/\$13\.98/)).toBeTruthy()
  })

  it('orkestrasiya xərcini AYRICA sətir kimi göstərir', () => {
    // Qəbul kriteriyası: orkestrasiya xərci daxil edilir və ayrıca görünür.
    render(<SavingsPanel summary={summary()} />)
    expect(screen.getByText(/orkestrasiya/i)).toBeTruthy()
    expect(screen.getByText(/\$0\.0200/)).toBeTruthy()
  })

  it('task sayını göstərir', () => {
    render(<SavingsPanel summary={summary()} />)
    expect(screen.getByText(/10 task/)).toBeTruthy()
  })
})

describe('SavingsPanel — abunəlik və real pul', () => {
  it('abunəlik xərcini "xərcləndi" kimi göstərmir', () => {
    // CLAUDE.md qayda 5: abunəlik icrasında kartdan pul çıxmır.
    render(<SavingsPanel summary={summary({ actualSubscriptionUsd: 0.5 })} />)
    const line = screen.getByTestId('subscription-line')
    expect(line.textContent).toMatch(/istinad/i)
    expect(line.textContent).not.toMatch(/xərcləndi/i)
  })

  it('abunəlik sıfırdırsa o sətri göstərmir', () => {
    render(<SavingsPanel summary={summary()} />)
    expect(screen.queryByTestId('subscription-line')).toBeNull()
  })

  it('baseline abunəlik modelidirsə xəbərdarlıq verir', () => {
    // Abunəlik baseline-ı ilə hesablanan qənaət REAL PUL qənaəti deyil.
    render(<SavingsPanel summary={summary({ subscriptionBaselineTasks: 3 })} />)
    expect(screen.getByText(/istinad qiyməti/i)).toBeTruthy()
  })
})

describe('SavingsPanel — dürüstlük', () => {
  it('xərci bilinməyən taskları GİZLƏTMİR', () => {
    render(<SavingsPanel summary={summary({ unknownCostTasks: 4 })} />)
    expect(screen.getByText(/4 taskın xərci bilinmir/i)).toBeTruthy()
  })

  it('keş vurmalarını ayrıca göstərir', () => {
    render(<SavingsPanel summary={summary({ cacheHits: 3, cacheSavingUsd: 2 })} />)
    expect(screen.getByTestId('cache-line').textContent).toMatch(/3/)
  })

  it('task tipinə görə bölgünü göstərir — mətn taskları da daxil', () => {
    // Mətn tasklarında qənaət az olacaq. Onu gizlətmək iddianı şişirdərdi.
    render(<SavingsPanel summary={summary()} />)
    expect(screen.getByText('code')).toBeTruthy()
    expect(screen.getByText('translate')).toBeTruthy()
  })

  it('baseline yoxdursa qənaət iddiası ETMİR', () => {
    // Başçı təyin olunmayıbsa müqayisə mümkün deyil.
    render(<SavingsPanel summary={summary({ baselineCostUsd: 0, netSavingUsd: 0, taskCount: 0 })} />)
    expect(screen.getByText(/hələ ölçüləcək/i)).toBeTruthy()
  })
})
