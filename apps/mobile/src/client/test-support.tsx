/**
 * A REAL STORE FOR MOBILE COMPONENT TESTS (POD-332).
 *
 * The point of this issue is that mobile screens read the SAME store and the
 * SAME published slices as the web. A test that mocked the store — or worse,
 * mocked `useSlice` — would pass identically against a screen that still
 * derived everything locally, which is the one thing these tests exist to
 * disprove. So this mounts the actual `StoreProvider` over a memory-backed
 * replica and drives the three entry points a real client has:
 *
 *   entities  → seeded into the replica (`applySnapshot`), the same collection a
 *               cold offline start paints from;
 *   repos     → answered by the tRPC stub's `discovery.refreshRepos`, which is
 *               where the engine's boot fan-out actually gets them;
 *   machines  → emitted on the hub as the `machines` event, which is the event
 *               a server frame produces. Reached through the hub's emitter
 *               because there is no other door: a machine list that arrived any
 *               other way would not be testing the path the product uses.
 */
import { asClientPrincipal } from '@podium/client-core/principal'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import { createReplica, memoryStorage } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import {
  asUserId,
  type GitRepositoryWire,
  type IssueWire,
  type MachineWire,
  type SessionMeta,
} from '@podium/model'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { MobileShellProvider } from './shell'
import { MobileShellSurface, useShellErrorChannel } from './shell-surface'
import type { MobileTrpc } from './trpc'

export interface MobileStoreFixture {
  sessions?: SessionMeta[]
  issues?: IssueWire[]
  repos?: GitRepositoryWire[]
  machines?: MachineWire[]
  principal?: string
  error?: string | null
  notice?: string | null
  /**
   * Mount the composition root's REAL shell instead of a fixed value: the
   * production error channel handed to the store as its `notices`, under the
   * production `MobileShellSurface`. `error` is ignored — an error arrives the
   * way a real one does, through the channel (POD-4662).
   */
  liveShell?: boolean
  /** Extra/overriding tRPC procedures merged over the defaults. */
  api?: Record<string, unknown>
}

const CONFIG = { httpOrigin: 'http://127.0.0.1:0', wsClientUrl: 'ws://127.0.0.1:0/client' }

/**
 * A socket that opens silently and never reaches the network.
 *
 * The runtime opens one on start, and in this lane the real `ws` emits an
 * unhandled ErrorEvent that takes the whole worker down — a harness failure
 * that arrives as an unrelated crash. Nothing here tests the transport: entity
 * rows come from the replica (which is the cold-offline path anyway) and
 * machine lists are pushed through the hub's own event. Opening the fake is an
 * explicit statement that component fixtures have a live transport; before the
 * exact `hub.connected` reader existed, the coarse initial health label made
 * that same assumption implicitly even though this socket never opened.
 */
class SilentSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    queueMicrotask(() => {
      this.readyState = SilentSocket.OPEN
      this.onopen?.()
    })
  }
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function stubApi(fixture: MobileStoreFixture): MobileTrpc {
  const noop = async () => {}
  return {
    discovery: {
      refreshRepos: {
        // The refresh answers with the fixture's machines too: it REPLACES the
        // machine list, so an empty answer here erased what the hub emitted.
        mutate: async () => ({
          repositories: fixture.repos ?? [],
          diagnostics: [],
          machines: fixture.machines ?? [],
        }),
      },
    },
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } },
    settings: { get: { query: async () => ({ sidebar: {} }) }, updatePersonal: { mutate: noop } },
    layout: { get: { query: async () => [] } },
    superagent: { listThreads: { query: async () => [] } },
    sessions: {
      transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
      answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
      create: { mutate: async () => ({ sessionId: 'created' }) },
    },
    issues: {
      update: { mutate: noop },
      panelApply: { mutate: async () => ({}) },
      clearNeedsHuman: { mutate: noop },
    },
    repos: { list: { query: async () => [] } },
    ...(fixture.api ?? {}),
  } as unknown as MobileTrpc
}

/**
 * Mount `children` under a live store seeded from `fixture`.
 *
 * Returns testing-library's render result plus the hub-emit helper, so a test
 * can move the world AFTER mount (a machine going offline, a grant revoked)
 * rather than only setting it up.
 */
export async function renderWithMobileStore(children: ReactNode, fixture: MobileStoreFixture = {}) {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  // EPHEMERAL, DECLARED RATHER THAN IMPLIED. `createReplica()` with no storage
  // already falls back to memory, but saying so at the call site is what makes
  // this root honest to the phase-2 client audit's `unattributed-store-read`
  // item: a store that persists nothing adopts nothing, so there is no previous
  // principal's slice for it to inherit. A root that PERSISTED would owe the
  // attribution gate here, and this one must never quietly become that.
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot('sessions', fixture.sessions ?? [])
  replica.applySnapshot('issues', fixture.issues ?? [])
  const api = stubApi(fixture)
  let hub: { emit(event: string, ...payload: unknown[]): void } | null = null

  function Capture({ inner }: { inner: ReactNode }) {
    // Reaching the hub through the store snapshot, not through a module import:
    // the hub under test must be the one the provider built.
    const store = useStore<MobileTrpc>()
    hub = store.hub as unknown as { emit(event: string, ...payload: unknown[]): void }
    return <>{inner}</>
  }

  const notice =
    fixture.notice == null ? null : { message: fixture.notice, dismiss: () => undefined }
  // Built once: a live shell re-renders its root on every notice, and a fresh
  // router window or replica factory per render would be a different store.
  const routerWindow = createMemoryRouterWindow()
  const principal = asClientPrincipal(asUserId(fixture.principal ?? 'user:test'))
  const createReplicaFn = () => replica

  function Store({ notices, children: inner }: { notices?: StoreNotices; children: ReactNode }) {
    return (
      <StoreProvider
        config={CONFIG}
        api={api}
        onFatalError={() => {}}
        notices={notices}
        principal={principal}
        createReplicaFn={createReplicaFn}
        routerWindow={routerWindow}
      >
        {inner}
      </StoreProvider>
    )
  }

  function LiveShellRoot({ inner }: { inner: ReactNode }) {
    const channel = useShellErrorChannel()
    return (
      <Store notices={channel.notices}>
        <MobileShellSurface
          value={{ error: channel.error, notice, eraseLocalData: async () => {} }}
        >
          <Capture inner={inner} />
        </MobileShellSurface>
      </Store>
    )
  }

  const result = render(
    fixture.liveShell ? (
      <LiveShellRoot inner={children} />
    ) : (
      <Store>
        <MobileShellProvider
          value={{
            error:
              fixture.error == null ? null : { message: fixture.error, dismiss: () => undefined },
            notice,
            eraseLocalData: async () => {},
          }}
        >
          <Capture inner={children} />
        </MobileShellProvider>
      </Store>
    ),
  )

  // Let the boot fan-out (repos, pins, tab orders) resolve, then publish the
  // machine list exactly as a server frame would.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  if (fixture.machines) {
    await act(async () => {
      hub?.emit('machines', fixture.machines)
      await Promise.resolve()
    })
  }
  return {
    ...result,
    replica,
    api,
    emit: (event: string, ...payload: unknown[]) => hub?.emit(event, ...payload),
  }
}
