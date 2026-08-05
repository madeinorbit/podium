// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'

/** The server the page talks to — same origin as the page unless a test says otherwise. */
let httpOrigin = ''
vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({ httpOrigin }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError } }))

const { OpenInBrowserButton } = await import('./OpenInBrowserButton')

const desktopGlobal = globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }

/** The bridge the shell injects, minus whichever external-open support we're testing. */
function shellBridge(extra: Partial<NativeDesktopBridge> = {}): NativeDesktopBridge {
  return {
    platform: 'macos',
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...extra,
  }
}

describe('OpenInBrowserButton', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    httpOrigin = window.location.origin
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete desktopGlobal.__PODIUM_DESKTOP__
  })

  function renderButton(dirty = false): HTMLAnchorElement {
    act(() => {
      root.render(
        <OpenInBrowserButton
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path="/repo/site/index.html"
          dirty={dirty}
        />,
      )
    })
    const anchor = container.querySelector<HTMLAnchorElement>('a[aria-label="Open in browser"]')
    if (!anchor) throw new Error('no anchor rendered')
    return anchor
  }

  /** Clicks the anchor and reports whether the button took the navigation over. */
  function clickIsHandled(anchor: HTMLAnchorElement): boolean {
    let handled = false
    // Runs after React's handler (which is bound on the root container, below document).
    const settle = (event: Event) => {
      handled = event.defaultPrevented
      event.preventDefault() // else happy-dom really opens a window and fetches the URL
    }
    document.addEventListener('click', settle)
    act(() => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    document.removeEventListener('click', settle)
    return handled
  }

  const assetUrl = () =>
    `${window.location.origin}/files/asset?sessionId=s1&path=%2Frepo%2Fsite%2Findex.html`

  it('links to the file’s own URL on the server', () => {
    expect(renderButton().getAttribute('href')).toBe(assetUrl())
  })

  it('leaves the navigation to the browser when there is no desktop shell', () => {
    expect(clickIsHandled(renderButton())).toBe(false)
  })

  it('hands the URL to the OS browser inside the desktop shell', () => {
    const openExternal = vi.fn(async () => {})
    desktopGlobal.__PODIUM_DESKTOP__ = shellBridge({ openExternal })

    // Prevented: the shell's own _blank would have opened an in-app webview window.
    expect(clickIsHandled(renderButton())).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(assetUrl())
  })

  it('leaves a cross-origin file URL to the shell’s own link shim', () => {
    // All-in-one mode: the UI is loaded from tauri://localhost, so the shim already diverts
    // this one. Taking it over here as well would open the file twice.
    httpOrigin = 'http://127.0.0.1:18787'
    const openExternal = vi.fn(async () => {})
    desktopGlobal.__PODIUM_DESKTOP__ = shellBridge({ openExternal })

    expect(clickIsHandled(renderButton())).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('falls back to the anchor on a shell older than openExternal', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = shellBridge()

    expect(clickIsHandled(renderButton())).toBe(false)
  })

  it('says so when the shell cannot reach a browser', async () => {
    desktopGlobal.__PODIUM_DESKTOP__ = shellBridge({
      openExternal: vi.fn(async () => {
        throw new Error('opener denied')
      }),
    })

    clickIsHandled(renderButton())
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it('warns that the browser gets the on-disk bytes when the editor is dirty', () => {
    clickIsHandled(renderButton(true))

    expect(toastInfo).toHaveBeenCalledTimes(1)
  })
})
