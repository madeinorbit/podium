// @vitest-environment happy-dom
import { HTML_MODE_MAP_KEY } from '@podium/client-core/ui-state'
import { tabIdFor } from '@podium/client-core/viewmodels'
import { asArtifactId, asIssueId, asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onSave = vi.fn(async () => {})
const onSetContent = vi.fn()
const onReadFile = vi.fn(async () => ({ ok: false, error: 'not found' }))
let documentContent = '<h1>Rendered</h1>'

vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    message: '',
    content: documentContent,
    contentRef: { current: documentContent },
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

/** A real (in-memory) ui-state, not an inert stub: the panel's mode is a
 *  SUBSCRIBED replicated key now, so a `set` that never notifies would model a
 *  store this component cannot have (POD-540). */
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
  const uiState = ui.uiState
  const useStore = () => ({
    httpOrigin: 'http://podium.test',
    readFileScoped: onReadFile,
    uiState,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/lib/hooks/use-is-mobile', () => ({
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
    ui.data.clear()
    vi.clearAllMocks()
    documentContent = '<h1>Rendered</h1>'
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
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
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

  it('adopts a stored mode that arrives after the panel has mounted', () => {
    // The mode map is per-user replicated, so on a cold load it is EMPTY at
    // mount and lands a moment later. A seeded `useState` would show preview
    // forever; a subscriber switches when the row shows up (POD-540).
    act(() => {
      root.render(
        <HtmlFilePanel
          scope={{ kind: 'session', sessionId: asSessionId('s1') }}
          path="/repo/site/index.html"
          onClose={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('iframe[title="Rendered HTML preview"]')).toBeTruthy()

    act(() => {
      const tabId = tabIdFor(
        { kind: 'session', sessionId: asSessionId('s1') },
        '/repo/site/index.html',
      )
      ui.uiState.set(HTML_MODE_MAP_KEY, JSON.stringify({ [tabId]: 'source' }))
    })

    expect(container.querySelector('iframe[title="Rendered HTML preview"]')).toBeNull()
    expect(container.querySelector('textarea[aria-label="HTML source"]')).toBeTruthy()
  })

  it('rewrites worktree-scoped relative assets through the root-scoped asset route', () => {
    documentContent = '<img src="./hero.png" alt="Hero">'
    act(() => {
      root.render(
        <HtmlFilePanel
          scope={{ kind: 'worktree', root: '/repo', machineId: 'm1' }}
          path="/repo/.superpowers/run/ready.html"
          onClose={vi.fn()}
        />,
      )
    })

    const iframe = container.querySelector('iframe[title="Rendered HTML preview"]')
    const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
    const preview = new DOMParser().parseFromString(srcdoc, 'text/html')
    expect(preview.querySelector('img')?.getAttribute('src')).toBe(
      'http://podium.test/files/asset?root=%2Frepo&path=%2Frepo%2F.superpowers%2Frun%2Fhero.png&machineId=m1',
    )
    expect(srcdoc).not.toContain('src="./hero.png"')
  })

  // Only an artifact ([spec:SP-0fc9]) is a deliverable the agent built to be clicked; any
  // other .html is incidental content on disk and stays inert.
  describe('script execution is scoped to artifacts', () => {
    const renderScope = (
      scope: Parameters<typeof HtmlFilePanel>[0]['scope'],
    ): HTMLIFrameElement => {
      documentContent = '<button onclick="go()">Go</button><script>window.go = () => {}</script>'
      act(() => {
        root.render(<HtmlFilePanel scope={scope} path="proto.html" onClose={vi.fn()} />)
      })
      const iframe = container.querySelector<HTMLIFrameElement>(
        'iframe[title="Rendered HTML preview"]',
      )
      if (!iframe) throw new Error('no preview iframe')
      return iframe
    }

    it('grants allow-scripts and keeps the script for an artifact', () => {
      const iframe = renderScope({
        kind: 'artifact',
        issueId: asIssueId('i1'),
        artifactId: asArtifactId('a1'),
      })
      const srcdoc = iframe.getAttribute('srcdoc') ?? ''

      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
      expect(srcdoc).toContain('<script>')
      expect(srcdoc).toContain('onclick')
      // Opaque origin is the isolation; the CSP is what stops a script phoning home.
      expect(srcdoc).toContain("connect-src 'none'")
      expect(srcdoc).toContain('img-src http://podium.test')
    })

    it.each([
      ['session', { kind: 'session', sessionId: asSessionId('s1') }],
      ['worktree', { kind: 'worktree', root: '/repo' }],
    ] as const)('keeps a %s file fully sandboxed and script-free', (_label, scope) => {
      const iframe = renderScope(scope)
      const srcdoc = iframe.getAttribute('srcdoc') ?? ''

      expect(iframe.getAttribute('sandbox')).toBe('')
      expect(srcdoc).not.toContain('<script')
      expect(srcdoc).not.toContain('onclick')
    })
  })
})
