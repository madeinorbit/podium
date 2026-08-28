// @vitest-environment happy-dom
import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// The arbitration through a real render (POD-408). `panel-surface.test.ts` pins
// the rules; this file pins that the PANEL is wired to them — in particular the
// PTY-size operations, which are the one place the arbitration change is a
// correctness change and not a reshuffle.
//
// The dock's open/close is the only PTY-size path reachable without a real
// ResizeObserver, so `fit`/`sendResize` are the instrument. They are spies on
// the ONE mounted session the panel keeps across mode toggles.
// ---------------------------------------------------------------------------

const fit = vi.fn(() => ({ cols: 100, rows: 30 }))
const sendResize = vi.fn()
const scrollToBottom = vi.fn()
const setActive = vi.fn()
const dispose = vi.fn()

const mountSessionMock = vi.fn((_el: unknown, _opts: { active?: boolean }) => ({
  connection: {
    state: () => ({ role: 'controller' }),
    sendInput: vi.fn(),
    sendResize,
    requestControl: vi.fn(),
  },
  view: {
    setFileLinks: vi.fn(),
    setAppearance: vi.fn(),
    setRefLinks: vi.fn(),
    onScroll: () => () => {},
    atBottom: () => true,
    focus: vi.fn(),
    screenText: () => '',
    scrollToBottom,
    requestPaste: vi.fn(),
    fit,
  },
  setActive,
  setAppearance: vi.fn(),
  dispose,
}))

// The presence seam [POD-1535]: the header's watcher strip reads the hub off
// the client-core StoreProvider, which these focused renders don't mount.
vi.mock('@podium/client-core/react', async () =>
  (await import('./test-support/presence-mock')).presenceSeamStub(),
)

vi.mock('@podium/terminal-client/session-mount', () => ({
  mountSession: (el: unknown, opts: { active?: boolean }) => mountSessionMock(el, opts),
}))

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

let storeSessions: SessionMeta[] = []
let storePanelMode: Record<string, 'chat' | 'native'> = {}
let storePendingSpawnIds = new Set<string>()
let storePendingSpawnPrompts = new Map<string, string>()

const subscribeTranscript = vi.fn(
  (_s: string, _since: string | undefined, _cb: unknown): (() => void) => () => {},
)
const fakeHub = {
  subscribeTranscript,
}

const transcriptRead = vi.fn(async () => ({ items: [], tail: 'confirmed-tail', hasMore: false }))
const fakeTrpc = {
  settings: {
    get: { query: vi.fn(async () => ({ roles: { coding: { startScreen: 'native' } } })) },
  },
  sessions: {
    sendText: { mutate: vi.fn(async () => {}) },
    transcriptRead: { query: transcriptRead },
  },
}

const stableStoreFns = {
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: [],
    pendingSpawnIds: storePendingSpawnIds,
    pendingSpawnPrompts: storePendingSpawnPrompts,
    repos: [],
    trpc: fakeTrpc,
    drafts: {},
    panelMode: storePanelMode,
    issues: [],
    ...stableStoreFns,
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: () => '',
    // `undefined` = this session has no exit state, which is what the panel saw
    // before the hook existed. A concrete kind here would change what AgentPanel
    // renders, so the neutral value is the one that keeps these cases about
    // arbitration rather than about teardown.
    useSessionExitKind: () => undefined,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const { AgentPanel } = await import('./AgentPanel')

const OFFER = {
  message: 'Ready to merge',
  actions: [{ label: 'Merge', prompt: 'merge it' }],
  createdAt: '2026-06-03T00:01:00.000Z',
}

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
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
  } as unknown as SessionMeta
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  storeSessions = [meta({})]
  storePanelMode = { s1: 'native' }
  storePendingSpawnIds = new Set<string>()
  storePendingSpawnPrompts = new Map<string, string>()
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function render(props: { active: boolean }): Promise<void> {
  await act(async () => {
    root.render(<AgentPanel sessionId={asSessionId('s1')} active={props.active} />)
  })
  await flush()
}

describe('AgentPanel panel-mode persistence', () => {
  it('does not rewrite an existing per-session mode during mount arbitration', async () => {
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    expect(stableStoreFns.setPanelMode).not.toHaveBeenCalled()
  })
})

describe('AgentPanel PTY sizing is gated on the visibility foundation', () => {
  it('winches the PTY when an offer docks on the VISIBLE pane', async () => {
    await render({ active: true })
    expect(fit).not.toHaveBeenCalled()
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: true })
    expect(fit).toHaveBeenCalled()
    expect(sendResize).toHaveBeenCalledWith(100, 30)
  })

  it('does NOT winch the PTY when the offer docks on a warm HIDDEN pane', async () => {
    // PanelDeck `display:none`s a non-visible panel, so it measures ZERO height:
    // fitting from here re-grids a live PTY to a box nobody is looking at. The
    // dock still opens (un-animated) — only the sizing is withheld.
    await render({ active: false })
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: false })
    expect(fit).not.toHaveBeenCalled()
    expect(sendResize).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="native-offer-dock"]')).toBeTruthy()
  })

  it('does NOT winch the PTY when the pane is showing chat', async () => {
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: true })
    expect(fit).not.toHaveBeenCalled()
  })
})

describe('AgentPanel lifecycle actions', () => {
  async function openMenu(): Promise<string> {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="header-menu"]')
    await act(async () => trigger?.click())
    await flush()
    return document.querySelector('[role="menu"]')?.textContent ?? ''
  }

  it('offers Hibernate for a live resumable agent and runs it', async () => {
    await render({ active: true })
    expect(await openMenu()).toContain('Hibernate')
    const item = document.querySelector<HTMLElement>('[data-testid="lifecycle-hibernate"]')
    await act(async () => item?.click())
    expect(stableStoreFns.hibernateSession).toHaveBeenCalledWith('s1')
  })

  it('offers Hibernate mid-turn but blocks it, with the reason on the item', async () => {
    storeSessions = [
      meta({
        agentState: { phase: 'working', since: '2026-06-03T00:00:00.000Z', nativeSubagentCount: 0 },
      }),
    ]
    await render({ active: true })
    await openMenu()
    const item = document.querySelector<HTMLElement>('[data-testid="lifecycle-hibernate"]')
    expect(item).toBeTruthy()
    expect(item?.getAttribute('title')).toBe('Agent is working — hibernate once it reaches idle')
  })

  it('does not offer Hibernate before the process exists', async () => {
    // The panel used to offer it on `starting`, disagreeing with the shared
    // eligibility rule the context menu and command palette both read.
    storeSessions = [meta({ status: 'starting' })]
    await render({ active: true })
    expect(await openMenu()).not.toContain('Hibernate')
  })

  it('wakes a parked session from the banner and stays retryable when refused', async () => {
    storeSessions = [meta({ status: 'hibernated', controllerId: null })]
    stableStoreFns.resurrectSession.mockRejectedValueOnce(new Error('wake rejected'))
    await render({ active: true })
    const button = container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-resume"]')
    expect(button?.textContent).toBe('Resume')
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })
    expect(stableStoreFns.resurrectSession).toHaveBeenCalledWith('s1')
    expect(button?.disabled).toBe(false)
  })

  it('gives a shell with no transcript the recovery pane, not a banner over nothing', async () => {
    storeSessions = [meta({ status: 'exited', agentKind: 'shell', transcriptAvailable: false })]
    await render({ active: true })
    const button = container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-restart"]')
    expect(button?.textContent).toBe('Restart shell')
  })
})

describe('AgentPanel header triage controls follow the surface', () => {
  // Found by mutation, not by reading: narrowing `showSnooze` from
  // `!hibernated && !exited` to `surface.kind === 'live'` was SILENT across the
  // whole terminal lane, and a throw on the same line reddened 24 named tests —
  // so the line runs constantly and nothing asserted on it. The snooze trigger
  // is the header's only `aria-pressed` control, which is what this keys on
  // (structure, not copy).
  const snooze = () => container.querySelector('[data-testid="agent-panel-header"] [aria-pressed]')
  // Snooze is offered only OUTSIDE the working bucket, so every fixture here is
  // explicitly idle — otherwise "no snooze" would pass for the wrong reason.
  const idle = { phase: 'idle' as const, since: '2026-06-03T00:00:00.000Z', nativeSubagentCount: 0 }

  it('offers snooze for a live, non-working session', async () => {
    storeSessions = [meta({ agentState: idle })]
    await render({ active: true })
    expect(snooze()).toBeTruthy()
  })

  it('withholds snooze from a parked or ended session — there is nothing to defer', async () => {
    storeSessions = [meta({ status: 'hibernated', controllerId: null, agentState: idle })]
    await render({ active: true })
    expect(snooze()).toBeNull()
    storeSessions = [meta({ status: 'exited', agentState: idle })]
    await render({ active: true })
    expect(snooze()).toBeNull()
  })

  it('withholds snooze while the session is in transit', async () => {
    // Pre-POD-408 the header offered it over the handover veil: `showSnooze`
    // checked hibernated/exited but not the move.
    storeSessions = [meta({ handoffTarget: 'other-machine', agentState: idle })]
    await render({ active: true })
    expect(snooze()).toBeNull()
  })
})

describe('AgentPanel mount gating', () => {
  it('holds the terminal mount until an optimistic spawn reconciles (#119)', async () => {
    storePendingSpawnIds = new Set(['s1'])
    await render({ active: true })
    expect(mountSessionMock).not.toHaveBeenCalled()
    storePendingSpawnIds = new Set<string>()
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
  })

  it('starts the transcript exactly once after an optimistic spawn is confirmed', async () => {
    const prompt = 'Keep the optimistic first turn visible.'
    storePanelMode = { s1: 'chat' }
    storeSessions = [meta({ status: 'starting' })]
    storePendingSpawnIds = new Set(['s1'])
    storePendingSpawnPrompts = new Map([['s1', prompt]])

    await render({ active: true })

    expect(transcriptRead).not.toHaveBeenCalled()
    // AgentPanel's terminal file-link index observes all transcript deltas from
    // mount. The window subscription is the one anchored to the read's tail.
    expect(subscribeTranscript.mock.calls.filter(([, since]) => since === 'confirmed-tail')).toEqual(
      [],
    )
    expect(container.textContent).toContain(prompt)

    // One store publication installs the authoritative terminal row and retires
    // both optimistic maps. AgentPanel must re-arm the read-then-subscribe
    // effect, while ChatView's local first-turn state bridges that transition.
    storeSessions = [meta({ status: 'exited', exitCode: 0 })]
    storePendingSpawnIds = new Set<string>()
    storePendingSpawnPrompts = new Map<string, string>()
    await render({ active: true })

    expect(transcriptRead).toHaveBeenCalledTimes(1)
    expect(
      subscribeTranscript.mock.calls.filter(([, since]) => since === 'confirmed-tail'),
    ).toHaveLength(1)
    expect(container.textContent).toContain(prompt)
  })

  it('tears the terminal down, and offers no mode switch, once the session is in transit', async () => {
    // Establish a real mounted terminal before the handoff. The renderer now
    // loads asynchronously, so beginning the test in transit can correctly
    // cancel the pending mount without ever creating an instance to dispose.
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)

    storeSessions = [meta({ handoffTarget: 'other-machine' })]
    await render({ active: true })
    expect(dispose).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="mode-native"]')).toBeNull()
    expect(container.querySelector('[data-testid="terminal-surface"]')).toBeNull()
  })
})
