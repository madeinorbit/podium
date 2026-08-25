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

beforeEach(() => {
  document.body.innerHTML = ''
  invoke = vi.fn(async () => undefined)
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
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

  it('leaves an in-app link to the webview', () => {
    expect(clickOfferLink(`${window.location.origin}/session/abc`)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
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
