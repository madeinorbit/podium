import { mountWorkingMark } from '@podium/working-mark'
import { tetra } from '@podium/working-mark/designs'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { color } from '../theme/theme'
import { WorkingMark } from './WorkingMark.web'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const picture = (root: ParentNode) =>
  root.querySelector('[data-testid="working-mark"] img')?.getAttribute('src')

describe('WorkingMark on web', () => {
  it('keeps the 66:100 cell and stays decorative', () => {
    const { container } = render(<WorkingMark size={12} label="Verifying" />)
    const mark = container.querySelector<HTMLElement>('[data-testid="working-mark"]')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect([mark?.style.width, mark?.style.height]).toEqual(['8px', '12px'])
    expect(container.querySelector('[role]')).toBeNull()
  })

  it('keeps moving without input and while the window is unfocused', () => {
    vi.useFakeTimers()
    const host = document.createElement('span')
    const still = mountWorkingMark(host, tetra, {
      size: 8,
      color: color.workingText,
      method: 'still',
    })
    const resting = host.querySelector('img')?.getAttribute('src')
    still.destroy()

    const { container } = render(<WorkingMark size={12} />)
    const moving = picture(container)
    expect(moving).toBeTruthy()
    expect(moving).not.toBe(resting)
    act(() => {
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(60_000)
    })
    expect(picture(container)).toBe(moving)
  })
})
