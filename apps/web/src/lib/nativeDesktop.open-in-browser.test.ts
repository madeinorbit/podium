// @vitest-environment happy-dom
/**
 * THE TWO HALVES OF "OPEN IN A REAL BROWSER" (POD-1606).
 *
 * The desktop shell's injected shim diverts links that LEAVE this Podium; this
 * function covers the ones that are ours, which the shim deliberately declines
 * and the webview would answer with an in-app window. Every link must be taken
 * by exactly one of them — a URL both claim opens twice, and one neither claims
 * opens nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openInSystemBrowser } from './nativeDesktop'
import { setKnownPodiumOrigins } from './podium-link'

const SERVER = 'http://127.0.0.1:8787'
let openExternal: ReturnType<typeof vi.fn>

function installShell(): void {
  openExternal = vi.fn(async () => undefined)
  ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
    platform: 'macos',
    openExternal,
  }
}

beforeEach(installShell)
afterEach(() => {
  ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = undefined
  setKnownPodiumOrigins([])
})

describe('openInSystemBrowser', () => {
  it('takes a URL on the server origin — the shim now leaves it alone', () => {
    setKnownPodiumOrigins([SERVER])
    expect(openInSystemBrowser(`${SERVER}/files/asset?root=/w&path=/w/a.html`)).not.toBeNull()
    expect(openExternal).toHaveBeenCalled()
  })

  it('declines a URL that leaves Podium, so the shim is the only one to open it', () => {
    setKnownPodiumOrigins([SERVER])
    expect(openInSystemBrowser('https://example.com/guide')).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('takes a URL built from the page origin even when that is not an http origin', () => {
    // The all-in-one shell serves the page from a custom scheme. Callers keep a
    // `window.location.origin` fallback for a client that has not resolved its
    // server yet; neither half speaks that scheme, so without this it opened
    // nothing at all.
    expect(
      openInSystemBrowser(`${window.location.origin}/files/asset?path=/w/a.html`),
    ).not.toBeNull()
    expect(openExternal).toHaveBeenCalled()
  })

  it('declines outside the desktop shell, where the anchor already works', () => {
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = undefined
    setKnownPodiumOrigins([SERVER])
    expect(openInSystemBrowser(`${SERVER}/files/asset?path=/w/a.html`)).toBeNull()
  })
})
