import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
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
    open ? <div role="dialog" aria-label="Podium ADE" /> : null,
}))

import { DesktopMenuHost } from './DesktopMenuHost'

const desktopGlobal = globalThis as { __PODIUM_DESKTOP__?: { platform: string } }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete desktopGlobal.__PODIUM_DESKTOP__
  delete (globalThis as { __PODIUM_ABOUT__?: unknown }).__PODIUM_ABOUT__
  delete (globalThis as { __PODIUM_SETTINGS__?: unknown }).__PODIUM_SETTINGS__
  delete (globalThis as { __PODIUM_ADD_PROJECT__?: unknown }).__PODIUM_ADD_PROJECT__
})

describe('DesktopMenuHost', () => {
  it('routes About, Settings, Add Project, and sidebar toggles from the macOS menu hooks', async () => {
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    const g = globalThis as {
      __PODIUM_ABOUT__?: () => void
      __PODIUM_SETTINGS__?: () => void
      __PODIUM_ADD_PROJECT__?: () => void
      __PODIUM_TOGGLE_FLIGHT_DECK__?: () => void
      __PODIUM_TOGGLE_RIGHT_SIDEBAR__?: () => void
    }

    g.__PODIUM_ABOUT__?.()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Podium ADE' })).toBeTruthy())

    // ⌘, opens the Settings sheet over whichever mode the shell is holding.
    g.__PODIUM_SETTINGS__?.()
    expect(mocks.openSettings).toHaveBeenCalledOnce()

    g.__PODIUM_ADD_PROJECT__?.()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add project' })).toBeTruthy())

    g.__PODIUM_TOGGLE_FLIGHT_DECK__?.()
    g.__PODIUM_TOGGLE_RIGHT_SIDEBAR__?.()
    expect(mocks.toggleFlight).toHaveBeenCalledOnce()
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
  })

  it('toggles the right sidebar on ⌘B and ignores ⇧⌘B in the desktop shell', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'macos' }
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(mocks.toggleRight).toHaveBeenCalledOnce()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true, bubbles: true }),
    )
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
    expect(mocks.toggleFlight).not.toHaveBeenCalled()
  })

  it('leaves ⌘B to the browser when this is not the desktop shell', () => {
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(mocks.toggleRight).not.toHaveBeenCalled()
  })
})
