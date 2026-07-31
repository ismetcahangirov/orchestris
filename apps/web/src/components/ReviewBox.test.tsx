import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReviewBox from './ReviewBox.js'

const type = (text: string): void => {
  fireEvent.change(screen.getByLabelText('Rəy mətni'), { target: { value: text } })
}

describe('ReviewBox', () => {
  it('boş mətndə hər iki düymə sönükdür', () => {
    render(<ReviewBox onSubmit={vi.fn()} running />)
    expect(screen.getByRole('button', { name: 'Növbəti icrada' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'İndi kəs' })).toBeDisabled()
  })

  it('«Növbəti icrada» next rejimi göndərir', () => {
    const onSubmit = vi.fn()
    render(<ReviewBox onSubmit={onSubmit} running />)
    type('httpOnly cookie işlət')
    fireEvent.click(screen.getByRole('button', { name: 'Növbəti icrada' }))
    expect(onSubmit).toHaveBeenCalledWith('httpOnly cookie işlət', 'next')
  })

  it('«İndi kəs» interrupt rejimi göndərir', () => {
    const onSubmit = vi.fn()
    render(<ReviewBox onSubmit={onSubmit} running />)
    type('dayan')
    fireEvent.click(screen.getByRole('button', { name: 'İndi kəs' }))
    expect(onSubmit).toHaveBeenCalledWith('dayan', 'interrupt')
  })

  it('icra işləmirsə «İndi kəs» sönükdür — kəsiləcək heç nə yoxdur', () => {
    render(<ReviewBox onSubmit={vi.fn()} />)
    type('mətn')
    expect(screen.getByRole('button', { name: 'İndi kəs' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Növbəti icrada' })).toBeEnabled()
  })

  it('göndərişdən sonra sahə təmizlənir', () => {
    render(<ReviewBox onSubmit={vi.fn()} running />)
    type('mətn')
    fireEvent.click(screen.getByRole('button', { name: 'Növbəti icrada' }))
    expect(screen.getByLabelText('Rəy mətni')).toHaveValue('')
  })

  it('kəsmənin QİYMƏTİ açıq yazılır — gizlədilmir', () => {
    render(<ReviewBox onSubmit={vi.fn()} running />)
    expect(screen.getByText(/çıxış tokenləri itir/)).toBeInTheDocument()
  })
})
