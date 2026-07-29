import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Workflows from './Workflows.js'

const CONTEXTS = [
  {
    id: 'ctx1',
    name: 'Layihə',
    cwd: null,
    amplificationProfile: 'balanced',
    workerMode: 'auto',
    autoSubmode: 'cheap',
    verifyCommandsJson: '[]',
    maxParallel: 1,
    memoryScope: null,
    memoryEnabled: true,
    createdAt: 0,
  },
]

const WORKFLOW = {
  id: 'wf1',
  contextId: 'ctx1',
  name: 'Sənəd zənciri',
  description: null,
  stepsJson: JSON.stringify([
    { kind: 'task', id: 'yaz', prompt: 'giriş yaz' },
    {
      kind: 'task',
      id: 'yoxla',
      prompt: 'yoxla: {{previous}}',
      when: { from: 'yaz', test: 'succeeded' },
    },
  ]),
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  lastRun: { id: 'r1', status: 'succeeded' },
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function mockFetch(workflows: unknown[] = [WORKFLOW]): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url === '/api/contexts' ? CONTEXTS : { workflows }
    return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return calls
}

function renderPage(workflows?: unknown[]): Call[] {
  const calls = mockFetch(workflows)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Workflows />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

describe('Zəncirlər səhifəsi', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('mövcud zəncirləri son icra vəziyyəti ilə göstərir', async () => {
    renderPage()
    expect(await screen.findByText('Sənəd zənciri')).toBeTruthy()
    expect(screen.getByText(/son icra: succeeded/)).toBeTruthy()
    expect(screen.getByText('2 addım')).toBeTruthy()
  })

  it('nümunə zəncirin addımları oxunaqlı göstərilir', async () => {
    // JSON budaqlanmanı GÖSTƏRMİR — "hansı addım nə vaxt işə düşür?" sualının
    // cavabı sahələrin arasında itir.
    renderPage([])
    await waitFor(() => {
      expect(screen.getByText(/yalnız «yaz» uğurludursa/)).toBeTruthy()
    })
    expect(screen.getByText(/sınsa da davam edir/)).toBeTruthy()
  })

  it('yararsız JSON-da səhv göstərilir və düymə bağlanır', async () => {
    renderPage([])
    const textarea = await screen.findByLabelText(/Addımlar/)
    fireEvent.change(textarea, { target: { value: '{ bu json deyil' } })

    expect(screen.getByText(/JSON oxunmadı/)).toBeTruthy()
    const button = screen.getByRole('button', { name: /Zənciri yarat/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('sxemə uyğun olmayan addım SERVERƏ GÖNDƏRİLMİR', async () => {
    // Eyni Zod sxemi hər iki tərəfdə işləyir: istifadəçi səhvi göndərməzdən
    // ƏVVƏL görür, server isə yenə heç nəyə etibar etmir.
    const calls = renderPage([])
    const textarea = await screen.findByLabelText(/Addımlar/)
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ kind: 'task', id: 'a' }]) },
    })

    expect((screen.getByRole('button', { name: /Zənciri yarat/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
  })

  it('"İşə sal" düyməsi icranı başladır', async () => {
    const calls = renderPage()
    const button = await screen.findByRole('button', { name: 'İşə sal' })
    fireEvent.click(button)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/workflows/wf1/run')).toBe(true)
    })
  })
})
