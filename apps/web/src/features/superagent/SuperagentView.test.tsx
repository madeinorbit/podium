import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

// ---------------------------------------------------------------------------
// The engraved column's content contract (issue #42): Tray (ONLY items needing
// a human) above the single overarching Super agent chat, each section
// collapsing to its bar with persisted state. Preview correction #66: the
// legacy transcript chrome (Search transcript / Earlier conversation) and the
// CTX badge above the composer must never render.
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
let storeSessions: Array<{ sessionId: string; cwd: string }> = []
let storeIssues: ReturnType<typeof makeIssue>[] = []
let storeSelectedIssueId: string | null = null
const uiStateMap = new Map<string, string>()
const uiState = {
  get: (key: string): string | null => uiStateMap.get(key) ?? null,
  set: vi.fn((key: string, value: string) => {
    uiStateMap.set(key, value)
  }),
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
    openInTerminal: { mutate: vi.fn(async () => ({ sessionId: 'pty-1' })) },
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    repos: [],
    sessions: storeSessions,
    issues: storeIssues,
    selectedIssueId: storeSelectedIssueId,
    superRefreshKey: 0,
    uiState,
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
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
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

async function mount(mobile = false): Promise<void> {
  act(() => {
    root.render(<SuperagentView mobile={mobile} onClose={vi.fn()} />)
  })
  await flush()
}

describe('engraved column structure', () => {
  it('renders one tray-free conversation surface on mobile', async () => {
    await mount(true)
    expect(container.querySelector('[data-testid="tray-bar"]')).toBeNull()
    expect(container.querySelector('[data-testid="tray-cards"]')).toBeNull()
    expect(container.querySelector('[data-testid="super-bar"]')).not.toBeNull()
    expect(container.querySelector('[data-superagent-composer]')).not.toBeNull()
  })

  it('renders the Tray bar above the Super agent bar with the quiet empty line', async () => {
    await mount()
    const bars = container.querySelectorAll('[data-testid="tray-bar"], [data-testid="super-bar"]')
    expect([...bars].map((b) => b.getAttribute('data-testid'))).toEqual(['tray-bar', 'super-bar'])
    expect(container.querySelector('[data-testid="tray-empty"]')?.textContent).toContain(
      'Nothing waiting on you',
    )
    expect(container.querySelector('[data-testid="tray-bar"]')?.textContent).toContain(
      'ALL TASKS · NEWEST FIRST',
    )
  })

  it('the scope label is STATIC (§5): a selection never rescopes the tray', async () => {
    storeIssues = [makeIssue({ id: 'p', seq: 7 })]
    storeSelectedIssueId = 'p'
    await mount()
    const label = container.querySelector('[data-testid="tray-bar"]')?.textContent
    expect(label).toContain('ALL TASKS · NEWEST FIRST')
    expect(label).not.toContain('TASK SCOPE')
  })
})

describe('tray filtering (human-actionable only)', () => {
  it('renders cards GLOBALLY and NEVER working rows; selection only adds the ring', async () => {
    storeIssues = [
      makeIssue({ id: 'p', seq: 1, title: 'Parent epic' }),
      makeIssue({
        id: 'q',
        seq: 2,
        parentId: 'p',
        needsHuman: true,
        humanQuestion: 'Ship behind a flag?',
      }),
      // A review-stage issue with no live offer gets the deterministic
      // backstop card [POD-118] — review visibility must not depend on an
      // offer surviving a hook-forced agent turn.
      makeIssue({ id: 'r', seq: 3, parentId: 'p', stage: 'review', title: 'Refresh-timer fix' }),
      makeIssue({ id: 'w', seq: 4, parentId: 'p', stage: 'in_progress', title: 'Worker issue' }),
      makeIssue({ id: 'x', seq: 9, needsHuman: true, humanQuestion: 'Outside the subtree?' }),
    ]
    storeSelectedIssueId = 'q'
    await mount()
    const cards = [...container.querySelectorAll('[data-testid^="tray-card-"]')]
    // The tray is global (§5): the unrelated seq-9 question renders too.
    expect(cards.map((c) => c.getAttribute('data-issue-seq'))).toEqual(['2', '3', '9'])
    // Only the selected issue's card carries the ring marker.
    expect(cards.map((c) => c.getAttribute('data-selected'))).toEqual(['true', null, null])
    expect(container.querySelector('[data-testid="tray-card-review"]')?.textContent).toContain(
      'Ready for review',
    )
    expect(container.textContent).toContain('Ship behind a flag?')
    expect(container.textContent).toContain('Outside the subtree?')
    expect(container.textContent).toContain('Refresh-timer fix')
    expect(container.textContent).not.toContain('Worker issue')
    expect(container.querySelector('[data-testid="tray-empty"]')).toBeNull()
  })

  it('offer cards [spec:SP-c7f1]: dynamic buttons send the prompt to the offer session and hide the card', async () => {
    storeIssues = [
      makeIssue({
        id: 'o',
        seq: 6,
        title: 'Offer host',
        sessions: [
          {
            sessionId: 'agent-1',
            agentKind: 'claude-code',
            status: 'live',
            cwd: '/r/wt',
            createdAt: 't',
            lastActiveAt: 't',
            offer: {
              message: 'PR is up — pick a next step.',
              actions: [{ label: 'Merge it', prompt: 'Merge the PR and close out.' }],
              createdAt: '2026-07-14T12:00:00Z',
            },
          },
        ] as never,
      }),
    ]
    await mount()
    const card = container.querySelector('[data-testid="tray-card-offer"]')
    expect(card?.textContent).toContain('PR is up — pick a next step.')
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Merge it',
    )
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'agent-1', text: 'Merge the PR and close out.' }),
    )
    // An action click never ALSO navigates (stopPropagation on the buttons).
    expect(setPane).not.toHaveBeenCalled()
    // Optimistically consumed — the card is gone before the server clears it.
    expect(container.querySelector('[data-testid="tray-card-offer"]')).toBeNull()
  })

  it('the session → link opens the offer session without firing the action', async () => {
    storeIssues = [
      makeIssue({
        id: 'o',
        seq: 6,
        sessions: [
          {
            sessionId: 'agent-1',
            agentKind: 'claude-code',
            status: 'live',
            cwd: '/r/wt',
            createdAt: 't',
            lastActiveAt: 't',
            offer: {
              message: 'Pick one.',
              actions: [{ label: 'Merge it', prompt: 'merge' }],
              createdAt: '2026-07-14T12:00:00Z',
            },
          },
        ] as never,
      }),
    ]
    await mount()
    const link = container.querySelector<HTMLButtonElement>('[data-testid="tray-session-link"]')
    expect(link).not.toBeNull()
    await act(async () => {
      link?.click()
    })
    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
    expect(setPane).toHaveBeenCalledWith('A', 'agent-1')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  it('offer input actions collect feedback in the card, then send prompt + feedback', async () => {
    storeIssues = [
      makeIssue({
        id: 'o',
        seq: 6,
        title: 'Offer host',
        sessions: [
          {
            sessionId: 'agent-1',
            agentKind: 'claude-code',
            status: 'live',
            cwd: '/r/wt',
            createdAt: 't',
            lastActiveAt: 't',
            offer: {
              message: 'POD-93 is ready.',
              actions: [{ label: 'Send back', prompt: 'Revise per this feedback:', input: true }],
              createdAt: '2026-07-14T12:00:00Z',
            },
          },
        ] as never,
      }),
    ]
    await mount()
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send back…',
    )
    await act(async () => {
      button?.click()
    })
    // No send yet, no navigation — the card swapped into feedback mode.
    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
    expect(setPane).not.toHaveBeenCalled()
    const field = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="tray-offer-feedback"] textarea',
    )
    expect(field).not.toBeNull()
    await act(async () => {
      if (!field) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(field, 'Dock icon still dead.')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send')
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'agent-1',
        text: 'Revise per this feedback:\n\nDock icon still dead.',
      }),
    )
    expect(setPane).not.toHaveBeenCalled()
  })

  it('finished issues render a deterministic card whose Archive routes to issues.archive', async () => {
    storeIssues = [
      makeIssue({
        id: 'f',
        seq: 8,
        title: 'Notification sounds',
        stage: 'done',
        closedAt: new Date(Date.now() - 60_000).toISOString(),
        closedReason: 'merged to main',
        unread: true,
      }),
    ]
    await mount()
    const card = container.querySelector('[data-testid="tray-card-finished"]')
    expect(card?.textContent).toContain('merged to main')
    const archive = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Archive'),
    )
    await act(async () => {
      archive?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.issues.archive.mutate).toHaveBeenCalledWith({ id: 'f' })
    // The button never ALSO navigates.
    expect(setPane).not.toHaveBeenCalled()
  })

  it('clicking a tray card focuses its native agent tab', async () => {
    storeIssues = [
      makeIssue({
        id: 'o',
        seq: 6,
        sessions: [
          {
            sessionId: 'agent-1',
            agentKind: 'claude-code',
            status: 'live',
            cwd: '/r/wt',
            createdAt: 't',
            lastActiveAt: 't',
            offer: { message: 'Pick one.', actions: [], createdAt: '2026-07-14T12:00:00Z' },
          },
        ] as never,
      }),
    ]
    await mount()
    const card = container.querySelector<HTMLElement>('[data-testid="tray-card-offer"]')
    await act(async () => {
      card?.click()
    })
    expect(setSelectedIssueId).toHaveBeenCalledWith('o')
    expect(setPane).toHaveBeenCalledWith('A', 'agent-1')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  it('question resolve routes through issues.clearNeedsHuman', async () => {
    storeIssues = [makeIssue({ id: 'q', seq: 2, needsHuman: true, humanQuestion: 'Choose?' })]
    await mount()
    const resolve = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('resolve'),
    )
    await act(async () => {
      resolve?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.issues.clearNeedsHuman.mutate).toHaveBeenCalledWith({ id: 'q' })
  })
})

describe('section collapse states', () => {
  it('collapsing the tray keeps the bar, shows the amber count pill, and persists', async () => {
    storeIssues = [makeIssue({ id: 'q', seq: 2, needsHuman: true, humanQuestion: 'Choose?' })]
    await mount()
    expect(container.querySelector('[data-testid="tray-cards"]')).not.toBeNull()
    const chevron = container.querySelector<HTMLButtonElement>(
      '[data-testid="tray-bar"] button[aria-expanded="true"]',
    )
    await act(async () => {
      chevron?.click()
    })
    expect(container.querySelector('[data-testid="tray-cards"]')).toBeNull()
    expect(container.querySelector('[data-testid="tray-bar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tray-count-pill"]')?.textContent).toBe('1')
    expect(uiState.set).toHaveBeenCalledWith('podium:tray:open', 'false')
  })

  it('collapsing the super agent hides the composer with the section (3b: no input)', async () => {
    await mount()
    expect(container.querySelector('textarea')).not.toBeNull()
    const chevron = container.querySelector<HTMLButtonElement>(
      '[data-testid="super-bar"] button[aria-expanded="true"]',
    )
    await act(async () => {
      chevron?.click()
    })
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('[data-testid="super-bar"]')).not.toBeNull()
    expect(uiState.set).toHaveBeenCalledWith('podium:superagent:chat', 'false')
  })

  it('restores persisted section state on mount', async () => {
    uiStateMap.set('podium:tray:open', 'false')
    uiStateMap.set('podium:superagent:chat', 'false')
    await mount()
    expect(container.querySelector('[data-testid="tray-empty"]')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    // Both bars stay — sections collapse to their bars, never further.
    expect(container.querySelector('[data-testid="tray-bar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="super-bar"]')).not.toBeNull()
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
