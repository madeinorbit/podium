// @vitest-environment happy-dom
/**
 * THE ONE HANDLER BOTH MARKDOWN PIPELINES CALL (POD-1606).
 *
 * The transcript and the file/artifact preview render through different
 * assemblers but mark internal anchors identically. When only the transcript
 * intercepted them, the same link opened in place in chat and full-page
 * navigated the SPA off the file in a preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKnownPodiumOrigins, setPodiumTargetActivator, startupPodiumHref } from './podium-link'
import { handlePodiumLinkClick } from './podium-link-click'

const HOME = 'http://127.0.0.1:8787'

function clickOn(html: string, init: MouseEventInit = {}): MouseEvent {
  document.body.innerHTML = html
  const anchor = document.querySelector('a') as HTMLAnchorElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  // The React handlers pass their synthetic event; only `target`, the modifier
  // flags and preventDefault are read, which a real MouseEvent supplies.
  Object.defineProperty(event, 'target', { value: anchor })
  handlePodiumLinkClick(event)
  return event
}

beforeEach(() => setKnownPodiumOrigins([HOME]))
afterEach(() => {
  setKnownPodiumOrigins([])
  setPodiumTargetActivator(null)
  ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = undefined
  document.body.innerHTML = ''
})

describe('handlePodiumLinkClick', () => {
  it('claims a link into this Podium and opens it in place', () => {
    const activate = vi.fn(() => true)
    setPodiumTargetActivator(activate)
    const event = clickOn(`<a href="${HOME}/issues/POD-1606">x</a>`)
    expect(activate).toHaveBeenCalledWith({ kind: 'issue', issue: 'POD-1606' }, { direct: false })
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a link that goes anywhere else completely alone', () => {
    const activate = vi.fn(() => true)
    setPodiumTargetActivator(activate)
    const event = clickOn('<a href="https://example.com/guide" target="_blank">x</a>')
    expect(activate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves the anchor alone when the activator cannot open the target', () => {
    // THE DEAD CLICK the review found: a repo file, a backend path, an issue the
    // replica has not received. Cancelling here replaces a real navigation with
    // nothing at all.
    setPodiumTargetActivator(() => false)
    expect(clickOn('<a href="/docs/readme.md">x</a>').defaultPrevented).toBe(false)
    expect(clickOn(`<a href="${HOME}/files/asset?path=/w/a.png">x</a>`).defaultPrevented).toBe(
      false,
    )
  })

  it('leaves the anchor alone when no activator is installed at all', () => {
    expect(clickOn(`<a href="${HOME}/issues/POD-1606">x</a>`).defaultPrevented).toBe(false)
  })

  it('lets the browser answer a modifier click', () => {
    const activate = vi.fn(() => true)
    setPodiumTargetActivator(activate)
    const event = clickOn(`<a href="${HOME}/issues/POD-1606">x</a>`, { metaKey: true })
    expect(activate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('hands a modifier click to the OS browser inside the desktop shell', () => {
    // The internal anchor has no target="_blank" and the shim now declines our
    // own origins, so WKWebView would drop this silently.
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    setPodiumTargetActivator(() => true)
    const event = clickOn(`<a href="${HOME}/issues/POD-1606">x</a>`, { ctrlKey: true })
    expect(openExternal).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores a click that did not land on a link', () => {
    setPodiumTargetActivator(() => true)
    document.body.innerHTML = '<p>no link here</p>'
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: document.querySelector('p') })
    expect(handlePodiumLinkClick(event)).toBe(false)
  })
})

describe('startupPodiumHref', () => {
  it('captures canonical targets before the ordinary router can erase them', () => {
    expect(startupPodiumHref({ pathname: '/issues/POD-1606', search: '' })).toBe('/issues/POD-1606')
    expect(startupPodiumHref({ pathname: '/sessions/POD-1606-A', search: '' })).toBe(
      '/sessions/POD-1606-A',
    )
    expect(
      startupPodiumHref({ pathname: '/issues/POD-1606/artifacts/art1/index.html', search: '' }),
    ).toBe('/issues/POD-1606/artifacts/art1/index.html')
    expect(startupPodiumHref({ pathname: '/file', search: '?path=%2Fw%2Fa.ts&root=%2Fw' })).toBe(
      '/file?path=%2Fw%2Fa.ts&root=%2Fw',
    )
  })

  it('leaves ordinary and detailed routes with the browser', () => {
    expect(startupPodiumHref({ pathname: '/settings/general', search: '' })).toBeNull()
    expect(
      startupPodiumHref({ pathname: '/issues/POD-1606', search: '?tab=activity', hash: '#latest' }),
    ).toBeNull()
  })
})
