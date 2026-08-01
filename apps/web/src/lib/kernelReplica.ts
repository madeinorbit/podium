/**
 * THE WEB COMPOSITION ROOT FOR THE KERNEL REPLICA (POD-1223).
 *
 * POD-376 shipped every piece of this and wired none of them into the app: the
 * frame consumer, the wire mapping, the push/pull bootstrap seam, the client
 * authority port, the IndexedDB adapter and the mode resolver all exist and are
 * verified against a live server in `tests/e2e/feed-v2.e2e.test.ts`. What was
 * missing was the last hop — the object the engine actually reads through. This
 * module assembles the pieces and hands the engine its two ends:
 *
 *   `createReplicaFn`  the kernel-backed `Replica` facade (the read model)
 *   `feed`             the `FeedSinkPort` the hub pushes v2 frames into
 *
 * WHY IT IS ASYNC AND WHY THE STORE WAITS ON IT. `IndexedDbSyncStore.open` is a
 * database open, and the engine reads rows synchronously at construction. A
 * store mounted before the open resolved would paint a cold slice and then jump
 * — losing exactly the cold-start paint the acceptance list protects. The
 * desktop SQLite replica already gates its mount the same way for the same
 * reason (`useDesktopReplica`); this follows that precedent rather than inventing
 * a second one.
 *
 * WHY THE HUB IS ATTACHED AFTERWARDS. A re-bootstrap is a RECONNECT — the server
 * pushes worlds and cannot be asked for one — so `PushedBootstrapSource` needs
 * `hub.requestFreshWorld()`, and the hub does not exist until the engine builds
 * it FROM this assembly. The cycle is broken with a late binding plus a pending
 * flag: a request that arrives before the hub is attached is remembered and
 * replayed on attach, because dropping it would strand the replica in
 * `bootstrapping` with nothing coming.
 */

import {
  type Replica as ClientReplica,
  createKernelReplica,
  createSideCache,
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
  type ReplicaMode,
  resolveReplicaMode,
} from '@podium/client-core/replica'
import type { FeedSinkPort, SocketHub } from '@podium/client-core/transport'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import {
  decideLegacyAdoption,
  type LegacyIdentityEvidence,
} from '@podium/sync/adapters/legacy-replica'
import { Replica as KernelReplica, type ReplicaEvent } from '@podium/sync/replica'
import type { Trpc } from '@/app/trpc'

/** The IndexedDB database the web client's kernel replica lives in. */
export const KERNEL_REPLICA_DB = 'podium-kernel-replica'

/**
 * The principal this client's slice is stored under.
 *
 * `CLIENT_PRINCIPAL_GRADE` is still `device` (one shared password — see the
 * shadow-comparison basis §5), so there is exactly one principal a browser can
 * name and it is this constant. It is NOT a placeholder to be filled in with a
 * user id later without thought: when per-user login lands, an existing store
 * keyed `default` holds rows captured before anyone could be attributed, and
 * POD-377's rule applies — adopt only when attribution is CERTAIN.
 */
export const KERNEL_REPLICA_PRINCIPAL = 'default'

export interface KernelAssembly {
  /** Handed to the engine; called once. */
  readonly createReplicaFn: () => ClientReplica
  /** Handed to the engine; makes its hub advertise wire 2. */
  readonly feed: FeedSinkPort
  /** The kernel Replica itself — the shadow harness classifies against it. */
  readonly kernel: KernelReplica
  readonly store: IndexedDbSyncStore
  /** Call once the engine's hub exists. Idempotent. */
  attachHub(hub: SocketHub): void
  /** Additional kernel-event listener (the shadow harness takes one). */
  onKernelEvent(listener: (event: ReplicaEvent) => void): () => void
  dispose(): Promise<void>
}

export interface OpenKernelAssemblyOptions {
  readonly trpc: Trpc
  readonly databaseName?: string
  readonly principal?: string
  /** Injected by tests (fake-indexeddb); defaults to the browser's. */
  readonly factory?: IdbFactoryLike
  /** Surfaced rather than swallowed (ADR 6 D4). */
  readonly onDegraded?: (detail: unknown) => void
  /**
   * WHO THIS DEVICE'S EXISTING STORE BELONGS TO — the attribution gate's input.
   *
   * POD-377 built `decideLegacyAdoption` and POD-378 verified it; nothing on
   * either client ever called it (POD-1239). A gate with no caller is
   * indistinguishable from an enforced one in every handoff that cites it, and
   * this one guards a privacy rule: POD-307 says an unattributable store is
   * DISCARDED and re-bootstrapped, never adopted, because on a shared device
   * adoption is how one person's cached rows become another person's history.
   *
   * The DEFAULT is `single-account`, and that is a claim about this tree rather
   * than a convenience: `CLIENT_PRINCIPAL_GRADE` is still `device` — one shared
   * password, `client_sessions` has no user column — so no user identities exist
   * in the system at all and the store can only be the one operator's. That is
   * the arm's definition verbatim.
   *
   * IT IS INJECTED, NOT HARDCODED, for two reasons. When per-user login lands,
   * this becomes `multi-user` with the device's identity ledger and the default
   * stops being true — a hardcoded arm would keep silently adopting. And a test
   * can present `unknown` or a foreign ledger and observe the REFUSAL, which is
   * the only way to know the gate can say no.
   */
  readonly evidence?: LegacyIdentityEvidence
}

export async function openKernelAssembly(
  options: OpenKernelAssemblyOptions,
): Promise<KernelAssembly> {
  const { trpc } = options
  const store = await IndexedDbSyncStore.open({
    factory: options.factory ?? (globalThis.indexedDB as unknown as IdbFactoryLike),
    databaseName: options.databaseName ?? KERNEL_REPLICA_DB,
    onDegraded: (detail: unknown) => {
      // Degradation is a real state, not an error: the replica keeps working in
      // memory and `persistent` goes false, which the UI can surface.
      options.onDegraded?.(detail)
      console.warn('[podium] kernel replica storage degraded', detail)
    },
  })
  const view = store.viewFor(options.principal ?? KERNEL_REPLICA_PRINCIPAL)

  // ---- THE ATTRIBUTION GATE, before a single row is read ------------------
  //
  // `decideLegacyAdoption` is called with an EMPTY plan on purpose: the decision
  // and the records are two things it returns, and only the decision applies
  // here. Re-deriving the rule locally would fork it, and a second copy of a
  // privacy rule is worse than an off-label call to the first.
  const evidence: LegacyIdentityEvidence = options.evidence ?? {
    kind: 'single-account',
    principal: options.principal ?? KERNEL_REPLICA_PRINCIPAL,
  }
  const adoption = decideLegacyAdoption(
    { verdict: 'import', outbox: [], retireKeys: [], rejected: [], cursorDiscarded: false },
    evidence,
    Date.now(),
  )
  if (!adoption.adopt) {
    // FAIL CLOSED. The cache is re-derivable at will, so discarding costs one
    // bootstrap; adopting rows that may be someone else's costs the property the
    // whole privacy model rests on. `discardCache()` structurally cannot reach
    // the outbox (ADR 2 D7), so the user's unsent work survives this.
    view.cache.discardCache()
    console.warn(
      `[podium] kernel replica store not adopted (${adoption.reason}) — discarded and re-bootstrapping`,
    )
    options.onDegraded?.({ kind: 'store-not-adopted', reason: adoption.reason })
  }

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

  const listeners = new Set<(event: ReplicaEvent) => void>()
  const facade = createKernelReplica({
    cache: view.cache,
    side: createSideCache({
      storage: globalThis.localStorage,
      storageEventApi: globalThis.window,
      // The same verdict governs the legacy QUEUE: an unattributable device's
      // unsent writes are not this user's to replay.
      adoptLegacyOutbox: adoption.adopt,
    }),
  })

  const kernel = new KernelReplica({
    store: view.cache,
    authority: new FeedAuthorityClient({
      fetchChangesSince: async (cursor) =>
        (await trpc.sync.feedChangesSince.query({ cursor })) as never,
      bootstraps,
    }),
    onEvent: (event) => {
      // ONE callback, fanned out here. The facade needs it to move the read
      // model; the shadow harness needs it to know when a comparison is worth
      // sampling. Whoever grabbed `onEvent` for itself would have taken it from
      // the other.
      facade.onKernelEvent(event)
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // an observer must not break the replica's own application
        }
      }
    },
  })

  const sink = new FeedSink({ replica: kernel, bootstraps })

  return {
    createReplicaFn: () => facade,
    feed: sink,
    kernel,
    store,
    attachHub: (attached) => {
      hub = attached
      if (freshWorldPending) {
        freshWorldPending = false
        attached.requestFreshWorld()
      }
    },
    onKernelEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: async () => {
      await store.settled()
      store.close()
    },
  }
}

/** `/version` → the scoping grade the mode resolver needs. Never throws: an
 *  unreachable probe is an unknown grade, which the resolver treats as
 *  `device-unscoped` with the reasoning written down in `mode.ts`. */
export async function fetchFeedScoping(httpOrigin: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${httpOrigin}/version`)
    if (!res.ok) return undefined
    const body = (await res.json()) as { feedScoping?: unknown }
    return typeof body.feedScoping === 'string' ? body.feedScoping : undefined
  } catch {
    return undefined
  }
}

/**
 * The resolved read path for this client. Pure resolution lives in
 * `resolveReplicaMode`; this only gathers its three inputs.
 */
export interface ResolvedWebReplicaMode {
  readonly mode: ReplicaMode
  /** The grade `/version` advertised, carried out so the shadow harness can be
   *  TOLD whether the authority is scoped instead of inferring it from data. */
  readonly serverGrade: string | undefined
}

export async function resolveWebReplicaMode(args: {
  httpOrigin: string
  trpc: Trpc
}): Promise<ResolvedWebReplicaMode> {
  const [flags, serverGrade] = await Promise.all([
    // An unreachable features query is FLAGS OFF, which resolves to the shipped
    // legacy path — the same posture `useFeature` takes on a failed first load.
    args.trpc.features.state.query().catch(() => null),
    fetchFeedScoping(args.httpOrigin),
  ])
  const enabledFlag = (id: string): boolean =>
    flags?.flags.find((f) => f.id === id)?.enabled ?? false
  return {
    mode: resolveReplicaMode({
      kernelReplicaEnabled: enabledFlag('kernel-replica'),
      shadowEnabled: enabledFlag('kernel-replica-shadow'),
      serverGrade,
    }),
    serverGrade,
  }
}
