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
import {
  hasServerSelector,
  internalPodiumTarget,
  setKnownPodiumOrigins,
  setPodiumTargetActivator,
  startupPodiumHref,
  startupPodiumRouteHref,
} from './podium-link'
import {
  handlePodiumLinkAuxClick,
  handlePodiumLinkClick,
  handlePodiumLinkContextMenu,
} from './podium-link-click'

const HOME = 'http://127.0.0.1:8787'
const OTHER = 'http://127.0.0.1:9898'

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

  it('gives ordinary browser fallback the active server when activation declines', () => {
    // THE DEAD CLICK the review found: a repo file, a backend path, an issue the
    // replica has not received. Cancelling here replaces a real navigation with
    // nothing at all.
    setPodiumTargetActivator(() => false)
    expect(window.location.origin).not.toBe(HOME)
    expect(clickOn('<a href="/docs/readme.md">x</a>').defaultPrevented).toBe(false)
    expect((document.querySelector('a') as HTMLAnchorElement).href).toBe(`${HOME}/docs/readme.md`)
    expect(clickOn(`<a href="${HOME}/files/asset?path=/w/a.png">x</a>`).defaultPrevented).toBe(
      false,
    )
  })

  it('removes a boot-stale blank target before an activator fallback', () => {
    setPodiumTargetActivator(() => false)
    const event = clickOn(
      `<a href="${HOME}/issues/POD-9999" data-podium-link-candidate="" target="_blank" rel="noopener noreferrer">x</a>`,
    )
    const link = document.querySelector('a') as HTMLAnchorElement
    expect(event.defaultPrevented).toBe(false)
    expect(link.getAttribute('target')).toBeNull()
    expect(link.getAttribute('rel')).toBeNull()
  })

  it('keeps deliberate blank-target fallback on an already-marked internal link', () => {
    setPodiumTargetActivator(() => false)
    const event = clickOn(
      `<a href="${HOME}/files/asset?path=%2Fw%2Fa.png" data-podium-link-candidate="" data-podium-link="" target="_blank" rel="noopener noreferrer">x</a>`,
    )
    const link = document.querySelector('a') as HTMLAnchorElement
    expect(event.defaultPrevented).toBe(false)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
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

  it('gives browser modifier fallback the active server instead of the page origin', () => {
    expect(window.location.origin).not.toBe(HOME)
    const event = clickOn('<a href="/issues/POD-1606">x</a>', { metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect((document.querySelector('a') as HTMLAnchorElement).href).toBe(`${HOME}/issues/POD-1606`)
  })

  it('keeps unknown file fallback query bytes exact', () => {
    setPodiumTargetActivator(() => false)
    const href =
      '/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D'
    const event = clickOn(`<a href="${href}">x</a>`)
    expect(event.defaultPrevented).toBe(false)
    expect((document.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe(
      `${HOME}${href}`,
    )
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

  it('resolves a root-relative modifier click against the active server, not Tauri', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    const event = clickOn('<a href="/issues/POD-1606">x</a>', { metaKey: true })
    expect(openExternal).toHaveBeenCalledWith(`${HOME}/issues/POD-1606`)
    expect(event.defaultPrevented).toBe(true)
  })

  it('hands a desktop middle-click to the OS browser', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    document.body.innerHTML =
      '<a href="/issues/POD-1606" data-podium-link-candidate="" data-podium-link-source="/issues/POD-1606">x</a>'
    const anchor = document.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    Object.defineProperty(event, 'target', { value: anchor })

    expect(handlePodiumLinkAuxClick(event)).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(`${HOME}/issues/POD-1606`)
    expect(event.defaultPrevented).toBe(true)
  })

  it('hands an external desktop middle-click to the OS browser', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    document.body.innerHTML =
      '<a href="https://example.com/guide" data-podium-link-candidate="" data-podium-link-source="https://example.com/guide" target="_blank">x</a>'
    const anchor = document.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    Object.defineProperty(event, 'target', { value: anchor })

    expect(handlePodiumLinkAuxClick(event)).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/guide')
    expect(event.defaultPrevented).toBe(true)
  })

  it('normalizes every protocol-relative spelling for desktop middle-click', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    for (const href of [
      '//example.test/guide',
      '/\\example.test/guide',
      '\\/example.test/guide',
      '\\\\example.test\\guide',
    ]) {
      document.body.innerHTML = '<a data-podium-link-candidate="">x</a>'
      const anchor = document.querySelector('a') as HTMLAnchorElement
      anchor.setAttribute('href', href)
      anchor.setAttribute('data-podium-link-source', href)
      const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      Object.defineProperty(event, 'target', { value: anchor })
      expect(handlePodiumLinkAuxClick(event)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(openExternal.mock.calls.map(([href]) => href)).toEqual([
      'http://example.test/guide',
      'http://example.test/guide',
      'http://example.test/guide',
      'http://example.test/guide',
    ])
  })

  it('canonicalizes protocol-relative context actions without changing detail bytes', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    const href = String.raw`\\example.test\guide?q=C:\Users#x\y`
    document.body.innerHTML = '<a data-podium-link-candidate="">x</a>'
    const anchor = document.querySelector('a') as HTMLAnchorElement
    anchor.setAttribute('href', href)
    anchor.setAttribute('data-podium-link-source', href)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: anchor })

    expect(handlePodiumLinkContextMenu(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(anchor.getAttribute('href')).toBe(String.raw`http://example.test/guide?q=C:\Users#x\y`)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('hands an authored old-server middle-click out after the active server changes', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    setKnownPodiumOrigins([OTHER])
    const href = `${HOME}/issues/POD-1606`
    document.body.innerHTML = `<a href="${href}" data-podium-link-candidate="" data-podium-link-source="${href}" data-podium-link="">x</a>`
    const anchor = document.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    Object.defineProperty(event, 'target', { value: anchor })

    expect(handlePodiumLinkAuxClick(event)).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(href)
    expect(anchor.hasAttribute('data-podium-link')).toBe(false)
    expect(anchor.getAttribute('target')).toBe('_blank')
  })

  it('keeps browser and shell context actions canonical without suppressing the menu', () => {
    document.body.innerHTML =
      '<a href="/issues/POD-1606" data-podium-link-candidate="" data-podium-link-source="/issues/POD-1606">x</a>'
    const anchor = document.querySelector('a') as HTMLAnchorElement
    const browserEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    Object.defineProperty(browserEvent, 'target', { value: anchor })

    expect(handlePodiumLinkContextMenu(browserEvent)).toBe(false)
    expect(anchor.href).toBe(`${HOME}/issues/POD-1606`)
    expect(browserEvent.defaultPrevented).toBe(false)

    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    const shellEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    Object.defineProperty(shellEvent, 'target', { value: anchor })
    expect(handlePodiumLinkContextMenu(shellEvent)).toBe(false)
    expect(shellEvent.defaultPrevented).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does not intercept ordinary app anchors at the document boundary', () => {
    const openExternal = vi.fn(async () => undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      openExternal,
    }
    document.body.innerHTML = '<a href="/settings">settings</a>'
    const anchor = document.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: anchor })

    expect(handlePodiumLinkContextMenu(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(anchor.getAttribute('href')).toBe('/settings')
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

  it('leaves ordinary views and unsupported typed detail with the browser', () => {
    expect(startupPodiumHref({ pathname: '/settings/general', search: '' })).toBeNull()
    expect(
      startupPodiumHref({ pathname: '/issues/POD-1606', search: '?tab=activity', hash: '#latest' }),
    ).toBeNull()
  })

  it('retains only the server selector while a typed startup target waits', () => {
    const search = '?server=wss%3A%2F%2Fother.example&path=not-route-state'
    expect(startupPodiumRouteHref({ search })).toBe('/workspace?server=wss%3A%2F%2Fother.example')
    expect(
      startupPodiumHref({
        pathname: '/sessions/POD-1606-A',
        search: '?server=wss%3A%2F%2Fother.example',
      }),
    ).toBe('/sessions/POD-1606-A')
    expect(
      startupPodiumHref({
        pathname: '/file',
        search: '?path=%2Fw%2Fa.ts&root=%2Fw&server=wss%3A%2F%2Fother.example',
      }),
    ).toBe('/file?path=%2Fw%2Fa.ts&root=%2Fw')
    expect(
      startupPodiumHref({ pathname: '/file', search: '?path=%2Fw%2Fa.ts&root=%2Fw&line=42' }),
    ).toBeNull()
  })
})

describe('server identity', () => {
  it('does not resolve the page origin when an explicit server is active', () => {
    expect(window.location.origin).not.toBe(HOME)
    expect(internalPodiumTarget(`${window.location.origin}/issues/POD-1606`)).toBeNull()
    expect(internalPodiumTarget(`${HOME}/issues/POD-1606`)).toEqual({
      kind: 'issue',
      issue: 'POD-1606',
    })
  })

  it('does not resolve a live server selector against the active replica', () => {
    expect(internalPodiumTarget('/sessions/POD-1606-A?server=wss%3A%2F%2Fother.example')).toBeNull()
    expect(
      internalPodiumTarget('/file?path=%2Fw%2Fa.ts&root=%2Fw&server=wss%3A%2F%2Fother.example'),
    ).toBeNull()
  })

  it('does not mistake a question mark inside a fragment for a server selector', () => {
    expect(hasServerSelector('/issues/POD-1606#example?server=docs')).toBe(false)
    expect(hasServerSelector('/issues/POD-1606?server=docs#example')).toBe(true)
  })
})
