import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SelectTextSheet } from './SelectTextSheet'

afterEach(cleanup)

const text = 'The migration runs in two passes. First it copies rows.'

it('copies or quotes the whole message when nothing is selected', () => {
  const onCopy = vi.fn()
  const onQuote = vi.fn()
  const onClose = vi.fn()
  render(<SelectTextSheet text={text} onClose={onClose} onCopy={onCopy} onQuote={onQuote} />)
  fireEvent.click(screen.getByLabelText('Quote message'))
  expect(onQuote).toHaveBeenCalledWith(text)
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByLabelText('Copy message'))
  expect(onCopy).toHaveBeenCalledWith(text)
})

it('quotes only the selected range', () => {
  const onQuote = vi.fn()
  render(<SelectTextSheet text={text} onClose={() => {}} onCopy={() => {}} onQuote={onQuote} />)
  const field = screen.getByLabelText('Message text') as HTMLTextAreaElement
  field.setSelectionRange(43, 54)
  fireEvent.select(field)
  fireEvent.click(screen.getByLabelText('Quote selection'))
  expect(onQuote).toHaveBeenCalledWith('copies rows')
})

it('offers no quote where the host has no composer', () => {
  render(<SelectTextSheet text={text} onClose={() => {}} onCopy={() => {}} />)
  expect(screen.queryByLabelText('Quote message')).toBeNull()
})
