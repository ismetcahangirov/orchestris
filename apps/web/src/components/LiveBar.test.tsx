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

function mockRuns(runs: unknown[]): void {
  globalThis.fetch = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ runs }),
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
    mockRuns([])
    const { container } = render(wrap(<LiveBar />))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(container.textContent).not.toContain('CANLI')
  })

  it('işləyən icranın modelini və prompt parçasını göstərir', async () => {
    mockRuns([RUN])
    render(wrap(<LiveBar />))
    expect(await screen.findByText('claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByText('auth bug-ı düzəlt')).toBeInTheDocument()
  })

  it('icra sayını göstərir', async () => {
    mockRuns([RUN, { ...RUN, runId: 'r2', taskId: 't2' }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/CANLI — 2 icra/)).toBeInTheDocument()
  })

  it('mənfi pillə RƏQƏM kimi göstərilmir — ad işlədilir', async () => {
    mockRuns([{ ...RUN, ladderRung: -1 }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/distillə/)).toBeInTheDocument()
    expect(screen.queryByText(/P-1/)).not.toBeInTheDocument()
  })

  it('bölgü icrası da adla göstərilir', async () => {
    mockRuns([{ ...RUN, ladderRung: -2 }])
    render(wrap(<LiveBar />))
    expect(await screen.findByText(/bölgü/)).toBeInTheDocument()
  })

  it('qlobal kanala abunə olur', async () => {
    mockRuns([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')
    FakeWs.last?.onopen?.()
    expect(FakeWs.last?.sent).toEqual([JSON.stringify({ type: 'subscribe_activity' })])
  })

  it('ended mesajı sətri siyahıdan çıxarır', async () => {
    mockRuns([RUN])
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
    mockRuns([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({
      data: JSON.stringify({ type: 'activity', kind: 'started', runId: 'r1', run: RUN }),
    } as MessageEvent<string>)

    await waitFor(() => expect(screen.getByText(/CANLI — 1 icra/)).toBeInTheDocument())
  })

  it('yeni started sətri əlavə edir', async () => {
    mockRuns([RUN])
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
    mockRuns([RUN])
    render(wrap(<LiveBar />))
    await screen.findByText('claude-haiku-4-5')

    FakeWs.last?.onmessage?.({ data: '{{{' } as MessageEvent<string>)

    expect(screen.getByText('claude-haiku-4-5')).toBeInTheDocument()
  })
})
