import type { TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Pins the delta-accumulation contract of SuperagentView's <SpawnedFollow>, the
// inline live-tail for spawned workers. The hub now forwards per-frame DELTAS
// (not the full accumulated list); a "treat the delta as the full list" mistake
// here would render only the LATEST delta. We mount the component with a fake
// hub that captures the cb, push delta frames, and assert what renders.
//
// markdown/voice touch browser APIs that are flaky under happy-dom, and store
// has module-load deps — stub them the same way ChatView.test.tsx does so the
// import of ./SuperagentView is side-effect-free.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

const superagentThreads = [
  { id: 'global', kind: 'global' as const, harnessSessionId: 'harness-1' },
  {
    id: 'btw_alpha',
    kind: 'btw' as const,
    originSessionId: 'alpha',
    title: 'Fix a long terminal link wrapping regression',
  },
  {
    id: 'btw_beta',
    kind: 'btw' as const,
    originSessionId: 'beta',
    title: 'Review packaging checks on mobile',
  },
]

let storeSuperThreadId = 'global'
let isMobile = false
let storeSessions: Array<{ sessionId: string; cwd: string }> = []
const setPane = vi.fn()
const setSelectedWorktree = vi.fn()
const setSelectedIssueId = vi.fn()
const setView = vi.fn()
const setSuperThreadId = vi.fn((id: string) => {
  storeSuperThreadId = id
})
const fakeTrpc = {
  superagent: {
    history: { query: vi.fn(async () => []) },
    listThreads: { query: vi.fn(async () => superagentThreads) },
    send: { mutate: vi.fn(async () => ({ messages: [], backendLabel: '' })) },
    clear: { mutate: vi.fn(async () => {}) },
    openInTerminal: { mutate: vi.fn(async () => ({ sessionId: 'pty-1' })) },
  },
}

vi.mock('./store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    repos: [],
    sessions: storeSessions,
    superThreadId: storeSuperThreadId,
    setSuperThreadId,
    superRefreshKey: 0,
    setPane,
    setSelectedWorktree,
    setSelectedIssueId,
    setView,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('./hooks/use-is-mobile', () => ({
  useIsMobile: () => isMobile,
}))
vi.mock('./voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('./markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { SpawnedFollow, SuperagentView } = await import('./SuperagentView')

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeHub.subscribes.length = 0
  storeSuperThreadId = 'global'
  isMobile = false
  storeSessions = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Superagent thread switcher', () => {
  it('renders desktop conversations as one non-wrapping horizontal tab strip', async () => {
    act(() => {
      root.render(<SuperagentView />)
    })
    await flush()

    const tablist = container.querySelector('[role="tablist"][aria-label="Superagent threads"]')
    expect(tablist).not.toBeNull()
    expect(tablist?.className).toContain('overflow-x-auto')
    expect(tablist?.className).toContain('flex-nowrap')
    expect(tablist?.querySelectorAll('[role="tab"]')).toHaveLength(3)
    expect(container.querySelector('select[aria-label="Superagent conversation"]')).toBeNull()
  })

  it('renders mobile conversations as a single selected dropdown', async () => {
    isMobile = true
    storeSuperThreadId = 'btw_alpha'
    act(() => {
      root.render(<SuperagentView />)
    })
    await flush()

    const select = container.querySelector(
      'select[aria-label="Superagent conversation"]',
    ) as HTMLSelectElement | null
    expect(container.querySelector('[role="tablist"][aria-label="Superagent threads"]')).toBeNull()
    expect(select).not.toBeNull()
    expect(select?.value).toBe('btw_alpha')
    expect(select?.selectedOptions[0]?.textContent).toBe(
      'Fix a long terminal link wrapping regression',
    )

    act(() => {
      if (select) {
        select.value = 'btw_beta'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    expect(setSuperThreadId).toHaveBeenCalledWith('btw_beta')
  })
})

describe('Open in terminal', () => {
  it('clears the issue selection so the pane lands on the PTY session, not an issue workspace', async () => {
    act(() => {
      root.render(<SuperagentView />)
    })
    await flush()

    const btn = container.querySelector<HTMLButtonElement>(
      'button[title="Open this conversation in a terminal session"]',
    )
    expect(btn).not.toBeNull()
    // The resumed PTY session lands in the sessions broadcast a beat later.
    storeSessions = [{ sessionId: 'pty-1', cwd: '/home/u' }]
    await act(async () => {
      btn?.click()
      await Promise.resolve()
    })
    await flush()

    expect(fakeTrpc.superagent.openInTerminal.mutate).toHaveBeenCalledWith({ threadId: 'global' })
    // An issue workspace scopes the tab strip to the issue's sessions; leaving
    // the selection set left the middle pane blank.
    expect(setSelectedIssueId).toHaveBeenCalledWith(null)
    expect(setSelectedWorktree).toHaveBeenCalledWith('/home/u')
    expect(setPane).toHaveBeenCalledWith('A', 'pty-1')
    expect(setView).toHaveBeenCalledWith('workspace')
  })
})

describe('SpawnedFollow delta accumulation', () => {
  it('ACCUMULATES items across two non-reset delta frames (second does not replace first)', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    expect(fakeHub.subscribes).toHaveLength(1)
    expect(fakeHub.subscribes[0]).toMatchObject({ sessionId: 's1' })
    const cb = fakeHub.subscribes[0]?.cb
    // Frame 1: one item.
    act(() => {
      cb?.([item('a', 'c1', 'first frame line')], { reset: false })
    })
    expect(container.textContent).toContain('first frame line')
    // Frame 2: a SECOND delta. The regression ("delta = full list") would render
    // only this frame and drop the first — assert BOTH are present.
    act(() => {
      cb?.([item('b', 'c2', 'second frame line')], { reset: false })
    })
    expect(container.textContent).toContain('first frame line')
    expect(container.textContent).toContain('second frame line')
  })

  it('a reset frame REPLACES the buffer — only the reset frame content remains', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    const cb = fakeHub.subscribes[0]?.cb
    act(() => {
      cb?.([item('a', 'c1', 'old content')], { reset: false })
    })
    expect(container.textContent).toContain('old content')
    // A reset (file roll / reattach re-seed) clears the local buffer.
    act(() => {
      cb?.([item('z', 'c9', 'fresh content')], { reset: true })
    })
    expect(container.textContent).toContain('fresh content')
    expect(container.textContent).not.toContain('old content')
  })

  it('dedupes a delta item already held (live repeats the tail) — no duplicate row', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    const cb = fakeHub.subscribes[0]?.cb
    act(() => {
      cb?.([item('a', 'c1', 'alpha')], { reset: false })
    })
    // Overlapping delta: repeats c1 plus a genuinely new c2.
    act(() => {
      cb?.([item('a', 'c1', 'alpha'), item('b', 'c2', 'bravo')], { reset: false })
    })
    expect(container.textContent).toContain('bravo')
    const occurrences = (container.textContent?.split('alpha').length ?? 0) - 1
    expect(occurrences).toBe(1)
  })
})
