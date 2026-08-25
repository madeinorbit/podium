// @vitest-environment happy-dom
/**
 * THE COLUMN FOLDS, AND STILL ENDS UP FOLDED (POD-1584, POD-1658).
 *
 * The sidebar's collapse used to be a state flip: one subtree out, another in,
 * no motion. Giving it a width animation changes things a careless refactor
 * would quietly undo — and each would look FINE to a test that only checked the
 * end state, because the end state was already right before any of this. So
 * every one of them is pinned here:
 *
 *  - the OPEN subtree stays mounted for the whole gesture, in BOTH directions
 *    (a fold that swapped the rail in on the press would slide an empty gap
 *    shut beside a 58px rail, which is the bug this replaced);
 *  - the committed width is the END of the motion, never the start — WAAPI
 *    holds the start, so the value underneath it is already where it lands;
 *  - an INTERRUPTED fold picks up from the width on screen (POD-1658). Reading
 *    it after `cancel()` reads the far end instead, which is a teleport, and it
 *    is invisible to any assertion about where the gesture finishes;
 *  - the ghost of the folded column dissolves TOWARDS the direction of travel,
 *    since it is the only thing standing between the subtree swap and the eye;
 *  - its two layers go in SEQUENCE and not together (POD-1672). The lid over
 *    the work list and the rail on top of the lid running at the same time is
 *    the double-exposed middle frame the whole thing exists to remove, and it
 *    is one edited constant away at any moment;
 *  - and both layers are PINNED to their ends before the fills are dropped,
 *    because the frame between `cancel()` and React's unmount is the one that
 *    flashed the clipped work list back over a settled rail.
 *
 * happy-dom has no Web Animations API, so the Animation is a stub whose only
 * job is to hand `onfinish` back and record what it was asked for. That is the
 * seam this hook has with the browser; everything above it is real. The MOTION
 * itself — the curve, the dissolve, the absence of a pop — is verified in the
 * sidebar harness (`?fold=1`), which drives this same hook and renders the same
 * two subtrees.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLUMN_FOLD_MS } from './sidebar-common'
import { useColumnFold } from './use-column-fold'

const RAIL = 58
const OPEN = 306

let reduceMotion = false
vi.mock('motion/react', () => ({
  useReducedMotion: () => reduceMotion,
}))

/** The stub Animation, and the keyframes it was asked for. */
interface Recorded {
  property: 'width' | 'opacity' | 'transform'
  node: HTMLElement
  from: number
  to: number
  duration: number
  delay: number
  /** Where the window ENDS, as the hook asked for it. */
  end: number
  finish: () => void
  cancelled: number
  /** The node's own inline values at the moment `cancel()` ran — which is what
   *  rule 8 is about: drop the fill before writing the end and the value
   *  underneath is the one the ghost mounted with. */
  atCancel: { opacity: string; transform: string } | null
}
let recorded: Recorded[] = []
const widths = (): Recorded[] => recorded.filter((r) => r.property === 'width')
const fades = (): Recorded[] => recorded.filter((r) => r.property === 'opacity')
const slides = (): Recorded[] => recorded.filter((r) => r.property === 'transform')
/** Indexed reads that fail loudly. An assertion against `undefined.from` reads
 *  as a broken expectation; "there is no second width animation" is the actual
 *  finding whenever one of these tests regresses. */
const at = (list: Recorded[], i: number, what: string): Recorded => {
  const entry = list[i]
  if (!entry) throw new Error(`no ${what} animation at index ${i} (got ${list.length})`)
  return entry
}
const w = (i: number): Recorded => at(widths(), i, 'width')
/** The two fades of ONE leg, in the order the hook starts them: the lid that
 *  covers the outgoing column, then the rail that lands on the lid. */
const lidOf = (leg: number): Recorded => at(fades(), leg * 2, 'lid opacity')
const railOf = (leg: number): Recorded => at(fades(), leg * 2 + 1, 'rail opacity')

/** What `getBoundingClientRect` answers. The hook measures the column both at
 *  rest and mid-gesture, and the whole POD-1658 fix is about which. */
let rectWidth = OPEN
const rect = (width: number): void => {
  rectWidth = width
}

beforeEach(() => {
  reduceMotion = false
  recorded = []
  rectWidth = OPEN
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: rectWidth,
        height: 600,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: rectWidth,
        bottom: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  // Not `vi.spyOn` — happy-dom has no `animate` to spy ON. A plain function and
  // not an arrow, because WHICH NODE each animation is on is half of what the
  // sequence tests are checking.
  ;(Element.prototype as unknown as { animate: unknown }).animate = function (
    this: HTMLElement,
    frames: Array<Record<string, string>>,
    options: { duration: number; delay?: number },
  ) {
    const [head, tail] = frames as [Record<string, string>, Record<string, string>]
    const property = 'width' in head ? 'width' : 'transform' in head ? 'transform' : 'opacity'
    // `translate3d(-6px, 0, 0)` — the px the hook asked for, so a slide can be
    // asserted in the same shape as a fade.
    const px = (value: string): number => Number.parseFloat(value.slice(value.indexOf('(') + 1))
    const read = (frame: Record<string, string>): number =>
      property === 'transform'
        ? px(frame.transform ?? '')
        : Number.parseFloat(frame[property] ?? '')
    const entry: Recorded = {
      property,
      node: this,
      from: read(head),
      to: read(tail),
      duration: options.duration,
      delay: options.delay ?? 0,
      end: (options.delay ?? 0) + options.duration,
      finish: () => {},
      cancelled: 0,
      atCancel: null,
    }
    const animation = {
      cancel: () => {
        entry.cancelled += 1
        entry.atCancel = { opacity: this.style.opacity, transform: this.style.transform }
      },
      set onfinish(fn: () => void) {
        entry.finish = fn
      },
    }
    recorded.push(entry)
    return animation
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  ;(Element.prototype as unknown as { animate?: unknown }).animate = undefined
})

/** The shell's shape, reduced to what the fold touches: one persistent wrapper,
 *  two subtrees, the ghost of the folded one, and the caller's collapsed state. */
function Column(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const fold = useColumnFold({
    foldedWidth: RAIL,
    openWidth: () => OPEN,
    onFold: setCollapsed,
  })
  return (
    <div
      data-testid="shell"
      ref={fold.ref}
      data-folding={fold.folding ? 'true' : undefined}
      style={{ width: fold.width ?? undefined }}
    >
      {collapsed && !fold.folding ? (
        <button type="button" onClick={() => fold.fold(false)}>
          the rail
        </button>
      ) : (
        <button type="button" onClick={() => fold.fold(true)}>
          the work list
        </button>
      )}
      {fold.folding && (
        <div data-testid="ghost" ref={fold.ghostRef}>
          <div data-testid="ghost-inner" ref={fold.ghostContentRef} />
        </div>
      )}
    </div>
  )
}

const shell = (): HTMLElement => screen.getByTestId('shell')

describe('useColumnFold', () => {
  it('holds the open column through the collapse and swaps at the end', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    // STILL THERE in the commit that shut it. This is the assertion that fails
    // if the fold ever goes back to `collapsed ? rail : list`: without it the
    // rail would be sitting in a wrapper 306px wide with 248px of empty ground
    // closing beside it.
    expect(screen.queryByText('the work list')).toBeTruthy()
    expect(shell().dataset.folding).toBe('true')
    // The END width, not the start — see the file header.
    expect(shell().style.width).toBe(`${RAIL}px`)
    expect(widths()).toHaveLength(1)
    expect(w(0).from).toBe(OPEN)
    expect(w(0).to).toBe(RAIL)

    act(() => w(0).finish())
    expect(screen.getByText('the rail')).toBeTruthy()
    expect(shell().dataset.folding).toBeUndefined()
    // Width handed back to layout, so the rail's own flex basis is what sizes
    // the column and the next drag-resize is not fighting an inline pixel.
    expect(shell().style.width).toBe('')
    expect(w(0).cancelled).toBe(1)
  })

  it('runs the expand from the rail to the open width', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    act(() => w(0).finish())

    rect(RAIL)
    fireEvent.click(screen.getByText('the rail'))
    expect(screen.getByText('the work list')).toBeTruthy()
    expect(shell().dataset.folding).toBe('true')
    expect(shell().style.width).toBe(`${OPEN}px`)
    expect(w(1).from).toBe(RAIL)
    expect(w(1).to).toBe(OPEN)

    act(() => w(1).finish())
    expect(shell().style.width).toBe('')
  })

  it('starts the collapse from the width the shell actually granted', () => {
    // A column under flex pressure is narrower than the number in ui-state, and
    // a fold that starts from the wish jumps before it moves.
    rect(244)
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    expect(w(0).from).toBe(244)
    expect(w(0).to).toBe(RAIL)
  })

  it('reverses a fold already in flight without stacking animations', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    // Mid-collapse the open column is still on screen, so its control is what
    // an operator hits — and it must not leave the first animation running.
    fireEvent.click(screen.getByText('the work list'))

    expect(w(0).cancelled).toBe(1)
    expect(widths()).toHaveLength(2)
  })

  it('picks an interrupted fold up from the width on screen (POD-1658)', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    // 240px in: the column is between its two ends, and `cancel()` is about to
    // snap it to the 58px React committed. The old hook measured AFTER that and
    // restarted the whole gesture from 306.
    rect(240)
    fireEvent.click(screen.getByText('the work list'))

    expect(w(1).from).toBe(240)
    expect(w(1).to).toBe(RAIL)
    // And only for the ground it has left: 182 of 248px, so 182/248 of 240ms.
    expect(w(1).duration).toBe(176)
  })

  it('never shortens an interrupted fold below the floor', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    // 32px from the rail. Proportionally that is 36ms, which is a stutter, not
    // a movement.
    rect(90)
    fireEvent.click(screen.getByText('the work list'))

    expect(w(1).duration).toBe(120)
  })

  it('takes the full duration for a fold that starts at rest', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    expect(w(0).duration).toBe(COLUMN_FOLD_MS)
  })

  it('lands the ghost inside the gesture, not on the tail of it (POD-1672)', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    // The whole swap is over before the width animation is. POD-1658 ran it to
    // the last millisecond, which is exactly where the old ease-out had already
    // stopped moving the column — a crossfade with nothing behind it to explain
    // it, held long enough for the eye to resolve both pictures.
    expect(railOf(0).end).toBeLessThan(w(0).duration)
    // And it does not open on the press either: the column has to be visibly
    // travelling before anything is laid over it.
    expect(lidOf(0).delay).toBeGreaterThan(0)
  })

  it('raises the lid before the rail, never both at once (POD-1672)', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    // TWO layers, in order. The ghost itself goes opaque over the work list
    // first; only then does its content arrive on top of it. Run them together
    // and the middle frame has the rail's ID tiles and the work list's row
    // numbers both legible, seven pixels apart — which is the reported flicker.
    expect(fades()).toHaveLength(2)
    expect(lidOf(0).node).toBe(screen.getByTestId('ghost'))
    expect(railOf(0).node).toBe(screen.getByTestId('ghost-inner'))
    expect(lidOf(0).from).toBe(0)
    expect(lidOf(0).to).toBe(1)
    expect(railOf(0).from).toBe(0)
    expect(railOf(0).to).toBe(1)
    // The lid is all the way up before the rail starts. Not "mostly": the two
    // windows are written not to overlap, and this is the assertion that says
    // so out loud.
    expect(railOf(0).delay).toBeGreaterThanOrEqual(lidOf(0).end)

    act(() => w(0).finish())
    rect(RAIL)
    fireEvent.click(screen.getByText('the rail'))

    // Expanding, the same two events in the mirror order: the rail leaves the
    // lid, then the lid lifts off the work list. The rail is the one that has
    // to go first — a lid lifting off a rail that is still on it is the same
    // double picture, played backwards.
    expect(railOf(1).from).toBe(1)
    expect(railOf(1).to).toBe(0)
    expect(lidOf(1).from).toBe(1)
    expect(lidOf(1).to).toBe(0)
    expect(railOf(1).delay).toBeLessThan(lidOf(1).delay)
    expect(lidOf(1).delay).toBeGreaterThanOrEqual(railOf(1).end)
  })

  it('slides the rail in on the collapse and holds it still on the expand', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    // ARRIVING, so it moves: the last few pixels in from the left, with the
    // edge that is closing over it, on the rail's own window.
    expect(slides()).toHaveLength(1)
    expect(slides()[0]?.node).toBe(screen.getByTestId('ghost-inner'))
    expect(slides()[0]?.from).toBeLessThan(0)
    expect(slides()[0]?.to).toBe(0)
    expect(slides()[0]?.delay).toBe(railOf(0).delay)

    act(() => w(0).finish())
    rect(RAIL)
    fireEvent.click(screen.getByText('the rail'))

    // LEAVING, so it does not. The column is what is moving; an exit vector of
    // the rail's own shears its labels against the column's left edge, and the
    // hook is expected to skip the animation rather than run a no-op.
    expect(slides()).toHaveLength(1)
  })

  it('pins both ghost layers to their ends before dropping the fills (POD-1672)', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    const ghost = screen.getByTestId('ghost')
    const inner = screen.getByTestId('ghost-inner')

    act(() => w(0).finish())

    // `cancel()` drops the fill and uncovers the inline value underneath, and
    // the commit that unmounts the ghost is a React state update — so a frame
    // can be painted in between. It must not be a frame with the rail missing.
    expect(lidOf(0).atCancel?.opacity).toBe('1')
    expect(railOf(0).atCancel?.opacity).toBe('1')
    expect(railOf(0).atCancel?.transform).toBe('translate3d(0px, 0, 0)')
    expect(ghost.style.opacity).toBe('1')
    expect(inner.style.opacity).toBe('1')
  })

  it('flips without motion when the operator asked not to be moved', () => {
    reduceMotion = true
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    expect(screen.getByText('the rail')).toBeTruthy()
    expect(shell().dataset.folding).toBeUndefined()
    expect(shell().style.width).toBe('')
    expect(recorded).toHaveLength(0)
  })
})
