// @vitest-environment happy-dom
import { JSON_MODE_MAP_KEY } from '@podium/client-core/ui-state'
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onSave = vi.fn(async () => {})
const onSetContent = vi.fn()
let documentContent = '{"a":1}'

vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    message: '',
    content: documentContent,
    contentRef: { current: documentContent },
    editable: true,
    dirty: false,
    saving: false,
    saveFeedback: null,
    baseHash: 'base',
    reloadNonce: 0,
    setContent: onSetContent,
    save: onSave,
    reload: vi.fn(),
  }),
}))

/** A real (in-memory) ui-state: the panel's mode is a SUBSCRIBED replicated key,
 *  so a `set` that never notifies would model a store it cannot have (POD-540). */
const ui = vi.hoisted(() => {
  const data = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    data,
    uiState: {
      get: (k: string): string | null => data.get(k) ?? null,
      set: (k: string, v: string | null): void => {
        if (v === null) data.delete(k)
        else data.set(k, v)
        for (const cb of [...listeners]) cb()
      },
      subscribe: (cb: () => void): (() => void) => {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      },
    },
  }
})

vi.mock('@/app/store', () => {
  const useStore = () => ({ httpOrigin: 'http://podium.test', uiState: ui.uiState })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('./OpenInBrowserButton', () => ({ OpenInBrowserButton: () => null }))

/** Stands in for CodeMirror: renders the text it was seeded with, and hands the
 *  panel a view whose dispatches we can read back. */
const editor = vi.hoisted(() => ({ dispatched: [] as { changes?: { insert?: string } }[] }))

vi.mock('./SourceEditor', () => ({
  SourceEditor: ({
    initialContent,
    editable,
    viewRef,
  }: {
    initialContent: string
    editable: boolean
    viewRef?: { current: unknown }
  }) => {
    if (viewRef) {
      viewRef.current = {
        state: { doc: { toString: () => initialContent, length: initialContent.length } },
        dispatch: (spec: { changes?: { insert?: string } }) => editor.dispatched.push(spec),
        focus: () => {},
      }
    }
    return <textarea aria-label={editable ? 'Raw' : 'Pretty'} value={initialContent} readOnly />
  },
}))

const { JsonFilePanel } = await import('./JsonFilePanel')

describe('JsonFilePanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ui.data.clear()
    editor.dispatched.length = 0
    documentContent = '{"a":1}'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderPanel(content: string, path = '/repo/data.json'): void {
    documentContent = content
    act(() => {
      root.render(
        <JsonFilePanel
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path={path}
          onClose={vi.fn()}
        />,
      )
    })
  }

  const pane = (label: string): HTMLTextAreaElement | null =>
    container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  const click = (selector: string): void => {
    act(() => container.querySelector<HTMLButtonElement>(selector)?.click())
  }

  it('opens a minified file already re-indented, without touching the document', () => {
    renderPanel('{"a":1,"b":[1,2]}')
    expect(pane('Pretty')?.value).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    expect(pane('Raw')).toBeNull()
    expect(onSetContent).not.toHaveBeenCalled()
  })

  it('says what the document is', () => {
    renderPanel('{"a":1,"b":2}')
    expect(container.textContent).toContain('Object · 2 keys')
    expect(container.textContent).toContain('13 B')
  })

  it('shows the file itself in Raw, and remembers the choice per tab', () => {
    renderPanel('{"a":1}')
    click('[aria-label="Raw"]')
    expect(pane('Raw')?.value).toBe('{"a":1}')
    expect(pane('Pretty')).toBeNull()
    const stored = JSON.parse(ui.data.get(JSON_MODE_MAP_KEY) ?? '{}') as Record<string, string>
    expect(Object.values(stored)).toEqual(['source'])
  })

  it('falls back to the file when it is not valid JSON, and names the fault', () => {
    renderPanel('{"a": 1,}')
    expect(pane('Raw')).toBeTruthy()
    expect(pane('Pretty')).toBeNull()
    expect(container.textContent).toContain('A trailing comma promises another key.')
    expect(container.textContent).toContain('Line 1, column 8')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Pretty"]')?.disabled).toBe(true)
  })

  it('leaves an empty file unscolded', () => {
    renderPanel('')
    expect(container.textContent).toContain('This file is empty.')
    expect(container.textContent).not.toContain('Line 1')
  })

  it('writes the indentation into the editor when asked to format', () => {
    renderPanel('{"a":1}')
    click('[aria-label="Raw"]')
    click('[aria-label="Format"]')
    expect(editor.dispatched.at(-1)?.changes?.insert).toBe('{\n  "a": 1\n}')
  })

  it('has nothing to format once the file is already formatted', () => {
    renderPanel('{\n  "a": 1\n}\n')
    click('[aria-label="Raw"]')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Format"]')?.disabled).toBe(true)
    expect(editor.dispatched).toHaveLength(0)
  })

  it('offers the fold controls only where there is a folded rendering to work on', () => {
    renderPanel('{"a":1}')
    expect(container.querySelector('[aria-label="Collapse all"]')).toBeTruthy()
    click('[aria-label="Raw"]')
    expect(container.querySelector('[aria-label="Collapse all"]')).toBeNull()
    expect(container.querySelector('[aria-label="Format"]')).toBeTruthy()
  })
})
