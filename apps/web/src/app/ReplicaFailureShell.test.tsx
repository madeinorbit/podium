/**
 * A replica that will not open is sync broken, and updating must still work
 * then (POD-6683): a signed-in person gets the update panel on the failure
 * screen; before sign-in the screen stays as it is.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from '@/features/updates/operation-view'

const mocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  useUpdateState: vi.fn(),
}))

vi.mock('@/app/pwa-register', () => ({ useRegisterSW: mocks.useRegisterSW }))
vi.mock('@/features/updates/use-update-state', () => ({ useUpdateState: mocks.useUpdateState }))
vi.mock('@/lib/update-status', () => ({ updateStatus: () => ({ watch: () => () => {} }) }))
vi.mock('@/app/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/trpc')>()),
  makeTrpc: () => ({ updates: { checkSpace: { query: async () => ({ machines: [] }) } } }),
}))

import { resetUpdates } from '@/features/updates/updates-panel-context'
import { ReplicaFailureShell, showsUpdatePanel } from './ReplicaFailureShell'

const OFFER: UpdatePanelView = {
  state: 'offer',
  title: 'Podium 0.4.3 is available',
  version: '0.4.3',
  steps: [],
  places: [{ kind: 'this-app', label: 'This app', effect: 'will refresh' }],
  primary: { kind: 'start', label: 'Update Podium', pendingLabel: 'Starting…' },
  awaitingElsewhere: [],
  indicator: 'idle-dot',
  indicatorLabel: 'Podium 0.4.3 is available',
}

/** The update engine is its own chunk; it arrives a beat after the screen. */
const CHUNK_ARRIVES_MS = 5_000

beforeEach(() => {
  // Nothing on these screens may reach a real server.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  mocks.useRegisterSW.mockReturnValue({
    needRefresh: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  })
  mocks.useUpdateState.mockReturnValue({
    view: OFFER,
    operation: null,
    server: {},
    fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
    pending: null,
    run: vi.fn(),
    checkNow: vi.fn(async () => {}),
    refreshState: vi.fn(),
    acknowledge: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  resetUpdates()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ReplicaFailureShell', () => {
  it('shows the update panel on the failure screen for a signed-in person', async () => {
    render(
      <ReplicaFailureShell
        cause={{ kind: 'sync-invalid' }}
        detail="the workspace download could not be read"
        httpOrigin="http://pod.test"
      />,
    )
    expect(
      await screen.findByTestId('update-panel', {}, { timeout: CHUNK_ARRIVES_MS }),
    ).toBeTruthy()
    // The failure screen is still there underneath.
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  })

  it('leaves the sign-in screen as it is', async () => {
    render(
      <ReplicaFailureShell
        cause={{ kind: 'signed-out' }}
        detail="authenticated account is unavailable"
        httpOrigin="http://pod.test"
      />,
    )
    await waitFor(() => expect(document.querySelector('input[type="password"]')).not.toBeNull())
    // Give a lazily loaded engine every chance to appear; it must not.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.queryByTestId('update-panel')).toBeNull()
    expect(mocks.useUpdateState).not.toHaveBeenCalled()
  })

  it('offers the panel only where the person may be signed in', () => {
    expect(showsUpdatePanel({ kind: 'replica-blocked' })).toBe(true)
    expect(showsUpdatePanel({ kind: 'boot-stalled' })).toBe(true)
    expect(showsUpdatePanel({ kind: 'signed-out' })).toBe(false)
    expect(showsUpdatePanel({ kind: 'account-missing' })).toBe(false)
    expect(showsUpdatePanel({ kind: 'auth-refused', status: 403 })).toBe(false)
    expect(showsUpdatePanel({ kind: 'offline-unknown' })).toBe(false)
  })
})
