// @vitest-environment happy-dom
/**
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
import { act, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'

// The terminal itself is not under test — only WHETHER it is mounted, and when.
// A call to `mountSession` IS the attach: it is what constructs the hub
// connection that emits the one-shot `attach` frame.
const mountSessionMock = vi.fn((_el: unknown, _opts: unknown) => ({
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
}))

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
})

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
