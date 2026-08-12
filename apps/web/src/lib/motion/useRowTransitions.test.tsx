import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROW_EXIT_MS, type RowTransitionTarget, useRowTransitions } from './useRowTransitions'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

let latest: ReturnType<typeof useRowTransitions<string>>
let renders = 0

function Probe({ targets }: { targets: RowTransitionTarget<string>[] }): JSX.Element {
  renders += 1
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

  it('can discard an exiting row as soon as a short gesture animation finishes', () => {
    const { container, rerender } = render(
      <Probe targets={[{ key: 'a', placement: 'closed', value: 'A' }]} />,
    )
    rerender(<Probe targets={[]} />)
    expect(content(container)).toBe('A:closed:exiting')

    act(() => latest.discardExit('a', 'closed'))
    expect(content(container)).toBe('')
  })

  /**
   * The sidebar wires `discardExit` to a row's `onAnimationComplete`, which also
   * fires for a row that is present and NOT exiting — the window between the
   * archive click and the outbox overlay dropping the row, which a dropped socket
   * holds open indefinitely. A discard that matches nothing has to be a READ: a
   * fresh array re-renders the list, which re-runs the animation callback, which
   * discards again. That loop is what crashed the column with React #185.
   */
  it('is a read when the discard matches no exiting row', () => {
    render(<Probe targets={[{ key: 'a', placement: 'closed', value: 'A' }]} />)
    const itemsBefore = latest.items
    renders = 0

    act(() => latest.discardExit('a', 'closed'))

    expect(latest.items).toBe(itemsBefore)
    expect(renders).toBe(0)
  })
})
