import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorktreePanel from './WorktreePanel.js'
import { api, type ArtifactRow } from '../lib/api.js'

function artifact(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 1,
    taskId: 'task1',
    kind: 'diff',
    worktreePath: 'C:/Users/me/.orchestris/worktrees/task1',
    branch: 'orchestris/task1',
    repoPath: 'C:/repo',
    content: 'diff --git a/a.ts b/a.ts\n+yeni sətir',
    files: 2,
    truncated: false,
    status: 'pending',
    createdAt: 0,
    resolvedAt: null,
    ...over,
  }
}

function show(row: ArtifactRow): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <WorktreePanel artifact={row} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorktreePanel', () => {
  it('diff-i və fayl sayını göstərir', () => {
    show(artifact())

    expect(screen.getByText(/2 fayl/)).toBeTruthy()
    expect(screen.getByText(/orchestris\/task1/)).toBeTruthy()
    expect(screen.getByText(/\+yeni sətir/)).toBeTruthy()
  })

  it('qəbul düyməsi diff-i repoya tətbiq edir', async () => {
    const accept = vi.spyOn(api, 'acceptDiff').mockResolvedValue({ ok: true, files: 2 })
    show(artifact())

    fireEvent.click(screen.getByText(/Qəbul et/))
    await waitFor(() => {
      expect(accept).toHaveBeenCalledWith('task1')
    })
  })

  it('kəsilmiş diff QƏBUL EDİLƏ BİLMİR — düymə söndürülür', () => {
    show(artifact({ truncated: true }))

    expect(screen.getByText(/kəsilib/)).toBeTruthy()
    expect(screen.getByText(/Qəbul et/).hasAttribute('disabled')).toBe(true)
    // Rədd hər halda mümkündür: worktree-ni silmək üçün diff-in tam olması
    // lazım deyil.
    expect(screen.getByText(/Rədd et/).hasAttribute('disabled')).toBe(false)
  })

  it('həll olunmuş diff-də düymələr göstərilmir', () => {
    show(artifact({ status: 'accepted' }))

    expect(screen.getByText('qəbul edildi')).toBeTruthy()
    expect(screen.queryByText(/Qəbul et/)).toBeNull()
    expect(screen.queryByText(/Rədd et/)).toBeNull()
  })

  it('münaqişə xətası göstərilir — səssiz uğur təəssüratı yaranmır', async () => {
    vi.spyOn(api, 'acceptDiff').mockRejectedValue(new Error('409: patch does not apply'))
    show(artifact())

    fireEvent.click(screen.getByText(/Qəbul et/))
    await waitFor(() => {
      expect(screen.getByText(/patch does not apply/)).toBeTruthy()
    })
  })
})
