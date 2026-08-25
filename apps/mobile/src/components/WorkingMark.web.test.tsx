import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkingMark } from './WorkingMark.web'

const css = readFileSync(
  resolve(process.cwd(), 'src/components/WorkingMark.web.css'),
  'utf8',
).replace(/\s+/g, ' ')

afterEach(cleanup)

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

  it('holds delayed dots at the authored trough before their wave starts', () => {
    expect(css).toContain('0%, 100% { opacity: 0.2; transform: scale(0.8); }')
    expect(css).toContain('animation: podium-mobile-mark-wave 1.5s linear infinite backwards;')
    for (const [child, delay] of [
      [2, '0.12s'],
      [3, '0.21s'],
      [4, '0.33s'],
      [5, '0.42s'],
      [6, '0.54s'],
      [7, '0.63s'],
      [8, '0.75s'],
    ] as const) {
      expect(css).toContain(
        `.podium-mobile-working-mark circle:nth-child(${child}) { animation-delay: ${delay}; }`,
      )
    }
  })
})
