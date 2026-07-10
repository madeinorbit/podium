// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileScope } from '@/lib/file-scope'

vi.mock('./HtmlFilePanel', () => ({
  HtmlFilePanel: ({ path }: { path: string }) => <div data-panel="html">{path}</div>,
}))

vi.mock('./MarkdownFilePanel', () => ({
  MarkdownFilePanel: ({ path }: { path: string }) => <div data-panel="markdown">{path}</div>,
}))

const { FilePanel } = await import('./FilePanel')

describe('FilePanel', () => {
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

  const scope: FileScope = { kind: 'session', sessionId: 's1' }

  function renderPath(path: string): void {
    act(() => {
      root.render(<FilePanel scope={scope} path={path} onClose={vi.fn()} />)
    })
  }

  it('routes html extensions to the html panel', () => {
    renderPath('/repo/index.html')
    expect(container.querySelector('[data-panel="html"]')?.textContent).toBe('/repo/index.html')

    renderPath('/repo/export.htm')
    expect(container.querySelector('[data-panel="html"]')?.textContent).toBe('/repo/export.htm')
  })

  it('keeps markdown and other files on the existing markdown/source panel', () => {
    renderPath('/repo/readme.md')
    expect(container.querySelector('[data-panel="markdown"]')?.textContent).toBe('/repo/readme.md')

    renderPath('/repo/app.ts')
    expect(container.querySelector('[data-panel="markdown"]')?.textContent).toBe('/repo/app.ts')
  })
})
