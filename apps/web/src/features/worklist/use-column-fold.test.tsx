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
 *    since it is the only thing standing between the subtree swap and the eye.
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
import { useColumnFold } from './use-column-fold'

const RAIL = 58
const OPEN = 306

let reduceMotion = false
vi.mock('motion/react', () => ({
  useReducedMotion: () => reduceMotion,
}))

/** The stub Animation, and the keyframes it was asked for. */
interface Recorded {
  property: 'width' | 'opacity'
  from: number
  to: number
  duration: number
  delay: number
  finish: () => void
  cancelled: number
}
let recorded: Recorded[] = []
const widths = (): Recorded[] => recorded.filter((r) => r.property === 'width')
const fades = (): Recorded[] => recorded.filter((r) => r.property === 'opacity')
/** Indexed reads that fail loudly. An assertion against `undefined.from` reads
 *  as a broken expectation; "there is no second width animation" is the actual
 *  finding whenever one of these tests regresses. */
const at = (list: Recorded[], i: number, what: string): Recorded => {
  const entry = list[i]
  if (!entry) throw new Error(`no ${what} animation at index ${i} (got ${list.length})`)
  return entry
}
const w = (i: number): Recorded => at(widths(), i, 'width')
const f = (i: number): Recorded => at(fades(), i, 'opacity')

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
  // Not `vi.spyOn` — happy-dom has no `animate` to spy ON.
  ;(Element.prototype as unknown as { animate: unknown }).animate = (
    frames: Array<Record<string, string>>,
    options: { duration: number; delay?: number },
  ) => {
    const [head, tail] = frames as [Record<string, string>, Record<string, string>]
    const property = 'width' in head ? 'width' : 'opacity'
    const entry: Recorded = {
      property,
      from: Number.parseFloat(head[property] ?? ''),
      to: Number.parseFloat(tail[property] ?? ''),
      duration: options.duration,
      delay: options.delay ?? 0,
      finish: () => {},
      cancelled: 0,
    }
    const animation = {
      cancel: () => {
        entry.cancelled += 1
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
      {fold.folding && <div data-testid="ghost" ref={fold.ghostRef} />}
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
    // 180px in: the column is between its two ends, and `cancel()` is about to
    // snap it to the 58px React committed. The old hook measured AFTER that and
    // restarted the whole gesture from 306.
    rect(180)
    fireEvent.click(screen.getByText('the work list'))

    expect(w(1).from).toBe(180)
    expect(w(1).to).toBe(RAIL)
    // And only for the ground it has left: 122 of 248px, so 122/248 of 280ms.
    expect(w(1).duration).toBe(138)
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

    expect(w(0).duration).toBe(280)
  })

  it('dissolves the ghost in behind the collapse and out ahead of the expand', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    // IN, and late: the rail is the destination arriving, and it owns the tail
    // of the width curve — which a strong ease-out has already abandoned.
    expect(fades()).toHaveLength(1)
    expect(f(0).from).toBe(0)
    expect(f(0).to).toBe(1)
    expect(f(0).delay).toBeGreaterThan(0)
    expect(f(0).delay + f(0).duration).toBe(280)

    act(() => w(0).finish())
    rect(RAIL)
    fireEvent.click(screen.getByText('the rail'))

    // OUT, and early: the rail is in the way, and the column is most of the way
    // open before a third of the duration has run.
    expect(f(1).from).toBe(1)
    expect(f(1).to).toBe(0)
    expect(f(1).delay).toBe(0)
    expect(f(1).duration).toBeLessThan(f(0).duration)
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
