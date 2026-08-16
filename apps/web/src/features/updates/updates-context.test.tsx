/**
 * Hide → indicator → reopen, which is the whole point of POD-2102's §6.1: the
 * old dialog's Hide set component state and the update became unreachable.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'
import { UpdateIndicator } from './UpdateIndicator'

const mocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  useUpdateState: vi.fn(),
  setNeedRefresh: vi.fn(),
  run: vi.fn(),
  checkNow: vi.fn(async () => {}),
  dismissFailure: vi.fn(),
}))

vi.mock('@/app/pwa-register', () => ({ useRegisterSW: mocks.useRegisterSW }))
vi.mock('./use-update-state', () => ({ useUpdateState: mocks.useUpdateState }))
vi.mock('@/app/trpc', () => ({
  serverConfig: () => ({ httpOrigin: 'http://podium.test' }),
}))

import { openUpdatePanel } from './open-panel'
import { UpdatesProvider } from './updates-context'
import { useUpdates } from './updates-panel-context'

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

function Strip(): JSX.Element {
  const updates = useUpdates()
  return (
    <UpdateIndicator
      state={updates.indicator}
      label={updates.indicatorLabel}
      open={updates.open}
      onToggle={updates.toggle}
    />
  )
}

function mount(view: UpdatePanelView = OFFER) {
  mocks.useUpdateState.mockReturnValue({
    view,
    operation: null,
    server: {},
    fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
    pending: null,
    run: mocks.run,
    checkNow: mocks.checkNow,
    dismissFailure: mocks.dismissFailure,
  })
  return render(
    <UpdatesProvider httpOrigin="http://podium.test">
      <Strip />
    </UpdatesProvider>,
  )
}

beforeEach(() => {
  mocks.useRegisterSW.mockReturnValue({
    needRefresh: [false, mocks.setNeedRefresh],
    updateServiceWorker: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdatesProvider', () => {
  it('shows the panel and the indicator for the same update', () => {
    mount()
    expect(screen.getByTestId('update-panel')).toBeTruthy()
    const indicator = screen.getByTestId('update-indicator')
    expect(indicator.getAttribute('aria-label')).toBe('Podium 0.4.3 is available')
    expect(indicator.getAttribute('data-indicator')).toBe('idle-dot')
  })

  it('Hide collapses to the indicator, and the indicator brings it back', () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('update-panel')).toBeNull()
    // NOTHING IS LOST: the indicator is still there, from server truth.
    expect(screen.getByTestId('update-indicator')).toBeTruthy()

    fireEvent.click(screen.getByTestId('update-indicator'))
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it('hides no more than the panel: needRefresh is cleared, the update is not', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(mocks.setNeedRefresh).toHaveBeenCalledWith(false)
  })

  it('acknowledges a failure when the user hides it, keeping the warning indicator', () => {
    mount({
      ...OFFER,
      state: 'failed',
      title: 'Podium update failed',
      error: { message: 'It broke.', nextAction: 'Try again.' },
      indicator: 'attention',
      indicatorLabel: 'Update failed',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(mocks.dismissFailure).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('update-indicator').getAttribute('data-indicator')).toBe('attention')
  })

  it('re-opens when the situation itself changes', () => {
    const { rerender } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('update-panel')).toBeNull()

    mocks.useUpdateState.mockReturnValue({
      view: { ...OFFER, state: 'waiting-you', title: 'Podium 0.4.3 is ready here' },
      operation: null,
      server: {},
      fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
      pending: null,
      run: mocks.run,
      checkNow: mocks.checkNow,
      dismissFailure: mocks.dismissFailure,
    })
    rerender(
      <UpdatesProvider httpOrigin="http://podium.test">
        <Strip />
      </UpdatesProvider>,
    )
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it('collapses a done panel on its own after a few seconds', () => {
    vi.useFakeTimers()
    try {
      mount({ ...OFFER, state: 'done', title: 'Podium is on 0.4.3 everywhere' })
      expect(screen.getByTestId('update-panel')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.queryByTestId('update-panel')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders no indicator when there is no update', () => {
    mount({
      state: 'none',
      title: '',
      steps: [],
      awaitingElsewhere: [],
      indicator: 'none',
      indicatorLabel: '',
    })
    expect(screen.queryByTestId('update-indicator')).toBeNull()
    expect(screen.queryByTestId('update-panel')).toBeNull()
  })

  /** The skew banner and the version guard live outside this tree (POD-1610). */
  it('can be opened from outside the React tree', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('update-panel')).toBeNull()

    act(() => {
      expect(openUpdatePanel()).toBe(true)
    })
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it('routes the macOS Check for Updates menu hook to the panel', () => {
    mount()
    const hook = (globalThis as { __PODIUM_CHECK_UPDATES__?: () => void }).__PODIUM_CHECK_UPDATES__
    expect(hook).toBeTypeOf('function')
    act(() => hook?.())
    expect(mocks.checkNow).toHaveBeenCalledTimes(1)
  })

  it('dispatches the panel’s primary action', () => {
    mount()
    fireEvent.click(screen.getByTestId('update-primary'))
    expect(mocks.run).toHaveBeenCalledWith('start')
  })
})
