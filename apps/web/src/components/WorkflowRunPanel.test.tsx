import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkflowRunPanel from './WorkflowRunPanel.js'
import { api, type WorkflowRunRow, type WorkflowStepRunRow } from '../lib/api.js'

function runRow(over: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: 'r1',
    workflowId: 'wf1',
    trigger: 'manual',
    status: 'succeeded',
    stepsJson: '[]',
    rootTaskId: 'root1',
    startedAt: 0,
    endedAt: 1,
    error: null,
    ...over,
  }
}

function stepRow(over: Partial<WorkflowStepRunRow> = {}): WorkflowStepRunRow {
  return {
    id: 1,
    workflowRunId: 'r1',
    stepId: 'yaz',
    stepIndex: 0,
    kind: 'task',
    attempt: 1,
    taskId: 'task1',
    status: 'succeeded',
    output: 'NƏTİCƏ',
    outputTruncated: false,
    detail: null,
    startedAt: 0,
    endedAt: 1,
    ...over,
  }
}

function show(run: WorkflowRunRow, steps: WorkflowStepRunRow[] = [stepRow()]): void {
  vi.spyOn(api, 'getWorkflowRun').mockResolvedValue({ run, steps })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkflowRunPanel runId="r1" onClose={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkflowRunPanel', () => {
  it('addımları və statusları göstərir', async () => {
    show(runRow())
    await waitFor(() => {
      expect(screen.getByText('yaz')).toBeTruthy()
    })
    expect(screen.getByText('NƏTİCƏ')).toBeTruthy()
  })

  it('zəncirin valideyn taskına keçid verir — dəyişiklik orada baxılır', async () => {
    show(runRow())
    await waitFor(() => {
      expect(screen.getByText(/nəticə və dəyişiklik/)).toBeTruthy()
    })
    const link = screen.getByText(/nəticə və dəyişiklik/) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/tasks/root1')
  })

  it('valideyn task yoxdursa (yalnız HTTP zənciri) keçid göstərilmir', async () => {
    show(runRow({ rootTaskId: null }), [stepRow({ kind: 'http', taskId: null })])
    await waitFor(() => {
      expect(screen.getByText('yaz')).toBeTruthy()
    })
    expect(screen.queryByText(/nəticə və dəyişiklik/)).toBeNull()
  })
})
