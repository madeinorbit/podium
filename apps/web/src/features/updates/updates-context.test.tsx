/**
 * THE DEFERRED ENGINE STILL ARRIVES (POD-2190).
 *
 * The provider was made a loader to get 99 KB of update machinery off the first
 * paint. The thing that must not break in exchange is the reason the surface
 * exists at all: an update must never be unreachable (spec §1.1). So these are
 * the two properties the split has to keep —
 *
 *   1. the panel and the indicator still appear when there is an update, without
 *      anyone touching anything, and
 *   2. the app's own tree neither waits for that chunk nor remounts when it
 *      lands, because a remount would take the store, the replica and the socket
 *      with it.
 *
 * They are asserted through the REAL lazy boundary, not a mocked one: mocking the
 * dynamic import away would leave exactly the failure this file exists to catch —
 * a boundary that never resolves — invisible.
 */
import { cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'

const mocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  useUpdateState: vi.fn(),
  setNeedRefresh: vi.fn(),
  run: vi.fn(),
  checkNow: vi.fn(async () => {}),
  acknowledge: vi.fn(),
}))

vi.mock('@/app/pwa-register', () => ({ useRegisterSW: mocks.useRegisterSW }))
vi.mock('./use-update-state', () => ({ useUpdateState: mocks.useUpdateState }))
vi.mock('@/app/trpc', () => ({
  serverConfig: () => ({ httpOrigin: 'http://podium.test' }),
}))

import { UpdateIndicator } from './UpdateIndicator'
import { UpdatesProvider } from './updates-context'
import { resetUpdates, useUpdates } from './updates-panel-context'

const OFFER: UpdatePanelView = {
  state: 'offer',
  title: 'Podium 0.4.3 is available',
  version: '0.4.3',
  steps: [],
  places: [{ kind: 'this-app', label: 'This app', effect: 'will refresh' }],
  restartNote: 'Your sessions keep running.',
  primary: { kind: 'start', label: 'Update Podium', pendingLabel: 'Starting…' },
  awaitingElsewhere: [],
  indicator: 'idle-dot',
  indicatorLabel: 'Podium 0.4.3 is available',
}

/** Stands in for the shell's own subtree, and counts how often it was mounted. */
function Child({ onMount }: { onMount: () => void }): JSX.Element {
  const updates = useUpdates()
  const mounted = useRef(onMount)
  useEffect(() => mounted.current(), [])
  return (
    <div data-testid="child">
      <UpdateIndicator
        state={updates.indicator}
        label={updates.indicatorLabel}
        open={updates.open}
        onToggle={updates.toggle}
      />
    </div>
  )
}

beforeEach(() => {
  mocks.useRegisterSW.mockReturnValue({
    needRefresh: [false, mocks.setNeedRefresh],
    updateServiceWorker: vi.fn(),
  })
  mocks.useUpdateState.mockReturnValue({
    view: OFFER,
    operation: null,
    server: {},
    fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
    pending: null,
    run: mocks.run,
    checkNow: mocks.checkNow,
    acknowledge: mocks.acknowledge,
  })
})

afterEach(() => {
  cleanup()
  resetUpdates()
  vi.clearAllMocks()
})

describe('UpdatesProvider', () => {
  it('loads the engine on mount, so the offered update reaches both halves', async () => {
    render(
      <UpdatesProvider httpOrigin="http://podium.test">
        <Child onMount={() => {}} />
      </UpdatesProvider>,
    )

    // Nobody clicked anything and no update was "requested" — mounting is enough.
    expect(await screen.findByTestId('update-panel')).toBeTruthy()
    const indicator = await screen.findByTestId('update-indicator')
    expect(indicator.getAttribute('data-indicator')).toBe('idle-dot')
    expect(indicator.getAttribute('aria-label')).toBe('Podium 0.4.3 is available')
  })

  it('renders children immediately, and does not remount them when the chunk lands', async () => {
    const onMount = vi.fn()
    render(
      <UpdatesProvider httpOrigin="http://podium.test">
        <Child onMount={onMount} />
      </UpdatesProvider>,
    )

    // Present on the FIRST paint: children are siblings of the boundary, never
    // suspended behind it.
    expect(screen.getByTestId('child')).toBeTruthy()
    expect(onMount).toHaveBeenCalledTimes(1)

    await screen.findByTestId('update-panel')

    // Still the same mount. A second one here would mean the shell's store,
    // replica and socket had been torn down and rebuilt by a bundle-size fix.
    expect(onMount).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('child')).toBeTruthy()
  })

  /**
   * Asserted against the store DIRECTLY rather than through the provider: once
   * the boundary above has resolved once, the module is cached for the rest of
   * the file, so there is no honest pre-load window left to observe there. The
   * invariant itself does not need one — it is a property of the store.
   */
  it('answers "no update" with no engine mounted, rather than throwing', () => {
    render(<Child onMount={() => {}} />)
    expect(screen.queryByTestId('update-indicator')).toBeNull()
  })
})
