/**
 * THE MOBILE COMPOSITION ROOT — bootstrap, and nothing else (POD-332).
 *
 * The Expo app runs the SAME `StoreProvider` as the web (replica-backed entity
 * reads, outboxed optimistic mutations), so a cold offline start paints from
 * local data and offline writes replay on reconnect.
 *
 * READ PATH (POD-1241): KernelReplica + FeedAuthorityClient over the v2 feed,
 * with entity rows in SqliteSyncStore. WRITE PATH (POD-1220): the durable
 * outbox binding already on SQLite. AsyncStorage holds only side-cache
 * (ui-state, transcript windows) and the pre-migration legacy bridge — never
 * per-user state, which is replicated rows read through the same slices and
 * commands as the web (doc §3.3, POD-1076).
 *
 * WHAT THIS FILE STOPPED BEING. It used to also publish `MobileClientValue`: a
 * 55-field object rebuilt in one `useMemo` with a 27-entry dependency array,
 * re-exporting store fields under mobile-local names and re-deriving on the
 * phone what the web read from a published slice. It is deleted. Screens read
 * `@podium/client-core/react` (`useStore`, `useSlice`) through the thin typing
 * seam in `./hooks`, so a slice fixed once is fixed on both platforms and the
 * two can no longer disagree about the same list.
 *
 * Three facts survive that a store cannot answer — a fatal error, a storage
 * degradation notice, and this principal's local erase. They live in `./shell`,
 * which says why each one cannot come from a snapshot.
 *
 * Demo mode (`?demo=1`) is now a REAL store over an in-memory replica seeded
 * with the fixtures, rather than a second hand-written value object: the design
 * surface therefore exercises the same slices as the product.
 */

import { OUTBOX_COMMANDS, outboxCommandFor } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  createKernelOutboxStorage,
  createKernelReplica,
  createReplica,
  createSideCache,
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  type Replica,
  type StorageApi,
} from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { FeedSinkPort, SocketHub } from '@podium/client-core/socket-transport'
import type { SessionId } from '@podium/model'
import type { FeedChangesSinceReplyLenient } from '@podium/protocol'
import {
  decideLegacyAdoption,
  LEGACY_STANDALONE_OUTBOX_KEY,
  type LegacyIdentityEvidence,
  type LegacyMigrationOutcome,
  migrateLegacyReplica,
} from '@podium/sync/adapters/legacy-replica'
import {
  fromExpoSqlite,
  type SqlDatabaseLike,
  SqliteSyncStore,
} from '@podium/sync/adapters/mobile-sqlite'
import type { OutboxAttribution, OutboxCommand } from '@podium/sync/outbox'
import { type Cursor, Replica as KernelReplica, type ReplicaEvent } from '@podium/sync/replica'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SQLite from 'expo-sqlite'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { BootSplash } from '../components/BootSplash'
import { fetchAuthStatus } from './auth'
import {
  DEMO_ISSUES,
  DEMO_SESSIONS,
  DEMO_SUPER_SESSION,
  DEMO_TRANSCRIPTS,
  demoEnabled,
} from './demoData'
import { type MobileShell, MobileShellProvider } from './shell'
import { type MobileTrpc, makeMobileTrpc, readServerConfig } from './trpc'

// ---------------------------------------------------------------------------
// THE MOBILE REPLICA COMPOSITION ROOT (POD-1220 durable + POD-1241 wire v2)
// ---------------------------------------------------------------------------

/** The SQLite file the durable outbox and entity cache live in. */
export const MOBILE_REPLICA_DB = 'podium-replica.db'

/** Test-only/legacy fallback. Production passes AuthStatus.userId explicitly; an
 * unattributed pre-identity store is accepted only through the injected gate. */
export const MOBILE_REPLICA_PRINCIPAL = 'default'

/** Re-exported for the tests and callers that named it here. The TABLE now
 *  lives beside `OutboxKinds` in client-core (POD-316) so the web recovery
 *  surface reads the same one — two copies would drift, and the thing that
 *  drifts is which contract a queued write is replayed under. */
export const MOBILE_OUTBOX_COMMANDS = OUTBOX_COMMANDS

const resolveMobileCommand = (kind: string): OutboxCommand | undefined => outboxCommandFor(kind)

/**
 * WHICH KEYS THE BRIDGE MUST HYDRATE, and why the default is not enough.
 *
 * `createAsyncStorageReplicaStorage` hydrates `podium.replica*` by default, but the
 * PRE-replica standalone outbox blob is `podium.outbox.v1` — outside that prefix. A
 * device that upgraded straight from a build older than the replica collections has
 * its queued work in exactly that key and nowhere else, so hydrating the default
 * prefix alone would make the migration read an empty store and report success.
 */
export const LEGACY_HYDRATE_PREFIXES = [REPLICA_KEY_PREFIX, LEGACY_STANDALONE_OUTBOX_KEY] as const

/**
 * Empty import plan for the entity-cache attribution decision. The decision and
 * the records are two things `decideLegacyAdoption` returns; only the decision
 * applies here. Re-deriving the rule locally would fork a privacy rule.
 */
const EMPTY_ADOPTION_PLAN = {
  verdict: 'import' as const,
  outbox: [],
  retireKeys: [],
  rejected: [],
  cursorDiscarded: false,
}

export interface MobileReplicaDeps {
  /** The SQLite engine. Injected so a test drives a real file-backed database. */
  readonly openDatabase: () => SqlDatabaseLike
  /** Remove the file, so a poisoned or newer-version store cold-starts instead of
   *  wedging boot (ADR 6 D4.5). The adapter makes this REQUIRED for that reason. */
  readonly deleteDatabase: () => void
  /** The hydrated AsyncStorage bridge: the legacy migration's source AND the
   *  side-cache home for ui-state / transcript windows. */
  readonly storage: StorageApi
  /** Hydrated AsyncStorage inventory used for namespace retention/erasure. */
  readonly enumerateKeys?: () => string[]
  /** Await write-behind durability, especially before sign-out reloads. */
  readonly flushStorage?: () => Promise<void>
  readonly principal?: string
  /** WHO THIS DEVICE'S EXISTING QUEUE BELONGS TO — the attribution gate's input.
   *  Injected, never derived here: a gate that supplied its own evidence would be
   *  a gate that always agreed with itself, and a test must be able to present an
   *  unattributable device and observe the REFUSAL. */
  readonly evidence?: LegacyIdentityEvidence
  /**
   * THE v2 CATCH-UP READ (POD-1241). Bound to `sync.feedChangesSince` in the
   * live provider; tests inject a silent authority that delivers nothing so a
   * cold-start paint assertion cannot be rescued by a live feed.
   */
  readonly fetchChangesSince: (cursor: Cursor) => Promise<FeedChangesSinceReplyLenient>
  /** Surfaced, never swallowed (ADR 6 D4.4). */
  readonly onDegraded: (message: string) => void
  readonly now?: () => number
}

export interface MobileReplica {
  /** What the engine reads through — the kernel-backed facade. */
  readonly replica: Replica
  /** Wire-v2 feed sink. Supplied WITH the replica; neither half is meaningful alone. */
  readonly feed: FeedSinkPort
  /** What the migration did — the caller tells the user (D4.4). */
  readonly outcome: LegacyMigrationOutcome
  readonly store: SqliteSyncStore
  readonly principal: string
  /**
   * Call once the engine's hub exists. A re-bootstrap is a reconnect, so
   * `PushedBootstrapSource` needs `hub.requestFreshWorld()`, and the hub is
   * built FROM this assembly — late binding breaks the cycle.
   */
  attachHub(hub: SocketHub): void
  /** Fail-closed sign-out: erase AsyncStorage and SQLite for this principal. */
  erase(): Promise<void>
}

/**
 * Open the durable store, run the attribution gate, assemble the v2 feed path,
 * and return the replica the engine reads through.
 *
 * POD-1220 landed the durable half: SqliteSyncStore, migrateLegacyReplica, and
 * the SQLite outbox binding. This issue (POD-1241) lands the READ half: the
 * kernel Replica, FeedAuthorityClient, FeedSink, and the facade that projects
 * entity rows into the engine's Replica interface.
 *
 * THE HAZARD THIS ASSEMBLY EXISTS TO CLOSE. Before the wire cutover, pointing
 * the facade at a cache whose frames never arrive painted an EMPTY SLICE on
 * every cold start — indistinguishable from a working offline cold start until
 * you have data. The feed sink is therefore required, and the cold-start test
 * proves rows paint from a populated store when the authority delivers nothing.
 */
export async function openMobileReplica(deps: MobileReplicaDeps): Promise<MobileReplica> {
  const principal = deps.principal ?? MOBILE_REPLICA_PRINCIPAL
  const now = deps.now ?? Date.now
  const store = await SqliteSyncStore.open({
    openDatabase: deps.openDatabase,
    deleteDatabase: deps.deleteDatabase,
    // A degraded store still WORKS — the queue runs in memory and forgets on
    // reload — so this is a notice, not a fatal error. Silence is the one option
    // ADR 6 D4.4 rules out.
    onDegraded: (degradation) =>
      deps.onDegraded(
        `Offline changes may not survive a restart on this device (${degradation.cause}).`,
      ),
  })
  const namespace = preparePrincipalNamespace({
    storage: deps.storage,
    enumerateKeys: deps.enumerateKeys ?? (() => []),
    basePrefix: REPLICA_KEY_PREFIX,
    principal,
    now: deps.now,
  })
  if (!namespace.durable) {
    deps.onDegraded('Offline entity storage is unavailable; this session will stay in memory.')
  }
  for (const stalePrincipal of namespace.evictedPrincipals) {
    await store.erasePrincipal(stalePrincipal)
  }
  const view = store.viewFor(principal)
  const attribution: OutboxAttribution = {
    actor: { kind: 'user', userId: principal },
    onBehalfOf: principal,
  }

  // Default evidence is the per-principal namespace ledger assembled above.
  // A caller may inject unknown/foreign evidence to exercise the refusal arm.
  const evidence: LegacyIdentityEvidence =
    deps.evidence ??
    (namespace.durable
      ? {
          kind: 'multi-user',
          signedInAs: principal,
          identitiesEverSignedIn: namespace.knownPrincipals,
        }
      : { kind: 'unknown' })

  // ---- THE ATTRIBUTION GATE, before a single entity row is read ------------
  //
  // Same rule as web's openKernelAssembly: an unattributable store is discarded
  // and re-bootstrapped, never adopted. The outbox migration below is a separate
  // call that parks unattributable queued work; this one governs the entity
  // cache the cold-start paint reads.
  const adoption = decideLegacyAdoption(EMPTY_ADOPTION_PLAN, evidence, now())
  if (!adoption.adopt) {
    view.cache.discardCache()
    deps.onDegraded(`Refreshing from the server after a storage upgrade (${adoption.reason}).`)
  }

  const outcome = await migrateLegacyReplica({
    legacy: deps.storage,
    outbox: view.outbox,
    transact: store.unitOfWork.transact,
    resolveCommand: resolveMobileCommand,
    attribution,
    evidence,
    now,
  })

  const outboxes = await createKernelOutboxStorage({
    outbox: view.outbox,
    resolveCommand: resolveMobileCommand,
    attribution,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  // Side cache: ui-state + transcript windows on the AsyncStorage bridge.
  // Outbox does NOT live here (ADR 6 D1) — it is injected from SQLite below.
  const side = createSideCache({
    storage: deps.storage,
    enumerateKeys: deps.enumerateKeys ?? (() => []),
    keyPrefix: namespace.keyPrefix,
    // Legacy outbox migration already ran above into SQLite; do not also fold
    // a second copy into the side-cache blob store.
    adoptLegacyOutbox: false,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  const facade = createKernelReplica({
    cache: view.cache,
    side,
    outbox: outboxes,
    // POD-1510, same closure-deferred edge as web: the kernel Replica is built
    // below (it needs `facade.onKernelEvent`), so the facade takes its exit
    // record as a function rather than a value. Wired on BOTH platforms
    // deliberately — an exit distinction that existed on web only would make
    // "unshared" render as "deleted" on mobile, which is the defect, not a
    // smaller version of it.
    exits: (entity, entityId) => kernel.exitKind(entity, entityId),
  })

  // ---- WIRE v2 (POD-1241) — the feed that populates entity rows ------------
  let hub: SocketHub | undefined
  let freshWorldPending = false
  const bootstraps = new PushedBootstrapSource({
    requestFreshWorld: () => {
      if (hub === undefined) {
        freshWorldPending = true
        return
      }
      hub.requestFreshWorld()
    },
  })

  const kernel = new KernelReplica({
    store: view.cache,
    authority: new FeedAuthorityClient({
      fetchChangesSince: deps.fetchChangesSince,
      bootstraps,
    }),
    onEvent: (event: ReplicaEvent) => {
      facade.onKernelEvent(event)
    },
  })

  const feed = new FeedSink({ replica: kernel, bootstraps })

  return {
    replica: facade,
    feed,
    outcome,
    store,
    principal,
    attachHub: (attached) => {
      hub = attached
      if (freshWorldPending) {
        freshWorldPending = false
        attached.requestFreshWorld()
      }
    },
    erase: async () => {
      side.dispose()
      namespace.erase()
      await Promise.all([
        store.erasePrincipal(principal),
        deps.flushStorage?.() ?? Promise.resolve(),
      ])
    },
  }
}

export function MobileClientProvider({ children }: { children: ReactNode }) {
  if (demoEnabled()) return <DemoProvider>{children}</DemoProvider>
  return <LiveProvider>{children}</LiveProvider>
}

/**
 * `?demo=1` — the design/screenshot surface, over a REAL store (POD-332).
 *
 * It used to be a second hand-written value object implementing the same 55
 * fields with fixtures and no-ops, which meant the demo surface and the product
 * surface could diverge silently: a screen ported to a slice would render from
 * the slice in production and from the fixture object in demo, and only one of
 * them was ever looked at.
 *
 * Now the fixtures are ROWS. A memory-backed replica is seeded with them and the
 * ordinary `StoreProvider` runs over it, so every screen exercises the same
 * slices, the same derivations and the same store actions it does in the
 * product. What is stubbed is only the network: a tRPC surface that answers the
 * handful of reads the fixture flows make and resolves mutations without
 * changing the world.
 *
 * The boot enrichments (repos, pins, tab orders, superagent threads) fail
 * harmlessly against that stub — the engine already runs every one of them
 * detached and swallowed, because a cold offline boot must keep serving the
 * replica instead of a connection error.
 */
function DemoProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(demoTrpc, [])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  const createReplicaFn = useMemo(() => {
    const replica = createReplica()
    replica.applySnapshot('sessions', DEMO_SESSIONS)
    replica.applySnapshot('issues', DEMO_ISSUES)
    return () => replica
  }, [])
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={() => {}}
      principal={asClientPrincipal(DEMO_PRINCIPAL)}
      createReplicaFn={createReplicaFn}
      routerWindow={routerWindow}
    >
      <MobileShellProvider value={DEMO_SHELL}>{children}</MobileShellProvider>
    </StoreProvider>
  )
}

/** The demo principal. Named rather than borrowed from a real id so nothing in
 *  a demo run can land under a person's namespace. */
const DEMO_PRINCIPAL = 'demo'

const DEMO_SHELL: MobileShell = {
  error: null,
  notice: null,
  eraseLocalData: async () => {},
}

/** The stubbed network for demo mode: the reads the fixture flows make, and
 *  mutations that resolve without changing the fixture so screening and
 *  curation flows stay drivable for design review. */
function demoTrpc(): MobileTrpc {
  const noop = async () => {}
  return {
    superagent: {
      // The screen reads this thread's session transcript, so the demo thread
      // must name a session DEMO_TRANSCRIPTS has rows for (POD-344).
      listThreads: {
        query: async () => [
          { id: 'global', kind: 'global' as const, podiumSessionId: DEMO_SUPER_SESSION },
        ],
      },
      sendTurn: { mutate: async () => ({ threadId: 'global' }) },
      interruptTurn: { mutate: noop },
      clear: { mutate: noop },
    },
    repos: { list: { query: async () => ['/home/dev/src/podium'] } },
    sessions: {
      transcriptRead: {
        query: async ({ sessionId }: { sessionId: SessionId }) => ({
          items: DEMO_TRANSCRIPTS[sessionId] ?? [],
          hasMore: false,
        }),
      },
      sendText: { mutate: noop },
      answerAskUserQuestion: { mutate: noop },
    },
    issues: {
      promote: { mutate: async () => ({}) },
      start: { mutate: async () => ({}) },
      close: { mutate: async () => ({}) },
      update: { mutate: noop },
      addComment: { mutate: noop },
      clearNeedsHuman: { mutate: noop },
      archive: { mutate: noop },
    },
  } as unknown as MobileTrpc
}

/**
 * Attach the engine's hub to the mobile assembly (POD-1241).
 *
 * A re-bootstrap is a reconnect, so `PushedBootstrapSource` needs the hub — and
 * the hub is built by the engine FROM the assembly, so it cannot be handed over
 * at construction. This runs inside the provider, where the hub exists.
 */
function MobileHubAttach({ attachHub }: { attachHub: (hub: SocketHub) => void }): null {
  const { hub } = useStore()
  useEffect(() => {
    attachHub(hub)
  }, [attachHub, hub])
  return null
}

function LiveProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(() => makeMobileTrpc(config.httpOrigin), [config.httpOrigin])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // AsyncStorage is Promise-only; hydrate the side-cache bridge before the store
  // boots. The migration and SQLite open then run BEFORE the store answers a
  // read and the app does not paint until they resolve — a replica read mid-
  // migration would show a slice that is about to be retired.
  const [openedReplica, setOpenedReplica] = useState<MobileReplica | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [bridge, status] = await Promise.all([
        createAsyncStorageReplicaStorage(AsyncStorage, LEGACY_HYDRATE_PREFIXES),
        fetchAuthStatus(config.httpOrigin),
      ])
      if (status.userId === null) throw new Error('authenticated account is unavailable')
      // The live server's v2 catch-up. Typed through the hand-written MobileTrpc
      // surface is deliberately loose: the client is createTRPCClient<any>, and
      // PodiumClientApi still only names the v1 changesSince. Runtime has the
      // real procedure; casting here is the same seam web uses.
      const syncV2 = trpc.sync as typeof trpc.sync & {
        feedChangesSince: {
          query: (input: { cursor: Cursor }) => Promise<FeedChangesSinceReplyLenient>
        }
      }
      const opened = await openMobileReplica({
        openDatabase: () => fromExpoSqlite(SQLite.openDatabaseSync(MOBILE_REPLICA_DB)),
        deleteDatabase: () => SQLite.deleteDatabaseSync(MOBILE_REPLICA_DB),
        storage: bridge.storage,
        enumerateKeys: bridge.keys,
        flushStorage: bridge.flush,
        principal: status.userId,
        fetchChangesSince: async (cursor) => syncV2.feedChangesSince.query({ cursor }),
        onDegraded: setNotice,
      })
      if (!alive) return
      // ADR 6 D4.4 — never silent, in order of how much it costs the user.
      //
      // PARKED and REJECTED are both work that will never be sent, and both are
      // reported: parked entries lost the attribution question, rejected ones never
      // reached it (undecodable, or naming a command no contract in
      // MOBILE_OUTBOX_COMMANDS resolves). Reporting only the first would leave a
      // whole class of lost writes announced nowhere, which is the posture D4.4
      // rules out — and `rejected` is the class a stale contract table produces, so
      // it is exactly the one a silent path would hide from the person who could
      // fix it. A discarded cursor is milder: one re-bootstrap, visible as a slow
      // first paint, so it only speaks when nothing louder has.
      const lost = opened.outcome.parked + opened.outcome.rejected.length
      if (lost > 0) {
        setNotice(
          `${lost} queued change(s) from an earlier session could not be carried over and were not sent.`,
        )
      } else if (opened.outcome.cursorDiscarded) {
        setNotice('Refreshing from the server after a storage upgrade.')
      }
      setOpenedReplica(opened)
    })()
    return () => {
      alive = false
    }
  }, [config.httpOrigin, trpc])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  // `info` stays a no-op: the engine's only info is a transient "a session moved
  // to X" toast, and `notice` below is a STICKY banner for the storage facts the
  // user is owed. Routing the toast into it would leave a stale line on screen.
  const notices = useMemo<StoreNotices>(
    () => ({ error: (message) => setError(message), info: () => {} }),
    [],
  )
  // The three composition-root facts no store snapshot can answer. Memoized on
  // the values themselves so a shell consumer re-renders when one MOVES and not
  // when the provider re-renders for another reason (see ./shell).
  const erase = openedReplica?.erase
  const shell = useMemo<MobileShell>(
    () => ({ error, notice, eraseLocalData: erase ?? (async () => {}) }),
    [error, notice, erase],
  )
  if (!openedReplica) return <BootSplash />
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={setError}
      notices={notices}
      // The principal the auth status named, and the store opened for exactly
      // it. The factory REFUSES any other principal rather than handing back
      // the store it happens to hold: on a shared device that would give one
      // account another's slice and cursor (POD-404).
      principal={asClientPrincipal(openedReplica.principal)}
      createReplicaFn={(principal) => {
        if (principal.userId !== openedReplica.principal) {
          throw new Error(
            `mobile replica belongs to a different principal (opened for ${openedReplica.principal})`,
          )
        }
        return openedReplica.replica
      }}
      // Wire v2 advertisement + frame sink (POD-1241). Providing this is how
      // the hub sends wireVersion and receives feedDelta/feedBootstrap/…
      feed={openedReplica.feed}
      routerWindow={routerWindow}
    >
      <MobileHubAttach attachHub={openedReplica.attachHub} />
      <MobileShellProvider value={shell}>{children}</MobileShellProvider>
    </StoreProvider>
  )
}
