// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => {
  const data = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    data,
    uiState: {
      get: (key: string): string | null => data.get(key) ?? null,
      set: (key: string, value: string | null): void => {
        if (value === null) data.delete(key)
        else data.set(key, value)
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
})

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ uiState: ui.uiState } as never),
}))

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    message: '',
    content: '# Breathe\n\nA quiet page.',
    editable: true,
    dirty: false,
    saving: false,
    saveFeedback: null,
    reloadNonce: 0,
    setContent: vi.fn(),
    save: vi.fn(async () => {}),
  }),
}))

vi.mock('./SourceEditor', () => ({
  SourceEditor: () => <textarea aria-label="File source" readOnly />,
}))

vi.mock('./MarkdownPreview', () => ({
  MarkdownPreview: ({ content, className }: { content: string; className?: string }) => (
    <div data-testid="markdown-preview" className={className}>
      {content}
    </div>
  ),
}))

vi.mock('./OpenInBrowserButton', () => ({ OpenInBrowserButton: () => null }))

const { MarkdownFilePanel } = await import('./MarkdownFilePanel')

describe('MarkdownFilePanel calm reading mode', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ui.data.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderPanel(path: string): void {
    act(() => {
      root.render(
        <MarkdownFilePanel
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path={path}
          onClose={vi.fn()}
        />,
      )
    })
  }

  it('offers calm reading only for Markdown files', () => {
    renderPanel('/repo/notes.txt')
    expect(container.querySelector('[aria-label="Enter calm reading mode"]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    renderPanel('/repo/notes.MARKDOWN')
    expect(container.querySelector('[aria-label="Enter calm reading mode"]')).toBeTruthy()
  })

  it('opens a focused reading dialog and leaves it with Escape', () => {
    renderPanel('/repo/notes.md')

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Enter calm reading mode"]')?.click()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('Calm reading: /repo/notes.md')
    expect(dialog?.querySelector('.calm-reader-document')?.textContent).toContain('A quiet page.')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('leaves calm reading from the lotus control', () => {
    renderPanel('/repo/notes.md')
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Enter calm reading mode"]')?.click()
    })
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Leave calm reading mode"]')
        ?.click()
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
