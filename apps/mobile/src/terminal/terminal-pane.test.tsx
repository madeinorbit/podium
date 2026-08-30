// @vitest-environment happy-dom
/**
 * The mobile pane's two contracts that are not xterm's: WHEN it attaches, and
 * WHAT it says while there is nothing to look at.
 *
 * ---------------------------------------------------------------------------
 * THE CREATE PATH MUST NOT ATTACH TO A SESSION THE SERVER HAS NEVER HEARD OF
 * (POD-1613).
 *
 * The operator's report: creating a session lands you on it with a permanently
 * blank terminal, while leaving to the overview and coming back renders it fine.
 *
 * The mechanism, measured rather than assumed:
 *
 *   1. `spawnDraftAgent` paints an OPTIMISTIC session row immediately, so
 *      SessionScreen's absence guard passes and TerminalPane mounts at once.
 *   2. `SocketHub.attach` sends its `attach` frame EXACTLY ONCE, at connection
 *      construction (socket-hub.ts) — it is re-sent only when the socket itself
 *      reconnects. A session the server has not created yet drops that frame.
 *   3. Nothing retries. `mountSession`'s `readyTimeoutMs` backstop then fires
 *      `onReady` anyway, so "Attaching terminal…" disappears and the operator is
 *      left looking at an empty grid FOREVER.
 *   4. Navigating away disposes the mount (`hub.detach`), and coming back builds
 *      a fresh connection whose one attach now lands — hence "it's there".
 *
 * This is the same hazard the desktop AgentPanel documents on its own `enabled`
 * gate ("its one-shot attach would be dropped and never retried, so
 * `spawnConfirmed` holds the mount until the reconcile") and defends with
 * `panelGates().terminalMounted`. Mobile gated only on transport connectivity.
 *
 * These cases drive the REAL optimism ledger — `store.spawnDraftAgent` mints the
 * pending id and a replica snapshot retires it — because a fixture that hands
 * the pane an already-confirmed session cannot reproduce a race and would pass
 * against the defect.
 */
import { useStore } from '@podium/client-core/react'
import {
  asIssueId,
  asSessionId,
  type IssueWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { cleanup } from '@testing-library/react'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'
import type { TerminalControlState } from './terminal-control'

/**
 * The mount's callbacks, kept from the last `mountSession` call so a test can
 * play the server's side of the attach by hand: `onReady` is the confirmation,
 * `onState` is how the durable "has this PTY ever spoken" reaches the pane
 * [POD-385]. Nothing else here can produce them — the socket in this lane never
 * connects, by design (see test-support).
 */
type MountRole = 'controller' | 'spectator'
type MountCallbacks = {
  onReady?: () => void
  onState?: (state: {
    outputSeen: boolean
    role: MountRole
    cols: number
    rows: number
    requestedGeometry: { cols: number; rows: number } | null
  }) => void
  onMounted?: (mounted: unknown) => void
  gridMode?: string
}
let lastMountOpts: MountCallbacks | null = null

/** The ref-link config the pane hands the terminal — see the POD-724 cases. */
type RefLinks = {
  isKnownPrefix: (prefix: string) => boolean
  onActivate: (ref: string) => void
  resolveStage: (ref: string) => string | null
}

// Module-level so a case can assert on the mount's OWN imperative surface: the
// explicit takeover the header requests, and the ref-link config the pane arms.
const takeControlMock = vi.fn()
const setRefLinksMock = vi.fn()
const refLinks = (): RefLinks => {
  const cfg = setRefLinksMock.mock.calls.at(-1)?.[0] as RefLinks | undefined
  if (!cfg) throw new Error('the pane never configured ref links')
  return cfg
}

// The terminal itself is not under test — only WHETHER it is mounted, and when.
// A call to `mountSession` IS the attach: it is what constructs the hub
// connection that emits the one-shot `attach` frame.
const mountSessionMock = vi.fn((_el: unknown, opts: unknown) => {
  lastMountOpts = opts as MountCallbacks
  const mounted = {
    connection: {
      state: () => ({ role: 'controller' }),
      sendInput: vi.fn(),
      requestControl: vi.fn(),
    },
    view: {
      setFileLinks: vi.fn(),
      setRefLinks: setRefLinksMock,
      onScroll: () => () => {},
      atBottom: () => true,
      focus: vi.fn(),
      screenText: () => '',
      scrollToBottom: vi.fn(),
      requestPaste: vi.fn(),
    },
    takeControl: takeControlMock,
    setActive: vi.fn(),
    setAppearance: vi.fn(),
    dispose: vi.fn(),
  }
  // `onMounted` is invoked by the REAL useTerminalSession (only mountSession is
  // faked here), so the pane's mount-time wiring runs through the shipped path.
  return mounted
})

vi.mock('@podium/terminal-client/session-mount', () => ({
  mountSession: (el: unknown, opts: unknown) => mountSessionMock(el, opts),
}))

// The mobile keyboard accessory reaches for real DOM measurement the pane's
// mount would own; nothing here tests it and it renders on every pane.
vi.mock('@podium/terminal-client-react', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, MobileTerminalKeyboard: () => null }
})

const { TerminalPane } = await import('./TerminalPane')

const TARGET = { path: '/repo/wt', repoPath: '/repo' }

/**
 * The create path in two moves, as the launch sheet performs it: spawn through
 * the store, THEN mount the pane on the returned id. Splitting them (rather than
 * spawning inside the pane's own mount) is what lets a test drive the id through
 * the REAL optimism ledger — a hand-built pending set would test the fixture.
 */
let control: {
  spawn: () => SessionId
  show: (id: SessionId) => void
} | null = null

function CreateThenAttach() {
  const store = useStore<MobileTrpc>()
  const [sessionId, setSessionId] = useState<SessionId | null>(null)
  control = {
    spawn: () => store.spawnDraftAgent({ target: TARGET, agentKind: 'claude-code' }).sessionId,
    show: setSessionId,
  }
  return sessionId ? <TerminalPane sessionId={sessionId} active /> : null
}

function confirmedRow(sessionId: SessionId): SessionMeta {
  return {
    sessionId,
    cwd: TARGET.path,
    status: 'live',
    agentKind: 'claude-code',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as SessionMeta
}

/** A visible task row, as the replica holds one. */
function issueRow(
  overrides: Omit<Partial<IssueWire>, 'id'> & { id: string; seq: number },
): IssueWire {
  return {
    title: 'Some work',
    stage: 'in_progress',
    prefix: 'POD',
    displayRef: `POD-${overrides.seq}`,
    archived: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
    id: asIssueId(overrides.id),
  } as unknown as IssueWire
}

beforeEach(() => {
  mountSessionMock.mockClear()
  takeControlMock.mockClear()
  setRefLinksMock.mockClear()
  lastMountOpts = null
})

// This lane registers no setup file, so testing-library's auto-cleanup is not
// installed: without this every render stacks up in the same document and a
// text query matches the PREVIOUS case's pane as well as this one's.
afterEach(cleanup)

describe('TerminalPane on the create path (POD-1613)', () => {
  it('holds the attach back while the spawn is unconfirmed, then attaches when it lands', async () => {
    const { replica } = await renderWithMobileStore(<CreateThenAttach />)
    const ctl = control
    if (!ctl) throw new Error('harness did not render')

    // Create, then land on the session — navigate the instant the spawn
    // returns, which is what the launch sheet does.
    let spawned: SessionId | undefined
    await act(async () => {
      spawned = ctl.spawn()
      ctl.show(spawned)
      await Promise.resolve()
    })
    if (!spawned) throw new Error('spawn produced no session id')

    // THE RACE, HELD OPEN: the optimistic row exists (the screen renders), the
    // server row does not. Attaching here is the defect — the frame is dropped
    // and never retried.
    expect(mountSessionMock).not.toHaveBeenCalled()

    // The server reconciles: truth for the same id lands in the replica, which
    // retires the spawn overlay and clears the id from pendingSpawnIds.
    await act(async () => {
      replica.applySnapshot('sessions', [confirmedRow(spawned as SessionId)])
      await Promise.resolve()
    })

    // ...and only NOW does the pane attach — without a remount.
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
  })

  it('attaches immediately for an already-confirmed session (the remount path)', async () => {
    const sessionId = asSessionId('sess-confirmed')
    await renderWithMobileStore(<TerminalPane sessionId={sessionId} active />, {
      sessions: [confirmedRow(sessionId)],
    })
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(lastMountOpts?.gridMode).toBe('server-grid')
  })
})

/**
 * A CLI THAT PRINTS NOTHING ON LAUNCH IS NOT A DEAD SESSION (POD-393).
 *
 * The pane's status sentences all ended at the attach, so a child still doing
 * first-run setup — or self-updating, which held one PTY silent for four
 * measured minutes (POD-385) — dropped the operator onto an empty grid with no
 * sentence at all. The distinguishing fact is the server's durable output
 * counter, delivered on the attach and republished on ConnectionState; a
 * session merely idling at a prompt has it TRUE and must keep its bare grid.
 */
describe('TerminalPane startup status (POD-393)', () => {
  const SILENT = 'Attached — no output yet…'

  /** Play the attach: confirm it, and report the PTY's output history with it. */
  async function attach(outputSeen: boolean): Promise<void> {
    const opts = lastMountOpts
    if (!opts) throw new Error('the pane never mounted a session')
    await act(async () => {
      opts.onState?.({
        outputSeen,
        role: 'spectator',
        cols: 103,
        rows: 28,
        requestedGeometry: null,
      })
      opts.onReady?.()
      await Promise.resolve()
    })
  }

  it('says the PTY has printed nothing yet, and stops as soon as it does', async () => {
    const sessionId = asSessionId('sess-silent')
    const view = await renderWithMobileStore(<TerminalPane sessionId={sessionId} active />, {
      sessions: [confirmedRow(sessionId)],
    })

    // Before the attach lands, the wait that is on screen is ours, not the
    // child's — one sentence at a time is the whole idiom.
    expect(view.queryByText('Attaching terminal…')).not.toBeNull()
    expect(view.queryByText(SILENT)).toBeNull()

    await attach(false)
    expect(view.queryByText('Attaching terminal…')).toBeNull()
    expect(view.queryByText(SILENT)).not.toBeNull()

    // First output: the terminal itself is the affordance from here on.
    await act(async () => {
      lastMountOpts?.onState?.({
        outputSeen: true,
        role: 'spectator',
        cols: 103,
        rows: 28,
        requestedGeometry: null,
      })
      await Promise.resolve()
    })
    expect(view.queryByText(SILENT)).toBeNull()
  })

  it('stays out of the way of a session that has already spoken', async () => {
    const sessionId = asSessionId('sess-talked')
    const view = await renderWithMobileStore(<TerminalPane sessionId={sessionId} active />, {
      sessions: [confirmedRow(sessionId)],
    })
    await attach(true)
    expect(view.queryByText(SILENT)).toBeNull()
    expect(view.queryByText('Attaching terminal…')).toBeNull()
  })
})

/**
 * READING A DESK-SIZED TUI ON A PHONE WITHOUT TYPING INTO IT (POD-724).
 *
 * The pane attaches in `server-grid`, so it is a spectator on the desk's grid
 * and pans the rest. Until now the ONLY way to be sized for this screen was the
 * implicit takeover inside `sendInput` — you had to send a keystroke into a
 * running agent's session in order to READ it. The screen header now offers the
 * takeover explicitly, which makes two things testable: that the pane publishes
 * WHICH side of that line it is on (a blind "Take control" button that lies
 * while already in control is the defect), and that the takeover goes through
 * the mount's `takeControl` — not a bare `connection.requestControl()`, which
 * would hand over without carrying this phone's measured viewport and leave
 * the PTY on the desk's geometry until the next debounced observer tick.
 */
describe('TerminalPane take control (POD-724)', () => {
  async function mountPane(sessionId: SessionId) {
    const published: TerminalControlState[] = []
    const view = await renderWithMobileStore(
      <TerminalPane sessionId={sessionId} active onControlState={(s) => published.push(s)} />,
      { sessions: [confirmedRow(sessionId)] },
    )
    return { view, published, latest: () => published.at(-1) }
  }

  async function report(
    role: MountRole,
    ready = true,
    requestedGeometry: { cols: number; rows: number } | null = null,
  ): Promise<void> {
    await act(async () => {
      lastMountOpts?.onState?.({
        outputSeen: true,
        role,
        cols: role === 'controller' ? 62 : 103,
        rows: role === 'controller' ? 36 : 28,
        requestedGeometry,
      })
      if (ready) lastMountOpts?.onReady?.()
      await Promise.resolve()
    })
  }

  it('publishes spectator until the server says controller, and takes control through the mount', async () => {
    const sessionId = asSessionId('sess-control')
    const pane = await mountPane(sessionId)

    // Attaching claims nothing: a phone that is merely looking must not resize
    // a desktop-driven PTY, so the honest published state is "spectator".
    await report('spectator')
    expect(pane.latest()?.role).toBe('spectator')
    expect(pane.latest()?.phase).toBe('spectating')
    expect(pane.latest()?.ready).toBe(true)

    // The header's action. `takeControl` on the MOUNT is what carries this
    // phone's viewport across with the control request.
    act(() => pane.latest()?.takeControl())
    expect(takeControlMock).toHaveBeenCalledTimes(1)

    // The server transfers control; the action must stop offering what already
    // happened.
    await report('controller')
    expect(pane.latest()?.role).toBe('controller')
    expect(pane.latest()?.phase).toBe('controlling')
  })

  it('keeps the claim pending until matching server geometry is acknowledged', async () => {
    const sessionId = asSessionId('sess-caption')
    const pane = await mountPane(sessionId)
    const SPECTATING = 'Following the shared 103×28 terminal — take control to fit this phone.'
    const FITTING = 'Taking control — fitting the shared terminal to this phone…'
    const CONTROLLING = 'In control — phone grid 62×36.'

    await report('spectator')
    expect(pane.view.queryByText(SPECTATING)).not.toBeNull()

    await report('spectator', true, { cols: 62, rows: 36 })
    expect(pane.latest()?.phase).toBe('fitting')
    expect(pane.view.queryByText(SPECTATING)).toBeNull()
    expect(pane.view.queryByText(FITTING)).not.toBeNull()

    // Controller role alone is not success: the target remains pending until
    // the authoritative geometry arrives.
    await report('controller', true, { cols: 62, rows: 36 })
    expect(pane.view.queryByText(FITTING)).not.toBeNull()

    await report('controller')
    expect(pane.view.queryByText(FITTING)).toBeNull()
    expect(pane.view.queryByText(CONTROLLING)).not.toBeNull()
  })
})

/**
 * REF UNDERLINES ON THE PHONE (POD-724).
 *
 * `POD-N` in agent output is painted with a live stage-coloured underline on the
 * desktop and with NOTHING here, because the mobile pane never configured the
 * terminal's ref links. The desktop learns its prefixes from a repo registry the
 * phone does not have; deriving them from the live issue projection instead is
 * the stricter answer — the phone marks only what it can actually open — and
 * these cases pin both halves of that: the projection decides, and a token that
 * resolves to nothing navigates nowhere.
 */
describe('TerminalPane ref underlines (POD-724)', () => {
  const SESSION = asSessionId('sess-refs')

  it('marks only prefixes the live projection knows, colours them by live stage, and opens the task', async () => {
    const opened: string[] = []
    const { replica } = await renderWithMobileStore(
      <TerminalPane sessionId={SESSION} active onOpenIssue={(id) => opened.push(id)} />,
      {
        sessions: [confirmedRow(SESSION)],
        issues: [issueRow({ id: 'iss-7', seq: 7, stage: 'in_progress' })],
      },
    )

    // Armed at mount time, so the first replayed frame is already marked.
    expect(setRefLinksMock).toHaveBeenCalled()
    expect(refLinks().isKnownPrefix('POD')).toBe(true)
    // The defect this guards: `UTF-8` is a real hyphen, not a task.
    expect(refLinks().isKnownPrefix('UTF')).toBe(false)
    expect(refLinks().resolveStage('POD-7')).toBe('in_progress')

    refLinks().onActivate('POD-7')
    expect(opened).toEqual(['iss-7'])

    // A parseable token with no visible row is late, hidden, or removed — the
    // pane must not render any of those as a destination.
    refLinks().onActivate('POD-404')
    expect(opened).toEqual(['iss-7'])

    // The stage is read LIVE, but nothing schedules a repaint on its own: a task
    // moving to review must re-arm the overlay, or it keeps yesterday's colour.
    setRefLinksMock.mockClear()
    await act(async () => {
      replica.applySnapshot('issues', [issueRow({ id: 'iss-7', seq: 7, stage: 'review' })])
      await Promise.resolve()
    })
    expect(setRefLinksMock).toHaveBeenCalled()
    expect(refLinks().resolveStage('POD-7')).toBe('review')
  })
})
