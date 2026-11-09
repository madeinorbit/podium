// @vitest-environment happy-dom
import type { EditorView } from '@codemirror/view'
import { MD_MODE_MAP_KEY } from '@podium/client-core/ui-state'
import { type FileScope, scopeKey } from '@podium/client-core/values'
import { asArtifactId, asIssueId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'

const fixture = vi.hoisted(() => {
  const data = new Map<string, string>()
  return {
    data,
    status: 'ready' as 'loading' | 'ready',
    access: {
      httpOrigin: 'http://podium.test',
      openFile: vi.fn(),
      openFileInWorktree: vi.fn(),
      uiState: {
        get: (key: string) => data.get(key) ?? null,
        set: (key: string, value: string | null) => {
          if (value === null) data.delete(key)
          else data.set(key, value)
        },
      },
    },
  }
})

vi.mock('@podium/client-core/react', async (original) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...(await original<typeof import('@podium/client-core/react')>()),
    ...fixtureRuntimeHooks(() => ({ access: fixture.access })),
  }
})
vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/use-persisted-ui-state', () => ({
  usePersistedUiValue: (key: string, parse: (raw: string | null) => unknown) =>
    parse(fixture.access.uiState.get(key)),
}))
vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: fixture.status,
    content: '# Saved report\n\nThe reading position belongs to this artifact.',
    editable: false,
    dirty: false,
    saving: false,
    reloadNonce: 0,
    setContent: vi.fn(),
    save: vi.fn(),
  }),
}))
vi.mock('./OpenInBrowserButton', () => ({ OpenInBrowserButton: () => null }))
vi.mock('./DownloadFileButton', () => ({ DownloadFileButton: () => null }))
vi.mock('./SourceEditor', () => ({
  SourceEditor: ({ onViewReady }: { onViewReady?: (view: EditorView) => void }) => {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      onViewReady?.({ scrollDOM: ref.current! } as unknown as EditorView)
    }, [onViewReady])
    return <div ref={ref} data-testid="source-scroller" />
  },
}))

const { MarkdownFilePanel } = await import('./MarkdownFilePanel')
const scope: FileScope = {
  kind: 'artifact',
  issueId: asIssueId('task-a'),
  artifactId: asArtifactId('report-a'),
}
const path = 'report.md'

function panel(owner = scope, visible = true) {
  return (
    <PanelVisible visible={visible}>
      <MarkdownFilePanel scope={owner} path={path} onClose={() => {}} />
    </PanelVisible>
  )
}

function flush() {
  act(() => vi.runOnlyPendingTimers())
}

beforeEach(() => {
  fixture.data.clear()
  fixture.status = 'ready'
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Markdown artifact reading position', () => {
  it.each([
    'preview',
    'source',
  ] as const)('restores %s after switching tasks, including a delayed file read', (mode) => {
    if (mode === 'source')
      fixture.data.set(
        MD_MODE_MAP_KEY,
        JSON.stringify({ [`file:${scopeKey(scope)}:${path}`]: mode }),
      )
    let mounted = render(panel())
    flush()
    const selector = mode === 'preview' ? '.markdown-preview' : '[data-testid="source-scroller"]'
    const scroller = mounted.container.querySelector<HTMLElement>(selector)!
    scroller.scrollTop = 640
    scroller.scrollLeft = 24
    fireEvent.scroll(scroller)
    // Switching away must flush even before the scroll debounce expires.
    mounted.unmount()

    fixture.status = 'loading'
    mounted = render(panel())
    flush()
    expect(mounted.container.querySelector(selector)).toBeNull()
    fixture.status = 'ready'
    mounted.rerender(panel())
    flush()
    const restored = mounted.container.querySelector<HTMLElement>(selector)!
    expect(restored.scrollTop).toBe(640)
    expect(restored.scrollLeft).toBe(24)
  })

  it('keeps artifacts with the same filename independent and remembers scrolling back to the top', () => {
    let mounted = render(panel())
    flush()
    const scroller = mounted.container.querySelector<HTMLElement>('.markdown-preview')!
    scroller.scrollTop = 480
    fireEvent.scroll(scroller)
    mounted.unmount()

    mounted = render(panel({ ...scope, artifactId: asArtifactId('report-b') }))
    flush()
    expect(mounted.container.querySelector<HTMLElement>('.markdown-preview')!.scrollTop).toBe(0)
    mounted.unmount()

    mounted = render(panel())
    flush()
    const restored = mounted.container.querySelector<HTMLElement>('.markdown-preview')!
    expect(restored.scrollTop).toBe(480)
    restored.scrollTop = 0
    fireEvent.scroll(restored)
    mounted.unmount()
    mounted = render(panel())
    flush()
    expect(mounted.container.querySelector<HTMLElement>('.markdown-preview')!.scrollTop).toBe(0)
  })

  it('ignores scroll resets while hidden and restores the offset on reveal', () => {
    const mounted = render(panel())
    flush()
    const scroller = mounted.container.querySelector<HTMLElement>('.markdown-preview')!
    scroller.scrollTop = 720
    fireEvent.scroll(scroller)
    mounted.rerender(panel(scope, false))
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    flush()
    mounted.rerender(panel())
    flush()
    expect(scroller.scrollTop).toBe(720)
  })
})
