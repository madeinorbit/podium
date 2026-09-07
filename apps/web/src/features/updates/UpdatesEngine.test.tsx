/**
 * Hide → indicator → reopen, which is the whole point of POD-2102's §6.1: the
 * old dialog's Hide set component state and the update became unreachable.
 */
import type { ReleaseProposal } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'
import { UpdateIndicator } from './UpdateIndicator'

const mocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  useUpdateState: vi.fn(),
  setNeedRefresh: vi.fn(),
  refreshState: vi.fn(),
  run: vi.fn(),
  checkNow: vi.fn(async () => {}),
  acknowledge: vi.fn(),
  approveProposal: vi.fn(async () => {}),
}))

vi.mock('@/app/pwa-register', () => ({ useRegisterSW: mocks.useRegisterSW }))
vi.mock('./use-update-state', () => ({ useUpdateState: mocks.useUpdateState }))
vi.mock('@/app/trpc', () => ({
  serverConfig: () => ({ httpOrigin: 'http://podium.test' }),
}))

import { openUpdatePanel } from './open-panel'
import { UpdatesEngine } from './UpdatesEngine'
import { resetUpdates, useUpdates } from './updates-panel-context'

const PROPOSAL: ReleaseProposal = {
  headSha: 'abcdef1',
  version: '0.1.2-dev.7+abcdef1',
  runningVersion: '0.1.1-edge.1',
  branch: 'feature/release',
  commits: [{ sha: 'abcdef1', summary: 'Safety repair' }],
  addedMigrations: [],
  state: 'pending',
}

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
    refreshState: mocks.refreshState,
    acknowledge: mocks.acknowledge,
  })
  // The engine and the strip are SIBLINGS, which is the arrangement the shell
  // uses: they are in different subtrees and share one module-level store, so
  // this is also the test that the store carries the picture between them.
  return render(
    <>
      <UpdatesEngine httpOrigin="http://podium.test" />
      <Strip />
    </>,
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
  // The surface store is module-level, so one test's update would otherwise be
  // the next test's starting picture.
  resetUpdates()
  vi.clearAllMocks()
})

describe('UpdatesEngine', () => {
  it('surfaces a new proposal in the indicator until explicitly opened', () => {
    mocks.useUpdateState.mockReturnValue({
      view: {
        state: 'none',
        title: '',
        steps: [],
        awaitingElsewhere: [],
        indicator: 'none',
        indicatorLabel: '',
      },
      operation: null,
      server: {},
      fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
      pending: null,
      run: mocks.run,
      checkNow: mocks.checkNow,
    refreshState: mocks.refreshState,
      acknowledge: mocks.acknowledge,
      proposal: PROPOSAL,
      proposalPending: false,
      proposalError: undefined,
      approveProposal: mocks.approveProposal,
    })
    render(
      <>
        <UpdatesEngine httpOrigin="http://podium.test" />
        <Strip />
      </>,
    )

    const indicator = screen.getByTestId('update-indicator')
    expect(indicator.getAttribute('aria-label')).toBe('Development release awaits approval')
    expect(screen.queryByTestId('release-proposal-card')).toBeNull()

    fireEvent.click(indicator)
    expect(screen.getByTestId('release-proposal-card')).toBeTruthy()
    const build = screen.getByRole('button', { name: 'Build and publish' })
    fireEvent.click(build)
    expect(mocks.approveProposal).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('release-proposal-card')).toBeNull()
    expect(screen.getByTestId('update-indicator')).toBeTruthy()
  })

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

  it('Hide does not mutate service-worker state', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(mocks.setNeedRefresh).not.toHaveBeenCalled()
  })

  it('uses the current narrow refresh from the initially captured worker callback', () => {
    const { rerender } = mount({ ...OFFER, state: 'done' })
    const initialOptions = mocks.useRegisterSW.mock.calls[0]?.[0]
    const refreshState = vi.fn()
    mocks.useRegisterSW.mockReturnValue({ needRefresh: [true, mocks.setNeedRefresh] })
    mocks.useUpdateState.mockReturnValue({
      ...mocks.useUpdateState.mock.results.at(-1)?.value,
      refreshState,
    })
    rerender(<UpdatesEngine httpOrigin="http://podium.test" />)
    act(() => initialOptions.onNeedRefresh())
    expect(refreshState).toHaveBeenCalledOnce()
    expect(mocks.refreshState).not.toHaveBeenCalled()
    expect(mocks.checkNow).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.useUpdateState.mock.calls.at(-1)?.[0]).not.toHaveProperty('needRefresh')
    expect(initialOptions).not.toHaveProperty('onNeedReload')
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it.each(['done', 'none'] as const)('keeps Hide closed when the same operation becomes %s', (state) => {
    const { rerender } = mount({ ...OFFER, state: 'waiting-you', operationId: 'op_same' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    mocks.useUpdateState.mockReturnValue({
      ...mocks.useUpdateState.mock.results.at(-1)?.value,
      view: { ...OFFER, state, operationId: 'op_same' },
    })
    rerender(<UpdatesEngine httpOrigin="http://podium.test" />)
    expect(screen.queryByTestId('update-panel')).toBeNull()
  })

  it('reopens a hidden running operation when it fails', () => {
    const { rerender } = mount({ ...OFFER, state: 'running', operationId: 'op_same' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    mocks.useUpdateState.mockReturnValue({
      ...mocks.useUpdateState.mock.results.at(-1)?.value,
      view: { ...OFFER, state: 'failed', operationId: 'op_same' },
    })
    rerender(<UpdatesEngine httpOrigin="http://podium.test" />)
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it('collapses a newly discovered proposal and reopens its state change', () => {
    const { rerender } = mount()
    const result = mocks.useUpdateState.mock.results.at(-1)?.value
    const view = { ...OFFER, state: 'none' }
    mocks.useUpdateState.mockReturnValue({ ...result, view, proposal: PROPOSAL })
    rerender(<UpdatesEngine httpOrigin="http://podium.test" />)
    expect(screen.queryByTestId('release-proposal-card')).toBeNull()
    mocks.useUpdateState.mockReturnValue({
      ...result, view, proposal: { ...PROPOSAL, state: 'building' },
    })
    rerender(<UpdatesEngine httpOrigin="http://podium.test" />)
    expect(screen.getByTestId('release-proposal-card')).toBeTruthy()
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
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1)
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
    refreshState: mocks.refreshState,
      acknowledge: mocks.acknowledge,
    })
    rerender(
      <>
        <UpdatesEngine httpOrigin="http://podium.test" />
        <Strip />
      </>,
    )
    expect(screen.getByTestId('update-panel')).toBeTruthy()
  })

  it('collapses a done panel on its own after a few seconds, and clears the indicator', () => {
    vi.useFakeTimers()
    try {
      mount({ ...OFFER, state: 'done', title: 'Podium is on 0.4.3 everywhere' })
      expect(screen.getByTestId('update-panel')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.queryByTestId('update-panel')).toBeNull()
      // §6.2.4: a finished update is not a standing fact about the toolbar.
      expect(mocks.acknowledge).toHaveBeenCalled()
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

  it('routes a check-again action back through the full manual check', () => {
    mount({
      ...OFFER,
      state: 'failed',
      primary: { kind: 'check', label: 'Check again', pendingLabel: 'Checking…' },
    })

    fireEvent.click(screen.getByTestId('update-primary'))
    expect(mocks.checkNow).toHaveBeenCalledTimes(1)
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
