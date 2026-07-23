import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './button'

afterEach(cleanup)

describe('Button interaction feedback', () => {
  it('opts into the shared pressable contract', () => {
    render(<Button>Run</Button>)
    expect(screen.getByRole('button', { name: 'Run' }).hasAttribute('data-pressable')).toBe(true)
  })

  it('locks a pending action and exposes action-specific feedback without replacing its layout slot', () => {
    const { rerender } = render(
      <Button pending={false} pendingLabel="Publishing…">
        Publish
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Publish' })
    const initialText = screen.getByText('Publish')
    const pendingText = screen.getByText('Publishing…')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.hasAttribute('aria-busy')).toBe(false)
    expect(initialText.classList.contains('invisible')).toBe(false)
    expect(pendingText.classList.contains('invisible')).toBe(true)

    rerender(
      <Button pending pendingLabel="Publishing…">
        Publish
      </Button>,
    )
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('data-pending')).toBe('true')
    expect(initialText.classList.contains('invisible')).toBe(true)
    expect(pendingText.classList.contains('invisible')).toBe(false)
  })

  it('keeps an explicitly disabled action unavailable', () => {
    render(<Button disabled>Delete</Button>)
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
