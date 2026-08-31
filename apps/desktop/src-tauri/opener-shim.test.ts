// @vitest-environment happy-dom
// apps/desktop/src-tauri/opener-shim.test.ts
//
// THE macOS HALF OF A CLICKABLE OFFER LINK. An agent offer renders its URLs as
// ordinary `<a href>` anchors (apps/web/src/features/chat/OfferText.tsx). In a
// browser tab `target="_blank"` is the whole story; inside the desktop shell
// WKWebView silently drops such a navigation, and what actually opens the OS
// browser is the shim injected into every window by `opener_shim_script()`.
//
// The Rust test beside that function only asserts the script MENTIONS the
// opener plugin. This one runs it: a real DOM, a real anchor of the shape the
// offer emits, a real capture-phase click — so the two halves are pinned to
// each other rather than to a substring.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The shim's source, lifted out of the Rust raw string that owns it. */
function openerShimScript(): string {
  const source = readFileSync(join(__dirname, 'src/bootstrap.rs'), 'utf8')
  const fn = source.indexOf('pub fn opener_shim_script()')
  expect(fn, 'opener_shim_script() moved or was renamed').toBeGreaterThan(-1)
  const start = source.indexOf('r#"', fn)
  const end = source.indexOf('"#', start)
  expect(start, 'opener_shim_script() no longer returns a raw string').toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start + 3, end)
}

let invoke: ReturnType<typeof vi.fn>
let nativeOpen: ReturnType<typeof vi.fn>

/** The endpoint `bootstrap::injection_script` writes into every window. */
function injectServer(endpoint: string | undefined): void {
  ;(window as unknown as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = endpoint
}

beforeEach(() => {
  document.body.innerHTML = ''
  invoke = vi.fn(async () => undefined)
  injectServer(undefined)
  // Every beforeEach installs another copy of the shim on the same document,
  // and each copy captures `__TAURI_INTERNALS__` as it stood when it ran. The
  // forwarding arrow is what keeps the oldest copy — the one whose capture
  // listener answers first — reporting into THIS test's mock.
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (...args: unknown[]) => invoke(...(args as [])),
  }
  // Stand in for the native `window.open` BEFORE the shim wraps it: the real
  // one makes happy-dom fetch the URL, and a declined (in-app) open would then
  // fail against a server that is not running.
  nativeOpen = vi.fn()
  window.open = nativeOpen as unknown as typeof window.open
  // Running the SHIPPED script is the point: a rewrite of it here would test
  // this file's idea of the shim rather than the one the app injects.
  new Function(openerShimScript())()
})

/** The anchor an offer's detail renders for a URL an agent wrote. */
function offerLink(href: string): HTMLAnchorElement {
  const paragraph = document.createElement('p')
  paragraph.innerHTML = `Open <a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a> and try it.`
  document.body.appendChild(paragraph)
  return paragraph.querySelector('a') as HTMLAnchorElement
}

/** Click the anchor and report whether the shim claimed the event. The target
 *  listener runs after the shim's capture-phase one, so it reads the verdict and
 *  then cancels the navigation the test environment would otherwise attempt. */
function clickOfferLink(href: string): boolean {
  const link = offerLink(href)
  let prevented = false
  link.addEventListener('click', (event) => {
    prevented = event.defaultPrevented
    event.preventDefault()
  })
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return prevented
}

describe('desktop opener shim', () => {
  it('hands an offer link to the OS browser instead of the webview', () => {
    // Prevented, so WKWebView never gets to swallow the navigation itself.
    expect(clickOfferLink('https://preview.example.com/login')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://preview.example.com/login',
    })
  })

  it('hands malformed explicit HTTP outward for clicks and window.open', () => {
    const href = 'http://127.0.0.1:8787./issues/POD-1'
    expect(clickOfferLink(href)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: href })

    invoke.mockClear()
    window.open(href, '_blank')
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: href })
    expect(nativeOpen).not.toHaveBeenCalled()
  })

  it('leaves an in-app link to the webview', () => {
    expect(clickOfferLink(`${window.location.origin}/session/abc`)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps a link to the reader\u2019s OWN Podium in the app (POD-1606)', () => {
    // THE PACKAGED-macOS BUG. All-in-one mode serves the page from
    // tauri://localhost and the server from 127.0.0.1, so an origin comparison
    // against the PAGE made the user's own issue link "external" and opened it
    // in Safari. The injected server endpoint is what says otherwise.
    injectServer('ws://127.0.0.1:8787')
    expect(clickOfferLink('http://127.0.0.1:8787/issues/POD-1606')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('still hands a different server to the OS browser', () => {
    injectServer('ws://127.0.0.1:8787')
    expect(clickOfferLink('http://127.0.0.1:9999/issues/POD-1606')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'http://127.0.0.1:9999/issues/POD-1606',
    })
  })

  it('hands live server selection to the OS instead of the active replica', () => {
    injectServer('ws://127.0.0.1:8787')
    expect(clickOfferLink('/sessions/POD-1606-A?server=wss%3A%2F%2Frelay.example')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'http://127.0.0.1:8787/sessions/POD-1606-A?server=wss%3A%2F%2Frelay.example',
    })
  })

  it('does not call the page origin ours when an injected server is active', () => {
    injectServer('ws://127.0.0.1:8787')
    expect(clickOfferLink(`${window.location.origin}/issues/POD-1606`)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: `${window.location.origin}/issues/POD-1606`,
    })
  })

  it('hands an active-origin link with a server selector to the OS', () => {
    injectServer('ws://127.0.0.1:8787')
    const href = 'http://127.0.0.1:8787/sessions/POD-1606-A?server=wss%3A%2F%2Frelay.example'
    expect(clickOfferLink(href)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: href })
  })

  it('reads the injected endpoint at click time, not at install time', () => {
    // The shim stays installed across the navigation to a transferred remote
    // origin; a value captured at install would go stale exactly then.
    expect(clickOfferLink('https://relay.example/issues/POD-1606')).toBe(true)
    invoke.mockClear()
    injectServer('wss://relay.example')
    expect(clickOfferLink('https://relay.example/issues/POD-1606')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('window.open answers the same question as a click', () => {
    injectServer('ws://127.0.0.1:8787')
    window.open('http://127.0.0.1:8787/issues/POD-1606', '_blank')
    expect(invoke).not.toHaveBeenCalled()
    expect(nativeOpen).toHaveBeenCalled()
    window.open('https://preview.example.com/login', '_blank')
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://preview.example.com/login',
    })
  })

  it('answers a userinfo host the same way the protocol resolver does', () => {
    // `http://anything@127.0.0.1:8787/x` is not our server, whatever the tail of
    // it looks like. The protocol layer calls it external and the page stamps
    // target="_blank"; if this half called it OURS it would decline, and
    // WKWebView would drop the click with nothing to show for it.
    injectServer('ws://127.0.0.1:8787')
    expect(clickOfferLink('http://anything@127.0.0.1:8787/issues/POD-1606')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'http://anything@127.0.0.1:8787/issues/POD-1606',
    })
  })

  it('does not install outside the desktop shell, where the anchor already works', () => {
    // Asserted through `window.open` rather than a click: the shim installed
    // for this test's siblings is still on the document and would answer first.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined
    const before = window.open
    new Function(openerShimScript())()
    expect(window.open).toBe(before)
  })
})
