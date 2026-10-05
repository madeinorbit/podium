/**
 * A REAL STORE FOR MOBILE COMPONENT TESTS (POD-332).
 *
 * The provider builds the same runtime, replica, outbox and pool as the app.
 * Tests publish into that replica and drive the production pool readers. So this mounts the actual `StoreProvider` over a memory-backed
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

import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { type StoreNotices, StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel, Replica } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { MobxPool } from '@podium/client-graph/pool'
import {
  asUserId,
  type GitRepositoryWire,
  type IssueDepProjection,
  type IssueGitStateProjection,
  type IssueProjection,
  type IssueUserStateWire,
  type MachineProjection,
  type MachineWire,
  type MessageRecordWire,
  type RepoProjection,
  type SessionMeta,
  type SessionUserStateWire,
} from '@podium/model'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { seedIssueFixtures } from './issue-fixtures'
import { attachMobilePool, useMobilePool, useMobilePoolProjection } from './mobile-pool'
import { MobileShellProvider } from './shell'
import { MobileShellSurface, useShellErrorChannel } from './shell-surface'
import { createMobileTestReplica } from './test-replica'
import type { MobileTrpc } from './trpc'

export interface MobileStoreFixture {
  /** A pre-seeded production kernel facade for addressed feed consumers. */
  replica?: Replica
  /** Exercise an app's real pool attachment on the provider-owned runtime. */
  attachRuntime?: (runtime: ClientRuntime<MobileTrpc>) => () => void
  sessions?: SessionMeta[]
  sessionUserStates?: SessionUserStateWire[]
  machineProjections?: MachineProjection[]
  issues?: IssueViewModel[]
  /** Explicit feed homes bypass the compatibility fixture adapter. */
  issueProjections?: IssueProjection[]
  issueUserStates?: IssueUserStateWire[]
  issueGitStates?: IssueGitStateProjection[]
  repoProjections?: RepoProjection[]
  issueDeps?: IssueDepProjection[]
  /** Synced chat message records (POD-4764), as the feed would carry them. */
  messageRecords?: MessageRecordWire[]
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
  api?: object
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
  // The pool's addressed feed is the production kernel facade. Fixture-only
  // metadata changes enter through its cache/events; no compatibility replica
  // or second runtime is constructed.
  const seededReplica = fixture.replica ? undefined : createMobileTestReplica()
  const replica = fixture.replica ?? seededReplica!
  if (seededReplica) {
    replica.applySnapshot('sessions', fixture.sessions ?? [])
    if (fixture.sessionUserStates)
      replica.applySnapshot('sessionUserStates', fixture.sessionUserStates)
    if (fixture.machineProjections) replica.applySnapshot('machines', fixture.machineProjections)
    seedIssueFixtures(replica, fixture.issues ?? [], asUserId(fixture.principal ?? 'user:test'))
    if (fixture.issueProjections)
      replica.applySnapshot('issueProjections', fixture.issueProjections)
    if (fixture.issueUserStates) replica.applySnapshot('issueUserStates', fixture.issueUserStates)
    if (fixture.issueGitStates) replica.applySnapshot('issueGitStates', fixture.issueGitStates)
    if (fixture.repoProjections) replica.applySnapshot('repos', fixture.repoProjections)
    if (fixture.issueDeps) replica.applySnapshot('issueDeps', fixture.issueDeps)
    replica.applySnapshot('messageRecords', fixture.messageRecords ?? [])
    // This fixture supplies a complete offline bootstrap, including known
    // absence of personal markers. Custom replicas control their own posture.
    seededReplica.finishBootstrap()
  }
  const api = stubApi(fixture)
  let hub: { emit(event: string, ...payload: unknown[]): void } | null = null
  let pool: MobxPool | null = null
  let ready = false
  let runtimeHandle: ClientRuntime<MobileTrpc> | undefined
  function PoolReady() {
    pool = useMobilePool()
    // The host publishes the pool before its lazy screen sources finish attaching.
    // A fixture is ready only when the actual readers and launch facts are present.
    ready = useMobilePoolProjection(readReady, false)
    return null
  }

  function Capture({ inner }: { inner: ReactNode }) {
    // Reaching the hub through the store snapshot, not through a module import:
    // the hub under test must be the one the provider built.
    const store = useStoreHandle<MobileTrpc>()
    runtimeHandle = store
    hub = store.access.hub as unknown as { emit(event: string, ...payload: unknown[]): void }
    return (
      <>
        {!fixture.attachRuntime && <PoolReady />}
        {inner}
      </>
    )
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
        attachRuntime={
          fixture.attachRuntime ??
          ((runtime) =>
            attachMobilePool(runtime, (cause) => {
              throw cause
            }))
        }
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
  if (!fixture.attachRuntime) {
    await waitFor(() => {
      if (!ready) throw new Error('Mobile pool is attaching')
    }, { timeout: 5000 })
    // Paint may ask for cold inputs after source attachment. Settle the production
    // batched loader; custom counter fixtures retain control of their own windows.
    for (let turn = 0; turn < 100; turn++) {
      let loaded = 0
      await act(async () => {
        loaded = pool?.hydrate() ?? 0
      })
      if (loaded === 0) break
      if (turn === 99) throw new Error('Mobile fixture loads did not settle')
    }
  }
  return {
    ...result,
    replica,
    api,
    runtime: runtimeHandle!,
    emit: (event: string, ...payload: unknown[]) => hub?.emit(event, ...payload),
  }
}

function readReady(pool: MobxPool): boolean {
  for (const kind of ['mobileScreenReader', 'mobileSessionReader', 'commandCatalog'] as const) {
    const row = pool.row(kind, kind === 'commandCatalog' ? 'catalog' : 'reader')
    if (!row || typeof row === 'symbol') return false
  }
  return true
}
