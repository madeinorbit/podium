import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkingMark } from './WorkingMark.web'

describe('WorkingMark on web', () => {
  it('renders the same braille geometry for CSS to animate', () => {
    const { container } = render(<WorkingMark size={12} />)
    const mark = container.querySelector('[data-testid="working-mark"]')
    const dots = [...container.querySelectorAll('circle')]

    expect(mark?.getAttribute('viewBox')).toBe('0 0 66 100')
    expect(mark?.getAttribute('width')).toBe('8')
    expect(dots.map((dot) => [dot.getAttribute('cx'), dot.getAttribute('cy')])).toEqual([
      ['17', '18'],
      ['49', '18'],
      ['17', '39'],
      ['49', '39'],
      ['17', '61'],
      ['49', '61'],
      ['17', '82'],
      ['49', '82'],
    ])
  })

  it('keeps the working status semantic unless adjacent text owns it', () => {
    const { getByRole, rerender, container } = render(<WorkingMark label="Verifying" />)
    expect(getByRole('progressbar').getAttribute('aria-label')).toBe('Verifying')

    rerender(<WorkingMark label={null} />)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('svg')?.hasAttribute('role')).toBe(false)
  })
})
