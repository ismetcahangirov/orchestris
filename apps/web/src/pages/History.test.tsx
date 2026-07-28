import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavingsTaskRow } from '../lib/api.js'
import History from './History.js'

function taskRow(over: Partial<SavingsTaskRow> = {}): SavingsTaskRow {
  return {
    taskId: 't1',
    taskType: 'code',
    actualCostUsd: 0.01,
    actualSubscriptionUsd: 0,
    baselineCostUsd: 0.5,
    baselineModelId: 'anthropic:başçı',
    baselineSubscription: false,
    orchestrationCostUsd: 0,
    netSavingUsd: 0.49,
    cachedHit: false,
    tokensIn: 1000,
    tokensOut: 500,
    at: 1_700_000_000_000,
    prompt: 'src/app.ts faylını düzəlt',
    status: 'succeeded',
    ...over,
  }
}

const SUMMARY = {
  taskCount: 1,
  actualCostUsd: 0.01,
  actualSubscriptionUsd: 0,
  baselineCostUsd: 0.5,
  orchestrationCostUsd: 0,
  memoryCostUsd: 0,
  netSavingUsd: 0.49,
  cacheHits: 0,
  cacheSavingUsd: 0,
  unknownCostTasks: 0,
  subscriptionBaselineTasks: 0,
  byTaskType: [{ taskType: 'code', tasks: 1, netSavingUsd: 0.49, actualCostUsd: 0.01 }],
  tokensIn: 1000,
  tokensOut: 500,
}

interface Call {
  url: string
}

function mockFetch(tasks: SavingsTaskRow[]): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string) => {
    calls.push({ url })
    return {
      ok: true,
      status: 200,
      json: async () => ({ period: 'month', summary: SUMMARY, tasks }),
      text: async () => '',
    } as Response
  }) as unknown as typeof fetch
  return calls
}

function renderPage(tasks: SavingsTaskRow[] = [taskRow()]): Call[] {
  const calls = mockFetch(tasks)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <History />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

describe('History səhifəsi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('taskı promptu və qənaəti ilə göstərir', async () => {
    renderPage()
    expect(await screen.findByText(/src\/app.ts faylını düzəlt/)).toBeTruthy()
    // Rəqəm həm cədvəl sətrində, həm də yekun panelində görünür.
    expect(screen.getAllByText(/\$0\.4900/).length).toBeGreaterThan(0)
  })

  it('xərci bilinməyən taskın xanasında "$0" GÖSTƏRMİR', async () => {
    // `null` = bilinmir. `$0.0000` yazsaq task pulsuz görünərdi (qayda 4).
    // Yoxlama sətrin ÖZ xanalarına aparılır: yekun panelində 0 dəyərlər
    // qanunidir (qayda routing həqiqətən 0 xərcləyir).
    renderPage([taskRow({ actualCostUsd: null, netSavingUsd: null })])
    const link = await screen.findByText(/src\/app.ts faylını düzəlt/)
    const cells = [...(link.closest('tr')?.querySelectorAll('td') ?? [])].map(
      (td) => td.textContent ?? '',
    )
    expect(cells[1]).toBe('bilinmir') // real xərc
    expect(cells[4]).toBe('bilinmir') // qənaət
  })

  it('keşdən gələn taskı işarələyir', async () => {
    renderPage([taskRow({ cachedHit: true })])
    expect(await screen.findByText(/keş/i)).toBeTruthy()
  })

  it('dövr dəyişəndə yeni sorğu göndərir', async () => {
    const calls = renderPage()
    await screen.findByText(/src\/app.ts/)

    fireEvent.change(screen.getByLabelText('Dövr'), { target: { value: 'day' } })
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('period=day'))).toBe(true)
    })
  })

  it('yekun paneli də göstərir', async () => {
    renderPage()
    expect(await screen.findByText(/net qənaət/i)).toBeTruthy()
  })

  it('task yoxdursa boş vəziyyəti izah edir', async () => {
    renderPage([])
    expect(await screen.findByText(/task yoxdur/i)).toBeTruthy()
  })
})
