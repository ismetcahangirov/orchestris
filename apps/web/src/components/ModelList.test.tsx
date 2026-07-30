import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type ModelRow } from '../lib/api.js'
import ModelList from './ModelList.js'

function modelRow(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'openai:gpt',
    providerId: 'openai',
    modelId: 'gpt-5.6',
    displayName: 'GPT-5.6',
    contextLimit: 200_000,
    outputLimit: null,
    priceIn: 1,
    priceOut: 5,
    priceCacheRead: null,
    priceCacheWrite: null,
    toolCall: true,
    structuredOutput: true,
    reasoning: false,
    source: 'models.dev',
    enabled: true,
    roleBoss: false,
    roleWorker: false,
    roleClassifier: false,
    priceKnown: true,
    taskCapable: true,
    ...over,
  }
}

function show(models: ModelRow[]): void {
  vi.spyOn(api, 'listModels').mockResolvedValue(models)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ModelList providerId="openai" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModelList', () => {
  it('task icra edə bilməyən modeli GÖSTƏRİR və səbəbini işarələyir (issue #47)', async () => {
    // Seçici belə modelləri gizlədir. Onları BURADA da gizlətsəydik, "modelim
    // niyə seçicidə yoxdur?" sualının cavabı heç yerdə görünməzdi — halbuki
    // istifadəçi məhz bu səhifədə modelləri idarə edir.
    show([
      modelRow(),
      modelRow({
        id: 'openai:embed',
        modelId: 'text-embedding-3-small',
        taskCapable: false,
      }),
    ])

    expect(await screen.findByText('text-embedding-3-small')).toBeInTheDocument()
    expect(screen.getByText('task üçün yararsız')).toBeInTheDocument()
  })

  it('işlək modeldə həmin işarə YOXDUR', async () => {
    show([modelRow()])
    expect(await screen.findByText('gpt-5.6')).toBeInTheDocument()
    expect(screen.queryByText('task üçün yararsız')).not.toBeInTheDocument()
  })
})
