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
import { asSessionId, type SessionId, type SessionMeta } from '@podium/model'
import { cleanup } from '@testing-library/react'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'

/**
 * The mount's callbacks, kept from the last `mountSession` call so a test can
 * play the server's side of the attach by hand: `onReady` is the confirmation,
 * `onState` is how the durable "has this PTY ever spoken" reaches the pane
 * [POD-385]. Nothing else here can produce them — the socket in this lane never
 * connects, by design (see test-support).
 */
type MountCallbacks = {
  onReady?: () => void
  onState?: (state: { outputSeen: boolean }) => void
}
let lastMountOpts: MountCallbacks | null = null

// The terminal itself is not under test — only WHETHER it is mounted, and when.
// A call to `mountSession` IS the attach: it is what constructs the hub
// connection that emits the one-shot `attach` frame.
const mountSessionMock = vi.fn((_el: unknown, opts: unknown) => {
  lastMountOpts = opts as MountCallbacks
  return {
    connection: {
      state: () => ({ role: 'controller' }),
      sendInput: vi.fn(),
      requestControl: vi.fn(),
    },
    view: {
      setFileLinks: vi.fn(),
      setRefLinks: vi.fn(),
      onScroll: () => () => {},
      atBottom: () => true,
      focus: vi.fn(),
      screenText: () => '',
      scrollToBottom: vi.fn(),
      requestPaste: vi.fn(),
    },
    setActive: vi.fn(),
    setAppearance: vi.fn(),
    dispose: vi.fn(),
  }
})

vi.mock('@podium/terminal-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, mountSession: (el: unknown, opts: unknown) => mountSessionMock(el, opts) }
})

// The mobile keyboard accessory reaches for real DOM measurement the pane's
// mount would own; nothing here tests it and it renders on every pane.
vi.mock('@podium/terminal-client-react', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, MobileTerminalKeyboard: () => null }
})

// `lucide-react-native` ships untransformed TypeScript that this lane's
// transform rejects ("Unexpected token 'typeof'") — a harness limit, not a fact
// about the pane. Only the pane's own icon is needed; naming it (rather than
// blanket-stubbing the package) means a new icon import fails loudly here.
vi.mock('lucide-react-native', () => ({ Mic: () => null }))

const { TerminalPane } = await import('./TerminalPane')

const TARGET = { path: '/repo/wt', repoPath: '/repo' }

/**
 * The create path in two moves, as NewSessionScreen performs it: spawn through
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

beforeEach(() => {
  mountSessionMock.mockClear()
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

    // Create, then land on the session — `router.replace` the instant the spawn
    // returns, which is what NewSessionScreen does.
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
      opts.onState?.({ outputSeen })
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
      lastMountOpts?.onState?.({ outputSeen: true })
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
