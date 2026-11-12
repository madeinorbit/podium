/**
 * A SIGN-IN THE SERVER ENDED IS NOT AN OUTAGE (POD-6910), end to end in one
 * client: LoginGate, a real SocketHub over fake sockets, and the watch wired
 * exactly as AppShell wires it.
 *
 * Alice and Bob are members of one team server; this is Bob's browser (the
 * desktop app and the phone web app run the same code). Alice signs Bob's
 * device out, or removes Bob: the server closes Bob's socket with a code and
 * then answers `GET /auth/status` with "not signed in". Bob's client must land
 * on the sign-in screen with the reason, erase Bob's local data and stop
 * dialling. A network drop must keep the workspace and keep reconnecting.
 */
import { parseReplicaNamespaceKey } from '@podium/client-core/replica'
import {
  type FeedSinkPort,
  SocketHub,
  type WebSocketLike,
} from '@podium/client-core/socket-transport'
import { SIGN_IN_ENDED_CLOSE } from '@podium/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginGate } from '@/features/setup/LoginGate'
import type { AuthBootstrap } from '@/lib/use-kernel-replica'
import { passwordCapabilities } from '@/test-support/auth-capabilities'
import { startSignInEndedWatch } from './sign-in-ended'

// The erase is observed, not run: jsdom has no IndexedDB. It is the same call
// a refused sync and a sign-out make (POD-6293).
const removePrincipal = vi.fn(async (_principal: string) => {})
vi.mock('@/lib/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts')>()
  return {
    ...actual,
    webAccounts: (origin: string) => ({ ...actual.webAccounts(origin), removePrincipal }),
  }
})

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(): void {}
  close(): void {
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }
  open(): void {
    this.onopen?.({})
  }
  /** The server (or the network) ended this socket. */
  closedBy(code: number, reason = ''): void {
    this.onclose?.({ code, reason, wasClean: code !== 1006 })
  }
}

const BOB = JSON.stringify(['team-server', 'bob'])
const bobSignedIn = {
  needsAuth: true,
  authed: true,
  userId: 'bob',
  memberId: 'bob',
  syncBoundaryId: 'team-server',
}

let sockets: FakeSocket[] = []

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  removePrincipal.mockClear()
  sockets = []
})

function statusAnswer(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ capabilities: passwordCapabilities, prompt: 'password', ...body }),
  }
}

/** Bob's workspace: one runtime, one hub, one watch, torn down when LoginGate drops it. */
function Workspace({ auth }: { auth: AuthBootstrap }) {
  useEffect(() => {
    if (auth.kind !== 'principal') return
    const identity = parseReplicaNamespaceKey(auth.principal)
    if (!identity) return
    const feed: FeedSinkPort = {
      helloFields: () => null,
      connected: () => {},
      disconnected: () => {},
      frame: () => {},
    }
    const hub = new SocketHub({
      url: 'ws://team-server/client',
      feed,
      makeSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const stop = startSignInEndedWatch(hub, {
      httpOrigin: 'https://team-server',
      principal: { userId: identity.memberId as never, syncBoundaryId: identity.syncBoundaryId },
    })
    hub.connect()
    sockets.at(-1)?.open()
    return () => {
      stop()
      hub.dispose()
    }
  }, [auth])
  return <div>BOB-WORKSPACE</div>
}

async function bobIsWorking() {
  const fetchMock = vi.fn().mockResolvedValue(statusAnswer(bobSignedIn))
  vi.stubGlobal('fetch', fetchMock)
  render(<LoginGate>{(auth) => <Workspace auth={auth} />}</LoginGate>)
  expect(await screen.findByText('BOB-WORKSPACE')).toBeTruthy()
  expect(sockets).toHaveLength(1)
  return fetchMock
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe("Bob's open client when his sign-in ends (POD-6910)", () => {
  it.each([
    [
      'Alice signs Bob’s device out',
      SIGN_IN_ENDED_CLOSE.signedOut,
      { needsAuth: true, authed: false },
      'You were signed out on this device.',
    ],
    [
      'Alice removes Bob',
      SIGN_IN_ENDED_CLOSE.accessEnded,
      { needsAuth: true, authed: false },
      'You no longer have access to this server.',
    ],
  ])('%s: sign-in screen with the reason, data erased, no reconnect loop', async (_case, close, status, copy) => {
    const fetchMock = await bobIsWorking()
    fetchMock.mockResolvedValue(statusAnswer(status))

    act(() => sockets[0]?.closedBy(close.code, close.reason))

    expect(await screen.findByText(copy)).toBeTruthy()
    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
    expect(screen.queryByText('BOB-WORKSPACE')).toBeNull()
    expect(removePrincipal).toHaveBeenCalledExactlyOnceWith(BOB)
    // The workspace is gone and so is its hub: nothing dials the server again.
    const dialled = sockets.length
    await wait(1_200)
    expect(sockets.length).toBe(dialled)
  })

  it('a removal seen only through the status answer still says access ended', async () => {
    const fetchMock = await bobIsWorking()
    fetchMock.mockResolvedValue(
      statusAnswer({ needsAuth: true, authed: false, denied: 'not_workspace_member' }),
    )
    // The device was asleep when Bob was removed: its socket just died.
    act(() => sockets[0]?.closedBy(1006))
    expect(await screen.findByText('You no longer have access to this server.')).toBeTruthy()
    expect(removePrincipal).toHaveBeenCalledExactlyOnceWith(BOB)
  })

  it('a network drop keeps the workspace and the cache, and keeps reconnecting', async () => {
    const fetchMock = await bobIsWorking()
    // No server answers: the status request fails like any request offline.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    act(() => sockets[0]?.closedBy(1006))
    await wait(1_200)

    expect(screen.getByText('BOB-WORKSPACE')).toBeTruthy()
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(removePrincipal).not.toHaveBeenCalled()
    // Reconnecting: the hub dialled again.
    expect(sockets.length).toBeGreaterThan(1)
  })
})
