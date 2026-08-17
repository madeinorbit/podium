// @vitest-environment happy-dom
/**
 * What a DOM-less environment can actually hold this hook to (POD-1191).
 *
 * NOT the two findings that made the drag look broken: Motion's projection
 * erasing the gesture's transforms, and the drop animating from a baseline
 * measured through them. Both need real layout and a real paint, and neither
 * lives in this file any more — the suspension is `layoutRevision` standing
 * still in `SidebarUnified`, and the only contract this hook owes it is the
 * `dragging` flag, whose lifecycle IS asserted below.
 *
 * What is testable here is everything that was wrong with the hook's own
 * bookkeeping: the gesture surviving its grip unmounting, the id list being a
 * statement about pointerdown rather than about now, and the session never
 * being left occupied — which was the failure that killed dragging outright
 * until the sidebar remounted.
 */
import { act, renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RowDrop, useRowDrag } from './useRowDrag'

const ROW_H = 46

interface Fixture {
  container: HTMLElement
  rows: HTMLElement[]
  grips: HTMLElement[]
}

/** A scope container holding `keys.length` rows of uniform height, each with a
 *  grip, laid out from y=0 down. Rects are stubbed because happy-dom has no
 *  layout — the geometry is the point of the insertion-index math, so it is
 *  supplied rather than measured. */
function mount(scope: string, keys: string[], top = 0): Fixture {
  const container = document.createElement('div')
  container.dataset.dragScope = scope
  // A section label: a direct child WITHOUT a drag key, which the hook must skip.
  container.appendChild(document.createElement('h3'))
  const rows: HTMLElement[] = []
  const grips: HTMLElement[] = []
  keys.forEach((key, i) => {
    const row = document.createElement('div')
    row.dataset.dragKey = key
    stubRect(row, top + i * ROW_H, ROW_H)
    const grip = document.createElement('span')
    grip.setPointerCapture = (): void => {}
    grip.hasPointerCapture = (): boolean => false
    grip.releasePointerCapture = (): void => {}
    row.appendChild(grip)
    container.appendChild(row)
    rows.push(row)
    grips.push(grip)
  })
  stubRect(container, top, keys.length * ROW_H)
  document.body.appendChild(container)
  return { container, rows, grips }
}

function stubRect(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
    }) as DOMRect
}

function gripEvent(grip: HTMLElement, clientY: number): ReactPointerEvent {
  return {
    currentTarget: grip,
    button: 0,
    pointerId: 1,
    clientY,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as ReactPointerEvent
}

function pointer(type: string, clientY: number, pointerId = 1): void {
  const ev = new Event(type) as Event & { pointerId: number; clientY: number }
  ev.pointerId = pointerId
  ev.clientY = clientY
  window.dispatchEvent(ev)
}

/** Two frames plus a microtask flush — enough for `onDrop`'s promise to resolve
 *  and for the rAF the hook releases its transforms in. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

function setup(onDrop: (drop: RowDrop) => void | Promise<unknown>, targets: string[] = []) {
  return renderHook(() => useRowDrag({ allowedTargets: () => targets, onDrop }))
}

beforeEach(() => {
  // happy-dom has no DOMMatrixReadOnly, and the hook only reads it to subtract a
  // FLIP transition's in-flight offset. The stubbed rects here are already
  // transform-free, so zero is the consistent answer.
  ;(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = class {
    m42 = 0
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useRowDrag', () => {
  it('reports the new order for the scope it was dragged within', async () => {
    const drops: RowDrop[] = []
    const { rows, grips } = mount('group:a', ['i1', 'i2', 'i3'])
    const { result } = setup((drop) => {
      drops.push(drop)
    })

    act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
    act(() => pointer('pointermove', 120))
    act(() => pointer('pointerup', 120))

    expect(drops).toEqual([
      { sourceScope: 'group:a', targetScope: 'group:a', movedId: 'i1', order: ['i2', 'i3', 'i1'] },
    ])
    // Rows are handed back unstyled.
    expect(rows[1]!.style.transform).toBe('')
    await settle()
  })

  it('does not report a drop when the row lands back where it started', () => {
    const drops: RowDrop[] = []
    const { grips } = mount('group:a', ['i1', 'i2', 'i3'])
    const { result } = setup((drop) => {
      drops.push(drop)
    })

    act(() => result.current.startDrag(gripEvent(grips[1]!, 60), 'i2'))
    act(() => pointer('pointermove', 62))
    act(() => pointer('pointerup', 62))

    expect(drops).toEqual([])
  })

  // FINDING 3. The grip is conditionally rendered, so a lane change or an
  // expiring snooze can unmount it mid-gesture. That used to release pointer
  // capture and deliver `pointerup` to a node with no listener on it: `finish`
  // never ran and `session` stayed occupied, which refused every later drag.
  describe('when the grip unmounts mid-drag', () => {
    it('still completes the drop', () => {
      const drops: RowDrop[] = []
      const { grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup((drop) => {
        drops.push(drop)
      })

      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      act(() => pointer('pointermove', 120))
      grips[0]!.remove()
      act(() => pointer('pointerup', 120))

      expect(drops.map((d) => d.order)).toEqual([['i2', 'i3', 'i1']])
    })

    it('leaves the session free for the next drag', () => {
      const drops: RowDrop[] = []
      const { grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup((drop) => {
        drops.push(drop)
      })

      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      grips[0]!.remove()
      act(() => pointer('pointerup', 10))

      act(() => result.current.startDrag(gripEvent(grips[2]!, 100), 'i3'))
      act(() => pointer('pointermove', 10))
      act(() => pointer('pointerup', 10))

      expect(drops.map((d) => d.movedId)).toEqual(['i3'])
    })
  })

  // FINDING 4. The ids and the row list are a statement about what the operator
  // is looking at. Re-reading them mid-gesture planned the write against
  // neighbours nobody had seen.
  describe('the frozen row list', () => {
    it('reports the ids as they stood at pointerdown', () => {
      const drops: RowDrop[] = []
      const { rows, grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup((drop) => {
        drops.push(drop)
      })

      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      // The store repaints a neighbour under the gesture.
      delete rows[1]!.dataset.dragKey
      act(() => pointer('pointermove', 120))
      act(() => pointer('pointerup', 120))

      expect(drops.map((d) => d.order)).toEqual([['i2', 'i3', 'i1']])
    })

    it('cancels when a frozen row leaves the document', () => {
      const drops: RowDrop[] = []
      const { rows, grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup((drop) => {
        drops.push(drop)
      })

      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      rows[2]!.remove()
      act(() => pointer('pointermove', 120))
      act(() => pointer('pointerup', 120))

      expect(drops).toEqual([])
      expect(rows[1]!.style.transform).toBe('')
      expect(rows[0]!.style.transform).toBe('')
    })
  })

  it('cancels on Escape without reporting a drop', () => {
    const drops: RowDrop[] = []
    const { rows, grips } = mount('group:a', ['i1', 'i2', 'i3'])
    const { result } = setup((drop) => {
      drops.push(drop)
    })

    act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
    act(() => pointer('pointermove', 120))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(drops).toEqual([])
    expect(rows[0]!.style.transform).toBe('')
  })

  it('crosses into a legal foreign scope', () => {
    const drops: RowDrop[] = []
    mount('pinned', ['p1', 'p2'])
    const group = mount('group:a', ['i1', 'i2'], 92)
    const { result } = setup(
      (drop) => {
        drops.push(drop)
      },
      ['pinned'],
    )

    act(() => result.current.startDrag(gripEvent(group.grips[0]!, 100), 'i1'))
    // Into the pinned container, above its second row's midpoint (46 + 23 = 69).
    act(() => pointer('pointermove', 50))
    act(() => pointer('pointerup', 50))

    expect(drops).toEqual([
      { sourceScope: 'group:a', targetScope: 'pinned', movedId: 'i1', order: ['p1', 'i1', 'p2'] },
    ])
  })

  // FINDING 1's other half: the flag the sidebar suspends layout animation on.
  // It has to cover the handoff window, or the drop's repaint animates from a
  // baseline measured through the gesture's own transforms.
  describe('the dragging flag', () => {
    it('stays true until the write settles and the transforms come off', async () => {
      let release = (): void => {}
      const queued = new Promise<void>((resolve) => {
        release = () => resolve()
      })
      const { rows, grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup(() => queued)

      expect(result.current.dragging).toBe(false)
      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      expect(result.current.dragging).toBe(true)

      act(() => pointer('pointermove', 120))
      act(() => pointer('pointerup', 120))
      // Pointer is up, but the write has not been published: the preview stands.
      expect(result.current.dragging).toBe(true)
      expect(rows[1]!.style.transform).toBe('translateY(-46px)')

      release()
      await settle()
      expect(result.current.dragging).toBe(false)
      expect(rows[1]!.style.transform).toBe('')
    })

    it('drops to false when the gesture changes nothing', () => {
      const { grips } = mount('group:a', ['i1', 'i2', 'i3'])
      const { result } = setup(() => undefined)

      act(() => result.current.startDrag(gripEvent(grips[0]!, 10), 'i1'))
      act(() => pointer('pointerup', 10))
      expect(result.current.dragging).toBe(false)
    })
  })
})
