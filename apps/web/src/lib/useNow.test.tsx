import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { useClock } from './clock-hooks'

function Clock(): JSX.Element {
  return <output>{useClock(1_000)}</output>
}

function PanelClock({ visible }: { visible: boolean }): JSX.Element {
  return (
    <PanelVisible visible={visible}>
      <Clock />
    </PanelVisible>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useClock panel visibility', () => {
  it('stops hidden clocks and resamples before a panel is revealed', () => {
    const view = render(<PanelClock visible />)
    expect(screen.getByRole('status').textContent).toBe('10000')

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByRole('status').textContent).toBe('11000')

    view.rerender(<PanelClock visible={false} />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('status').textContent).toBe('11000')

    view.rerender(<PanelClock visible />)
    expect(screen.getByRole('status').textContent).toBe('21000')

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByRole('status').textContent).toBe('22000')
  })
})
