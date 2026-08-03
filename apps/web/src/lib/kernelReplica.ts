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
  type CreateEngineOutbox,
  type CreateReplicaForPrincipal,
  openKernelEngineOutbox,
  outboxCommandFor,
} from '@podium/client-core/engine'
import { asClientPrincipal, type ClientPrincipal } from '@podium/client-core/principal'
import {
  type Replica as ClientReplica,
  createKernelReplica,
  createSideCache,
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
  preparePrincipalNamespace,
  type ReplicaMode,
  resolveReplicaMode,
} from '@podium/client-core/replica'
import type { FeedSinkPort, SocketHub } from '@podium/client-core/socket-transport'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import {
  decideLegacyAdoption,
  LEGACY_OUTBOX_AWAITING_KEY,
  LEGACY_OUTBOX_KEY,
  LEGACY_QUARANTINE_SUFFIX,
  type LegacyIdentityEvidence,
  type LegacyKeyValueStore,
  type LegacyMigrationOutcome,
  migrateLegacyReplica,
} from '@podium/sync/adapters/legacy-replica'
import type { OutboxAttribution } from '@podium/sync/outbox'
import { Replica as KernelReplica, type ReplicaEvent } from '@podium/sync/replica'
import type { Trpc } from '@/app/trpc'

/** The IndexedDB database the web client's kernel replica lives in. */
export const KERNEL_REPLICA_DB = 'podium-kernel-replica'
/** Root below which every localStorage side-cache key is principal-bound. */
export const KERNEL_SIDE_CACHE_PREFIX = 'podium.kernel-replica'

/** The caller supplies the authenticated principal. Every cache and side-cache
 * address below is bound to it before the first row is read. */

export interface KernelAssembly {
  /** WHOSE ASSEMBLY THIS IS. The whole thing — IndexedDB region, side cache,
   *  outbox, cursor — was opened for exactly this principal and can serve no
   *  other (POD-404). */
  readonly principal: ClientPrincipal
  /**
   * Handed to the provider; called once, WITH the principal it is building for.
   *
   * It refuses rather than answers when that principal is not the one this
   * assembly was opened for. A silent answer would hand one person's slice and
   * cursor to another — the exact cross-principal adoption the namespace exists
   * to prevent — and the failure would be invisible, because a wrong slice
   * renders like a slice.
   */
  readonly createReplicaFn: CreateReplicaForPrincipal
  /** Handed to the engine; makes its hub advertise wire 2. */
  readonly feed: FeedSinkPort
  /** Real kernel Outbox over this assembly's IndexedDB store. */
  readonly createOutboxFn: CreateEngineOutbox
  /** The kernel Replica itself — the shadow harness classifies against it. */
  readonly kernel: KernelReplica
  readonly store: IndexedDbSyncStore
  /** Call once the engine's hub exists. Idempotent. */
  attachHub(hub: SocketHub): void
  /** Additional kernel-event listener (the shadow harness takes one). */
  onKernelEvent(listener: (event: ReplicaEvent) => void): () => void
  /** Fail-closed sign-out: erase this principal's IDB and side-cache namespace. */
  erasePrincipalData(): Promise<void>
  dispose(): Promise<void>
}

export interface OpenKernelAssemblyOptions {
  readonly trpc: Trpc
  readonly databaseName?: string
  readonly principal: string
  /** Injected by tests (fake-indexeddb); defaults to the browser's. */
  readonly factory?: IdbFactoryLike
  /** Surfaced rather than swallowed (ADR 6 D4). */
  readonly onDegraded?: (detail: unknown) => void
  /** Identity evidence for the pre-namespace legacy-adoption gate. The web boot
   * root derives multi-user evidence from existing principal namespace markers;
   * tests can inject unknown/foreign evidence to exercise fail-closed refusal. */
  readonly evidence: LegacyIdentityEvidence
}

/** What the app is owed about a migration that ran — see `summarizeMigrations`. */
export interface WebOutboxMigrationSummary {
  readonly adopted: number
  readonly parked: number
  readonly quarantined: readonly string[]
  readonly rejected: number
  /** Absent when nothing happened; a sentence for the user when it did. */
  readonly notice?: string
}

/**
 * The two migration passes, as ONE thing to tell the user.
 *
 * ADR 6 D4.4's posture is that a degradation is explained, never silent, and
 * "some of your unsent work could not be carried across" is the sharpest form of
 * that. The three outcomes read differently on purpose: adopted work is now
 * drainable and needs no sentence of its own beyond the count; PARKED work is
 * visible in the dead-letter recovery surface; QUARANTINED work is neither — it
 * is on disk under `<key>.unmigrated` and no build reads it, so the sentence has
 * to say that rather than imply a queue will get to it.
 */
export function summarizeMigrations(
  outcomes: readonly LegacyMigrationOutcome[],
): WebOutboxMigrationSummary {
  const adopted = outcomes.reduce((n, o) => n + o.adopted, 0)
  const parked = outcomes.reduce((n, o) => n + o.parked, 0)
  const rejected = outcomes.reduce((n, o) => n + o.rejected.length, 0)
  const quarantined = outcomes.flatMap((o) => [...o.quarantined])
  const parts: string[] = []
  if (adopted > 0) parts.push(`${adopted} queued ${plural(adopted)} moved to secure storage`)
  if (parked > 0)
    parts.push(
      `${parked} could not be attributed to this account and ${wasWere(parked)} parked for review`,
    )
  if (rejected > 0) {
    parts.push(
      `${rejected} could not be matched to a known action and ${wasWere(rejected)} kept on this device unsent`,
    )
  }
  return {
    adopted,
    parked,
    rejected,
    quarantined,
    ...(parts.length === 0 ? {} : { notice: `${parts.join('; ')}.` }),
  }
}

const plural = (n: number): string => (n === 1 ? 'change' : 'changes')
const wasWere = (n: number): string => (n === 1 ? 'was' : 'were')

/**
 * The side-cache queue keys, presented UNDER THE LEGACY NAMES the importer scans.
 *
 * A shipped kernel build folded the pre-kernel localStorage queue into
 * `<principal-prefix>.outbox.v1` and `.outbox-awaiting.v1` — the same blob shape
 * (a JSON array of entries), a different address. Rather than teach the importer a
 * second key inventory, the addresses are translated here: the importer keeps ONE
 * key set, and the sequencing rule it enforces (retire only after a durable commit)
 * applies to these keys unchanged, because they are retired through this same map.
 *
 * Keys it does not translate read as ABSENT, deliberately: this pass must not see
 * entity rows, a cursor or the standalone pre-replica blob — the raw pass already
 * owns those, and a second importer touching them would retire keys whose entries
 * the first one is responsible for.
 */
export function sideCacheQueueAsLegacy(storage: Storage, keyPrefix: string): LegacyKeyValueStore {
  const map = new Map<string, string>([
    [LEGACY_OUTBOX_KEY, `${keyPrefix}.outbox.v1`],
    [LEGACY_OUTBOX_AWAITING_KEY, `${keyPrefix}.outbox-awaiting.v1`],
  ])
  /** Quarantine writes land beside the key they preserve, on the side-cache
   *  address — otherwise the copy would be written to a legacy name that this
   *  device may not even have, and the evidence would be filed under someone
   *  else's key. */
  const translate = (key: string): string | undefined => {
    const direct = map.get(key)
    if (direct !== undefined) return direct
    if (!key.endsWith(LEGACY_QUARANTINE_SUFFIX)) return undefined
    const base = map.get(key.slice(0, -LEGACY_QUARANTINE_SUFFIX.length))
    return base === undefined ? undefined : `${base}${LEGACY_QUARANTINE_SUFFIX}`
  }
  return {
    getItem: (key) => {
      const at = translate(key)
      if (at === undefined) return null
      try {
        return storage.getItem(at)
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      const at = translate(key)
      // A write with nowhere to go must THROW, not succeed silently: the caller
      // treats a failed quarantine as "leave the original in place", and a
      // no-op that reported success would delete it.
      if (at === undefined) throw new Error(`no side-cache address for ${key}`)
      storage.setItem(at, value)
    },
    removeItem: (key) => {
      const at = translate(key)
      if (at === undefined) return
      storage.removeItem(at)
    },
  }
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
  const enumerateLocalKeys = (): string[] => Object.keys(globalThis.localStorage)
  const namespace = preparePrincipalNamespace({
    storage: globalThis.localStorage,
    enumerateKeys: enumerateLocalKeys,
    basePrefix: KERNEL_SIDE_CACHE_PREFIX,
    principal: options.principal,
  })
  if (!namespace.durable) {
    store.close()
    throw new Error('principal namespace marker is unavailable')
  }
  // Apply the same bounded-retention decision to transactional regions before
  // the acting slice is read.
  for (const stalePrincipal of namespace.evictedPrincipals) {
    await store.erasePrincipal(stalePrincipal)
  }
  // Identity evidence now lives in per-principal namespace markers. Retire the
  // old raw ledger; theme is the sole raw pre-auth exception.
  globalThis.localStorage.removeItem('podium-kernel-identity-ledger')
  const view = store.viewFor(options.principal)

  // ---- THE ATTRIBUTION GATE, before a single row is read ------------------
  //
  // `decideLegacyAdoption` is called with an EMPTY plan on purpose: the decision
  // and the records are two things it returns, and only the decision applies
  // here. Re-deriving the rule locally would fork it, and a second copy of a
  // privacy rule is worse than an off-label call to the first.
  const evidence: LegacyIdentityEvidence = options.evidence
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

  // ---- THE QUEUED WRITES ALREADY ON THIS DISK (POD-1232) ------------------
  //
  // The engine's outbox is the kernel one, over `view.outbox`, in the same
  // IndexedDB transaction domain as the entity rows (ADR 6 D4.3). Everything a
  // user queues from here on lands there. What did NOT was everything already
  // queued: a build before this one wrote its queue to localStorage, and the
  // side cache's own fold only moved those blobs to ANOTHER localStorage key —
  // one the kernel Outbox never reads. A rename made on a train, by a user who
  // then updated, was still on the disk and drained by nobody.
  //
  // So the ADR 6 D6 migration runs here, exactly as mobile runs it, and the side
  // cache's fold is switched OFF below: two things folding one queue in
  // different directions is how a duplicate becomes a re-send.
  //
  // TWO SOURCES, because there are two places the entries can be. The raw legacy
  // keys are the pre-kernel build's; the side-cache namespace holds whatever an
  // ALREADY-SHIPPED kernel build folded there before this fix existed, and those
  // are the entries most likely to still exist, because that build is the one
  // people are running.
  const attribution: OutboxAttribution = {
    // ADR 3 D7: identity from the authenticated transport, never a frame payload.
    // `options.principal` is the boot gate's `/auth/status` answer (offline: a
    // single durable namespace marker, ambiguity failing closed) — it is not
    // asserted by anything the queue itself carries. A legacy entry carries NO
    // identity at all, which is why this pair is stamped by the importer from the
    // authenticated principal rather than read out of the blob.
    actor: { kind: 'user', userId: options.principal },
    onBehalfOf: options.principal,
  }
  const migrations: LegacyMigrationOutcome[] = []
  for (const legacy of [
    globalThis.localStorage as unknown as LegacyKeyValueStore,
    sideCacheQueueAsLegacy(globalThis.localStorage, namespace.keyPrefix),
  ]) {
    migrations.push(
      await migrateLegacyReplica({
        legacy,
        outbox: view.outbox,
        transact: store.unitOfWork.transact,
        // The contract table, never a guess (ADR 3 D9). A kind it does not know
        // is REJECTED and its blob quarantined, not replayed under a made-up
        // version — see `migrateLegacyReplica`'s header.
        resolveCommand: outboxCommandFor,
        attribution,
        evidence,
        now: Date.now,
      }),
    )
  }
  const migration = summarizeMigrations(migrations)
  if (migration.notice !== undefined) {
    console.warn('[podium] legacy queued writes migrated', migration)
    options.onDegraded?.({ kind: 'legacy-outbox-migrated', ...migration })
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
  const createOutboxFn = await openKernelEngineOutbox({
    store: view.outbox,
    principal: options.principal,
    api: trpc,
    onDegraded: (detail) => options.onDegraded?.(detail),
  })
  const side = createSideCache({
    storage: globalThis.localStorage,
    storageEventApi: globalThis.window,
    enumerateKeys: enumerateLocalKeys,
    keyPrefix: namespace.keyPrefix,
    // OFF (POD-1232). The queue's home is the kernel store now, and the fold
    // above already carried every legacy blob into it — including the one this
    // flag used to write. Leaving it on would re-fold entries the migration has
    // retired, into a key nothing drains, and the attribution verdict it used to
    // carry is applied where it belongs: `migrateLegacyReplica` takes the same
    // `evidence` and parks an unattributable device's work as dead letters
    // rather than adopting it.
    adoptLegacyOutbox: false,
    // ADR 6 D4.4 clause 3 (POD-1231). Mobile passed this from the start; web did
    // not, so a denied outbox write threw and logged and then died at the seam
    // with nothing above it any the wiser. The legacy-queue fold at construction
    // writes through this same guard, which is the one outbox write on web that
    // happens before anything else could report it.
    onDegraded: (error) => options.onDegraded?.(error),
  })
  const facade = createKernelReplica({
    cache: view.cache,
    side,
    // POD-1510: the read model's answer to "was this row DELETED or did it leave
    // MY view?". Deferred through a closure because the kernel Replica is
    // constructed below — it needs `facade.onKernelEvent`, and the facade needs
    // its exit record, so one of the two edges has to be lazy. Nothing calls
    // this before the assembly returns.
    exits: (entity, entityId) => kernel.exitKind(entity, entityId),
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
    principal: asClientPrincipal(options.principal),
    createReplicaFn: (principal: ClientPrincipal) => {
      if (principal.userId !== options.principal) {
        throw new Error(
          `kernel replica assembly belongs to a different principal (opened for ${options.principal}); ` +
            'a new principal needs a new assembly, never this one',
        )
      }
      return facade
    },
    feed: sink,
    createOutboxFn,
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
    erasePrincipalData: async () => {
      side.dispose()
      namespace.erase()
      await store.erasePrincipal(options.principal)
    },
    dispose: async () => {
      side.dispose()
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
      kernelReplicaEnabled: true,
      shadowEnabled: enabledFlag('kernel-replica-shadow'),
      serverGrade,
    }),
    serverGrade,
  }
}
