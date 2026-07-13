// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Regression cover for the chat→native draft flush re-arm (#17/#62 over Task 6).
// Task 6 keeps the terminal mounted across a chat↔native toggle, so the mount
// effect's one-shot draft flush no longer re-fires on each toggle. This test
// proves the flush re-arms when the panel re-enters native: a draft authored in
// chat is injected into the (still-mounted) native composer on the toggle back.
//
// We capture the single MountedSession the warm-toggle produces and assert on
// its connection.sendInput, mirroring the flush's "Ctrl-U then draft" injection.
// ---------------------------------------------------------------------------

const sendInput = vi.fn()
const setActive = vi.fn()
const dispose = vi.fn()

// screenText returns a clean, EMPTY Claude composer box so flushDraftToNative's
// scrape (extractClaudePromptDraft) reads '' (empty composer) and is allowed to
// inject. A bare '' would parse to null (no box) and the flush would wait forever,
// so render the rounded box with just the '>' marker. happy-dom doesn't run real
// layout, so we also force the terminal container to "contain" the active element
// (the flush guards on termRef.current.contains(activeElement)).
const EMPTY_CLAUDE_COMPOSER = ['╭──────────────╮', '│ >            │', '╰──────────────╯'].join(
  '\n',
)
const mountSessionMock = vi.fn((el: unknown, _opts: { active?: boolean }) => {
  // Make the focus guard pass: the flush only injects while the terminal holds
  // focus. Mark the mount element as containing the active element.
  const node = el as HTMLElement
  Object.defineProperty(node, 'contains', { value: () => true, configurable: true })
  return {
    connection: { state: () => ({ role: 'controller' }), sendInput, requestControl: vi.fn() },
    view: {
      setFileLinks: vi.fn(),
      onScroll: () => () => {},
      atBottom: () => true,
      focus: vi.fn(),
      screenText: () => EMPTY_CLAUDE_COMPOSER,
      scrollToBottom: vi.fn(),
      requestPaste: vi.fn(),
    },
    setActive,
    setAppearance: vi.fn(),
    dispose,
  }
})

vi.mock('@podium/terminal-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    mountSession: (el: unknown, opts: { active?: boolean }) => mountSessionMock(el, opts),
  }
})

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

let storeSessions: SessionMeta[] = []
let storePanelMode: Record<string, 'chat' | 'native'> = {}
let storeDrafts: Record<string, string> = {}

const fakeHub = {
  subscribeTranscript: (_s: string, _since: string | undefined, _cb: unknown): (() => void) => {
    return () => {}
  },
}

const fakeTrpc = {
  settings: {
    get: { query: vi.fn(async () => ({ sessionDefaults: { startScreen: 'native' as const } })) },
  },
}

const stableStoreFns = {
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  setPanelRenderMode: vi.fn(),
  uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: [],
    pendingSpawnIds: new Set<string>(),
    repos: [],
    trpc: fakeTrpc,
    drafts: storeDrafts,
    panelMode: storePanelMode,
    ...stableStoreFns,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const { AgentPanel } = await import('./AgentPanel')

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
    resumable: true,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  storeSessions = [meta({})]
  storePanelMode = { s1: 'native' }
  storeDrafts = {}
  sendInput.mockClear()
  setActive.mockClear()
  dispose.mockClear()
  mountSessionMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// Settle pending promise microtasks (trpc settings.get) under fake timers.
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// Advance the bounded flush poll (150ms ticks) a few times so an idle composer
// (no frames) still gets the one-shot flush.
function tickPoll(): void {
  act(() => {
    vi.advanceTimersByTime(150 * 3)
  })
}

describe('AgentPanel chat→native draft flush re-arm (warm toggle)', () => {
  it('re-injects a chat-authored draft into the native composer on a later chat→native toggle', async () => {
    // Start native (mounts the terminal once, warm across toggles).
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await settle()
    tickPoll()
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    // No draft yet → no injection at first mount.
    expect(sendInput).not.toHaveBeenCalled()

    // Switch native→chat (terminal stays mounted, hidden).
    storePanelMode = { s1: 'chat' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await settle()

    // Author a draft in chat, then toggle back to native.
    storeDrafts = { s1: 'hello from chat' }
    storePanelMode = { s1: 'native' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await settle()
    tickPoll()

    // The terminal was never re-mounted (warm toggle)…
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    // …yet the chat draft was flushed into the native composer: Ctrl-U then text.
    expect(sendInput).toHaveBeenCalledWith('\x15')
    expect(sendInput).toHaveBeenCalledWith('hello from chat')
  })
})
