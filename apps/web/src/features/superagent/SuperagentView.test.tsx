import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

// ---------------------------------------------------------------------------
// The Superagent dock pane's contract (POD-516 §1.2, from the approved POD-491
// artifact): head + "Current focus" + the ONE global conversation. Nothing
// else — no Tray, no second collapsible section bar, no drag separator.
// Preview correction #66: the legacy transcript chrome (Search transcript /
// Earlier conversation) and the CTX badge above the composer must never render.
//
// markdown/voice touch browser APIs that are flaky under happy-dom, and store
// has module-load deps — stub them the same way ChatView.test.tsx does so the
// import of ./SuperagentView is side-effect-free.
// ---------------------------------------------------------------------------

const fakeHub = {
  subscribeTranscript(): () => void {
    return () => {}
  },
  subscribeHeadless(): () => void {
    return () => {}
  },
}

const superagentThreads = [{ id: 'global', kind: 'global' as const, harnessSessionId: 'harness-1' }]

let isMobile = false
let storeSessions: Array<{ sessionId: SessionId; cwd: string }> = []
let storeIssues: ReturnType<typeof makeIssue>[] = []
let storeSelectedIssueId: string | null = null
const uiStateMap = new Map<string, string>()
const uiState = {
  get: (key: string): string | null => uiStateMap.get(key) ?? null,
  set: vi.fn((key: string, value: string) => {
    uiStateMap.set(key, value)
  }),
}
/**
 * The read position is per-user state with its own port (POD-1380), no longer a
 * ui-state key. The double is monotonic like the real one so a test that sets a
 * position and then renders sees the same refusal-to-rewind the product has.
 */
let readPositionValue = { lastEventId: 0, seenAt: null as string | null }
const readPosition = {
  get: () => readPositionValue,
  advance: vi.fn((_stream: string, next: { lastEventId: number; seenAt: string | null }) => {
    if (next.lastEventId > readPositionValue.lastEventId) readPositionValue = next
  }),
  hydrate: vi.fn(async () => {}),
  replace: vi.fn(),
  subscribe: () => () => {},
}
const setPane = vi.fn()
const setSelectedWorktree = vi.fn()
const setSelectedIssueId = vi.fn()
const setView = vi.fn()
const setSessionDraft = vi.fn()
const fakeTrpc = {
  superagent: {
    listThreads: { query: vi.fn(async () => superagentThreads) },
    sendTurn: { mutate: vi.fn(async () => ({ threadId: 'global', podiumSessionId: 'hp-1' })) },
    clear: { mutate: vi.fn(async () => {}) },
    openInTerminal: { mutate: vi.fn(async () => ({ sessionId: asSessionId('pty-1') })) },
  },
  issues: {
    events: { query: vi.fn(async () => []) },
    clearNeedsHuman: { mutate: vi.fn(async () => {}) },
    update: { mutate: vi.fn(async () => {}) },
    archive: { mutate: vi.fn(async () => {}) },
  },
  sessions: {
    sendText: { mutate: vi.fn(async () => ({})) },
  },
}

const normalizedIssues = () =>
  storeIssues.map((issue) => {
    const { sessions = [], ...normalized } = issue as typeof issue & {
      sessions?: Array<{ sessionId: string; cwd: string }>
    }
    return { ...normalized, memberSessionIds: sessions.map((session) => session.sessionId) }
  })

const embeddedSessions = () =>
  storeIssues.flatMap(
    (issue) =>
      (issue as typeof issue & { sessions?: Array<{ sessionId: string; cwd: string }> }).sessions ??
      [],
  )

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    repos: [],
    sessions: [...storeSessions, ...embeddedSessions()],
    issues: normalizedIssues(),
    selectedIssueId: storeSelectedIssueId,
    // POD-330: the thread list is STORE state now, not a view-local mirror
    // refetched off a `superRefreshKey` bump.
    superThreads: superagentThreads,
    superThreadId: 'global',
    refreshSuperThreads: async () => {},
    uiState,
    readPosition,
    setPane,
    setSelectedWorktree,
    setSelectedIssueId,
    setView,
    setSessionDraft,
    getUserFocus: () => ({ view: 'workspace' }),
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: normalizedIssues,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) => def.derive(useStore() as never),
  }
})
vi.mock('@/lib/hooks/use-is-mobile', () => ({
  useIsMobile: () => isMobile,
}))
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { SuperagentView } = await import('./SuperagentView')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  isMobile = false
  storeSessions = []
  storeIssues = []
  storeSelectedIssueId = null
  uiStateMap.clear()
  readPositionValue = { lastEventId: 0, seenAt: null }
  readPosition.advance.mockClear()
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

async function mount(): Promise<void> {
  act(() => {
    root.render(<SuperagentView />)
  })
  await flush()
}

describe('Superagent pane structure (POD-516 §1.2)', () => {
  it('is the head, the focus line and the conversation — nothing else', async () => {
    await mount()
    expect(container.querySelector('[data-testid="super-head"]')?.textContent).toContain(
      'Portfolio copilot',
    )
    expect(container.querySelector('[data-testid="super-head"]')?.textContent).toContain(
      'One thread across every task and session.',
    )
    expect(container.querySelector('[data-superagent-composer]')).not.toBeNull()
    // The dock-top is the pane's only chrome: no second collapsible bar.
    expect(container.querySelector('[data-testid="super-bar"]')).toBeNull()
  })

  // "remove the tray functionality completely. code, ui, all incl. traces."
  // The tray bar, its card stack, its count pill and the drag separator that
  // split it from the chat are all gone — including for an issue that would
  // have produced a card.
  it('renders NO tray surface even when issues are asking for a human', async () => {
    storeIssues = [
      makeIssue({ id: 'q', seq: 2, needsHuman: true, humanQuestion: 'Ship behind a flag?' }),
      makeIssue({ id: 'r', seq: 3, stage: 'review', title: 'Refresh-timer fix' }),
    ]
    await mount()
    expect(container.querySelector('[data-testid="tray-bar"]')).toBeNull()
    expect(container.querySelector('[data-testid="tray-cards"]')).toBeNull()
    expect(container.querySelector('[data-testid^="tray-card-"]')).toBeNull()
    expect(container.querySelector('[data-testid="tray-count-pill"]')).toBeNull()
    expect(container.querySelector('[data-testid="tray-empty"]')).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(container.textContent).not.toContain('Ship behind a flag?')
    expect(container.textContent).not.toContain('ALL TASKS · NEWEST FIRST')
  })

  it('names the selected mission as the current focus (artifact #super-focus)', async () => {
    storeIssues = [makeIssue({ id: 'p', seq: 7, title: 'Multi-agent operator workspace' })]
    storeSelectedIssueId = 'p'
    await mount()
    const focus = container.querySelector('[data-testid="super-focus"]')
    expect(focus?.textContent).toContain('Current focus')
    expect(focus?.textContent).toContain('Multi-agent operator workspace')
  })

  it('says so plainly when nothing is selected — the thread is still global', async () => {
    await mount()
    const focus = container.querySelector('[data-testid="super-focus"]')
    expect(focus?.textContent).toContain('ask across every task')
  })

  it('keeps the composer mounted — there is no section to collapse it into', async () => {
    // The chat used to fold behind its own section bar, persisted under
    // podium:superagent:chat. Collapsing the only content of a dock panel is
    // just closing the panel, which the dock-top already does.
    uiStateMap.set('podium:superagent:chat', 'false')
    uiStateMap.set('podium:tray:open', 'false')
    await mount()
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.querySelector('[data-superagent-composer]')).not.toBeNull()
  })
})

describe('standing event feed removal (POD-113)', () => {
  it('renders NO cross-issue changelog even when issue events exist', async () => {
    fakeTrpc.issues.events.query.mockResolvedValue([
      {
        id: 4,
        ts: '2026-07-22T14:07:00Z',
        kind: 'issue.closed',
        subject: 'p',
        repoPath: null,
        payload: null,
      },
    ] as never)
    storeIssues = [makeIssue({ id: 'p', seq: 7, title: 'Some task' })]
    await mount()
    expect(container.querySelector('[data-testid="super-event-feed"]')).toBeNull()
    expect(container.textContent).not.toContain('Some task — closed')
  })

  it('keeps the YOU-WERE-HERE divider when events landed since the frozen cursor', async () => {
    readPositionValue = { lastEventId: 2, seenAt: '2026-07-22T14:20:00Z' }
    fakeTrpc.issues.events.query.mockResolvedValue([
      {
        id: 5,
        ts: '2026-07-22T14:30:00Z',
        kind: 'issue.closed',
        subject: 'p',
        repoPath: null,
        payload: null,
      },
    ] as never)
    await mount()
    const divider = container.querySelector('[data-testid="you-were-here"]')
    expect(divider?.textContent).toContain('YOU WERE HERE')
  })
})

describe('Clear context', () => {
  it('routes through superagent.clear so the global thread restarts fresh', async () => {
    await mount()
    const btn = container.querySelector<HTMLButtonElement>(
      'button[title="Clear context — start the global chat fresh"]',
    )
    expect(btn).not.toBeNull()
    await act(async () => {
      btn?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.superagent.clear.mutate).toHaveBeenCalledWith({ threadId: 'global' })
  })
})

describe('Open in terminal', () => {
  it('clears the issue selection so the pane lands on the PTY session, not an issue workspace', async () => {
    await mount()
    const btn = container.querySelector<HTMLButtonElement>(
      'button[title="Open this conversation in a terminal session"]',
    )
    expect(btn).not.toBeNull()
    // The resumed PTY session lands in the sessions broadcast a beat later.
    storeSessions = [{ sessionId: asSessionId('pty-1'), cwd: '/home/u' }]
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

describe('legacy chrome stays gone (#66 preview correction)', () => {
  it('renders NO CTX badge above the composer even with an issue selected — the focus payload still rides the turn', async () => {
    storeIssues = [makeIssue({ id: 'p', seq: 35, title: 'Parent epic' })]
    storeSelectedIssueId = 'p'
    await mount()
    expect(container.querySelector('[data-testid="ctx-badge"]')).toBeNull()
    expect(container.textContent).not.toContain('CTX')
    expect(container.textContent).not.toContain('answering with')
    // The context CAPABILITY is intact: sending a turn still carries the focus payload.
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      if (!textarea) return
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      container.querySelector('textarea')?.dispatchEvent(enter)
      await Promise.resolve()
    })
    expect(fakeTrpc.superagent.sendTurn.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', focus: { view: 'workspace' } }),
    )
  })

  it('renders NO "Earlier conversation" block and NO transcript search input', async () => {
    await mount()
    expect(container.textContent).not.toContain('Earlier conversation')
    expect(container.querySelector('input[placeholder="Search transcript…"]')).toBeNull()
  })
})
