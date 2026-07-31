import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FolderPicker from './FolderPicker.js'

const LIST = {
  path: '/projects',
  parent: '/',
  drives: ['/'],
  entries: [
    { name: 'orchestris', path: '/projects/orchestris', isRepo: true, hidden: false },
    { name: 'arxiv', path: '/projects/arxiv', isRepo: false, hidden: false },
    { name: '.gizli', path: '/projects/.gizli', isRepo: false, hidden: true },
  ],
}

const CHECK = {
  path: '/projects',
  exists: true,
  isDirectory: true,
  isRepo: false,
  writable: true,
}

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

function mockFetch(check: unknown = CHECK): void {
  globalThis.fetch = vi.fn(async (url: string) => {
    const body = url.includes('/api/fs/check') ? check : LIST
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  mockFetch()
})

describe('FolderPicker', () => {
  it('qovluqları sadalayır və repo işarəsi göstərir', async () => {
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={vi.fn()} />))
    expect(await screen.findByText('orchestris')).toBeInTheDocument()
    expect(screen.getByText('git')).toBeInTheDocument()
  })

  it('gizli qovluq default GİZLİDİR', async () => {
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={vi.fn()} />))
    await screen.findByText('orchestris')
    expect(screen.queryByText('.gizli')).not.toBeInTheDocument()
  })

  it('keçid açılanda gizli qovluq görünür', async () => {
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={vi.fn()} />))
    await screen.findByText('orchestris')
    fireEvent.click(screen.getByLabelText('Gizli qovluqları göstər'))
    expect(await screen.findByText('.gizli')).toBeInTheDocument()
  })

  it('Seç düyməsi SERVERDƏN gələn yolu qaytarır', async () => {
    const onSelect = vi.fn()
    render(wrap(<FolderPicker open onSelect={onSelect} onClose={vi.fn()} />))
    await screen.findByText('orchestris')
    fireEvent.click(screen.getByRole('button', { name: 'Seç' }))
    expect(onSelect).toHaveBeenCalledWith('/projects')
  })

  it('yazıla bilən qovluq üçün vəziyyət göstərilir', async () => {
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={vi.fn()} />))
    expect(await screen.findByText(/✓ yazıla bilir/)).toBeInTheDocument()
  })

  it('yazıla bilməyən qovluq XƏBƏRDARLIQ göstərir', async () => {
    mockFetch({ ...CHECK, writable: false })
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={vi.fn()} />))
    expect(await screen.findByText(/⚠ yazıla bilmir/)).toBeInTheDocument()
  })

  it('Ləğv düyməsi onClose çağırır', async () => {
    const onClose = vi.fn()
    render(wrap(<FolderPicker open onSelect={vi.fn()} onClose={onClose} />))
    await screen.findByText('orchestris')
    fireEvent.click(screen.getByRole('button', { name: 'Ləğv' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('open false olanda heç nə render olunmur', () => {
    const { container } = render(
      wrap(<FolderPicker open={false} onSelect={vi.fn()} onClose={vi.fn()} />),
    )
    expect(container).toBeEmptyDOMElement()
  })
})
