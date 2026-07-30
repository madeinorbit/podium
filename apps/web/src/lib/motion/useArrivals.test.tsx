/**
 * The load-bearing guarantees of the arrival latch (POD-167):
 *  - a fresh mount NEVER animates — the first render's keys pre-exist;
 *  - only keys appearing AFTER mount are arrivals, exactly once;
 *  - settle() drops a key so re-renders can't restart the animation;
 *  - a key that leaves the list and returns arrives again.
 */
import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useArrivals } from './useArrivals'

afterEach(cleanup)

let latest: ReturnType<typeof useArrivals>

function Probe({ keys }: { keys: readonly string[] }): JSX.Element {
  latest = useArrivals(keys)
  return <output data-arrivals={[...latest.arrivals].sort().join(',')} />
}

const arrivalsOf = (c: HTMLElement) =>
  c.querySelector('output')!.getAttribute('data-arrivals')

describe('useArrivals — mount latch for row arrivals', () => {
  it('marks nothing on a fresh mount, however many keys are present', () => {
    const { container } = render(<Probe keys={['a', 'b', 'c']} />)
    expect(arrivalsOf(container)).toBe('')
  })

  it('marks only keys that appear after mount', () => {
    const { container, rerender } = render(<Probe keys={['a', 'b']} />)
    rerender(<Probe keys={['new', 'a', 'b']} />)
    expect(arrivalsOf(container)).toBe('new')
    // Unrelated re-renders keep the mark until settled — no restart, no growth.
    rerender(<Probe keys={['new', 'a', 'b']} />)
    expect(arrivalsOf(container)).toBe('new')
  })

  it('settle() drops the key and it never re-arrives while present', () => {
    const { container, rerender } = render(<Probe keys={['a']} />)
    rerender(<Probe keys={['n', 'a']} />)
    act(() => latest.settle('n'))
    expect(arrivalsOf(container)).toBe('')
    rerender(<Probe keys={['n', 'a']} />)
    expect(arrivalsOf(container)).toBe('')
  })

  it('reordering existing keys (pin/unpin moves) is not an arrival', () => {
    const { container, rerender } = render(<Probe keys={['a', 'b']} />)
    rerender(<Probe keys={['b', 'a']} />)
    expect(arrivalsOf(container)).toBe('')
  })

  it('a departed key arrives again when it returns', () => {
    const { container, rerender } = render(<Probe keys={['a', 'b']} />)
    rerender(<Probe keys={['a']} />)
    expect(arrivalsOf(container)).toBe('')
    rerender(<Probe keys={['a', 'b']} />)
    expect(arrivalsOf(container)).toBe('b')
  })

  it('settle() on an unknown key is a no-op', () => {
    const { container } = render(<Probe keys={['a']} />)
    act(() => latest.settle('ghost'))
    expect(arrivalsOf(container)).toBe('')
  })
})
