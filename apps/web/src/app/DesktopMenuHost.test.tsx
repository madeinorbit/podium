import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
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
  delete (globalThis as { __PODIUM_TOGGLE_LEFT_SIDEBAR__?: unknown }).__PODIUM_TOGGLE_LEFT_SIDEBAR__
  delete (globalThis as { __PODIUM_CLOSE_TAB__?: unknown }).__PODIUM_CLOSE_TAB__
  delete (globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: unknown })
    .__PODIUM_FOCUS_SESSION_PROMPT__
  document.body.innerHTML = ''
})

function host(): JSX.Element {
  return (
    <DesktopMenuHost
      openSettings={mocks.openSettings}
      toggleLeftSidebar={mocks.toggleLeft}
      toggleFlightDeck={mocks.toggleFlight}
      toggleRightSidebar={mocks.toggleRight}
    />
  )
}

function press(
  key: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  target.dispatchEvent(event)
  return event
}

describe('DesktopMenuHost', () => {
  it('routes About, Settings, Add Project, and sidebar toggles from the macOS menu hooks', async () => {
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleLeftSidebar={mocks.toggleLeft}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    const g = globalThis as {
      __PODIUM_ABOUT__?: () => void
      __PODIUM_SETTINGS__?: () => void
      __PODIUM_ADD_PROJECT__?: () => void
      __PODIUM_TOGGLE_LEFT_SIDEBAR__?: () => void
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

    g.__PODIUM_TOGGLE_LEFT_SIDEBAR__?.()
    g.__PODIUM_TOGGLE_FLIGHT_DECK__?.()
    g.__PODIUM_TOGGLE_RIGHT_SIDEBAR__?.()
    expect(mocks.toggleLeft).toHaveBeenCalledOnce()
    expect(mocks.toggleFlight).toHaveBeenCalledOnce()
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
  })

  it('toggles the right sidebar on ⌘B and the left on ⇧⌘B in the desktop shell', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'macos' }
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleLeftSidebar={mocks.toggleLeft}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
    expect(mocks.toggleLeft).not.toHaveBeenCalled()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true, bubbles: true }),
    )
    expect(mocks.toggleLeft).toHaveBeenCalledOnce()
    expect(mocks.toggleFlight).not.toHaveBeenCalled()
  })

  it('leaves ⌘B to the browser when this is not the desktop shell', () => {
    render(
      <DesktopMenuHost
        openSettings={mocks.openSettings}
        toggleLeftSidebar={mocks.toggleLeft}
        toggleFlightDeck={mocks.toggleFlight}
        toggleRightSidebar={mocks.toggleRight}
      />,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
    expect(mocks.toggleRight).not.toHaveBeenCalled()
  })
})

// THE LINUX AND WINDOWS KEYBOARD (POD-1532). There is no menu bar off macOS, so
// every one of these commands existed only as an accelerator no one could
// press. The host binds them all from one listener, in the Ctrl spelling.
describe('the shell keyboard where there is no menu bar', () => {
  it('routes the whole command set on Linux', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'linux' }
    const closeTab = vi.fn(() => true)
    const focusPrompt = vi.fn()
    ;(globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__ = closeTab
    ;(
      globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void }
    ).__PODIUM_FOCUS_SESSION_PROMPT__ = focusPrompt
    render(host())

    press(',', { ctrlKey: true })
    expect(mocks.openSettings).toHaveBeenCalledOnce()

    press('w', { ctrlKey: true })
    expect(closeTab).toHaveBeenCalledOnce()

    press('f', { ctrlKey: true, altKey: true })
    expect(mocks.toggleFlight).toHaveBeenCalledOnce()

    press('l', { ctrlKey: true })
    expect(focusPrompt).toHaveBeenCalledOnce()

    press('b', { ctrlKey: true })
    press('b', { ctrlKey: true, shiftKey: true })
    expect(mocks.toggleRight).toHaveBeenCalledOnce()
    expect(mocks.toggleLeft).toHaveBeenCalledOnce()
  })

  // Super is Hyprland's on this desktop; a leaked Super chord is not ours.
  it('refuses the Super spelling on Linux', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'linux' }
    render(host())
    press('b', { metaKey: true })
    expect(mocks.toggleRight).not.toHaveBeenCalled()
  })

  // xterm has already written the control byte to the pty by the time this
  // listener runs, so claiming the chord would fire the command AND type it.
  it('leaves the control range to a focused terminal', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'linux' }
    render(host())
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="xterm"><span id="cell"></span></div>',
    )
    const cell = document.getElementById('cell')
    if (!cell) throw new Error('no terminal cell')
    press('b', { ctrlKey: true }, cell)
    expect(mocks.toggleRight).not.toHaveBeenCalled()
  })

  // A command nothing answers leaves the keystroke for whoever else wants it.
  it('does not swallow a chord no surface is bound to', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'linux' }
    render(host())
    expect(press('w', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press('b', { ctrlKey: true }).defaultPrevented).toBe(true)
  })
})
