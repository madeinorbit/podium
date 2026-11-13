import type { IssueEventWire, SessionId } from '@podium/model'
import '@/test-support/mock-core-store-handle'
import {
  asSessionId,
  asThreadId,
  asUserId,
  issueEventRowId,
  type SuperagentThreadWire,
} from '@podium/model'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { makeIssue } from '@/lib/test-issue'

// ---------------------------------------------------------------------------
// The Superagent dock pane's contract (POD-516 §1.2): the ONE global
// conversation and its composer, under the dock title bar's single header.
// Nothing else — no second header, no "Current focus" line (round 3: "no need
// to list the focus it has, remove that"), no Tray, no collapsible section bar,
// no drag separator, and no status strip under the prompt box.
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

/** My global thread's synced record (POD-6675), in the shape the test sets. */
type SuperThreadFake = {
  id: string
  kind: 'global'
  /** The server holds a harness conversation (the record's `resumable`). */
  resumable?: boolean
  podiumSessionId?: SessionId
  agentKind?: string
}
const GLOBAL_THREAD: SuperThreadFake = {
  id: 'global',
  kind: 'global' as const,
  resumable: true,
  // POD-782: a thread has its headless session from the moment the pane opens
  // (superagent.ensureSession), which is what lets this pane mount the ORDINARY
  // ChatView instead of carrying a second composer for the empty case.
  podiumSessionId: asSessionId('hp-1'),
  agentKind: 'claude-code',
}
let superagentThreads: SuperThreadFake[] = [GLOBAL_THREAD]
/** The records the replica holds for those threads. */
const threadRecords = (): SuperagentThreadWire[] =>
  superagentThreads.map((thread) => ({
    threadId: asThreadId(thread.id),
    ownerUserId: asUserId('operator'),
    kind: thread.kind,
    ...(thread.podiumSessionId ? { podiumSessionId: thread.podiumSessionId } : {}),
    ...(thread.agentKind ? { agentKind: thread.agentKind } : {}),
    archived: false,
    resumable: thread.resumable === true,
    turnRunning: false,
    lastTurnFailure: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }))

let isMobile = false
let storeSessions: Array<{ sessionId: SessionId; cwd: string }> = []
let storeIssues: ReturnType<typeof makeIssue>[] = []
let storeSelectedIssueId: string | null = null
/** The chat feed's rows are REPLICATED now (POD-1772) — store state, not an RPC
 *  the view polls. Seeded per test the same way sessions and issues are. */
let storeIssueEvents: IssueEventWire[] = []
const issueEvent = (eventId: number, over: Partial<IssueEventWire> = {}): IssueEventWire => ({
  id: issueEventRowId(eventId, 'p'),
  eventId,
  ts: '2026-07-22T14:07:00Z',
  kind: 'issue.closed',
  subject: 'p',
  repoPath: null,
  payload: null,
  ...over,
})
const uiStateMap = new Map<string, string>()
const uiState = {
  get: (key: string): string | null => uiStateMap.get(key) ?? null,
  subscribe: () => () => {},
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
    sendTurn: { mutate: vi.fn(async () => ({ threadId: 'global', podiumSessionId: 'hp-1' })) },
    clear: { mutate: vi.fn(async () => {}) },
    restart: { mutate: vi.fn(async () => {}) },
    openInTerminal: { mutate: vi.fn(async () => ({ sessionId: asSessionId('pty-1') })) },
    ensureSession: {
      mutate: vi.fn(async () => ({ threadId: 'global', podiumSessionId: asSessionId('hp-1') })),
    },
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
    return {
      ...normalized,
      memberSessionIds: sessions.map((session: { sessionId: string }) => session.sessionId),
    }
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
    issueEvents: storeIssueEvents,
    selectedIssueId: storeSelectedIssueId,
    // POD-6675: the thread list is synced records the replica holds.
    superagentThreads: threadRecords(),
    superThreadId: 'global',
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
    useSession: (id: string | undefined) =>
      [...storeSessions, ...embeddedSessions()].find((session) => session.sessionId === id),
    readFixture: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/lib/hooks/use-is-mobile', () => ({
  useIsMobile: () => isMobile,
}))
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))
vi.mock('./use-superagent-inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-superagent-inputs')>()
  return {
    ...actual,
    useSuperagentAccess: () => ({ ...actual.useSuperagentAccess(), readPosition }),
  }
})
/**
 * THE CHAT IS STUBBED, AND THAT IS THE POINT OF THIS FILE (POD-782).
 *
 * This pane used to own a composer, so its tests had to assert on a textarea,
 * an @-menu and a send path — all of which were a SECOND implementation of the
 * chat's own. The pane now mounts `ChatView` and nothing else, so what is left
 * to test here is what SURROUNDS the conversation (one header, no tray, the two
 * dock actions, the return marker) plus the props it hands down. The conversation
 * itself is covered where it lives: `ChatView.headless.test.tsx` owns the
 * headless send path, the composer and the running-turn gate.
 */
const chatProps: Array<Record<string, unknown>> = []
vi.mock('@/features/chat/ChatView', () => ({
  ChatView: (props: Record<string, unknown>) => {
    chatProps.push(props)
    return <div data-testid="chat-view" />
  },
}))

const { SuperagentView } = await import('./SuperagentView')

let container: HTMLDivElement
let root: Root
/** Stands in for the dock title bar's action slot: the pane portals its two
 *  icon actions there instead of wearing a header of its own. */
let dockHeaderSlot: HTMLElement

beforeEach(() => {
  isMobile = false
  superagentThreads = [{ ...GLOBAL_THREAD }]
  chatProps.length = 0
  storeSessions = []
  storeIssues = []
  storeIssueEvents = []
  storeSelectedIssueId = null
  uiStateMap.clear()
  readPositionValue = { lastEventId: 0, seenAt: null }
  readPosition.advance.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  // Outside `container`: createRoot clears its container on first commit, and
  // the real slot lives in the dock title bar, above this pane's own subtree.
  dockHeaderSlot = document.createElement('span')
  document.body.appendChild(dockHeaderSlot)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  dockHeaderSlot.remove()
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
    root.render(
      <DockHeaderSlotProvider value={dockHeaderSlot}>
        <SuperagentView />
      </DockHeaderSlotProvider>,
    )
  })
  await flush()
}

describe('Superagent pane structure (POD-516 §1.2)', () => {
  it('is the conversation and its composer — nothing else', async () => {
    await mount()
    expect(container.querySelector('[data-superagent-composer]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull()
    // The dock-top is the pane's only chrome: no second collapsible bar.
    expect(container.querySelector('[data-testid="super-bar"]')).toBeNull()
  })

  /**
   * THE DEDUPE, ASSERTED (POD-782). The pane mounts the shared chat over the
   * thread's own headless session, in compact mode, bound to the global thread —
   * and mounts it exactly once. A second composer reappearing here is the
   * regression this guards, and it would show up as a `ChatView` that is absent
   * (something else is drawing the box) or a second one.
   */
  it('mounts ONE shared ChatView over the thread — no second composer', async () => {
    await mount()
    expect(container.querySelectorAll('[data-testid="chat-view"]')).toHaveLength(1)
    expect(chatProps.at(-1)).toMatchObject({
      sessionId: 'hp-1',
      compact: true,
      superThread: { threadId: 'global', kind: 'global' },
    })
    // No hand-rolled box left behind it.
    expect(container.querySelector('[data-testid="super-composer"]')).toBeNull()
  })

  /**
   * A thread with no session yet cannot render a transcript, which is the whole
   * reason the second composer existed. The pane asks for one instead of growing
   * a different screen.
   */
  it('mints the thread’s headless session so the chat has something to render', async () => {
    superagentThreads = [{ id: 'global', kind: 'global', resumable: true }]
    await mount()
    expect(fakeTrpc.superagent.ensureSession.mutate).toHaveBeenCalledWith({ threadId: 'global' })
  })

  // POD-516 item 10: "Superagent" is the dock title; a "Portfolio copilot"
  // heading under it named the same surface a second time. ONE header.
  it('renders no header of its own — the dock title bar is the only one', async () => {
    await mount()
    expect(container.querySelector('[data-testid="super-head"]')).toBeNull()
    expect(container.querySelector('h1, h2, h3')).toBeNull()
    expect(container.textContent).not.toContain('Portfolio copilot')
    expect(container.textContent).not.toContain('One thread across every task and session')
  })

  it('lends its conversation menu to the dock title bar', async () => {
    await mount()
    expect(
      dockHeaderSlot.querySelector('button[aria-label="Superagent conversation actions"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('button[aria-label="Superagent conversation actions"]'),
    ).toBeNull()
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

  // "no need to list the focus it has, remove that". The pane no longer names
  // the selected mission — the sidebar row, the rail's ID square and the tab
  // strip all already say which task is selected, and the thread is global
  // either way. Both the selected and the nothing-selected wordings go.
  it('does not name the selected mission — the focus line is gone', async () => {
    storeIssues = [makeIssue({ id: 'p', seq: 7, title: 'Multi-agent operator workspace' })]
    storeSelectedIssueId = 'p'
    await mount()
    expect(container.querySelector('[data-testid="super-focus"]')).toBeNull()
    expect(container.textContent).not.toContain('Current focus')
    expect(container.textContent).not.toContain('Multi-agent operator workspace')
  })

  it('shows no focus placeholder when nothing is selected either', async () => {
    await mount()
    expect(container.querySelector('[data-testid="super-focus"]')).toBeNull()
    expect(container.textContent).not.toContain('Nothing selected')
  })

  // "the 'auto delegate on' and other infos there can be removed". The composer
  // is a box: no status strip under it, and the scope it does state is stated
  // once, by the placeholder, inside the box.
  // "the 'auto delegate on' and other infos there can be removed". The composer
  // is a box: no status strip under it, and the scope it does state is stated
  // once, by the placeholder, inside the box. (The placeholder itself is the
  // shared composer's now — `composerState` in the chat slice owns the wording
  // and `chat.test.ts` asserts it, so it is not restated here.)
  it('carries no meta strip under the prompt box', async () => {
    await mount()
    expect(container.textContent).not.toContain('auto-delegate')
    expect(container.textContent).not.toContain('shift+tab to cycle')
    expect(container.textContent).not.toContain('? for shortcuts')
  })

  it('keeps the conversation mounted — there is no section to collapse it into', async () => {
    // The chat used to fold behind its own section bar, persisted under
    // podium:superagent:chat. Collapsing the only content of a dock panel is
    // just closing the panel, which the dock-top already does.
    uiStateMap.set('podium:superagent:chat', 'false')
    uiStateMap.set('podium:tray:open', 'false')
    await mount()
    expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull()
    expect(container.querySelector('[data-superagent-composer]')).not.toBeNull()
  })
})

describe('standing event feed removal (POD-113)', () => {
  it('renders NO cross-issue changelog even when issue events exist', async () => {
    storeIssueEvents = [issueEvent(4)]
    storeIssues = [makeIssue({ id: 'p', seq: 7, title: 'Some task' })]
    await mount()
    expect(container.querySelector('[data-testid="super-event-feed"]')).toBeNull()
    expect(container.textContent).not.toContain('Some task — closed')
  })

  it('keeps the YOU-WERE-HERE divider when events landed since the frozen cursor', async () => {
    readPositionValue = { lastEventId: 2, seenAt: '2026-07-22T14:20:00Z' }
    storeIssueEvents = [issueEvent(5, { ts: '2026-07-22T14:30:00Z' })]
    await mount()
    const divider = container.querySelector('[data-testid="you-were-here"]')
    expect(divider?.textContent).toContain('YOU WERE HERE')
  })
})

describe('Clear context', () => {
  it('routes through superagent.clear so the global thread restarts fresh', async () => {
    await mount()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Superagent conversation actions' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Clear conversation' }))
    })
    expect(fakeTrpc.superagent.clear.mutate).toHaveBeenCalledWith({ threadId: 'global' })
  })
})

describe('Open in terminal', () => {
  it('clears the issue selection so the pane lands on the PTY session, not an issue workspace', async () => {
    await mount()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Superagent conversation actions' }))
    })
    // The resumed PTY session lands in the sessions broadcast a beat later.
    storeSessions = [{ sessionId: asSessionId('pty-1'), cwd: '/home/u' }]
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in terminal' }))
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
  // The focus payload still rides every turn — that lives in `conversation sends`
  // and is asserted in `ChatView.headless.test.tsx`, which owns the send path.
  // What this pane must never grow back is the BADGE that reported it.
  it('renders NO CTX badge above the composer even with an issue selected', async () => {
    storeIssues = [makeIssue({ id: 'p', seq: 35, title: 'Parent epic' })]
    storeSelectedIssueId = 'p'
    await mount()
    expect(container.querySelector('[data-testid="ctx-badge"]')).toBeNull()
    expect(container.textContent).not.toContain('CTX')
    expect(container.textContent).not.toContain('answering with')
  })

  it('renders NO "Earlier conversation" block and NO transcript search input', async () => {
    await mount()
    expect(container.textContent).not.toContain('Earlier conversation')
    expect(container.querySelector('input[placeholder="Search transcript…"]')).toBeNull()
  })
})

describe('Start a fresh session', () => {
  it('restarts the global harness without clearing the conversation', async () => {
    await mount()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Superagent conversation actions' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Start a fresh session' }))
    })
    expect(fakeTrpc.superagent.restart.mutate).toHaveBeenCalledWith({ threadId: 'global' })
    expect(fakeTrpc.superagent.clear.mutate).not.toHaveBeenCalled()
  })
})
