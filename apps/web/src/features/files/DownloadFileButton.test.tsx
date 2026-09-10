// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let httpOrigin = ''
vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({ httpOrigin }),
}))

const toastInfo = vi.fn()
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

const { DownloadFileButton } = await import('./DownloadFileButton')

describe('DownloadFileButton', () => {
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
  })

  function renderButton(dirty = false): HTMLAnchorElement {
    act(() => {
      root.render(
        <DownloadFileButton
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path="/repo/site/index.html"
          dirty={dirty}
        />,
      )
    })
    const anchor = container.querySelector<HTMLAnchorElement>('a[aria-label="Download"]')
    if (!anchor) throw new Error('no anchor rendered')
    return anchor
  }

  function click(anchor: HTMLAnchorElement): boolean {
    let handled = false
    const settle = (event: Event) => {
      handled = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', settle)
    act(() => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    document.removeEventListener('click', settle)
    return handled
  }

  it('links to the file’s own URL with the server-side download flag', () => {
    const anchor = renderButton()
    expect(anchor.getAttribute('href')).toBe(
      `${window.location.origin}/files/asset?sessionId=s1&path=%2Frepo%2Fsite%2Findex.html&download=1`,
    )
    expect(anchor.getAttribute('download')).toBe('index.html')
  })

  it('does not hand the navigation to anyone: the webview saves it itself', () => {
    // No preventDefault even inside the desktop shell, whose on_download picks the path.
    expect(click(renderButton())).toBe(false)
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('warns when the saved file will not match unsaved editor changes', () => {
    click(renderButton(true))
    expect(toastInfo).toHaveBeenCalledTimes(1)
  })

  it('renders nothing for a path with no file name', () => {
    act(() => {
      root.render(
        <DownloadFileButton
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path="/repo/site/"
          dirty={false}
        />,
      )
    })
    expect(container.querySelector('a')).toBeNull()
  })
})
