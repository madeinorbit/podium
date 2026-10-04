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
  it('renders the still braille geometry', () => {
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

  it('schedules no CSS animation at any motion preference', () => {
    expect(css).not.toContain('@keyframes')
    expect(css).not.toMatch(/\b(?:animation|transition)(?:-[\w-]+)?\s*:/)
  })
})
