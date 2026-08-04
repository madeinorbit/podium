import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  useUpdateState: vi.fn(),
  toast: vi.fn(),
  updateServiceWorker: vi.fn(),
  setNeedRefresh: vi.fn(),
}))

vi.mock('./pwa-register', () => ({ useRegisterSW: mocks.useRegisterSW }))
vi.mock('@/features/updates/use-update-state', () => ({ useUpdateState: mocks.useUpdateState }))
vi.mock('sonner', () => ({ toast: mocks.toast }))

import { UpdatePrompt } from './UpdatePrompt'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdatePrompt', () => {
  it('turns needRefresh into the shared dialog and does not raise a toast', () => {
    mocks.useRegisterSW.mockReturnValue({
      needRefresh: [true, mocks.setNeedRefresh],
      updateServiceWorker: mocks.updateServiceWorker,
    })
    mocks.useUpdateState.mockReturnValue({
      view: {
        state: 'available',
        version: '0.4.2',
        places: [{ kind: 'this-app', label: 'This app', effect: 'will refresh' }],
        restartNote: 'No restart needed. Your sessions keep running.',
      },
      actions: {},
      server: {},
      fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
    })

    render(<UpdatePrompt httpOrigin="http://podium.test" />)

    expect(screen.getByText(/Podium 0\.4\.2 is available/i)).toBeTruthy()
    expect(screen.getByText(/This app/)).toBeTruthy()
    expect(mocks.toast).not.toHaveBeenCalled()

    const stateOptions = mocks.useUpdateState.mock.calls[0]?.[0]
    expect(stateOptions.needRefresh).toBe(true)
    expect(typeof stateOptions.reload).toBe('function')
  })
})
