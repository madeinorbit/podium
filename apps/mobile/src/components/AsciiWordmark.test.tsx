import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let reduceMotion = false
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => reduceMotion }))

const { AsciiWordmark, REVEAL_DURATION_MS } = await import('./AsciiWordmark')

describe('AsciiWordmark', () => {
  beforeEach(() => {
    reduceMotion = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not schedule work for the idle wordmark', () => {
    render(<AsciiWordmark color="#fff" />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the launch reveal after its one-second budget', () => {
    const { getByLabelText } = render(<AsciiWordmark color="#fff" variant="reveal" />)
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(REVEAL_DURATION_MS + 100))

    expect(vi.getTimerCount()).toBe(0)
    expect(getByLabelText('Podium').textContent?.trim().length).toBeGreaterThan(0)
  })

  it('keeps the launch mark static under reduced motion', () => {
    reduceMotion = true
    render(<AsciiWordmark color="#fff" variant="reveal" />)
    expect(vi.getTimerCount()).toBe(0)
  })
})
