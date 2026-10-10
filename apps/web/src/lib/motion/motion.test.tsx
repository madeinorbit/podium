/**
 * The load-bearing guarantees of the motion primitives:
 *  - one-shot morphs NEVER fire on mount (a fresh sidebar must not replay
 *    thirty flashes) and fire exactly once per real phase transition;
 *  - the mark/timer render only for the working phase;
 *  - the timer freezes into the amber "ago" stamp on the waiting transition.
 * The keyframes themselves are CSS (motion.css) — geometry and browser timing
 * are driven through the real app by the Playwright motion-demo spec.
 */
import { cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhaseTimer } from './PhaseTimer'
import { StatusBadge } from './StatusBadge'
import { usePhaseMorph } from './usePhaseMorph'
import { WorkingMark } from './WorkingMark'

afterEach(cleanup)

function Probe({ phase }: { phase: string }): JSX.Element {
  const morph = usePhaseMorph(phase)
  return <output data-morph={morph ?? ''} />
}

describe('usePhaseMorph — one-shot transition latch', () => {
  it('returns null on mount and across re-renders without a change', () => {
    const { container, rerender } = render(<Probe phase="working" />)
    const out = (): string | null =>
      container.querySelector('output')?.getAttribute('data-morph') ?? null
    expect(out()).toBe('')
    rerender(<Probe phase="working" />)
    expect(out()).toBe('')
  })

  it('returns the value from the first real change onward', () => {
    const { container, rerender } = render(<Probe phase="working" />)
    const out = (): string | null =>
      container.querySelector('output')?.getAttribute('data-morph') ?? null
    rerender(<Probe phase="waiting" />)
    expect(out()).toBe('waiting')
    // Stays latched across unrelated re-renders (class must not flicker off,
    // which would restart the CSS animation).
    rerender(<Probe phase="waiting" />)
    expect(out()).toBe('waiting')
    rerender(<Probe phase="working" />)
    expect(out()).toBe('working')
  })
})

describe('WorkingMark', () => {
  it('renders a decorative square mark using the shared image runtime', () => {
    const { container } = render(<WorkingMark size={12} />)
    const el = container.querySelector('.pod-mark') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('img')?.alt).toBe('')
    expect(el.style.width).toBe('12px')
    expect(el.style.height).toBe('12px')
  })

  it.each([11, 12, 13, 15, 24])('reserves a full square at %ipx', (size) => {
    const { container } = render(<WorkingMark size={size} className="custom-mark" />)
    const el = container.querySelector('.pod-mark') as HTMLElement
    expect(el.classList.contains('custom-mark')).toBe(true)
    expect(el.style.width).toBe(`${size}px`)
    expect(el.style.height).toBe(`${size}px`)
  })
})

describe('PhaseTimer', () => {
  const NOW = Date.parse('2026-07-06T12:00:00.000Z')

  it('working: spinner + counting m:ss, no tick-in morph on fresh mount', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { container } = render(<PhaseTimer phase="working" sinceMs={NOW - 390_000} />)
    expect(container.querySelector('.pod-mark')).toBeTruthy()
    expect(container.textContent).toContain('6:30')
    expect(container.querySelector('.morph-tick-in')).toBeNull()
    vi.restoreAllMocks()
  })

  it('working: resumes from baseMs instead of resetting', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { container } = render(
      <PhaseTimer phase="working" sinceMs={NOW - 10_000} baseMs={380_000} />,
    )
    expect(container.textContent).toContain('6:30')
    vi.restoreAllMocks()
  })

  it('waiting after working: frozen amber ago stamp with a one-shot flip', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { container, rerender } = render(<PhaseTimer phase="working" sinceMs={NOW - 5_000} />)
    rerender(<PhaseTimer phase="waiting" sinceMs={NOW - 5_000} />)
    expect(container.querySelector('.pod-mark')).toBeNull()
    expect(container.textContent).toBe('just now')
    expect(container.querySelector('.morph-flip-ago')).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('waiting on fresh mount: ago stamp, but NO flip morph', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { container } = render(<PhaseTimer phase="waiting" sinceMs={NOW - 300_000} />)
    expect(container.textContent).toBe('5m ago')
    expect(container.querySelector('.morph-flip-ago')).toBeNull()
    vi.restoreAllMocks()
  })

  it('done: grey ∑ total when supplied, nothing when the backend has no total', () => {
    const { container, rerender } = render(
      <PhaseTimer phase="done" sinceMs={NOW} totalMs={340_000} />,
    )
    expect(container.textContent).toBe('∑ 5:40')
    rerender(<PhaseTimer phase="done" sinceMs={NOW} />)
    expect(container.textContent).toBe('')
  })

  it('supports a surrounding lifecycle lockup without duplicating its spinner', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { container, rerender } = render(
      <PhaseTimer
        phase="working"
        sinceMs={NOW - 390_000}
        showSpinner={false}
        plainLanguage
        leadingSeparator
      />,
    )
    expect(container.querySelector('.pod-mark')).toBeNull()
    expect(container.textContent).toBe('·6:30')
    rerender(
      <PhaseTimer
        phase="done"
        sinceMs={NOW}
        totalMs={340_000}
        showSpinner={false}
        plainLanguage
        leadingSeparator
      />,
    )
    expect(container.textContent).toBe('· 5:40 total')
    vi.restoreAllMocks()
  })

  it('queued: renders nothing (dim stillness is the row treatment)', () => {
    const { container } = render(<PhaseTimer phase="queued" sinceMs={NOW} />)
    expect(container.textContent).toBe('')
  })
})

describe('StatusBadge', () => {
  it('queued → spinner keeps the latch mounted and ticks in once', () => {
    const { container, rerender } = render(<StatusBadge kind={null} />)
    expect(container.firstChild).toBeNull()
    rerender(<StatusBadge kind="spinner" />)
    expect(container.querySelector('.pod-mark')).toBeTruthy()
    expect(container.querySelector('.morph-tick-in')).toBeTruthy()
    expect((container.querySelector('.pod-mark') as HTMLElement).style.width).toBe('11px')
  })

  it('count: renders the amber pill, no pop on mount, pops on increase', () => {
    const { container, rerender } = render(<StatusBadge kind="count" count={1} />)
    expect(container.textContent).toBe('1')
    expect(container.querySelector('.morph-pop')).toBeNull()
    rerender(<StatusBadge kind="count" count={2} />)
    expect(container.textContent).toBe('2')
    expect(container.querySelector('.morph-pop')).toBeTruthy()
  })

  it('count of zero renders nothing', () => {
    const { container } = render(<StatusBadge kind="count" count={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('spinner ↔ check transitions morph one-shot', () => {
    const { container, rerender } = render(<StatusBadge kind="spinner" />)
    expect(container.querySelector('.pod-mark')).toBeTruthy()
    expect(container.querySelector('.morph-tick-in')).toBeNull()
    rerender(<StatusBadge kind="check" />)
    expect(container.textContent).toBe('✓')
    expect(container.querySelector('.morph-pop-soft')).toBeTruthy()
    expect(container.querySelector('.pod-mark')).toBeNull()
  })
})
