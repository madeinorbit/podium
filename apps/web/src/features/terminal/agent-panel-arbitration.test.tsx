import { ConversationService } from '@podium/client-core/conversation'
import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
// @vitest-environment happy-dom
import { type AccessRefusal, asSessionId, type CredentialView } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { fixtureSnapshot as readFixture } from '@/test-support/fixture-snapshot'
import { createPanePoolFixture } from './test-support/pane-pool.test.fixture'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// The arbitration through a real render (POD-408). `panel-surface.test.ts` pins
// the rules; this file pins that the PANEL is wired to them — in particular the
// PTY-size operations, which are the one place the arbitration change is a
// correctness change and not a reshuffle.
//
// The dock's open/close used to be the one PTY-size path the panel drove
// itself. Since POD-3239 the mount's box observer is the only asker, so the
// instrument here is `sendResize` staying SILENT: a spy on the ONE mounted
// session the panel keeps across mode toggles.
// ---------------------------------------------------------------------------

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
  },
  setActive,
  setAppearance: vi.fn(),
  dispose,
}))

// The presence seam [POD-1535]: the header's watcher strip reads the hub off
// the client-core StoreProvider, which these focused renders don't mount.
// My startScreen is my synced settings record (POD-6673).
vi.mock('@/lib/my-preferences', () => ({ useMyStartScreen: () => 'native' }))
vi.mock('@podium/client-core/react', async () =>
  (await import('./test-support/presence-mock')).presenceSeamStub(paneFixture.owner as never),
)

vi.mock('@podium/terminal-client/session-mount', () => ({
  mountSession: (el: unknown, opts: { active?: boolean }) => mountSessionMock(el, opts),
}))

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

// The pane's first live size reading (the session.terminalState topic,
// POD-6764), which the terminal mount waits for before building its buffer.
vi.mock('./use-session-pane-inputs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-session-pane-inputs')>()),
  usePaneGeometry: () => ({ cols: 80, rows: 24 }),
}))

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

// My credentials list (the request boundary of the session's credential
// controls). Undefined: not read yet, as in a suite that never opens one.
let credentialViews: CredentialView[] | undefined
vi.mock('@/features/credentials/session/use-session-credentials', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/features/credentials/session/use-session-credentials')
  >()),
  useSessionCredentials: () => ({
    views: credentialViews,
    defaults: {},
    custodianOf: () => 'fixture-user',
    reload: () => {},
  }),
  // The refusal a failed launch record names, by session (the record itself is
  // the pool's effect model, which this fixture does not carry).
  usePaneLaunchRefusal: (sessionId: string | undefined) =>
    sessionId ? launchRefusals[sessionId] : undefined,
}))
let launchRefusals: Record<string, AccessRefusal> = {}

let storeSessions: SessionView[] = []
let storeMachines: Array<{ id: string; name: string; hostname: string; online: boolean }> = []
let storePanelMode: Record<string, 'chat' | 'native'> = {}
let storePendingSpawnIds = new Set<string>()
let storePendingSpawnPrompts = new Map<string, string>()

const subscribeTranscript = vi.fn(
  (_s: string, _since: string | undefined, _cb: unknown): (() => void) =>
    () => {},
)
const fakeHub = {
  subscribeTranscript,
}

const transcriptRead = vi.fn(async () => ({ items: [], tail: 'confirmed-tail', hasMore: false }))
const accountsLogin = vi.fn(async () => ({ sessionId: asSessionId('login-1') }))
const fakeTrpc = {
  settings: {
    get: { query: vi.fn(async () => ({ roles: { coding: { startScreen: 'native' } } })) },
  },
  sessions: {
    sendText: { mutate: vi.fn(async () => {}) },
    transcriptRead: { query: transcriptRead },
  },
  accounts: {
    login: { mutate: accountsLogin },
  },
}

const stableStoreFns = {
  // The chat's durable sends (POD-4762). These suites never send, so the outbox
  // holds nothing for the conversation to follow.
  chatSendsFor: () => [],
  sendChat: vi.fn(async () => ({ state: 'sent' as const })),
  discardChat: vi.fn(async () => {}),
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  navigateToSession: vi.fn(),
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: storeMachines,
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
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: () => '',
    // `undefined` = this session has no exit state, which is what the panel saw
    // before the hook existed. A concrete kind here would change what AgentPanel
    // renders; ChatView also requires this scoped subscription seam.
    useSessionExitKind: () => undefined,
    readFixture: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const paneFixture = createPanePoolFixture(() => readFixture((state) => state) as never)
vi.mock('@/app/store-worklist-pool', () => paneFixture.hooks)

function renderPanel(...args: Parameters<Root['render']>) {
  paneFixture.sync()
  root.render(...args)
}

const { AgentPanel } = await import('./AgentPanel')

const OFFER = {
  message: 'Ready to merge',
  actions: [{ label: 'Merge', prompt: 'merge it' }],
  createdAt: '2026-06-03T00:01:00.000Z',
}

function meta(over: Partial<SessionViewInput>): SessionView {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
    resumable: true,
    ...over,
  } as unknown as SessionView
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  credentialViews = undefined
  launchRefusals = {}
  storeSessions = [meta({})]
  storeMachines = []
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
  paneFixture.dispose()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function render(props: { active: boolean }): Promise<void> {
  await act(async () => {
    renderPanel(<AgentPanel sessionId={asSessionId('s1')} active={props.active} />)
  })
  await flush()
}

describe('AgentPanel panel-mode persistence', () => {
  it('does not rewrite an existing per-session mode during mount arbitration', async () => {
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    expect(stableStoreFns.setPanelMode).not.toHaveBeenCalled()
  })

  it('temporarily routes a logged-out session to native without overwriting chat preference', async () => {
    storePanelMode = { s1: 'chat' }
    storeSessions = [meta({ condition: 'logged-out' })]
    await render({ active: true })

    expect(container.querySelector('[data-testid="terminal-surface"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="terminal-surface"]')?.className).not.toContain(
      'hidden',
    )
    expect(container.querySelector('[data-testid="mode-chat"]')).toBeNull()
    expect(stableStoreFns.setPanelMode).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toContain("isn't logged in")
  })

  it('opens a PTY login session for a logged-out attach-less driver, then navigates after its row arrives', async () => {
    storePanelMode = { s1: 'chat' }
    storeSessions = [
      meta({
        condition: 'logged-out',
        // The Claude stream engine as it binds since POD-4612: server family,
        // no client terminal declared.
        driverFamily: 'server',
        attachKinds: [],
        machineId: 'machine-1',
      }),
    ]
    await render({ active: true })

    expect(container.querySelector('[data-testid="terminal-surface"]')).toBeNull()
    expect(container.querySelector('[data-testid="no-terminal-pane"]')?.textContent).toContain(
      'needs sign-in',
    )
    const login = container.querySelector<HTMLButtonElement>('[data-testid="open-login-terminal"]')
    expect(login).toBeTruthy()
    await act(async () => {
      login?.click()
      await Promise.resolve()
    })
    expect(accountsLogin).toHaveBeenCalledWith({
      harness: 'claude-code',
      machineId: 'machine-1',
    })
    expect(stableStoreFns.navigateToSession).not.toHaveBeenCalled()

    storeSessions = [...storeSessions, meta({ sessionId: asSessionId('login-1') })]
    await render({ active: true })
    expect(stableStoreFns.navigateToSession).toHaveBeenCalledWith(asSessionId('login-1'))
  })
})

// The "isn't logged in" bar speaks for the machine's own login (POD-7062).
// Every session here is on a machine whose Claude Code login is OUT; the
// fixture turns `condition: 'logged-out'` into that machine record, and the
// pool derives each session's condition from it.
describe('AgentPanel login bar and the session credential', () => {
  const apiKey = credentialView({ label: 'Team key', type: 'anthropic.api-key' })
  const subscription = credentialView({
    label: 'Work Max',
    type: 'anthropic.claude-login',
    homes: [{ machineId: 'machine-1', homeId: 'h:claude-code', state: 'in' }],
  })
  const sick = credentialView({
    label: 'CI token',
    type: 'anthropic.claude-token',
    status: 'attention',
    statusReason: 'It expired on Nov 10.',
  })
  const loggedOutOn = (credentialId?: string) =>
    meta({
      condition: 'logged-out',
      machineId: 'machine-1',
      ...(credentialId ? { credentialId } : {}),
    } as Partial<SessionViewInput>)
  const statusText = () =>
    [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? '')

  it.each([
    ['an API key', apiKey.id],
    ['a subscription home', subscription.id],
    ['another member’s credential', 'cred_00000000-0000-4000-8000-0000000000ff'],
  ])('acceptance 1: a session on %s never shows the machine login bar', async (_name, id) => {
    credentialViews = [apiKey, subscription]
    storePanelMode = { s1: 'chat' }
    storeSessions = [loggedOutOn(id)]
    await render({ active: true })
    expect(statusText().join(' ')).not.toContain("isn't logged in")
    // Nor is it pulled to the terminal to sign in: the chat preference holds.
    expect(container.querySelector('[data-testid="mode-chat"]')).toBeTruthy()
  })

  it('acceptance 2: a session on its harness login that is signed out still shows the bar', async () => {
    credentialViews = [apiKey, subscription]
    storeSessions = [loggedOutOn()]
    await render({ active: true })
    expect(statusText().join(' ')).toContain("isn't logged in")
  })

  it('acceptance 3: a session on a credential that needs attention shows its notice instead', async () => {
    credentialViews = [apiKey, sick]
    storeSessions = [loggedOutOn(sick.id)]
    await render({ active: true })
    const text = statusText()
    expect(text.join(' ')).not.toContain("isn't logged in")
    expect(text).toContainEqual(
      expect.stringContaining('CI token needs attention: It expired on Nov 10.'),
    )
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('Renew')
  })
})

// A start refused for its credential never ran, and no session row landed for
// it (POD-7067): the pane reads the painted session alone, on a machine whose
// own Claude login is out. It never says the session runs on its own login,
// and never asks for that login.
describe('AgentPanel on a start refused for its credential (POD-7067)', () => {
  const token = credentialView({ label: 'Placeholder token', type: 'anthropic.claude-token' })
  const refusedOn = (credentialId?: string) =>
    meta({
      status: 'exited',
      spawnFailure: 'not encrypted',
      condition: 'logged-out',
      machineId: 'machine-1',
      ...(credentialId ? { credentialId } : {}),
    } as Partial<SessionViewInput>)
  const statusText = () =>
    [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? '')
  const chip = () =>
    container.querySelector(
      '[aria-label^="Credential"], [data-testid="session-credential-readout"]',
    )

  it('shows no login bar and no "Its own login" chip when no credential was named', async () => {
    credentialViews = [token]
    launchRefusals = { s1: 'connection-not-encrypted' }
    storeSessions = [refusedOn()]
    await render({ active: true })
    const text = statusText().join(' ')
    expect(text).toContain('This session did not start.')
    expect(text).not.toContain("isn't logged in")
    expect(chip()).toBeNull()
    expect(container.textContent).not.toContain('Its own login')
  })

  it('names the credential chosen, as a readout with nothing to switch', async () => {
    credentialViews = [token]
    launchRefusals = { s1: 'connection-not-encrypted' }
    storeSessions = [refusedOn(token.id)]
    await render({ active: true })
    expect(statusText().join(' ')).not.toContain("isn't logged in")
    expect(chip()?.textContent).toContain('Placeholder token')
    expect(chip()?.tagName).not.toBe('BUTTON')
  })
})

describe('AgentPanel never sizes the PTY itself (one writer, POD-3239)', () => {
  // Pinning the surface for the dock changes the BOX; the mount's ResizeObserver
  // asks for the size from there, gated on the mount's own eligibility. The
  // panel's part is the scroll, and it must not have grown a second writer.
  it('an offer docking on the VISIBLE pane scrolls, and sends no resize of its own', async () => {
    await render({ active: true })
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: true })
    expect(scrollToBottom).toHaveBeenCalled()
    expect(sendResize).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="native-offer-dock"]')).toBeTruthy()
  })

  it('an offer docking on a warm HIDDEN pane sends no resize either', async () => {
    // PanelDeck `display:none`s a non-visible panel, so it measures ZERO height.
    // The dock still opens (un-animated); nothing here may touch the grid.
    await render({ active: false })
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: false })
    expect(sendResize).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="native-offer-dock"]')).toBeTruthy()
  })

  it('an offer arriving while the pane shows chat sends no resize', async () => {
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    storeSessions = [meta({ offer: OFFER })]
    await render({ active: true })
    expect(sendResize).not.toHaveBeenCalled()
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
    storeSessions = [meta({ status: 'hibernated' })]
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
    storeSessions = [meta({ status: 'hibernated', agentState: idle })]
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
    const starts = vi.spyOn(ConversationService.prototype, 'start')
    try {
      const prompt = 'Keep the optimistic first turn visible.'
      storePanelMode = { s1: 'chat' }
      storeSessions = [meta({ status: 'starting', driverFamily: 'server' })]
      storePendingSpawnIds = new Set(['s1'])
      storePendingSpawnPrompts = new Map([['s1', prompt]])

      await render({ active: true })

      expect(starts).not.toHaveBeenCalled()
      expect(transcriptRead).not.toHaveBeenCalled()
      // AgentPanel's terminal file-link index observes all transcript deltas from
      // mount. The window subscription is the one anchored to the read's tail.
      expect(
        subscribeTranscript.mock.calls.filter(([, since]) => since === 'confirmed-tail'),
      ).toEqual([])
      expect(container.textContent).toContain(prompt)

      // One store publication installs the authoritative terminal row and retires
      // both optimistic maps. AgentPanel must re-arm the read-then-subscribe
      // effect, while ChatView's local first-turn state bridges that transition.
      storeSessions = [meta({ status: 'exited', exitCode: 0 })]
      storePendingSpawnIds = new Set<string>()
      storePendingSpawnPrompts = new Map<string, string>()
      await render({ active: true })

      expect(starts).toHaveBeenCalledTimes(1)
      // The shared owner's start reads the newest window. First acquisition by
      // the chat reader must use that read, including its live-edge tail.
      expect(transcriptRead).toHaveBeenCalledTimes(1)
      expect(
        subscribeTranscript.mock.calls.filter(([, since]) => since === 'confirmed-tail'),
      ).toHaveLength(1)
      expect(container.textContent).toContain(prompt)
    } finally {
      starts.mockRestore()
    }
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

describe('AgentPanel on a server-family client terminal', () => {
  const serverDriven = () =>
    meta({
      agentKind: 'opencode',
      driverId: 'opencode-server',
      driverFamily: 'server',
      configureFields: ['model', 'effort'],
      requestedModel: 'opencode-go/kimi-k3',
      requestedEffort: 'max',
    })

  it('carries the model and effort menus in the header while the CLI view shows', async () => {
    // POD-6264: the chat view carries them in its composer; the CLI view has no
    // composer, so the header holds the same chip at every width.
    storeSessions = [serverDriven()]
    await render({ active: true })
    const header = container.querySelector('[data-testid="agent-panel-header"]')
    const chip = header?.querySelector('[data-testid="session-model"]')
    expect(chip?.getAttribute('data-configurable')).toBe('true')
    expect(chip?.querySelector('[aria-label="Model"]')).toBeTruthy()
    expect(chip?.querySelector('[aria-label="Effort"]')).toBeTruthy()
  })

  it('native-default mounts the original harness terminal and offers both modes', async () => {
    storeSessions = [serverDriven()]
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="chat-surface"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="chat-surface"]')?.className).toContain('hidden')
    expect(
      container.querySelector('[data-testid="mode-native"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(container.querySelector('[data-testid="mode-chat"]')).toBeTruthy()
  })

  it('offers the CLI switch before a server transcript has reported its first item', async () => {
    // The daemon publishes `transcriptAvailable` only after the first read. A
    // live server-family session still has a native attach surface immediately,
    // and the fallback must keep the Chat/CLI control visible during that gap.
    storeSessions = [
      meta({
        agentKind: 'opencode',
        driverId: 'opencode-server',
        driverFamily: 'server',
        transcriptAvailable: undefined,
      }),
    ]
    await render({ active: true })
    expect(container.querySelector('[data-testid="mode-chat"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="mode-native"]')).toBeTruthy()
  })

  it('chat-default keeps chat selected and defers native loading until requested', async () => {
    storePanelMode = { s1: 'chat' }
    storeSessions = [serverDriven()]
    await render({ active: true })
    expect(mountSessionMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="mode-native"]')).toBeTruthy()
    expect(
      container.querySelector('[data-testid="mode-chat"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    storePanelMode = { s1: 'native' }
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
  })

  it('reconstructs Native from the live attach contract in fresh client state', async () => {
    storePanelMode = {}
    storeSessions = [serverDriven()]
    storeSessions[0] = {
      ...storeSessions[0],
      driverFamily: undefined,
      attachKinds: ['client'],
    } as SessionView
    await render({ active: true })
    expect(container.querySelector('[data-testid="mode-native"]')).toBeTruthy()
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    storePanelMode = { s1: 'native' }
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
  })

  it('keeps ChatView subscribed while the native view is selected', async () => {
    storeSessions = [serverDriven()]
    await render({ active: true })

    const chatSurface = container.querySelector('[data-testid="chat-surface"]')
    expect(chatSurface).toBeTruthy()
    expect(subscribeTranscript).toHaveBeenCalled()

    // A CLI turn can arrive while the operator is looking at native mode. The
    // hidden ChatView must stay mounted so its live subscription can fold that
    // delta; switching back only changes visibility and foreground activity.
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    expect(container.querySelector('[data-testid="chat-surface"]')).toBe(chatSurface)
    expect(chatSurface?.className).not.toContain('hidden')
  })

  it('keeps an attach-less server session (the Claude stream engine) chat-only', async () => {
    storeSessions = [meta({ driverFamily: 'server', attachKinds: [] })]
    await render({ active: true })
    expect(mountSessionMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="mode-native"]')).toBeNull()
  })

  it('leaves a PTY session with the same harness completely alone', async () => {
    // The regression guard, and it has to be the SAME harness: opencode degraded
    // to the terminal driver is a session with a real PTY, and the difference
    // between the two rows is the driver that was actually bound.
    storeSessions = [
      meta({ agentKind: 'opencode', driverId: 'generic-pty', driverFamily: 'terminal' }),
    ]
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="mode-native"]')).toBeTruthy()
  })

  it('leaves a row whose driver family has not arrived alone too', async () => {
    // Transient field, absent before bind and on older daemons. Unknown reads as
    // "assume a terminal", so nothing about today's sessions changes.
    storeSessions = [meta({})]
    await render({ active: true })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="mode-native"]')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// POD-2290 round 4 — the arm existed and never reached the screen. The pure
// function returned `awaiting-machine`; the overlay's headline ternary knew
// only `stalled`, so past the threshold the reviewer photographed a bare
// "Starting OpenCode…" with no clock and no mention of the machine. The unit
// tests could not catch it: nothing in them renders. This one does.
// ---------------------------------------------------------------------------
describe('AgentPanel while the machine is away (POD-2290)', () => {
  // Reconnecting is the machine's condition (ADR 12 D1): a live row on a
  // machine the LiveStore reads as offline.
  const awayMachine = { id: 'm-away', name: 'away', hostname: 'away', online: false }
  const away = () => {
    storeMachines = [awayMachine]
    return meta({ agentKind: 'opencode', status: 'live', machineId: 'm-away' } as never)
  }

  async function tickPast(ms: number): Promise<void> {
    await act(async () => {
      vi.setSystemTime(Date.now() + ms)
      await vi.advanceTimersByTimeAsync(1_000)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the machine, and dates the wait, once the absence is real', async () => {
    storeSessions = [away()]
    await render({ active: true })
    await tickPast(60_000)
    const headline = container.querySelector('[data-testid="startup-headline"]')
    expect(headline?.textContent).toBe('Waiting for this machine')
    const overlay = container.querySelector('[data-testid="terminal-startup-overlay"]')
    expect(overlay?.textContent).toContain('hasn\u2019t heard from this machine')
    // The clock is the whole point of the arm: a wait the operator cannot date
    // is the state we are replacing, not the one we are rendering.
    expect(overlay?.textContent).toMatch(/\d+:\d\d/)
    // A spinner claims progress. There is none to claim.
    expect(overlay?.querySelector('.animate-spin')).toBeNull()
  })

  it('reads as an ordinary start while the absence could still be a blip', async () => {
    storeSessions = [away()]
    await render({ active: true })
    await tickPast(10_000)
    expect(container.querySelector('[data-testid="startup-headline"]')?.textContent).toContain(
      'Starting',
    )
  })

  it('leaves a reconnecting session that HAS a driver family on its own wait', async () => {
    // The narrow tail this arm is for is the legacy row with no family. A PTY
    // row that reconnects takes the ordinary attach-side wording instead — the
    // point is that the machine is never named for a row that told us what it
    // is.
    storeMachines = [awayMachine]
    storeSessions = [
      meta({
        agentKind: 'opencode',
        status: 'live',
        driverFamily: 'terminal',
        machineId: 'm-away',
      } as never),
    ]
    await render({ active: true })
    await tickPast(60_000)
    const headline = container.querySelector('[data-testid="startup-headline"]')?.textContent
    expect(headline).not.toContain('machine')
    expect(headline).toContain('hasn\u2019t started')
  })
})

// ---------------------------------------------------------------------------
// POD-4629 — the CLI pane of a session whose MACHINE is offline was an empty
// terminal with a blinking cursor. The server answers the attach without the
// daemon, and a PTY that spoke before reads `outputSeen`, so the startup overlay
// correctly steps aside — and nothing else said why there was no screen. The
// phone said "Session is not running"; the desktop said nothing at all.
// ---------------------------------------------------------------------------
describe('AgentPanel on a session whose machine is offline (POD-4629)', () => {
  const offline = { id: 'm-lud', name: 'ludovico', hostname: 'ludovico', online: false }
  const onMachine = (status: 'live') =>
    meta({ status, driverFamily: 'terminal', machineId: 'm-lud', machineName: 'ludovico' } as never)

  it('names the offline machine over the CLI of a reconnecting session', async () => {
    storeMachines = [offline]
    storeSessions = [onMachine('live')]
    await render({ active: true })
    const bar = container.querySelector('[data-testid="machine-offline-bar"]')
    expect(bar?.classList.contains('pane-state-bar')).toBe(true)
    expect(bar?.textContent).toContain('ludovico is offline')
    // The way forward is the view that still works.
    expect(bar?.querySelector('[data-testid="machine-offline-open-chat"]')).toBeTruthy()
  })

  it('names it for a row still marked live, which is how the copied DB carried it', async () => {
    storeMachines = [offline]
    storeSessions = [onMachine('live')]
    await render({ active: true })
    expect(container.querySelector('[data-testid="machine-offline-bar"]')?.textContent).toContain(
      'ludovico is offline',
    )
  })

  it('says nothing about a machine that is online', async () => {
    storeMachines = [{ ...offline, online: true }]
    storeSessions = [onMachine('live')]
    await render({ active: true })
    expect(container.querySelector('[data-testid="machine-offline-bar"]')).toBeNull()
  })

  it('leaves the chat view to its composer, which already says the session is not running', async () => {
    storeMachines = [offline]
    storeSessions = [onMachine('live')]
    storePanelMode = { s1: 'chat' }
    await render({ active: true })
    expect(container.querySelector('[data-testid="machine-offline-bar"]')).toBeNull()
  })
})
