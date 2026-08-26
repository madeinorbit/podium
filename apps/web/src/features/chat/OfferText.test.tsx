// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKnownPodiumOrigins, setPodiumTargetActivator } from '@/lib/podium-link'
import { OfferText } from './OfferText'

const HOME = 'http://127.0.0.1:8787'

afterEach(() => {
  cleanup()
  setKnownPodiumOrigins([])
  setPodiumTargetActivator(null)
})

describe('OfferText', () => {
  it('sends an external URL to a new tab, as POD-1589 shipped it', () => {
    render(<OfferText text="Try https://preview.example.com/login now." />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('opens a link to this Podium in the app instead', () => {
    setKnownPodiumOrigins([HOME])
    const activate = vi.fn(() => true)
    setPodiumTargetActivator(activate)
    render(<OfferText text={`Ready to merge: ${HOME}/issues/POD-1606`} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('target')).toBeNull()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(link, event)
    expect(activate).toHaveBeenCalledWith({ kind: 'issue', issue: 'POD-1606' }, { direct: false })
    expect(event.defaultPrevented).toBe(true)
  })

  it('keeps the href real, and leaves ⌘-click to the browser tab it opens', () => {
    setKnownPodiumOrigins([HOME])
    const activate = vi.fn(() => true)
    setPodiumTargetActivator(activate)
    render(<OfferText text={`${HOME}/issues/POD-1606`} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(`${HOME}/issues/POD-1606`)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
    fireEvent(link, event)
    expect(activate).not.toHaveBeenCalled()
    // NOT cancelled: outside the desktop shell the anchor's own new tab is the
    // right answer, and cancelling it would make ⌘-click do nothing.
    expect(event.defaultPrevented).toBe(false)
  })

  it('hands ⌘-click to the OS browser inside the desktop shell', () => {
    // There the internal anchor has no target="_blank" — that is the point — and
    // the injected shim now leaves our own origins alone, so WKWebView would
    // drop the new-window request silently.
    setKnownPodiumOrigins([HOME])
    setPodiumTargetActivator(() => true)
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    render(<OfferText text={`${HOME}/issues/POD-1606`} />)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
    fireEvent(screen.getByRole('link'), event)
    expect(openExternal).toHaveBeenCalledWith(`${HOME}/issues/POD-1606`)
    expect(event.defaultPrevented).toBe(true)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = undefined
  })

  it('falls back to plain navigation when nothing can route it', () => {
    // No activator installed: the anchor must stay an anchor rather than
    // becoming a click that does nothing.
    setKnownPodiumOrigins([HOME])
    render(<OfferText text={`${HOME}/issues/POD-1606`} />)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('link'), event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('falls back to plain navigation when the activator cannot open the target', () => {
    // THE DEAD CLICK. An activator is installed but the address names something
    // this client has not got — an unsynced issue, a backend path, a repo file.
    // Cancelling the anchor there replaces a working navigation with nothing.
    setKnownPodiumOrigins([HOME])
    setPodiumTargetActivator(() => false)
    render(<OfferText text={`${HOME}/issues/POD-9999`} />)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('link'), event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not let following a link collapse the offer around it', () => {
    const onParentClick = vi.fn()
    render(
      // A stand-in for the fold's own click target, which wraps this prose.
      // biome-ignore lint/a11y/useKeyWithClickEvents: not a real control
      // biome-ignore lint/a11y/noStaticElementInteractions: not a real control
      <div onClick={onParentClick}>
        <OfferText text="see https://example.com/x" />
      </div>,
    )
    fireEvent.click(screen.getByRole('link'))
    expect(onParentClick).not.toHaveBeenCalled()
  })
})
