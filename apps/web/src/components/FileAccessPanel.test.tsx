import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FileAccessPanel, { type FileAccessContext } from './FileAccessPanel.js'

const CTX: FileAccessContext = {
  id: 'c1',
  cwd: '/repo',
  fileAccess: 'workspace',
  extraDirsJson: '[]',
}

function wrap(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

describe('FileAccessPanel', () => {
  it('cari səviyyə seçili göstərilir', () => {
    render(wrap(<FileAccessPanel context={CTX} onSave={vi.fn()} />))
    expect(screen.getByLabelText('İş qovluğuna yaz')).toBeChecked()
    expect(screen.getByLabelText('Yalnız-oxu')).not.toBeChecked()
  })

  it('səviyyə dəyişəndə onSave çağırılır', () => {
    const onSave = vi.fn()
    render(wrap(<FileAccessPanel context={CTX} onSave={onSave} />))
    fireEvent.click(screen.getByLabelText('Yalnız-oxu'))
    expect(onSave).toHaveBeenCalledWith({ fileAccess: 'read-only' })
  })

  it('əlavə qovluqlar YALNIZ extended səviyyəsində görünür', () => {
    render(wrap(<FileAccessPanel context={CTX} onSave={vi.fn()} />))
    expect(screen.queryByText('Əlavə qovluqlar')).not.toBeInTheDocument()
  })

  it('extended səviyyəsində qovluq siyahısı göstərilir', () => {
    render(
      wrap(
        <FileAccessPanel
          context={{ ...CTX, fileAccess: 'extended', extraDirsJson: '["/a"]' }}
          onSave={vi.fn()}
        />,
      ),
    )
    expect(screen.getByText('Əlavə qovluqlar')).toBeInTheDocument()
    expect(screen.getByText('/a')).toBeInTheDocument()
  })

  it('sil düyməsi qovluğu siyahıdan çıxarır', () => {
    const onSave = vi.fn()
    render(
      wrap(
        <FileAccessPanel
          context={{ ...CTX, fileAccess: 'extended', extraDirsJson: '["/a","/b"]' }}
          onSave={onSave}
        />,
      ),
    )
    fireEvent.click(screen.getAllByText('sil')[0] as HTMLElement)
    expect(onSave).toHaveBeenCalledWith({ extraDirs: ['/b'] })
  })

  it('sınıq extraDirsJson komponenti çökdürmür', () => {
    render(
      wrap(
        <FileAccessPanel
          context={{ ...CTX, fileAccess: 'extended', extraDirsJson: '{{{' }}
          onSave={vi.fn()}
        />,
      ),
    )
    expect(screen.getByText('(yoxdur)')).toBeInTheDocument()
  })
})
