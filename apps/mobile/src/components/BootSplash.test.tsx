import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./AsciiWordmark', () => ({ AsciiWordmark: () => null }))

const { BootSplash } = await import('./BootSplash')

describe('BootSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a static ellipsis without a React timer loop', () => {
    const view = render(<BootSplash />)

    expect(view.getByText('LOADING...')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(5_000)
    expect(view.getByText('LOADING...')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
  })
})
