// @vitest-environment happy-dom
/**
 * THE GUARD OVER UNCLAIMED GROUND (POD-1595).
 *
 * Its whole contract is a negative one — it must act on drags nothing else
 * wanted, and must keep its hands off every drag a real drop zone took — so
 * both halves are worth pinning. The half that matters most is the second: a
 * guard that claimed events zones had already accepted would override their
 * cursor and, in the file case, fight the thing it exists to help.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFileDropGuard } from './use-file-drop-guard'

function drag(type: 'dragover' | 'drop', kinds: string[], claimed = false): DragEvent {
  const list = Object.assign(
    kinds.map((kind) => ({ kind, type: '' })),
    { length: kinds.length },
  )
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    value: { items: list, dropEffect: 'uninitialized' },
  })
  if (claimed) event.preventDefault()
  return event
}

// Every mount here adds a WINDOW listener, so a hook left mounted keeps
// guarding through the next test — and the unmount case would pass or fail on
// how many tests ran before it rather than on its own behaviour.
afterEach(cleanup)

describe('useFileDropGuard', () => {
  it('swallows a file drag nothing claimed, so the page cannot navigate to it', () => {
    renderHook(() => useFileDropGuard())
    for (const type of ['dragover', 'drop'] as const) {
      const event = drag(type, ['file'])
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
  })

  it('says "not here" rather than promising a drop it will not honour', () => {
    renderHook(() => useFileDropGuard())
    const event = drag('dragover', ['file'])
    window.dispatchEvent(event)
    expect(event.dataTransfer?.dropEffect).toBe('none')
  })

  it('leaves a drag a real drop zone already accepted completely alone', () => {
    renderHook(() => useFileDropGuard())
    const event = drag('dragover', ['file'], true)
    window.dispatchEvent(event)
    // Untouched: the zone's own cursor stands.
    expect(event.dataTransfer?.dropEffect).toBe('uninitialized')
  })

  it('ignores drags that carry no file, so in-app HTML5 dragging stays possible', () => {
    renderHook(() => useFileDropGuard())
    const event = drag('dragover', ['string'])
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('stops listening when unmounted', () => {
    const { unmount } = renderHook(() => useFileDropGuard())
    unmount()
    const event = drag('dragover', ['file'])
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
