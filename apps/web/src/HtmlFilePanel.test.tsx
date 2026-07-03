// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onSave = vi.fn(async () => {})
const onSetContent = vi.fn()
const onReadFile = vi.fn(async () => ({ ok: false, error: 'not found' }))

vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    message: '',
    content: '<h1>Rendered</h1>',
    contentRef: { current: '<h1>Rendered</h1>' },
    editable: true,
    dirty: false,
    saving: false,
    baseHash: 'base',
    reloadNonce: 0,
    setContent: onSetContent,
    save: onSave,
    reload: vi.fn(),
  }),
}))

vi.mock('./store', () => ({
  useStore: () => ({
    httpOrigin: 'http://podium.test',
    readFileScoped: onReadFile,
  }),
}))

vi.mock('./hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('./SourceEditor', () => ({
  SourceEditor: ({ initialContent }: { initialContent: string }) => (
    <textarea aria-label="HTML source" value={initialContent} readOnly />
  ),
}))

const { HtmlFilePanel } = await import('./HtmlFilePanel')

describe('HtmlFilePanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows rendered preview by default, switches to source, and closes', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(
        <HtmlFilePanel
          scope={{ kind: 'session', sessionId: 's1' }}
          path="/repo/site/index.html"
          onClose={onClose}
        />,
      )
    })

    const iframe = container.querySelector('iframe[title="Rendered HTML preview"]')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Rendered</h1>')

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Source"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('iframe[title="Rendered HTML preview"]')).toBeNull()
    expect(container.querySelector('textarea[aria-label="HTML source"]')).toBeTruthy()

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
