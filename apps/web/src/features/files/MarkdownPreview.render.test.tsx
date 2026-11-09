// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.hoisted(() => ({
  httpOrigin: 'http://podium.test',
  openFile: vi.fn(),
  openFileInWorktree: vi.fn(),
}))

vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/react')>()),
  useClientRuntime: () => ({ access }),
}))

const { MarkdownPreview } = await import('./MarkdownPreview')

describe('MarkdownPreview re-renders', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(content: string, className: string): void {
    act(() =>
      root.render(
        <MarkdownPreview
          sessionId={asSessionId('s1')}
          path="/repo/notes.md"
          content={content}
          className={className}
        />,
      ),
    )
  }

  it('keeps the rendered nodes when a parent re-renders with the same content', () => {
    render('## Section\n\nBody.', 'a')
    const heading = container.querySelector('h2')
    expect(heading).toBeTruthy()

    render('## Section\n\nBody.', 'b')
    expect(container.querySelector('h2')).toBe(heading)
    expect(heading?.isConnected).toBe(true)
  })

  it('replaces the nodes when the content changes', () => {
    render('## Section\n\nBody.', 'a')
    const heading = container.querySelector('h2')

    render('## Renamed\n\nBody.', 'a')
    expect(container.querySelector('h2')?.textContent).toBe('Renamed')
    expect(heading?.isConnected).toBe(false)
  })
})
