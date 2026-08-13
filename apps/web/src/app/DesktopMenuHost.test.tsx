import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toggleLeft: vi.fn(),
  toggleFlight: vi.fn(),
  toggleRight: vi.fn(),
}))

vi.mock('@/features/setup/RepoScanFlow', () => ({
  RepoScanFlow: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Add project">
      <button type="button" onClick={onClose}>
        Close scan
      </button>
    </div>
  ),
}))

vi.mock('./use-desktop-close-tab', () => ({
  DesktopCloseTab: () => null,
}))

vi.mock('./AboutPodium', () => ({
  AboutPodium: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="About Podium" /> : null,
}))

import { DesktopMenuHost } from './DesktopMenuHost'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (globalThis as { __PODIUM_ABOUT__?: unknown }).__PODIUM_ABOUT__
  delete (globalThis as { __PODIUM_ADD_PROJECT__?: unknown }).__PODIUM_ADD_PROJECT__
  delete (globalThis as { __PODIUM_TOGGLE_LEFT_SIDEBAR__?: unknown }).__PODIUM_TOGGLE_LEFT_SIDEBAR__
})

describe('DesktopMenuHost', () => {
  it('routes About, Add Project, and sidebar toggles from the macOS menu hooks', async () => {
    render(
      <DesktopMenuHost
        toggleLeftSidebar={mocks.toggleLeft}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    const g = globalThis as {
      __PODIUM_ABOUT__?: () => void
      __PODIUM_ADD_PROJECT__?: () => void
      __PODIUM_TOGGLE_LEFT_SIDEBAR__?: () => void
      __PODIUM_TOGGLE_FLIGHT_DECK__?: () => void
      __PODIUM_TOGGLE_RIGHT_SIDEBAR__?: () => void
    }

    g.__PODIUM_ABOUT__?.()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'About Podium' })).toBeTruthy())

    g.__PODIUM_ADD_PROJECT__?.()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add project' })).toBeTruthy())

    g.__PODIUM_TOGGLE_LEFT_SIDEBAR__?.()
    g.__PODIUM_TOGGLE_FLIGHT_DECK__?.()
    g.__PODIUM_TOGGLE_RIGHT_SIDEBAR__?.()
    expect(mocks.toggleLeft).toHaveBeenCalledOnce()
    expect(mocks.toggleFlight).toHaveBeenCalledOnce()
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
  })
})
