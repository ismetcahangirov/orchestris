import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { QuestionRow } from '../lib/api.js'
import QuestionPanel from './QuestionPanel.js'

const BASE: QuestionRow = {
  id: 'q1',
  taskId: 't1',
  runId: 'r1',
  question: 'Davam edim?',
  kind: 'yes_no',
  options: [],
  answerJson: null,
  status: 'pending',
  askedAt: 1,
  answeredAt: null,
}

const single: QuestionRow = { ...BASE, kind: 'single', options: ['a', 'b'] }
const multi: QuestionRow = { ...BASE, kind: 'multi', options: ['a', 'b'] }

describe('QuestionPanel — bəli/xeyr', () => {
  it('iki düymə göstərir və boolean qaytarır', () => {
    const onAnswer = vi.fn()
    render(<QuestionPanel question={BASE} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bəli' }))
    expect(onAnswer).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Xeyr' }))
    expect(onAnswer).toHaveBeenCalledWith(false)
  })

  it('pending halında düymələr sönükdür — ikiqat cavab 409 alardı', () => {
    render(<QuestionPanel question={BASE} onAnswer={vi.fn()} pending />)
    expect(screen.getByRole('button', { name: 'Bəli' })).toBeDisabled()
  })
})

describe('QuestionPanel — təkseçimli', () => {
  it('radio seçimi göndərilir', () => {
    const onAnswer = vi.fn()
    render(<QuestionPanel question={single} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByLabelText('a'))
    fireEvent.click(screen.getByRole('button', { name: 'Göndər' }))
    expect(onAnswer).toHaveBeenCalledWith('a')
  })

  it('seçim edilmədən Göndər sönükdür', () => {
    render(<QuestionPanel question={single} onAnswer={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Göndər' })).toBeDisabled()
  })
})

describe('QuestionPanel — çoxseçimli (checkbox)', () => {
  it('bir neçə variant massiv kimi göndərilir', () => {
    const onAnswer = vi.fn()
    render(<QuestionPanel question={multi} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByLabelText('a'))
    fireEvent.click(screen.getByLabelText('b'))
    fireEvent.click(screen.getByRole('button', { name: 'Göndər' }))
    expect(onAnswer).toHaveBeenCalledWith(['a', 'b'])
  })

  it('seçimin ləğvi siyahıdan çıxarır', () => {
    const onAnswer = vi.fn()
    render(<QuestionPanel question={multi} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByLabelText('a'))
    fireEvent.click(screen.getByLabelText('b'))
    fireEvent.click(screen.getByLabelText('a'))
    fireEvent.click(screen.getByRole('button', { name: 'Göndər' }))
    expect(onAnswer).toHaveBeenCalledWith(['b'])
  })

  it('heç nə seçilməyibsə Göndər SÖNÜKDÜR', () => {
    // Boş massivi həm zod sxemi, həm server rədd edir — düymə aktiv olsaydı
    // istifadəçi səbəbsiz xəta görərdi.
    render(<QuestionPanel question={multi} onAnswer={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Göndər' })).toBeDisabled()
  })
})

describe('QuestionPanel — bağlanmış sual', () => {
  it('cavablanmış sual cavabı ilə göstərilir, forma YOX', () => {
    render(
      <QuestionPanel
        question={{ ...multi, status: 'answered', answerJson: '["a","b"]' }}
        onAnswer={vi.fn()}
      />,
    )
    expect(screen.getByText('a, b')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Göndər' })).not.toBeInTheDocument()
  })

  it('boolean cavab oxunaqlı yazılır', () => {
    render(
      <QuestionPanel
        question={{ ...BASE, status: 'answered', answerJson: 'true' }}
        onAnswer={vi.fn()}
      />,
    )
    expect(screen.getByText('bəli')).toBeInTheDocument()
  })

  it('ləğv edilmiş sual bunu açıq yazır', () => {
    render(
      <QuestionPanel question={{ ...BASE, status: 'cancelled' }} onAnswer={vi.fn()} />,
    )
    expect(screen.getByText('(ləğv edildi)')).toBeInTheDocument()
  })
})
