import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LiveBar from './LiveBar.js'

/** Sıfır şəbəkə — `useActivity`-nin WS yolu üçün. */
class FakeWs {
  static last: FakeWs | undefined
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  sent: string[] = []

  constructor() {
    FakeWs.last = this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    /* test-də bağlanma əhəmiyyətsizdir */
  }
}

const RUN = {
  runId: 'r1',
  taskId: 't1',
  contextId: 'c1',
  contextName: 'orchestris',
  promptExcerpt: 'auth bug-ı düzəlt',
  modelId: 'claude-haiku-4-5',
  runnerId: 'cli:claude',
  ladderRung: 2,
  attempt: 1,
  startedAt: Date.now(),
}

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

/**
 * Mock URL-dən ASILIDIR: zolaq iki endpoint çəkir — `/api/runs/active` və
 * `/api/questions/pending` (Faza 5B). Hamısına eyni gövdə qaytarsaydıq test
 * serverin real cavabını təmsil etməzdi.
 */
function mockServer(runs: unknown[], questions: unknown[] = []): void {
  globalThis.fetch = vi.fn(
    async (url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => (url.includes('/api/questions/pending') ? { questions } : { runs }),
        text: async () => '',
      }) as Response,
  ) as unknown as typeof fetch
}

beforeEach(() => {
  FakeWs.last = undefined
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket
})

describe('LiveBar', () => {
  it('icra yoxdursa zolaq ÜMUMİYYƏTLƏ render olunmur', async () => {
    mockServer([])
    const { container } = render(wrap(<LiveBar />))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(container.textContent).not.toContain('CANLI')
  })

  it('işləyən icranın modelini və prompt parçasını göstərir', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    expect(await screen.findByText('claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByText('auth bug-ı düzəlt')).toBeInTheDocument()
  })

  it('icra sayını göstərir', async () => {
    mockServer([RUN, { ...RUN, runId: 'r2', taskId: 't2' }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/CANLI — 2 icra/)).toBeInTheDocument()
  })

  it('mənfi pillə RƏQƏM kimi göstərilmir — ad işlədilir', async () => {
    mockServer([{ ...RUN, ladderRung: -1 }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/distillə/)).toBeInTheDocument()
    expect(screen.queryByText(/P-1/)).not.toBeInTheDocument()
  })

  it('bölgü icrası da adla göstərilir', async () => {
    mockServer([{ ...RUN, ladderRung: -2 }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/bölgü/)).toBeInTheDocument()
  })

  it('qlobal kanala abunə olur', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')
    FakeWs.last?.onopen?.()
    expect(FakeWs.last?.sent).toEqual([JSON.stringify({ type: 'subscribe_activity' })])
  })

  it('ended mesajı sətri siyahıdan çıxarır', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({
      data: JSON.stringify({ type: 'activity', kind: 'ended', runId: 'r1' }),
    } as MessageEvent<string>)

    await waitFor(() =>
      expect(screen.queryByText('claude-haiku-4-5')).not.toBeInTheDocument(),
    )
  })

  it('təkrar started sətri İKİLƏŞDİRMİR', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({
      data: JSON.stringify({ type: 'activity', kind: 'started', runId: 'r1', run: RUN }),
    } as MessageEvent<string>)

    await waitFor(() => expect(screen.getByText(/CANLI — 1 icra/)).toBeInTheDocument())
  })

  it('yeni started sətri əlavə edir', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({
      data: JSON.stringify({
        type: 'activity',
        kind: 'started',
        runId: 'r2',
        run: { ...RUN, runId: 'r2', taskId: 't2', modelId: 'gpt-5-mini' },
      }),
    } as MessageEvent<string>)

    expect(await screen.findByText('gpt-5-mini')).toBeInTheDocument()
  })

  it('sınıq JSON mesajı komponenti çökdürmür', async () => {
    mockServer([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({ data: '{{{' } as MessageEvent<string>)

    expect(screen.getByText('claude-haiku-4-5')).toBeInTheDocument()
  })
})

describe('LiveBar — gözləyən sual nişanı (Faza 5B)', () => {
  const QUESTION = { id: 'q1', taskId: 't1', status: 'pending' }

  it('icra olmasa da gözləyən sual varsa zolaq GÖRÜNÜR', async () => {
    // Sualı verən icra ARTIQ bitib, yəni `runs` boşdur. Nişanı göstərməsək,
    // task səssizcə dayanmış kimi qalardı.
    mockServer([], [QUESTION])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/1 sual cavab gözləyir/)).toBeInTheDocument()
  })

  it('sual da, icra da yoxdursa heç nə render olunmur', async () => {
    mockServer([], [])
    const { container } = render(wrap(<LiveBar />))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('sual sayı göstərilir', async () => {
    mockServer([], [QUESTION, { ...QUESTION, id: 'q2' }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/2 sual cavab gözləyir/)).toBeInTheDocument()
  })
})
