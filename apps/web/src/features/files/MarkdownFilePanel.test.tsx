import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const file = vi.hoisted(() => ({ content: '# Breathe\n\nA quiet page.' }))

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
  useRuntimeSelector: (select: (store: unknown) => unknown) =>
    select({ uiState: ui.uiState } as never),
}))

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    message: '',
    content: file.content,
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

// Renders `## ` lines as headings so the reader's outline has something to find.
vi.mock('./MarkdownPreview', () => ({
  MarkdownPreview: ({
    content,
    className,
    scrollRef,
  }: {
    content: string
    className?: string
    scrollRef?: { current: HTMLDivElement | null }
  }) => (
    <div
      data-testid="markdown-preview"
      className={className}
      ref={(el) => {
        if (scrollRef) scrollRef.current = el
      }}
    >
      {content
        .split('\n')
        .filter(Boolean)
        .map((line) =>
          line.startsWith('## ') ? <h2 key={line}>{line.slice(3)}</h2> : <p key={line}>{line}</p>,
        )}
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
    file.content = '# Breathe\n\nA quiet page.'
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
    // Focus lands on the scroller, so Space and PageDown page the document at once.
    expect(document.activeElement).toBe(dialog?.querySelector('.calm-reader-document'))

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

  function openReader(): HTMLElement {
    renderPanel('/repo/notes.md')
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Enter calm reading mode"]')?.click()
    })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('calm reader did not open')
    return dialog
  }

  it('lists the document sections in the outline and marks one as current', () => {
    file.content = '# Notes\n\n## Why handoffs fail\n\nBody.\n\n## The shape of a good one\n\nMore.'
    const dialog = openReader()

    const items = [
      ...dialog.querySelectorAll<HTMLButtonElement>('nav[aria-label="Sections"] button'),
    ]
    expect(items.map((b) => b.textContent)).toEqual([
      'Why handoffs fail',
      'The shape of a good one',
    ])
    // happy-dom lays nothing out, so WHICH section is current is not testable
    // here; that exactly one is marked is.
    expect(items.filter((b) => b.getAttribute('aria-current') === 'location')).toHaveLength(1)
    expect(dialog.querySelector('[aria-label="Reading progress"]')).toBeTruthy()

    // A jump takes focus with it, so the keyboard pages on from the destination.
    act(() => items[1]?.click())
    expect(document.activeElement?.textContent).toBe('The shape of a good one')
    expect(items[1]?.getAttribute('aria-current')).toBe('location')
  })

  it('leaves out the outline when the document has fewer than two sections', () => {
    const dialog = openReader()
    expect(dialog.querySelector('nav[aria-label="Sections"]')).toBeNull()
  })

  it('closes from the dimmed backdrop but not from inside the document or a drag out of it', () => {
    const dialog = openReader()

    const press = (el: Element | null | undefined): void => {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    }

    act(() => {
      const paragraph = dialog.querySelector<HTMLElement>('.calm-reader-document p')
      press(paragraph)
      paragraph?.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy()

    // A selection dragged from the text out into the margin ends with a click
    // on the backdrop; it began in the document, so the reader stays open.
    act(() => {
      press(dialog.querySelector('.calm-reader-document p'))
      dialog.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy()

    act(() => {
      press(dialog)
      dialog.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
