import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AddProvider from './AddProvider.js'
import { api, type AvailableProviderRow } from '../lib/api.js'

function row(over: Partial<AvailableProviderRow> = {}): AvailableProviderRow {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    support: 'openai-compatible',
    modelCount: 4,
    envVars: ['DEEPSEEK_API_KEY'],
    ...over,
  }
}

function show(providers: AvailableProviderRow[]): void {
  vi.spyOn(api, 'availableProviders').mockResolvedValue({
    providers,
    catalogSource: 'cache',
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AddProvider />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AddProvider (issue #44)', () => {
  it('provayderi adı və model sayı ilə göstərir', async () => {
    show([row()])

    expect(await screen.findByText('deepseek')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByText('4 model')).toBeTruthy()
  })

  it('açar ilə əlavə edir', async () => {
    const add = vi.spyOn(api, 'addProvider').mockResolvedValue({ ok: true, modelCount: 4 })
    show([row()])

    fireEvent.click(await screen.findByText('Əlavə et'))
    fireEvent.change(screen.getByPlaceholderText(/API açarı/), {
      target: { value: 'sk-deepseek-0123456789' },
    })
    fireEvent.click(screen.getByText('Təsdiqlə'))

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('deepseek', 'sk-deepseek-0123456789'),
    )
  })

  it('AÇARSIZ əlavə mümkündür — lokal provayderlər açar tələb etmir', async () => {
    const add = vi.spyOn(api, 'addProvider').mockResolvedValue({ ok: true, modelCount: 2 })
    show([row({ id: 'ollama', name: 'Ollama', envVars: [] })])

    fireEvent.click(await screen.findByText('Əlavə et'))
    fireEvent.click(screen.getByText('Təsdiqlə'))

    // Boş sətir DEYİL, `undefined` göndərilir — server boş açarı "açar var,
    // amma yararsızdır" kimi oxumamalıdır.
    await waitFor(() => expect(add).toHaveBeenCalledWith('ollama', undefined))
  })

  it('açar göndərişdən sonra state-də QALMIR', async () => {
    // Açar React Query keşinə, localStorage-a və ya URL-ə heç vaxt düşməməlidir
    // (qayda 13). Uğursuz halda da təmizlənir.
    vi.spyOn(api, 'addProvider').mockRejectedValue(new Error('502'))
    show([row()])

    fireEvent.click(await screen.findByText('Əlavə et'))
    const input = screen.getByPlaceholderText(/API açarı/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-gizli-0123456789' } })
    fireEvent.click(screen.getByText('Təsdiqlə'))

    await waitFor(() => expect(input.value).toBe(''))
  })

  it('açar sahəsi `password` tipindədir və avtomatik doldurulmur', async () => {
    show([row()])
    fireEvent.click(await screen.findByText('Əlavə et'))

    const input = screen.getByPlaceholderText(/API açarı/) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
  })

  it('açarın env adını göstərir — istifadəçi onu harada tapacağını bilməlidir', async () => {
    show([row()])
    fireEvent.click(await screen.findByText('Əlavə et'))

    expect(screen.getByText(/DEEPSEEK_API_KEY/)).toBeTruthy()
  })

  it('siyahı UZUN olanda kəsilir və axtarış təklif olunur', async () => {
    // Kataloq yeniləndikdən sonra ~138 provayder olur; hamısını göstərmək
    // səhifəni oxunmaz edərdi.
    show(Array.from({ length: 20 }, (_, i) => row({ id: `p${i}`, name: `P${i}` })))

    expect(await screen.findByText(/12 provayder daha/)).toBeTruthy()
  })

  it('axtarış siyahını süzür', async () => {
    show([row({ id: 'deepseek' }), row({ id: 'groq', name: 'Groq' })])

    await screen.findByText('deepseek')
    fireEvent.change(screen.getByPlaceholderText(/Axtar/), { target: { value: 'groq' } })

    expect(screen.queryByText('deepseek')).toBeNull()
    expect(screen.getByText('groq')).toBeTruthy()
  })

  it('uyğun tapılmayanda səbəb yazılır', async () => {
    show([row()])
    await screen.findByText('deepseek')
    fireEvent.change(screen.getByPlaceholderText(/Axtar/), { target: { value: 'yoxdur' } })

    expect(screen.getByText(/tapılmadı/)).toBeTruthy()
  })

  it('əlavə ediləcək provayder yoxdursa BÖLMƏ ÜMUMİYYƏTLƏ göstərilmir', async () => {
    show([])
    await waitFor(() => expect(screen.queryByText('Provayder əlavə et')).toBeNull())
  })

  it('xəta göstərilir — səssiz uğur təəssüratı yaranmır', async () => {
    vi.spyOn(api, 'addProvider').mockRejectedValue(new Error('409: artıq əlavə edilib'))
    show([row()])

    fireEvent.click(await screen.findByText('Əlavə et'))
    fireEvent.click(screen.getByText('Təsdiqlə'))

    expect(await screen.findByText(/artıq əlavə edilib/)).toBeTruthy()
  })
})
