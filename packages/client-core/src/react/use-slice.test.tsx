// @vitest-environment happy-dom
/**
 * POD-330 — `useSlice` under REAL React renders.
 *
 * The publisher's own tests prove the memoization. They cannot prove the
 * BINDING: a derivation can be perfect while the hook re-runs it per component,
 * or never re-runs it at all, and both failures are invisible to a unit test of
 * the publisher. So these drive real renders and COUNT.
 *
 * The probe says YES before it is trusted: the first assertion in each test is
 * that the derivation ran at all. A binding that never derives reports the best
 * possible number — zero — which is exactly the shape of instrument that this
 * issue has already been fooled by once (see §4b of the ownership map).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { createContext, useContext, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSlicePublisher, defineSlice, type SlicePublisher } from '../viewmodels/slices/publish'

// A stand-in for the store handle: same shape the provider exposes
// (subscribe + getSnapshot), without booting a runtime.
interface World {
  readonly rows: readonly { id: string; rev: number }[]
}

function makeHandle(initial: World) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot: () => snapshot,
    publish(next: World) {
      snapshot = next
      for (const l of [...listeners]) l()
    },
  }
}

type Handle = ReturnType<typeof makeHandle>

const HandleCtx = createContext<{ handle: Handle; publisher: SlicePublisher<World> } | null>(null)

/** The hook under test, wired to the fake handle exactly as `useSlice` is wired
 *  to the provider's: one publisher for the whole tree, keyed off the handle. */
function useTestSlice<T>(def: Parameters<SlicePublisher<World>['read']>[0]): T {
  const ctx = useContext(HandleCtx)
  if (!ctx) throw new Error('no handle')
  return useSyncExternalStore(ctx.handle.subscribe, () => ctx.publisher.read(def)) as T
}

let derivations = 0
const idsSlice = defineSlice<World, string[]>({
  name: 'ids',
  derive: (w) => {
    derivations += 1
    return w.rows.map((r) => r.id)
  },
})

function Reader({ label }: { label: string }) {
  const ids = useTestSlice<string[]>(idsSlice)
  return <div data-testid={label}>{ids.join(',')}</div>
}

function mount(initial: World) {
  derivations = 0
  const handle = makeHandle(initial)
  const publisher = createSlicePublisher<World>(() => handle.getSnapshot())
  render(
    <HandleCtx.Provider value={{ handle, publisher }}>
      <Reader label="a" />
      <Reader label="b" />
      <Reader label="c" />
    </HandleCtx.Provider>,
  )
  return handle
}

afterEach(cleanup)

describe('useSlice', () => {
  it('derives ONCE for three components reading the same slice', () => {
    mount({ rows: [{ id: 'r1', rev: 1 }] })
    // The instrument fired: without this, "1" and "never ran" are the same
    // number to a ceiling assertion.
    expect(derivations).toBeGreaterThan(0)
    expect(derivations).toBe(1)
    expect(screen.getByTestId('a').textContent).toBe('r1')
    expect(screen.getByTestId('c').textContent).toBe('r1')
  })

  it('derives once more per publish, not once per component', () => {
    const handle = mount({ rows: [{ id: 'r1', rev: 1 }] })
    const atMount = derivations
    act(() => {
      handle.publish({ rows: [{ id: 'r1', rev: 1 }, { id: 'r2', rev: 1 }] })
    })
    expect(derivations).toBeGreaterThan(atMount)
    expect(derivations - atMount).toBe(1)
    expect(screen.getByTestId('b').textContent).toBe('r1,r2')
  })

  it('re-renders every reader when a row is EVICTED, with no revision moving', () => {
    const kept = { id: 'r1', rev: 9 }
    const handle = mount({ rows: [kept, { id: 'shared-away', rev: 9 }] })
    expect(screen.getByTestId('a').textContent).toBe('r1,shared-away')
    const atMount = derivations
    act(() => {
      // Same revision on the surviving row: this is a visibility change, not an
      // update and not a deletion.
      handle.publish({ rows: [kept] })
    })
    expect(derivations - atMount).toBe(1)
    for (const label of ['a', 'b', 'c']) {
      expect(screen.getByTestId(label).textContent).toBe('r1')
    }
  })
})
