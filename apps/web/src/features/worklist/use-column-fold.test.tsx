// @vitest-environment happy-dom
/**
 * THE COLUMN FOLDS, AND STILL ENDS UP FOLDED (POD-1584).
 *
 * The sidebar's collapse used to be a state flip: one subtree out, another in,
 * no motion. Giving it a width animation changes two observable things that a
 * careless refactor would quietly undo — and each would look FINE to a test
 * that only checked the end state, because the end state was already right
 * before any of this. So both ends are pinned here:
 *
 *  - the OPEN subtree stays mounted for the whole gesture, in BOTH directions
 *    (a fold that swapped the rail in on the press would slide an empty gap
 *    shut beside a 58px rail, which is the bug this replaced);
 *  - the committed width is the END of the motion, never the start — WAAPI
 *    holds the start, so the value underneath it is already where it lands.
 *
 * happy-dom has no Web Animations API, so the Animation is a stub whose only
 * job is to hand `onfinish` back. That is the seam this hook has with the
 * browser; everything above it is real. The MOTION itself is verified in the
 * sidebar harness (`?fold=1`), which drives this same hook.
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
  from: number
  to: number
  finish: () => void
  cancelled: number
}
let recorded: Recorded[] = []

beforeEach(() => {
  reduceMotion = false
  recorded = []
  // Not `vi.spyOn` — happy-dom has no `animate` to spy ON.
  ;(Element.prototype as unknown as { animate: unknown }).animate = (
    frames: Array<{ width: string }>,
  ) => {
    const entry: Recorded = {
      from: Number.parseFloat(frames[0]!.width),
      to: Number.parseFloat(frames[1]!.width),
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
  ;(Element.prototype as unknown as { animate?: unknown }).animate = undefined
})

/** The shell's shape, reduced to what the fold touches: one persistent wrapper,
 *  two subtrees, and the caller's own collapsed state. */
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
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.from).toBe(OPEN)
    expect(recorded[0]!.to).toBe(RAIL)

    act(() => recorded[0]!.finish())
    expect(screen.getByText('the rail')).toBeTruthy()
    expect(shell().dataset.folding).toBeUndefined()
    // Width handed back to layout, so the rail's own flex basis is what sizes
    // the column and the next drag-resize is not fighting an inline pixel.
    expect(shell().style.width).toBe('')
    expect(recorded[0]!.cancelled).toBe(1)
  })

  it('runs the expand from the rail to the open width', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    act(() => recorded[0]!.finish())

    fireEvent.click(screen.getByText('the rail'))
    expect(screen.getByText('the work list')).toBeTruthy()
    expect(shell().dataset.folding).toBe('true')
    expect(shell().style.width).toBe(`${OPEN}px`)
    expect(recorded[1]!.from).toBe(RAIL)
    expect(recorded[1]!.to).toBe(OPEN)

    act(() => recorded[1]!.finish())
    expect(shell().style.width).toBe('')
  })

  it('starts the collapse from the width the shell actually granted', () => {
    // A column under flex pressure is narrower than the number in ui-state, and
    // a fold that starts from the wish jumps before it moves.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 244,
      height: 600,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 244,
      bottom: 600,
      toJSON: () => ({}),
    } as DOMRect)
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))

    expect(recorded[0]!.from).toBe(244)
    expect(recorded[0]!.to).toBe(RAIL)
  })

  it('reverses a fold already in flight without stacking animations', () => {
    render(<Column />)
    fireEvent.click(screen.getByText('the work list'))
    // Mid-collapse the open column is still on screen, so its control is what
    // an operator hits — and it must not leave the first animation running.
    fireEvent.click(screen.getByText('the work list'))

    expect(recorded[0]!.cancelled).toBe(1)
    expect(recorded).toHaveLength(2)
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
