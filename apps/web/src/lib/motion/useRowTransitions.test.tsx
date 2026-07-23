import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROW_EXIT_MS, type RowTransitionTarget, useRowTransitions } from './useRowTransitions'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

let latest: ReturnType<typeof useRowTransitions<string>>

function Probe({ targets }: { targets: RowTransitionTarget<string>[] }): JSX.Element {
  latest = useRowTransitions(targets)
  return (
    <output>
      {latest.items.map((item) => `${item.value}:${item.placement}:${item.phase}`).join('|')}
    </output>
  )
}

const content = (container: HTMLElement) => container.querySelector('output')!.textContent

describe('useRowTransitions', () => {
  it('does not animate rows present on the first mount', () => {
    const { container } = render(<Probe targets={[{ key: 'a', placement: 'open', value: 'A' }]} />)
    expect(content(container)).toBe('A:open:stable')
  })

  it('puts a new row in target order while marking only it as entering', () => {
    const { container, rerender } = render(
      <Probe targets={[{ key: 'a', placement: 'open', value: 'A' }]} />,
    )
    rerender(
      <Probe
        targets={[
          { key: 'n', placement: 'open', value: 'N' },
          { key: 'a', placement: 'open', value: 'A' },
        ]}
      />,
    )
    expect(content(container)).toBe('N:open:entering|A:open:stable')
  })

  it('retains a removed row as exiting at its old position', () => {
    const { container, rerender } = render(
      <Probe
        targets={[
          { key: 'a', placement: 'open', value: 'A' },
          { key: 'b', placement: 'open', value: 'B' },
          { key: 'c', placement: 'open', value: 'C' },
        ]}
      />,
    )
    rerender(
      <Probe
        targets={[
          { key: 'a', placement: 'open', value: 'A' },
          { key: 'c', placement: 'open', value: 'C' },
        ]}
      />,
    )
    expect(content(container)).toBe('A:open:stable|B:open:exiting|C:open:stable')
  })

  it('finishes the old placement before entering Closed', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <Probe targets={[{ key: 'a', placement: 'open', value: 'A' }]} />,
    )
    rerender(<Probe targets={[{ key: 'a', placement: 'closed', value: 'A' }]} />)
    expect(content(container)).toBe('A:open:exiting')

    act(() => vi.advanceTimersByTime(ROW_EXIT_MS))
    expect(content(container)).toBe('A:closed:entering')

    act(() => latest.settle('a', 'closed'))
    expect(content(container)).toBe('A:closed:stable')
  })
})
