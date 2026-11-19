/**
 * The Replica role of the sync kernel — a pure state machine over injected ports
 * (ADR 2 as amended by ADR 2 Amendment 1; storage port per ADR 6 D3).
 *
 * DELTA-FIRST. Steady state is "apply certified frames in seq order". Bootstrap is
 * the RECOVERY case that every rung of the D7 ladder terminates at (ADR 2 D6/D7) —
 * which is exactly what keeps it the most-exercised path in the system rather than
 * a rarely-tested emergency one.
 *
 * THE INVARIANT THIS COMPONENT EXISTS TO HOLD: **a replica never arbitrates.**
 * It applies an ordering somebody else decided. Concretely, in this file:
 *  - `revision` is stored and echoed, never compared to decide a winner. Feed order
 *    is the only order. A same-revision upsert is APPLIED, not dropped — that is
 *    literally the re-admission path (Amendment 1 D14.2), and a "skip duplicate
 *    revisions" optimisation would silently break re-sharing.
 *  - No id is ever invented here. No local guess is promoted to fact.
 *  - **No visibility is ever evaluated.** There is no principal, grant or owner in
 *    this file. `evict` is applied because the Authority said so; the Replica never
 *    computes who may see what, never filters its own view, and never infers a
 *    share (Amendment 1 D12.7). If this file ever needs to ask "may this principal
 *    see X", the design has drifted.
 *
 * D13 IS FOLLOWED LITERALLY: accept iff `fromSeq === cursor`, otherwise rung 1.
 * An earlier revision of this file also absorbed re-delivered and partially
 * overlapping frames through two locally-derived transitions. Removed after
 * review: D13.1 normatively guarantees frames for one connection are contiguous
 * and non-overlapping, so those are protocol violations rather than cases to
 * tolerate, and tolerating them made the acceptance rule WEAKER than the one the
 * amendment strengthened. On a contract shared with POD-1077 and POD-308, a
 * locally documented fork is not good enough.
 *
 * ORDER IS THE CORRECTNESS PROPERTY, including inside one frame. Changes go to
 * the store as ONE ordered operation list (see `CacheOperation`), never grouped
 * by op kind — grouping applied every upsert before every removal, so
 * `remove(seq 1)` then `upsert(seq 2)` for one entity left the entity absent.
 */

import { COLLECTIONS, RECORDS } from '@podium/model'
import { instanceKey, rowAfter } from './cache-state'
import {
  AnswerMembers,
  comesWithHolderKey,
  comesWithHolderOf,
  comesWithHolders,
  loadInstancesFromDisk,
  pointerTargetOf,
  type ResidentLoadPort,
  rowKeyOf,
  splitRowKey,
} from './disk-index'
import {
  comesWithOf,
  HeldIndex,
  type HeldRows,
  planTrim,
  policyArgs,
  policyInstances,
  resolveInstance,
  stubFieldsOf,
  stubOfValue,
} from './holdings'
import type { OptimisticOverlayPort, RetirementEvidence, RetirementIntent } from './overlay'
import { computeOverlay, type OverlayRow } from './overlay-projection'
import {
  type AuthorityReadPort,
  type CacheMutation,
  type CacheOperation,
  type ComesWithOperation,
  type InstanceOperation,
  type KnownKindValidatorPort,
  type ReplicaParticipantStore,
  ReplicaStoreCorruptError,
  type SyncSpan,
  type SyncUnitOfWork,
} from './ports'
import { transitionRow } from './transition-table'
import {
  type BootstrapChunk,
  type ChangeEnvelope,
  type Cursor,
  type DeltaFrame,
  type DeviceCollectionReads,
  type EntityRecord,
  type ExitKind,
  type HealRung,
  type InstanceRecord,
  type InstanceRequest,
  type InstanceSpec,
  type KindTokens,
  type Posture,
  type RebootstrapCause,
  type ReplicaEvent,
  type ReplicaStats,
  rowAsOf,
  type ServerFrame,
  type StubRow,
} from './types'

export interface ReplicaOptions {
  /**
   * The cache port, NARROWED: no `beginSpan` (POD-1158). The Replica participates in
   * a transaction; it never opens or settles one.
   */
  readonly store: ReplicaParticipantStore
  readonly authority: AuthorityReadPort
  /** Optional until POD-372/POD-351 land real reducers. Absent ⇒ the view is the base. */
  readonly overlay?: OptimisticOverlayPort
  /**
   * ADR 2 D10's transaction boundary, owned by whoever COMPOSES the hop (POD-1158).
   *
   * REQUIRED whenever `overlay` is supplied, and refused at construction otherwise.
   * That pairing is the whole guard: an overlay means retirements can arrive, a
   * retirement plus a cache write is a MULTI-REGION commit, and a multi-region commit
   * with no unit of work is precisely the D10 non-compliance. Making it a constructor
   * error rather than a per-commit fallback means the non-compliant configuration
   * cannot be reached silently — it cannot be reached at all.
   *
   * The Replica only ever sees the `SyncSpan` this hands to `transact`'s body, so it
   * gains no way to commit or abort. The asynchrony a durable store needs lives in
   * that body, which is where ADR 2 always allowed it, while every hook registered
   * inside stays synchronous — the IndexedDB auto-close rule is untouched.
   */
  readonly unitOfWork?: SyncUnitOfWork
  /**
   * ADR 2 D7 rung 3's known-kind check. Absent ⇒ no kind is known ⇒ everything is
   * parsed leniently (D4), which is the correct posture for a kernel that has not
   * been told any schemas. POD-308/POD-351 supply the real one.
   */
  readonly validator?: KnownKindValidatorPort
  readonly onEvent?: (event: ReplicaEvent) => void
  /**
   * Wraps every post-commit emission burst — one applied frame's events, or one
   * bootstrap install's whole replay — in a single call.
   *
   * `emitApplied` emits one event per change plus a cursor, and an install emits
   * one `upserted` per row of the ENTIRE slice; a consumer that derives its view
   * per event therefore pays its full derivation once per row, which is what made
   * a rebootstrap on a large store effectively never finish. This seam lets that
   * consumer treat the burst as one unit — the client facade passes its own
   * `batch()`, so one applied frame drains its listeners once. Pass-through by
   * default. The wrapper MUST be synchronous and MUST call `emitAll` exactly
   * once: on the multi-region path it runs inside `span.onCommit`, where an
   * await would break the IndexedDB auto-close rule (see `unitOfWork`), and a
   * wrapper that skipped `emitAll` would swallow the frame's public projection
   * along with the cursor advance it reports.
   */
  readonly batchEvents?: (emitAll: () => void) => void
  /**
   * ADR 2 D6.5 — a failed bootstrap RESTARTS. Since POD-7086 a restart keeps
   * what it installed: each collection is written in chunks with its marker
   * last, so the next attempt loads only the collections without a marker.
   */
  readonly maxBootstrapAttempts?: number
  /** The clock collection rules compare "newer than N days" against. */
  readonly now?: () => number
  /**
   * What the visible view asks for when a full load starts (the loader's,
   * POD-7087): the first download's second step, design "One loader, one
   * route". Read once per attempt.
   */
  readonly view?: () => readonly InstanceRequest[]
  /**
   * Where the instances held records come with are asked for, outside a
   * load: the loader's queue (POD-7087), so they share its window and its
   * offline rule. Absent, the Replica batches them itself per microtask.
   */
  readonly request?: (specs: readonly InstanceSpec[]) => void
}

/** Most instances one fetch names; the route's own bound. */
const FETCH_MAX_INSTANCES = 200

/**
 * POD-7122 — the most rows (records, stubs and markers) a load installs in
 * one store write. Chunks that arrive in a row are installed together, up to
 * this, so the first download is a few native transactions instead of one per
 * chunk; each transaction costs more than its rows (IndexedDB, and an fsync
 * per SQLite commit on a phone). A load that closes early keeps every batch it
 * installed.
 */
const INSTALL_BATCH_ROWS = 4096

/**
 * POD-7165 — the automatic cache trim waits until no fetch has run for this
 * long. A trim reads every row and instance on the device; a view that opens
 * fetches in waves (a tree, what it comes with, a parent at a time), and a
 * trim after each wave cost more than the wave. The cap is a target, not a
 * wall: the cache may stand above it for the length of a burst of fetches.
 */
const TRIM_QUIET_MS = 1_000

/**
 * POD-7159 — the most rows a disk load puts in memory in one burst: one
 * store step, one burst of events and so one reader notification per chunk
 * (the install-cost rule, POD-7165), each in a task of its own.
 */
export const DISK_INSTALL_ROWS = 250

/** What `arrivedBy` answers for a step that has not arrived by the next task. */
const NOT_YET: unique symbol = Symbol('not yet')

/**
 * The next task, after every microtask queued now: what is already buffered
 * (a stream's chunk the reader holds) resolves before it, network I/O does not.
 */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    // A message, not a timer: fake timers in tests leave it alone, and a
    // browser does not clamp it.
    if (typeof MessageChannel === 'function') {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
    } else if (typeof setImmediate === 'function') setImmediate(resolve)
    else setTimeout(resolve, 0)
  })

/** `step` if it has arrived by the next task, else `NOT_YET` (the step stays pending). */
async function arrivedBy<T>(step: Promise<T>): Promise<T | typeof NOT_YET> {
  return await Promise.race([step, nextTask().then((): typeof NOT_YET => NOT_YET)])
}

const rowsOfChunk = (chunk: BootstrapChunk): number =>
  chunk.changes.length + (chunk.stubs?.length ?? 0) + (chunk.complete?.length ?? 0)

/**
 * The chunk completes an instance the load asked for itself (a policy
 * collection or a view's), not one its records come with (`via`). A batch
 * ends there: each such marker is installed as it arrives, in the answer's
 * order (stub level, then full records, then the sidebar…, design POD-7059),
 * and there are only a handful of them per load.
 */
const closesRequestedInstance = (chunk: BootstrapChunk): boolean =>
  chunk.complete?.some((marker) => marker.via === undefined) === true

/**
 * Chunks of one answer as one: their records, stubs and markers in arrival
 * order (each part after the same part of the chunks before it, so a marker
 * still follows its records), the policy of the first that has one.
 */
function mergeChunks(chunks: readonly BootstrapChunk[]): BootstrapChunk {
  if (chunks.length === 1) return chunks[0] as BootstrapChunk
  const last = chunks[chunks.length - 1] as BootstrapChunk
  const policy = chunks.find((chunk) => chunk.policy !== undefined)?.policy
  return {
    feedId: last.feedId,
    epoch: last.epoch,
    snapshotSeq: last.snapshotSeq,
    kindTokens: last.kindTokens,
    last: last.last,
    changes: chunks.flatMap((chunk) => chunk.changes),
    stubs: chunks.flatMap((chunk) => chunk.stubs ?? []),
    complete: chunks.flatMap((chunk) => chunk.complete ?? []),
    ...(policy === undefined ? {} : { policy }),
  }
}

/** What a single input did, including the transition-table row it took. */
export interface TransitionOutcome {
  readonly rowId: string
  readonly posture: Posture
  readonly cursor: Cursor | null
  readonly rung: HealRung | null
}

const entityKey = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

/** A retired kind requires a full replacement; missing local tokens reload their kinds. */
function changedKinds(
  installed: KindTokens | undefined,
  offered: KindTokens,
): string[] | undefined {
  if (installed && Object.keys(installed).some((kind) => !Object.hasOwn(offered, kind)))
    return undefined
  return Object.keys(offered).filter(
    (kind) => !installed || !Object.hasOwn(installed, kind) || installed[kind] !== offered[kind],
  )
}

/**
 * Bound on one buffer drain, so a non-terminating drain is LOUD rather than silent
 * (POD-1140: microtask starvation defeats vitest's own testTimeout, and an unbounded
 * loop here once took a whole lane down with zero output). Generous: it bounds a
 * pathology, not a workload.
 */
const DRAIN_BUFFER_LIMIT = 10_000

/**
 * A multi-region commit was required and no `SyncUnitOfWork` was supplied.
 *
 * Its own type rather than a bare `Error` because it is a WIRING fault, not a
 * runtime condition: nothing at run time can satisfy it and no retry can help. It is
 * thrown from the constructor, so it fires before any frame has been accepted.
 */
export class SyncUnitOfWorkRequiredError extends Error {
  constructor() {
    super(
      'a Replica with an optimistic overlay must be given a SyncUnitOfWork: a retirement plus a cache write is one multi-region commit (ADR 2 D10), and committing them separately is the non-compliance POD-1158 measured',
    )
    this.name = 'SyncUnitOfWorkRequiredError'
  }
}

export class Replica implements DeviceCollectionReads {
  private readonly store: ReplicaParticipantStore
  private readonly authority: AuthorityReadPort
  private readonly overlayPort: OptimisticOverlayPort | undefined
  private readonly unitOfWork: SyncUnitOfWork | undefined
  private readonly validator: KnownKindValidatorPort | undefined
  private readonly emit: (event: ReplicaEvent) => void
  private readonly batchEvents: (emitAll: () => void) => void
  private readonly maxBootstrapAttempts: number

  private state: Posture = 'cold'
  private cursorValue: Cursor | null = null
  /**
   * Frames held while a bootstrap walk or a heal is in flight. The rule is stated
   * over FRAMES, never over ops, so watermarks and evicts are covered by
   * construction rather than by remembering to list them (D6.3 / D15.2).
   */
  private buffer: DeltaFrame[] = []
  /** How each entity left the view. The model-level remove-vs-evict distinction (D14.5). */
  private readonly exits = new Map<string, ExitKind>()
  /** Set while a bootstrap walk is in flight; bumped to abandon a superseded walk. */
  private walkGeneration = 0
  private walkAbort = new AbortController()
  private inflight: Promise<void> = Promise.resolve()
  /** A ladder failure awaiting its ONE report through `settled()` (POD-1162). */
  private failure: unknown | undefined
  private pendingTransition = false
  /**
   * Every transition-table row this replica has taken, in order. Not telemetry:
   * it is how `transition-table.test.ts` proves the ADR's table is EXERCISED
   * rather than merely transcribed — including the rows that only fire deep
   * inside an async heal or bootstrap walk and never surface as a return value.
   */
  readonly trace: string[] = []
  /**
   * The same rows with the postures actually observed around them. The bare
   * `trace` proved a row IDENTIFIER was reached; this proves the row's declared
   * `from`/`to` match what the machine really did, which is what caught the table
   * claiming D6-BUFFER lands in `bootstrapping` when it fires during a heal.
   */
  readonly transitions: { rowId: string; from: Posture; to: Posture }[] = []

  private readonly now: () => number
  /** Instances an open view holds, with how many holds each has (design "Two holders"). */
  private readonly holds = new Map<string, { readonly spec: InstanceSpec; count: number }>()
  /** Instances a fetch is answering now: they count as held, so the feed keeps their records. */
  private readonly inFlight = new Map<string, InstanceSpec>()
  private inFlightVersion = 0
  /**
   * The feed number of every change seen while a fetch is in flight, by record.
   * An answer older than a change the device ignored or applied as a removal
   * must not bring the old record back ("the newer one wins").
   */
  private seen: Map<string, number> | null = null
  private fetchCount = 0
  private fetchAbort = new AbortController()
  private fetching: Promise<void> = Promise.resolve()
  /**
   * POD-7165: a fetched answer's install takes a task of its own. Pending while
   * an install has run in the current task; the next waits for the next task,
   * so the page draws and takes input between two installs instead of running
   * every answer that has arrived, and every view's reaction to it, as one task.
   */
  private installTurn: Promise<void> | null = null
  /**
   * POD-7168 — the durable tail of a load: after the views open on it
   * ("load-installed"), the load waits for its chunks to be durable before it
   * stages its last commit (`SyncUnitOfWork.durable`). On a large first
   * download that is every chunk reaching IndexedDB (25 s on a busy host), and
   * a fetch installed behind the load (`serial`) waited all that time: the
   * deck's tree, answered by the server in under a second, appeared after the
   * whole first download was durable. While the load waits, nothing of its
   * last commit is staged, and a fetch installs at once; what it named stays
   * out of the load's sweep. The last commit is then read from the store as
   * the fetches left it.
   */
  private tail: { readonly generation: number; readonly named: Set<string> } | null = null
  /** The fetch answering each instance now: a second asker waits for its answer (POD-7169). */
  private readonly inFlightAnswers = new Map<string, Promise<unknown>>()
  /** POD-7159 — the disk load answering each instance now: a second asker waits for it. */
  private readonly diskLoads = new Map<string, Promise<void>>()
  /** POD-7159 — the records each comes-with instance was asked for, until its answer completes them. */
  private readonly askedComesWith = new Map<string, Set<string>>()
  /**
   * POD-7159 — a holder's own comes-with instances answered complete while
   * others of the same via are still to come (the loader sends a holder's
   * asks in more than one request): kept until the via is complete.
   */
  private readonly comesWithAnswered = new Map<string, Set<string>>()
  /** What held records come with, gathered for one batched fetch. */
  private readonly needs = new Map<string, InstanceRequest>()
  private needsScheduled = false
  private trimScheduled = false
  /** A trim was asked for while a fetch was in flight: it runs once none is. */
  private trimAfterFetches = false
  private trimTimer: ReturnType<typeof setTimeout> | undefined
  private heldIndexCache:
    | {
        readonly instances: ReadonlyMap<string, InstanceRecord>
        readonly policy: unknown
        readonly version: number
        readonly index: HeldIndex
      }
    | undefined
  private readonly viewRequests: (() => readonly InstanceRequest[]) | undefined
  private readonly requestHook: ((specs: readonly InstanceSpec[]) => void) | undefined

  private counters = {
    heals: 0,
    bootstraps: 0,
    framesApplied: 0,
    watermarksApplied: 0,
    trims: 0,
    pendingGap: false,
  }

  constructor(options: ReplicaOptions) {
    this.store = options.store
    this.authority = options.authority
    this.overlayPort = options.overlay
    this.unitOfWork = options.unitOfWork
    if (this.overlayPort !== undefined && this.unitOfWork === undefined) {
      throw new SyncUnitOfWorkRequiredError()
    }
    this.validator = options.validator
    this.now = options.now ?? (() => Date.now())
    const onEvent = options.onEvent ?? (() => {})
    this.emit = onEvent
    this.batchEvents = options.batchEvents ?? ((emitAll) => emitAll())
    this.maxBootstrapAttempts = options.maxBootstrapAttempts ?? 3
    this.viewRequests = options.view
    this.requestHook = options.request
    this.cursorValue = this.readCursorSafely()
    if (this.cursorValue !== null) this.state = 'stale'
  }

  // ─── Observation ──────────────────────────────────────────────────────────

  get posture(): Posture {
    return this.state
  }

  get cursor(): Cursor | null {
    return this.cursorValue
  }

  /** True while the replica is showing data it cannot currently confirm (D7 stale-visible). */
  get isStale(): boolean {
    return this.state === 'stale'
  }

  stats(): ReplicaStats {
    return {
      bufferedFrames: this.buffer.length,
      bufferedChanges: this.buffer.reduce((n, f) => n + f.changes.length, 0),
      pendingGaps: this.counters.pendingGap ? 1 : 0,
      heals: this.counters.heals,
      bootstraps: this.counters.bootstraps,
      framesApplied: this.counters.framesApplied,
      watermarksApplied: this.counters.watermarksApplied,
      trims: this.counters.trims,
      entityCount: this.store.readEntities().length,
    }
  }

  /** How this entity left the view, if it did. `undefined` ⇒ it is present, or was never held. */
  exitKind(entity: string, entityId: string): ExitKind | undefined {
    return this.exits.get(entityKey(entity, entityId))
  }

  /**
   * The read model: authoritative base with the optimistic overlay applied on top.
   * The overlay is DERIVED here and never persisted (ADR 4 D7).
   *
   * The value only. `overlay()` is the full row, and it is the one to use when the
   * caller must distinguish "no row" from "a row whose value happens to be
   * undefined", or must know that commands are in flight whose effect nothing
   * derived.
   */
  view(entity: string, entityId: string): unknown {
    return this.overlay(entity, entityId).value
  }

  /**
   * The overlay row: what to render, where it came from, and what is still in
   * flight over it (POD-372).
   *
   * The Replica's only job here is to GATHER the inputs — the base row from its
   * own slice, the exit that removed or revoked it, the pending commands from the
   * outbox port — and hand them to a pure function. It does not decide any of
   * them. With no overlay port the answer is the base, unchanged: a replica that
   * has been told no reducers must render authoritative truth and nothing else.
   */
  overlay(entity: string, entityId: string): OverlayRow {
    const base = this.store.read(entity, entityId)
    const exit = this.exits.get(entityKey(entity, entityId))
    const port = this.overlayPort
    if (port === undefined) {
      return computeOverlay({ base, exit, pending: [], reduce: () => ({ kind: 'no-reducer' }) })
    }
    return computeOverlay({
      base,
      exit,
      pending: port.pending(entity, entityId),
      reduce: (value, command) => port.reduce(value, command),
    })
  }

  /** The installed slice, base only. Conformance and hydrate use this. */
  entities(): readonly EntityRecord[] {
    return this.store.readEntities()
  }

  /** Resolves once every input accepted so far has fully settled (heals and walks included). */
  async settled(): Promise<void> {
    this.sealTransitions()
    // A heal can start a bootstrap, which can start a heal. Drain until quiet.
    for (let i = 0; i < 50; i += 1) {
      const before = this.inflight
      const fetching = this.fetching
      await before
      await fetching
      if (this.inflight === before && this.fetching === fetching) return this.reportFailure()
    }
    throw new Error('replica did not settle: the ladder is not resolving downward')
  }

  /**
   * Rethrow a held ladder failure ONCE, then clear it.
   *
   * Once, because a caller that has been told cannot be helped by being told again, and
   * a sticky error is indistinguishable from a wedge to everyone downstream — which is
   * precisely the bug this pair of methods replaces. Clearing it does not lose it: the
   * commit never applied, so the cursor never advanced, so the condition is still
   * observable in the replica's own state and the next frame heals it.
   */
  private reportFailure(): void {
    const failure = this.failure
    if (failure === undefined) return
    this.failure = undefined
    throw failure
  }

  // ─── Inputs ───────────────────────────────────────────────────────────────

  /** Come online. From `cold` this bootstraps; from `stale` it RESUMES from the cursor. */
  private transportGap = false

  /** A socket drop cannot cancel an independently owned HTTP snapshot. */
  transportDisconnected(): void {
    if (this.state !== 'bootstrapping') {
      this.disconnect()
      return
    }
    this.buffer = []
    this.transportGap = true
  }

  requestRebootstrap(): void {
    this.rebootstrap('resync-required')
  }

  /** Called from both the connection advertisement and the HTTP delta header. */
  observeKindTokens(offered: KindTokens): void {
    if (this.cursorValue === null || this.state === 'bootstrapping') return
    let installed: KindTokens | undefined
    try {
      installed = this.store.readKindTokens()
    } catch (error) {
      if (!(error instanceof ReplicaStoreCorruptError)) throw error
      this.onCorruption()
      return
    }
    const kinds = changedKinds(installed, offered)
    if (kinds?.length === 0) return
    this.rebootstrap('kind-shape', kinds && new Set(kinds))
  }

  connect(): TransitionOutcome {
    const from = this.state
    if (this.cursorValue === null) {
      this.rebootstrap('cold-start')
      return this.outcome('D7-2-COLD', from)
    }
    this.startHeal()
    return this.outcome('D7-1-RESUME', from)
  }

  /** Go offline. The last-known slice stays VISIBLE, marked stale (D7). Never blank. */
  disconnect(): TransitionOutcome {
    if (this.trimTimer !== undefined) {
      clearTimeout(this.trimTimer)
      this.trimTimer = undefined
      this.trimScheduled = false
    }
    // Abandon any walk in flight: its staging is discarded, never half-installed.
    this.walkAbort.abort()
    this.walkAbort = new AbortController()
    this.walkGeneration += 1
    this.buffer = []
    this.counters.pendingGap = false
    if (this.cursorValue === null) return this.transitionTo('cold', 'D7-DISCONNECT-COLD')
    return this.transitionTo('stale', 'D7-STALE-VISIBLE')
  }

  /** ADR 2 D4 / D7 rung 6 — the local store layout moved; discard rather than migrate. */
  replicaSchemaChanged(): TransitionOutcome {
    const from = this.state
    this.rebootstrap('schema-version')
    return this.outcome('D7-6-SCHEMA', from)
  }

  /** The one entry point for everything the authority pushes. */
  async receive(frame: ServerFrame): Promise<TransitionOutcome> {
    const from = this.state
    try {
      return await this.route(frame, from)
    } catch (error) {
      if (error instanceof ReplicaStoreCorruptError) return this.onCorruption()
      throw error
    }
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private async route(frame: ServerFrame, from: Posture): Promise<TransitionOutcome> {
    // Control frames act immediately and are never buffered: both resolve
    // strictly DOWNWARD, so deferring them could only delay the terminal path.
    if (frame.kind === 'rescope') {
      // Amendment 1 D14.4 — always legal, from any posture, on the SAME path as
      // every other rung. Cause is recorded as authz, distinguishable in
      // telemetry from backpressure.
      this.rebootstrap('rescope')
      return this.outcome('D14-RESCOPE', from)
    }
    if (frame.kind === 'resync-required') {
      this.rebootstrap('resync-required')
      return this.outcome('D7-2-RESYNC', from)
    }

    // ADR 2 D1 / D7 rung 4 — equality only, and checked BEFORE the buffering
    // branch. It used to sit after it, so a mismatched frame arriving during a
    // heal or a walk was quietly buffered (D6-BUFFER) instead of taking the
    // declared D7-4-EPOCH transition; the mismatch was then noticed much later,
    // in drainBuffer, or silently skipped at install. Rung 4 says discard and
    // re-bootstrap, and it must fire wherever a cursor exists to compare against.
    //
    // EXCEPT WHILE A BOOTSTRAP WALK RUNS (POD-6838). The walk is already replacing
    // that cursor with the snapshot's identity, so a frame that disagrees with the
    // OLD cursor says nothing the walk will not fix. Re-bootstrapping on it restarted
    // the walk on every live frame: a replica whose saved cursor carried an old epoch
    // never finished a bootstrap on a busy feed. The frame is buffered instead, and
    // `drainBuffer` holds it to rung 4 against the identity the walk installs.
    if (
      this.cursorValue !== null &&
      this.state !== 'bootstrapping' &&
      (frame.feedId !== this.cursorValue.feedId || frame.epoch !== this.cursorValue.epoch)
    ) {
      this.rebootstrap('epoch-mismatch')
      return this.outcome('D7-4-EPOCH', from)
    }

    if (this.state === 'bootstrapping' || this.state === 'healing') {
      // Validate BEFORE buffering. Buffering first meant a malformed frame
      // received during a heal or a walk was applied later without ever passing
      // rung 3 — the cursor advanced over a corrupt payload. Rung 3 must be
      // unavoidable on EVERY route into the store, not only the live one.
      if (this.rejects(frame) !== null) {
        this.rebootstrap('malformed')
        return this.outcome('D7-3-MALFORMED', from)
      }
      if (this.buffer.length >= DRAIN_BUFFER_LIMIT) {
        this.buffer = []
        this.rebootstrap('resync-required')
        return this.outcome('D7-2-RESYNC', from)
      }
      this.buffer.push(frame)
      return this.outcome('D6-BUFFER', from)
    }

    if (this.state === 'cold' || this.cursorValue === null) {
      // Nothing to apply a delta onto.
      this.rebootstrap('cold-start')
      return this.outcome('D7-2-COLD', from)
    }

    if (this.rejects(frame) !== null) {
      this.rebootstrap('malformed')
      return this.outcome('D7-3-MALFORMED', from)
    }

    if (this.state === 'stale') {
      // The link came back underneath us. Frames were missed while offline, so
      // heal from the cursor rather than applying blind — UNLESS the frame's own
      // retention floor already says the heal cannot succeed, which is the
      // long-offline case D5 advertises `minAvailableSeq` for.
      if (this.belowRetentionFloor(frame)) {
        this.rebootstrap('compacted')
        return this.outcome('D7-2-COMPACTED', from)
      }
      this.buffer.push(frame)
      this.startHeal()
      return this.outcome('D7-1-FRAME-WHILE-STALE', from)
    }

    return await this.applyCertified(frame, from)
  }

  /**
   * Rung 0, literally as Amendment 1 D13 states it: **accept iff
   * `fromSeq === cursor`. Otherwise it is a gap.**
   *
   * An earlier version of this file also accepted a wholly re-delivered frame
   * (ignoring it) and a partially overlapping one (truncating to the uncovered
   * tail). Both are removed. D13.1 normatively guarantees that frames for one
   * connection are "strictly ordered, contiguous and NON-OVERLAPPING", so those
   * cases are protocol violations rather than situations to be tolerated — and
   * tolerating them made the rule WEAKER than the one it replaced, when the
   * amendment's whole point is that an explicit lower bound is STRONGER (it also
   * catches a frame that vanished between two others). A replica that quietly
   * absorbs an overlapping frame removes the only check that would have caught an
   * authority emitting them, on a contract shared with POD-1077 and POD-308.
   *
   * The cost of strictness is one heal round trip if a transport ever does
   * re-deliver, which resolves and terminates — it is not the endless-heal shape
   * D13 exists to prevent, because the heal advances the cursor.
   */
  private async applyCertified(frame: DeltaFrame, from: Posture): Promise<TransitionOutcome> {
    const cursor = this.cursorValue as Cursor

    if (frame.fromSeq !== cursor.seq) {
      // A gap. Before spending a round trip on a heal, read the retention floor
      // the frame itself certifies: if the rows this cursor needs have already
      // been pruned, `changesSince` can only answer `bootstrap-required`, and
      // asking is a round trip whose answer is already known (ADR 2 D5).
      if (this.belowRetentionFloor(frame)) {
        this.rebootstrap('compacted')
        return this.outcome('D7-2-COMPACTED', from)
      }
      // Do NOT apply. Applying would make the cursor certify data we never
      // received, which is a permanent lie rather than a lost update.
      this.buffer.push(frame)
      this.counters.pendingGap = true
      this.startHeal()
      return this.outcome('D7-1-GAP', from)
    }

    // The row is decided synchronously; the COMMIT may not be, because a
    // multi-region commit belongs to a unit of work this class does not own
    // (POD-1158). Tracking it on `inflight` is what makes `settled()` cover it, and
    // what makes a refused commit surface there rather than vanish.
    const { row, done } = this.commitChanges(frame.changes, { ...cursor, seq: frame.seq })
    this.run(() => done)
    return this.outcome(row, from)
  }

  /**
   * ONE transaction for the changes and the cursor (ADR 2 D10 / ADR 6 D4.1), so
   * the cursor is never ahead of the data it claims. Returns the transition row
   * that best describes what the frame carried.
   */
  private commitChanges(
    changes: readonly ChangeEnvelope[],
    nextCursor: Cursor,
    generation?: number,
  ): { readonly row: string; readonly done: Promise<void> } {
    // Classified BEFORE the commit, from the pre-frame exit state — the same inputs
    // `emitApplied` classifies from, through the same function, so the row this
    // returns and the row the emission reports cannot drift. That matters because a
    // multi-region commit now resolves asynchronously, and the transition row must
    // still be available to the synchronous caller.
    const row = this.classify(changes)
    let decision: FeedDecision | undefined
    const done = this.commitRegions(
      { matches: retirementsOf([changes]), through: nextCursor, install: false },
      (span) => {
        if (generation !== undefined) {
          const prepare = (): void => {
            if (generation !== this.walkGeneration) throw new Error('superseded heal')
          }
          prepare()
          span?.join({ prepare, publish() {} })
        }
        decision = this.feedMutation(changes, nextCursor)
        this.store.applyAtomic(decision.mutation, span)
      },
      () => {
        this.cursorValue = nextCursor
        this.counters.pendingGap = false
        this.emitApplied(changes, nextCursor, decision)
        if (decision !== undefined) this.request(decision.needs)
      },
    )
    return { row, done }
  }

  /**
   * ONE logical commit, ADR 2 D10 as settled with POD-370.
   *
   * The retirement and the cache write are ONE unit of work whenever the overlay
   * says this commit covers something: the cursor must never certify a frame whose
   * confirmed commands are still queued (the user would see their own write twice,
   * then watch it vanish), and a command must never be retired against a frame that
   * did not commit (the user is told a write landed when it did not). Two sequential
   * writes cannot give either guarantee, in EITHER order.
   *
   * Coverage, not provenance, decides (ADR 12). A frame with no provenance at all —
   * a watermark — still covers an applied command whose receipt it reaches, so it
   * must open the unit of work; a frame whose provenance names only other writers'
   * commands covers nothing, so it need not.
   *
   * A lone cache write normally autocommits (D10 clause 2). A kind replacement
   * uses the unit of work to wait for durable publication of its new token.
   *
   * Everything the Replica itself observes — the cursor, `exits`, public events —
   * is updated by the CALLER, strictly after this returns, so no observer can see
   * uncommitted state and an abort leaves nothing to undo.
   */
  private commitRegions(
    evidence: RetirementEvidence,
    write: (span?: SyncSpan) => void,
    adopt: () => void,
    awaitDurability = false,
  ): Promise<void> {
    // The one choke point every post-commit burst passes through, so wrapping
    // HERE is what makes `batchEvents`'s "one burst, one call" a property rather
    // than a rule each call site remembers: a live frame, a heal reply, a
    // drained buffer frame and a whole install all adopt through this function.
    const adoptBatched = (): void => this.batchEvents(adopt)
    const overlay = this.overlayPort?.covers(evidence) ? this.overlayPort : undefined
    const unitOfWork = this.unitOfWork
    if (unitOfWork === undefined || (overlay === undefined && !awaitDurability)) {
      write()
      adoptBatched()
      return Promise.resolve()
    }
    return unitOfWork.transact(async (span) => {
      // The ASYNC enrolment first, and AWAITED. This is the line POD-1158 exists
      // for: a durable outbox store cannot enrol synchronously, and `transact`'s
      // body is the one place allowed to await. Doing it before the cache write also
      // means a refusal costs nothing — no region has staged yet.
      if (overlay) await overlay.retire(evidence, span)
      write(span)
      // Strictly AFTER durability, through the span's own protocol. Nothing the
      // Replica observes — cursor, exits, public events — escapes before the commit,
      // and an abort simply never runs this, so there is nothing to undo.
      span.onCommit(adoptBatched)
    })
  }

  /**
   * The ONE post-commit emission path, shared by live application, heal
   * application and post-install replay of buffered frames.
   *
   * It is one function on purpose. It used to be two — `commitChanges` and a
   * separate `replayEmissions` for the bootstrap path — and they drifted: only
   * the first retired overlay entries, and only for upserts, so a tombstone or an
   * eviction carrying provenance never retired the command that caused it, and
   * nothing applied through a bootstrap retired anything at all. Two emission
   * paths for one concept is how a contract in a docstring stops being true.
   *
   * Emission happens strictly AFTER the commit, so no observer can see
   * uncommitted state. Retirement is therefore NOT collected here even though
   * this walks exactly the right changes: a retirement must be enrolled in the
   * commit, which has already happened by the time anything is emitted.
   * `retirementsOf` derives it from the same envelopes, before the commit.
   */
  /**
   * Which transition row a frame's contents take, as a PURE function of the changes
   * and the pre-frame exit state.
   *
   * Extracted so the row is decided in exactly one place. `commitChanges` needs it
   * before the commit (a multi-region commit resolves asynchronously, and its caller
   * still returns a `TransitionOutcome` synchronously) and `emitApplied` returns it
   * after. Two copies of this classification would be two answers to one question,
   * which is the drift this programme is deleting — so there is one, and
   * `emitApplied` calls it rather than recomputing.
   */
  private classify(changes: readonly ChangeEnvelope[]): string {
    if (changes.length === 0) return 'D13-WATERMARK'
    // Walked against an exit state that EVOLVES across the frame, exactly as the
    // emission does: evict(seq 1) then a same-revision upsert(seq 2) of one entity is
    // a re-admission, and a pre-frame snapshot would call it a creation.
    const exits = new Map(this.exits)
    let sawEvict = false
    let sawRemove = false
    let sawReadmit = false
    for (const change of changes) {
      const key = entityKey(change.entity, change.entityId)
      if (change.op === 'upsert') {
        sawReadmit ||= exits.get(key) === 'evicted'
        exits.delete(key)
      } else if (change.op === 'remove') {
        sawRemove = true
        exits.set(key, 'removed')
      } else {
        sawEvict = true
        exits.set(key, 'evicted')
      }
    }
    if (sawEvict) return 'D14-EVICT'
    if (sawRemove) return 'D5-REMOVE'
    if (sawReadmit) return 'D14-READMIT'
    return 'D7-0-APPLY'
  }

  private emitApplied(
    changes: readonly ChangeEnvelope[],
    cursor: Cursor,
    decision?: FeedDecision,
  ): string {
    const row = this.classify(changes)
    let sawEvict = false
    let sawRemove = false
    let sawReadmit = false

    // Project each change SEQUENTIALLY, from its own envelope, against an exit
    // state that evolves as we walk the frame. Two earlier shortcuts both broke
    // feed order in the PUBLIC projection while the cache had it right:
    //  - re-admission was precomputed from the pre-frame exit map, so
    //    evict(seq 1) + same-revision upsert(seq 2) in ONE frame emitted
    //    readmitted:false and a client would render a re-share as a creation
    //    (Amendment 1 D14.2);
    //  - each upsert's record was read back from the already-final store, so
    //    upsert-then-remove in one frame emitted NO upserted event at all, and
    //    two upserts of one entity both reported the last value.
    // The envelope is the truth about what happened at that seq; the store is
    // only the truth about where the frame ENDED.
    for (const change of changes) {
      const key = entityKey(change.entity, change.entityId)
      // Older than the record the device holds (a fetch answered ahead of the
      // feed): nothing changed for it, so nothing is announced either.
      if (decision?.skipped.has(change)) continue
      if (change.op === 'upsert') {
        const readmitted = this.exits.get(key) === 'evicted'
        sawReadmit ||= readmitted
        this.exits.delete(key)
        // The feed-apply table decided what the device keeps (POD-7086): a
        // change it ignored is not held, and a stub is not a whole record.
        if (decision?.ignored.has(change)) continue
        if (decision?.stubbed.has(change)) {
          this.emit({ type: 'stub-upserted', record: { ...recordOf(change), part: 'stub' } })
          continue
        }
        this.emit({ type: 'upserted', record: recordOf(change), readmitted })
      } else if (change.op === 'remove') {
        sawRemove = true
        this.exits.set(key, 'removed')
        this.emit({ type: 'removed', entity: change.entity, entityId: change.entityId })
      } else {
        // D14.1 — dropped from cache and from derived views, and that is ALL.
        // No domain "deleted" event, no tombstone: an entity you can no longer
        // see has not stopped existing.
        sawEvict = true
        this.exits.set(key, 'evicted')
        this.emit({ type: 'evicted', entity: change.entity, entityId: change.entityId })
      }
    }

    const watermarkOnly = changes.length === 0
    if (watermarkOnly) this.counters.watermarksApplied += 1
    this.counters.framesApplied += 1
    this.emit({ type: 'cursor', cursor, watermarkOnly })

    // `classify` is the ONE answer, and the locals above are what the emission loop
    // needed anyway. Asserting they agree here would be a comment; `replica.test.ts`
    // pins it instead, over a table of frames, the way `applyMutation` is pinned.
    void sawEvict
    void sawRemove
    void sawReadmit
    return row
  }

  // ─── Rung 1: heal ─────────────────────────────────────────────────────────

  private startHeal(): void {
    this.walkAbort.abort()
    this.walkAbort = new AbortController()
    const signal = this.walkAbort.signal
    const generation = ++this.walkGeneration
    this.counters.heals += 1
    this.setPosture('healing')
    this.emit({ type: 'heal', rung: 1, cause: 'gap' })
    this.run(async () => {
      if (generation !== this.walkGeneration) return
      const cursor = this.cursorValue
      if (cursor === null) {
        this.rebootstrap('cold-start')
        return
      }
      let targetSeq: number | undefined
      let framesCommitted = 0
      const fromSeq = cursor.seq
      // Catch only source failures. A refused durable commit must still be
      // surfaced through settled(), rather than mistaken for a network outage.
      const sourceFailed = (): void => {
        if (generation !== this.walkGeneration) return
        this.note('D7-1-HEAL-STREAM-FAILED')
        this.counters.pendingGap = true
        this.setPosture('stale')
      }
      let range: Awaited<ReturnType<AuthorityReadPort['changesRange']>>
      try {
        range = await this.authority.changesRange(cursor, signal, (target, kindTokens) => {
          if (generation !== this.walkGeneration) return
          targetSeq = target.seq
          this.observeKindTokens(kindTokens)
        })
      } catch {
        sourceFailed()
        return
      }
      if (generation !== this.walkGeneration) return
      if ('kind' in range) {
        this.note('D7-2-COMPACTED')
        this.rebootstrap('compacted')
        return
      }
      const iterator = range[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          let next: IteratorResult<DeltaFrame>
          try {
            next = await iterator.next()
          } catch {
            sourceFailed()
            return
          }
          if (generation !== this.walkGeneration) return
          if (next.done) {
            completed = true
            break
          }
          const frame = next.value
          const current = this.cursorValue as Cursor
          if (frame.feedId !== current.feedId || frame.epoch !== current.epoch) {
            this.note('D7-4-EPOCH')
            this.rebootstrap('epoch-mismatch')
            return
          }
          if (this.rejects(frame) !== null || frame.fromSeq !== current.seq) {
            this.note('D7-3-REPLY-MALFORMED')
            this.rebootstrap('malformed')
            return
          }
          try {
            const applied = this.commitChanges(
              frame.changes,
              { ...current, seq: frame.seq },
              generation,
            )
            await applied.done
            if (generation !== this.walkGeneration) return
            this.note(applied.row)
          } catch (error) {
            if (generation !== this.walkGeneration) return
            if (!(error instanceof ReplicaStoreCorruptError)) this.setPosture('stale')
            throw error
          }
          framesCommitted += 1
          this.note('D7-1-PARTIAL-HEAL-COMMITTED')
          this.sealTransitions()
          this.emit({ type: 'heal-progress', framesCommitted, seq: frame.seq, targetSeq, fromSeq })
        }
      } finally {
        if (!completed) {
          // Cancellation also reaches an HTTP reader waiting for bytes. Closing
          // an abandoned iterator must not mask the original failure.
          if (this.walkAbort.signal === signal) this.walkAbort.abort()
          try {
            await iterator.return?.()
          } catch {
            /* abandoned source */
          }
        }
      }
      if (generation !== this.walkGeneration) return
      this.counters.pendingGap = false
      this.note('D7-1-HEALED')
      this.setPosture('live')
      await this.drainBuffer()
      if (generation !== this.walkGeneration || this.state !== 'live') return
      // A first download or reload the app closed early resumes at the first
      // collection without a marker (POD-7048); otherwise fetch what a held
      // record comes with that an interrupted answer did not bring.
      if (this.store.readLoadingSince() !== null) this.rebootstrap('resume')
      else this.requestMissingComesWith()
    })
  }

  /**
   * Apply buffered frames while they chain exactly; the first that does not,
   * heals again.
   *
   * A frame wholly at or below the cursor is DROPPED, not applied and not healed:
   * our own cursor already certifies that range, so there is nothing to learn
   * from it and nothing to lose by discarding it. That is not the acceptance of
   * an overlapping frame — nothing from it reaches the store.
   */
  private async drainBuffer(): Promise<void> {
    // A FRAME IS CONSUMED ONLY AFTER ITS COMMIT IS DURABLE (POD-1161). This used to
    // take the whole buffer and empty it up front, so a commit that aborted part-way
    // dropped every remaining frame — and with them the retirements they were the only
    // carrier of. Entity truth survives that (a heal or a re-bootstrap re-derives it);
    // retirement does not, because provenance for an already-applied command appears in
    // the feed ONCE and no later frame carries it again after the cursor passes it.
    //
    // Shifting after `await` rather than restoring on failure is the same shape the
    // install path uses, and it is deliberate: restoring is the undo-shaped answer the
    // span design avoids everywhere else, and it would have to reconstruct order by
    // hand. Frames arriving while this awaits append to the END of `this.buffer`, which
    // is where feed order already puts them.
    //
    // BOUNDED AND LOUD (POD-1140): the loop consumes from a buffer that concurrent
    // frames can grow, so it needs a bound that is not "until it is empty". An
    // unbounded drain here is the shape that once produced zero bytes and hung forever.
    for (let guard = 0; this.buffer.length > 0; guard += 1) {
      if (guard > DRAIN_BUFFER_LIMIT) {
        throw new Error(
          `replica buffer drain did not terminate after ${DRAIN_BUFFER_LIMIT} frames (${this.buffer.length} still buffered)`,
        )
      }
      const frame = this.buffer[0] as DeltaFrame
      const cursor = this.cursorValue as Cursor
      if (frame.feedId !== cursor.feedId || frame.epoch !== cursor.epoch) {
        this.note('D7-4-EPOCH')
        this.rebootstrap('epoch-mismatch')
        return
      }
      if (frame.seq <= cursor.seq) {
        // Covered by our own cursor: nothing to learn and nothing to lose. Dropping it
        // is safe without a commit, so it is consumed immediately.
        this.buffer.shift()
        this.note('D6-BUFFER-COVERED')
        continue
      }
      if (frame.fromSeq !== cursor.seq) {
        // A gap: this frame and everything after it stay buffered for the heal.
        this.counters.pendingGap = true
        this.startHeal()
        return
      }
      const applied = this.commitChanges(frame.changes, { ...cursor, seq: frame.seq })
      // A rejection leaves the frame at the head of the buffer, so the heal or the
      // re-bootstrap that follows still has it — and still has its retirements.
      await applied.done
      this.buffer.shift()
      this.note(applied.row)
    }
  }

  // ─── Rungs 2-6: the ONE terminal path ─────────────────────────────────────

  /**
   * Every rung ends here. That is the design, and it is also the enforcement:
   * "discard the cache, re-bootstrap, KEEP THE OUTBOX" is a property of this one
   * function, not a rule repeated at six call sites where one of them forgets.
   *
   * The outbox is not discarded because it CANNOT be reached from here — it is
   * not on `ReplicaCacheStore` at all (see ports.ts). Under private-by-default a
   * `rescope` fires whenever somebody's shares change, so this is a normal-path
   * event and a drop-the-outbox bug would be reachable by a colleague clicking
   * "share" (ADR 2 D7 + Amendment 1 D14.4).
   *
   * Rows are never discarded up front: rungs 2-6 must never blank the UI. The
   * load writes its collections in chunks over the old rows and sweeps what it
   * did not confirm only once every policy collection has its marker (D7
   * stale-visible; POD-7086). Only the markers go at once: what the feed kept
   * complete is no longer known to be.
   */
  private rebootstrap(cause: RebootstrapCause, kinds?: ReadonlySet<string>): void {
    // A changed record shape reloads only the collections of those kinds,
    // through the collection fetch, while the feed keeps applying (POD-7086).
    if (cause === 'kind-shape' && kinds !== undefined && this.reloadKinds(kinds)) return
    // Bump first, then read: a superseded walk notices the mismatch and abandons
    // its staging rather than installing a slice the ladder has moved past.
    this.walkAbort.abort()
    this.fetchAbort.abort()
    this.fetchAbort = new AbortController()
    this.walkAbort = new AbortController()
    this.walkGeneration += 1
    const generation = this.walkGeneration
    // ONE recovery path owns invalidation for every rung. Ordinary walks keep
    // the old slice visible, but it must no longer certify absent personal rows.
    if (cause === 'local-corruption' || cause === 'schema-version') {
      try {
        this.store.discardCache()
      } catch (error) {
        if (cause !== 'local-corruption') throw error
        // A store too broken to clear is still a store we re-bootstrap over.
      }
      this.cursorValue = null
      this.buffer = []
      this.exits.clear()
    }
    this.counters.bootstraps += 1
    this.counters.pendingGap = false
    this.setPosture('bootstrapping')
    this.emit({ type: 'heal', rung: rungFor(cause), cause })
    this.run(async () => {
      if (generation !== this.walkGeneration) return
      // After prior frame commits settle, before the new walk: the markers
      // described what the feed kept complete, and a walk is under way because
      // it could not. The old rows stay readable; only "complete" is withdrawn.
      // Clearing eagerly while an older span is still staged would let its
      // publication restore the old markers behind this recovery.
      try {
        if (cause !== 'resume' && this.store.readInstances().size > 0) {
          this.store.applyAtomic({ operations: [], instances: [{ kind: 'dropAll' }] })
          this.emit({ type: 'markers' })
        }
      } catch (error) {
        // An unreadable corruption walk must consume its bounded attempt budget,
        // rather than resetting it by escalating before the walk can begin.
        if (cause !== 'local-corruption' || !(error instanceof ReplicaStoreCorruptError))
          throw error
      }
      await this.walk(cause, generation)
    })
  }

  private async walk(cause: RebootstrapCause, generation: number): Promise<void> {
    let lastError = 'unknown'
    for (let attempt = 1; attempt <= this.maxBootstrapAttempts; attempt += 1) {
      if (generation !== this.walkGeneration) return // superseded
      try {
        const installed = await this.attemptWalk(cause, generation)
        if (installed || generation !== this.walkGeneration) return
        lastError = 'stream ended before the last chunk'
        this.note('D6-RESTART')
      } catch (error) {
        if (generation !== this.walkGeneration) return
        if (error instanceof ReplicaStoreCorruptError) {
          // Rung 5 discovered from INSIDE a walk. Escalating is correct exactly
          // once: a walk that is not already the corruption walk hands over to
          // onCorruption, which discards the cache and re-bootstraps for that
          // cause. But a corruption walk that finds the store STILL corrupt must
          // not escalate again — onCorruption starts a fresh walk with a fresh
          // attempt budget, so every attempt would renew its own bound and the
          // ladder would never terminate. D7 requires it to resolve strictly
          // DOWNWARD, so here corruption simply consumes an attempt and the walk
          // runs out into D6-EXHAUSTED like any other unrecoverable bootstrap.
          if (cause !== 'local-corruption') {
            this.onCorruption()
            return
          }
          lastError = 'store still corrupt'
          this.note('D6-RESTART')
          continue
        }
        lastError = error instanceof Error ? error.message : String(error)
        this.note('D6-RESTART')
      }
      // D6-RESTART: what the attempt installed stays, chunk by chunk, with a
      // marker for every collection it finished; the next attempt resumes at
      // the first collection without one (POD-7086).
    }
    if (generation !== this.walkGeneration) return
    this.emit({
      type: 'bootstrap-failed',
      cause,
      attempts: this.maxBootstrapAttempts,
      error: lastError,
    })
    // D6-EXHAUSTED: keep serving whatever is installed, marked stale. Never blank.
    this.note('D6-EXHAUSTED')
    this.setPosture(this.cursorValue === null ? 'cold' : 'stale')
  }

  /**
   * One attempt. Returns true iff the load finished.
   *
   * CHUNKED AND RESUMABLE (POD-7086, design "One loader, one route"; replaces
   * the single install POD-7048 lost on an early close). Each chunk commits as
   * it arrives, an instance's marker with or after its records. A full load
   * (the first download, or a reload after a gap the feed cannot bridge) moves
   * the cursor to its snapshot with the first chunk and notes the load as
   * under way; rows older than that number stay readable until the load ends
   * and sweeps them. When a load is under way and the policy is known, the
   * attempt asks the collection fetch for only the policy's collections
   * without a marker.
   */
  private async attemptWalk(cause: RebootstrapCause, generation: number): Promise<boolean> {
    const signal = this.walkAbort.signal
    const missing = this.resumeRequests()
    if (missing !== undefined && missing.length === 0) {
      await this.finishLoad(cause, undefined, generation, false, 0)
      return true
    }
    const full = missing === undefined
    const source =
      missing === undefined
        ? this.authority.bootstrap(signal, this.viewRequests?.())
        : // A method of the authority: called on it, so a class source keeps its `this`.
          (this.authority as Required<Pick<AuthorityReadPort, 'collections'>>).collections(
            missing,
            signal,
          )
    let head: BootstrapChunk | undefined
    let first = true
    let entityCount = 0
    // POD-7122: chunks that have ARRIVED are installed together, up to
    // INSTALL_BATCH_ROWS or the marker of an instance the load asked for; the
    // walk never waits for more data to install what it has, so a stream that
    // stalls or dies keeps every chunk it delivered.
    const pending: BootstrapChunk[] = []
    let pendingRows = 0
    const members = new AnswerMembers()
    const install = (): void => {
      if (pending.length === 0) return
      if (generation !== this.walkGeneration) {
        // A superseded walk installs nothing more.
        pending.length = 0
        pendingRows = 0
        return
      }
      const chunk = mergeChunks(pending)
      pending.length = 0
      pendingRows = 0
      entityCount += this.installChunk(chunk, { start: full && first, members }).length
      first = false
    }
    const chunks = source[Symbol.asyncIterator]()
    let done = false
    try {
      for (;;) {
        const next = chunks.next()
        let step: IteratorResult<BootstrapChunk> | typeof NOT_YET =
          pending.length === 0 ? await next : await arrivedBy(next)
        if (step === NOT_YET) {
          install()
          step = await next
        }
        if (step.done === true) {
          done = true
          break
        }
        const chunk = step.value
        if (generation !== this.walkGeneration) return false
        if (
          head &&
          (chunk.feedId !== head.feedId ||
            chunk.epoch !== head.epoch ||
            chunk.snapshotSeq !== head.snapshotSeq)
        ) {
          throw new Error('bootstrap chunks disagree about the snapshot point')
        }
        head = chunk
        this.validateChunk(chunk)
        if (!full) {
          const cursor = this.cursorValue
          if (cursor === null || cursor.feedId !== chunk.feedId || cursor.epoch !== chunk.epoch)
            throw new Error('a resumed load answered for another feed')
        }
        pending.push(chunk)
        pendingRows += rowsOfChunk(chunk)
        if (chunk.last) break
        if (pendingRows >= INSTALL_BATCH_ROWS || closesRequestedInstance(chunk)) {
          install()
          // POD-7170: an answer already buffered resolves its next chunk in a
          // microtask; without a task between installs the whole download,
          // and every reader's reaction to it, ran as one task (6.5 s).
          await nextTask()
        }
      }
    } catch (error) {
      // The answer broke off: the chunks that arrived whole stay (POD-7086).
      done = true
      if (generation === this.walkGeneration && !(error instanceof ReplicaStoreCorruptError))
        install()
      throw error
    } finally {
      // Leaving early (the last chunk, or a superseded walk) closes the
      // answer, as a `for await` that breaks does.
      if (!done) await chunks.return?.(undefined)
    }
    if (generation !== this.walkGeneration) return false
    install()
    if (generation === this.walkGeneration) this.completeComesWith(members)
    if (!head?.last) return false
    if (generation !== this.walkGeneration) return false
    await this.finishLoad(cause, head, generation, full, entityCount)
    return true
  }

  /** The policy's instances a load under way still lacks; `undefined` when only a full load can help. */
  private resumeRequests(): InstanceRequest[] | undefined {
    if (this.authority.collections === undefined || this.cursorValue === null) return undefined
    if (this.store.readLoadingSince() === null) return undefined
    const policy = this.store.readPolicy()
    if (policy === null) return undefined
    return this.missingPolicyInstances()
  }

  private missingPolicyInstances(): InstanceSpec[] {
    const instances = this.store.readInstances()
    return policyInstances(this.store.readPolicy()).filter(
      (spec) => !instances.has(instanceKey(spec)),
    )
  }

  /**
   * D6's positive-state rules, chunk by chunk: a snapshot lists what exists and
   * is visible, so a removal inside one is malformed, and a known kind that
   * fails validation is refused before it lands.
   */
  private validateChunk(chunk: BootstrapChunk): void {
    for (const change of chunk.changes) {
      // D6 — a snapshot is POSITIVE STATE. A remove/evict inside it is not a
      // smaller snapshot, it is a malformed one.
      if (change.op !== 'upsert' || change.payload === undefined) {
        throw new Error(`bootstrap chunk carried a non-upsert row: ${change.op}`)
      }
      if (change.seq > chunk.snapshotSeq) {
        throw new Error('bootstrap chunk carried a row above the snapshot point')
      }
      // The third ingress route. A snapshot is the RECOVERY path, so a corrupt
      // known-kind row here is the worst place to accept one: it installs as
      // authoritative truth and the cursor advances over it. Unknown kinds stay
      // lenient (D4) exactly as on the other two routes.
      if (this.validator?.knows(change.entity) === true) {
        const reason = this.validator.validate(change)
        if (reason !== null) throw new Error(`bootstrap chunk failed validation: ${reason}`)
      }
    }
    for (const change of chunk.stubs ?? []) {
      if (change.op !== 'upsert' || change.payload === undefined)
        throw new Error(`a stub chunk carried a non-upsert row: ${change.op}`)
      if (change.seq > chunk.snapshotSeq)
        throw new Error('a stub chunk carried a row above the snapshot point')
      if (stubFieldsOf(change.entity).length === 0)
        throw new Error(`a stub chunk carried ${change.entity}, which has no stub`)
    }
  }

  /**
   * The feed number a held row is current as of. Every held row receives
   * every change the feed applies, so a row the device has confirmed is
   * current through the cursor; a row a load under way has not confirmed yet
   * is current only as of its own number.
   */
  private currencyOf(row: EntityRecord, loadingSince: number | null): number {
    const asOf = rowAsOf(row)
    if (loadingSince !== null && asOf < loadingSince) return asOf
    return Math.max(asOf, this.cursorValue?.seq ?? -1)
  }

  /**
   * Commit one chunk of an answer: its whole records, its stubs and its
   * markers, in one transaction, the newer one winning per record. Returns the
   * whole records written.
   */
  private installChunk(
    chunk: BootstrapChunk,
    options: {
      readonly start?: boolean
      readonly reload?: KindReload
      readonly signal?: AbortSignal
      /** What the answer named so far: the members of the instances it marks (POD-7159). */
      readonly members?: AnswerMembers
    },
  ): EntityRecord[] {
    if (options.signal?.aborted) return []
    const start = options.start === true
    const members = options.members
    if (members !== undefined)
      for (const change of chunk.changes)
        members.add(change.entity, change.entityId, change.payload)
    const snapshot: Cursor = { feedId: chunk.feedId, epoch: chunk.epoch, seq: chunk.snapshotSeq }
    const at = chunk.snapshotSeq
    const loadingSince = start ? at : this.store.readLoadingSince()
    const staged = new Map<string, EntityRecord | null>()
    const rowOf = (entity: string, entityId: string): EntityRecord | undefined => {
      const key = entityKey(entity, entityId)
      return staged.has(key) ? (staged.get(key) ?? undefined) : this.store.readRow(entity, entityId)
    }
    const newer = (key: string): boolean => (this.seen?.get(key) ?? -1) > at
    const operations: CacheOperation[] = []
    const events: ReplicaEvent[] = []
    const written: EntityRecord[] = []
    for (const change of chunk.changes) {
      const key = entityKey(change.entity, change.entityId)
      if (newer(key)) continue
      const existing = rowOf(change.entity, change.entityId)
      // A whole record the device keeps current needs no older or equal answer.
      // A stub is current only for its stub fields: the answer brings the main
      // part unless the stub itself changed after the answer was read.
      if (existing !== undefined) {
        const stale =
          existing.part === 'stub'
            ? at < rowAsOf(existing)
            : at <= this.currencyOf(existing, loadingSince)
        if (stale) continue
      }
      const op = upsertOf(change, change.payload, at)
      operations.push(op)
      const row = recordFromOp(op)
      staged.set(key, row)
      events.push({ type: 'upserted', record: row, readmitted: false })
      written.push(row)
    }
    const disk = this.store.readDiskIndex()
    for (const change of chunk.stubs ?? []) {
      const key = entityKey(change.entity, change.entityId)
      if (newer(key)) continue
      // POD-7159: a record whole on disk and not in memory is whole, as of its index number.
      const onDisk = staged.has(key) ? undefined : disk.record(key)
      const existing: EntityRecord | undefined =
        rowOf(change.entity, change.entityId) ??
        (onDisk?.level === 'main'
          ? {
              entity: change.entity,
              entityId: change.entityId,
              value: undefined,
              provenance: { seq: onDisk.seq },
              asOf: onDisk.seq,
            }
          : undefined)
      if (existing !== undefined && existing.part !== 'stub') {
        // A whole record the feed keeps current needs no stub. Only a load
        // that replaces what the device held takes an unconfirmed record back
        // to the stub it delivered; a kind reload remembers it for its sweep.
        if (options.reload?.kinds.has(change.entity) && rowAsOf(existing) < at) {
          options.reload.stubs.set(key, { ...upsertOf(change, change.payload, at), part: 'stub' })
          continue
        }
        if (loadingSince === null || rowAsOf(existing) >= loadingSince) continue
        events.push({ type: 'released', entity: change.entity, entityId: change.entityId })
      } else if (existing !== undefined && at <= this.currencyOf(existing, loadingSince)) continue
      const op: CacheOperation = { ...upsertOf(change, change.payload, at), part: 'stub' }
      operations.push(op)
      const row = recordFromOp(op)
      staged.set(key, row)
      events.push({ type: 'stub-upserted', record: row })
    }
    const instances: InstanceOperation[] = []
    if (start) instances.push({ kind: 'dropAll' })
    const markRows: HeldRows = {
      readRow: (entity, entityId) => {
        const key = entityKey(entity, entityId)
        return staged.has(key)
          ? (staged.get(key) ?? undefined)
          : this.ruleRows.readRow(entity, entityId)
      },
    }
    const args = policyArgs(chunk.policy ?? this.store.readPolicy())
    for (const marker of chunk.complete ?? []) {
      const key = instanceKey(marker)
      // POD-7159: what a record comes with is not a marker of its own; the
      // answer's end records it on the holder (`completeComesWith`).
      if (marker.via !== undefined) {
        members?.comesWith.set(key, marker)
        continue
      }
      const held =
        marker.part === 'main' && members !== undefined
          ? members.membersOf(marker, args, markRows, this.now())
          : undefined
      // A later page carries no total: the first page's stays (POD-7158).
      const total =
        marker.total ??
        (start || marker.range === undefined
          ? undefined
          : this.store.readInstances().get(key)?.total)
      instances.push({
        kind: 'mark',
        instance: {
          key,
          collection: marker.collection,
          ...(marker.args === undefined || Object.keys(marker.args).length === 0
            ? {}
            : { args: marker.args }),
          part: marker.part,
          ...(marker.via === undefined ? {} : { via: marker.via }),
          ...(marker.range === undefined ? {} : { range: marker.range }),
          ...(total === undefined ? {} : { total }),
          completeAt: snapshot,
          ...(this.holds.has(key) ? {} : { releasedAt: this.now() }),
        },
        ...(held === undefined ? {} : { members: held }),
        at: this.now(),
      })
    }
    const mutation: CacheMutation = {
      operations,
      ...(instances.length === 0 ? {} : { instances }),
      ...(start
        ? {
            cursor: snapshot,
            kindTokens: chunk.kindTokens,
            loadingSince: at,
            policy: chunk.policy ?? null,
          }
        : chunk.policy === undefined
          ? {}
          : { policy: chunk.policy }),
    }
    if (operations.length === 0 && instances.length === 0 && !start && chunk.policy === undefined)
      return written
    // What `isComplete` answers moves with a marker written, or with markers
    // a full load's first chunk drops.
    const markersMoved =
      (chunk.complete?.length ?? 0) > 0 || (start && this.store.readInstances().size > 0)
    this.store.applyAtomic(mutation)
    if (start) this.cursorValue = snapshot
    this.batchEvents(() => {
      for (const event of events) this.emit(event)
      if (markersMoved) this.emit({ type: 'markers' })
    })
    return written
  }

  /**
   * The end of a load: sweep what it did not confirm, apply the frames that
   * arrived meanwhile, and go live — the old install's commit, now small.
   *
   * The sweep runs once every policy collection has its marker and what its
   * records come with has arrived ("Sidebar, with what it comes with"): a row
   * current only as of an earlier number than the load was not in any answer,
   * so it is gone or no longer visible. Before that the rows stay readable.
   */
  private async finishLoad(
    cause: RebootstrapCause,
    head: BootstrapChunk | undefined,
    generation: number,
    full: boolean,
    entityCount: number,
  ): Promise<void> {
    if (this.store.readLoadingSince() !== null && this.missingPolicyInstances().length === 0) {
      await this.fetchComesWith(generation)
      if (generation !== this.walkGeneration) return
    }
    const base = this.cursorValue as Cursor
    const snapshotSeq = head?.snapshotSeq ?? base.seq
    // POD-7122: every policy collection, and what its records come with, is in
    // the store now. The views open on it here; the durable commit below waits
    // for every chunk's write, and only it moves the posture live.
    if (
      this.store.readLoadingSince() !== null &&
      (this.store.readPolicy() === null || this.missingPolicyInstances().length === 0)
    ) {
      this.emit({ type: 'load-installed', cause, snapshotSeq })
    }
    // POD-7168: the chunks become durable first, with nothing of the last
    // commit staged, and fetched answers install meanwhile. The last commit is
    // read after them and waits only for itself. An adapter whose writes are
    // durable when they return has no `durable`.
    const named = new Set<string>()
    const durable = this.unitOfWork?.durable
    if (durable !== undefined) {
      this.tail = { generation, named }
      try {
        await durable.call(this.unitOfWork)
      } finally {
        if (this.tail?.generation === generation) this.tail = null
      }
      if (generation !== this.walkGeneration) return
    }
    await this.commitLoad(cause, generation, full, entityCount, snapshotSeq, named)
    if (this.state === 'live' && generation === this.walkGeneration) {
      await this.drainBuffer()
      if (this.state === 'live' && generation === this.walkGeneration) {
        this.requestMissingComesWith()
        this.scheduleTrim()
      }
    }
  }

  /** The load's last commit: its sweep, the frames that arrived meanwhile, and going live. */
  private async commitLoad(
    cause: RebootstrapCause,
    generation: number,
    full: boolean,
    entityCount: number,
    snapshotSeq: number,
    named: ReadonlySet<string>,
  ): Promise<void> {
    const base = this.cursorValue as Cursor
    // A COPY, and `this.buffer` is NOT cleared here (POD-1161): the consumed prefix
    // is removed inside the `adopt` closure below, in `span.onCommit`, so an aborted
    // commit leaves the frames for the restart.
    const buffered = [...this.buffer]
    // Fold the buffered frames against the cursor: a frame wholly covered is
    // dropped, an exact chain is applied whole, anything else heals.
    const chained: { changes: readonly ChangeEnvelope[]; cursor: Cursor }[] = []
    let running = base
    let gapAt = -1
    // The first buffered frame of ANOTHER identity than the cursor. It and what
    // follows stay buffered, so the drain after the load holds it to rung 4
    // (POD-6838: a walk buffers frames whatever cursor they disagree with).
    let foreignAt = -1
    for (let i = 0; i < buffered.length; i += 1) {
      const frame = buffered[i] as DeltaFrame
      if (frame.feedId !== base.feedId || frame.epoch !== base.epoch) {
        foreignAt = i
        break
      }
      if (frame.seq <= running.seq) {
        this.note('D6-BUFFER-COVERED')
        continue
      }
      if (frame.fromSeq !== running.seq) {
        gapAt = i
        break
      }
      const next: Cursor = { ...running, seq: frame.seq }
      chained.push({ changes: frame.changes, cursor: next })
      running = next
    }
    const loadingSince = this.store.readLoadingSince()
    const complete = this.store.readPolicy() === null || this.missingPolicyInstances().length === 0
    // POD-7168: read when the commit is written, after the fetches the load's
    // durable wait let in, and never a row one of them named.
    let swept: { readonly entity: string; readonly entityId: string }[] = []
    const decisions: FeedDecision[] = []
    // A load that replaced what the device held is a new truth, also when it
    // was resumed after an early close: it covers receipts the old rows owed.
    const replaces = full || loadingSince !== null
    await this.commitRegions(
      {
        matches: retirementsOf(chained.map((entry) => entry.changes)),
        through: running,
        install: replaces,
      },
      (span) => {
        const prepare = (): void => {
          if (generation !== this.walkGeneration) throw new Error('superseded bootstrap')
        }
        prepare()
        span?.join({ prepare, publish() {} })
        // POD-7159: over every row on the device, in memory or only on disk.
        swept = []
        if (complete && loadingSince !== null)
          for (const [key, entry] of this.store.readDiskIndex().records())
            if (entry.seq < loadingSince && !named.has(key)) swept.push(splitRowKey(key))
        const staged = new Map<string, EntityRecord | null>()
        for (const row of swept) staged.set(entityKey(row.entity, row.entityId), null)
        this.store.applyAtomic(
          {
            operations: swept.map((row) => ({
              kind: 'remove' as const,
              entity: row.entity,
              entityId: row.entityId,
            })),
            cursor: base,
            ...(complete ? { loadingSince: null } : {}),
          },
          span,
        )
        decisions.length = 0
        for (const entry of chained) {
          const decision = this.feedMutation(entry.changes, entry.cursor, staged)
          decisions.push(decision)
          this.store.applyAtomic(decision.mutation, span)
        }
      },
      () => {
        // Consume exactly the prefix this commit included. Frames that arrived while
        // the transaction was open are LATER in feed order and stay buffered for the
        // drain below — clearing outright would drop them.
        if (generation === this.walkGeneration)
          this.buffer = this.buffer.slice(foreignAt >= 0 ? foreignAt : buffered.length)
        this.note('D6-INSTALL')
        this.cursorValue = running
        if (full) this.exits.clear()
        for (const row of swept)
          this.emit({ type: 'released', entity: row.entity, entityId: row.entityId })
        this.emit({
          type: 'bootstrap-installed',
          cause,
          snapshotSeq,
          entityCount,
          bufferedFramesApplied: chained.length,
          ...(full ? {} : { dropped: swept.map(({ entity, entityId }) => ({ entity, entityId })) }),
        })
        // Same emission semantics as the live and heal paths — one function, so a
        // change applied after a load is projected exactly as a change applied live.
        chained.forEach((entry, at) => {
          this.emitApplied(entry.changes, entry.cursor, decisions[at])
        })
        for (const decision of decisions) this.request(decision.needs)

        if (generation !== this.walkGeneration) return
        this.setPosture('live')
        if (gapAt >= 0 || this.transportGap) {
          this.transportGap = false
          // DISCARD the unchainable remainder rather than re-buffering it: the frame
          // demands a fromSeq the fresh load cannot satisfy, so keeping it is an
          // infinite ladder (D7 resolves strictly DOWNWARD). One heal catches up,
          // resolved against the authority instead of against a stale buffer.
          this.note('D6-INSTALL-GAP', 'bootstrapping')
          this.buffer = []
          this.counters.pendingGap = true
          this.startHeal()
        }
      },
      replaces,
    )
  }

  // ─── Collections the device holds (POD-7086) ──────────────────────────────

  /**
   * The feed-apply table (design POD-7059 "The feed"), one change at a time in
   * feed order, against the rows as the earlier changes of the same batch
   * leave them:
   *
   * | the device holds                          | the change                       |
   * |-------------------------------------------|----------------------------------|
   * | the record with its main part             | replaces it                      |
   * | the issue as a stub, no held match        | updates the stub fields          |
   * | a stub or nothing, a held match           | keeps the whole record, and asks for what it comes with |
   * | nothing, no held match                    | ignored; an issue keeps its stub |
   *
   * A removal or an eviction applies as ever: the lookup answers "gone". A
   * device that has no policy yet (it never ran a collection download) holds
   * whatever the feed sends it.
   */
  private feedMutation(
    changes: readonly ChangeEnvelope[],
    cursor: Cursor,
    staged: Map<string, EntityRecord | null> = new Map(),
  ): FeedDecision {
    const everything = this.store.readPolicy() === null
    const index = everything ? undefined : this.heldIndex()
    const disk = this.store.readDiskIndex()
    const rows: HeldRows = {
      readRow: (entity, entityId) => {
        const key = entityKey(entity, entityId)
        return staged.has(key)
          ? (staged.get(key) ?? undefined)
          : this.store.readRow(entity, entityId)
      },
    }
    // What a rule reads: the rows as this batch leaves them, then the stub
    // columns of a record only on disk (a parent's id for a tree).
    const ruleRows: HeldRows = {
      readRow: (entity, entityId) =>
        staged.has(entityKey(entity, entityId))
          ? rows.readRow(entity, entityId)
          : this.ruleRows.readRow(entity, entityId),
    }
    const now = this.now()
    const operations: CacheOperation[] = []
    const ignored = new Set<ChangeEnvelope>()
    const stubbed = new Set<ChangeEnvelope>()
    const skipped = new Set<ChangeEnvelope>()
    const needs: InstanceSpec[] = []
    for (const change of changes) {
      const key = entityKey(change.entity, change.entityId)
      if (this.seen !== null) this.seen.set(key, Math.max(this.seen.get(key) ?? -1, change.seq))
      const existing = rows.readRow(change.entity, change.entityId)
      let op: CacheOperation | undefined
      if (change.op !== 'upsert') {
        op = { kind: change.op, entity: change.entity, entityId: change.entityId, asOf: change.seq }
      } else if (index === undefined) {
        op = upsertOf(change, change.payload, change.seq)
      } else {
        const memberOf = index.matching(change.entity, change.payload, ruleRows, now)
        // POD-7159: what it comes with for a holder (a session of a held issue),
        // by the holder's comes-with complete bit.
        const brought = comesWithHolders(
          change.entity,
          change.payload,
          index.args,
          ruleRows,
          now,
          disk,
        )
        // POD-7159: a record whole on disk and not in memory is whole too.
        const whole =
          existing !== undefined
            ? existing.part !== 'stub'
            : !staged.has(key) && disk.record(key)?.level === 'main'
        if (memberOf.length > 0 || brought.length > 0 || whole) {
          // Its holders, for the disk index: the instances it belongs to now,
          // and the records it comes with.
          const holders: string[] = [...brought]
          for (const instance of memberOf) {
            if (instance.spec.via === undefined) holders.push(instance.key)
            else {
              const holder = comesWithHolderOf(instance.spec)
              if (holder !== undefined) holders.push(comesWithHolderKey(holder))
            }
          }
          op = { ...upsertOf(change, change.payload, change.seq), holders }
          needs.push(...comesWithOf(change.entity, change.payload, memberOf, now))
        } else if (stubFieldsOf(change.entity).length > 0) {
          op = {
            ...upsertOf(change, stubOfValue(change.entity, change.payload), change.seq),
            part: 'stub',
          }
          stubbed.add(change)
        }
      }
      if (op === undefined) {
        ignored.add(change)
        continue
      }
      const next = rowAfter(existing, op)
      if (next === undefined) {
        // The newer one wins, per record: the row is current as of this
        // change or later already.
        skipped.add(change)
        continue
      }
      staged.set(key, next)
      operations.push(op)
    }
    return { mutation: { operations, cursor }, ignored, stubbed, skipped, needs }
  }

  /** The instances the device holds, as a change asks about them; new only when the markers or fetches change. */
  private heldIndex(): HeldIndex {
    const instances = this.store.readInstances()
    const policy = this.store.readPolicy()
    const cached = this.heldIndexCache
    if (
      cached !== undefined &&
      cached.instances === instances &&
      cached.policy === policy &&
      cached.version === this.inFlightVersion
    )
      return cached.index
    const index = new HeldIndex(instances, policyArgs(policy), this.inFlight.values())
    this.heldIndexCache = { instances, policy, version: this.inFlightVersion, index }
    return index
  }

  /** Ask for instances held records come with, batched into one fetch per burst. */
  private request(specs: readonly InstanceSpec[]): void {
    if (specs.length === 0 || this.authority.collections === undefined) return
    if (this.requestHook !== undefined) {
      const fresh = specs.filter((spec) => {
        const key = instanceKey(spec)
        return !this.inFlight.has(key) && !this.comesWithSatisfied(spec, key)
      })
      if (fresh.length > 0) this.requestHook(fresh)
      return
    }
    for (const spec of specs) {
      const key = instanceKey(spec)
      if (this.inFlight.has(key) || this.comesWithSatisfied(spec, key)) continue
      this.needs.set(key, spec)
    }
    if (this.needs.size === 0 || this.needsScheduled) return
    this.needsScheduled = true
    queueMicrotask(() => {
      this.needsScheduled = false
      const batch = [...this.needs.values()]
      this.needs.clear()
      if (batch.length > 0 && this.state !== 'bootstrapping' && this.state !== 'cold')
        void this.load(batch).catch(() => undefined)
    })
  }

  /** What every held record comes with that the device holds no marker for. */
  private requestMissingComesWith(): void {
    this.request(this.missingComesWith(this.store.readEntities()))
  }

  /** What these whole records come with that memory holds no marker for, nor fetches. */
  private missingComesWith(rows: readonly EntityRecord[]): InstanceSpec[] {
    if (this.store.readPolicy() === null || this.authority.collections === undefined) return []
    const index = this.heldIndex()
    const now = this.now()
    const specs = new Map<string, InstanceSpec>()
    for (const row of rows) {
      const memberOf = index.matching(row.entity, row.value, this.ruleRows, now)
      const holder = rowKeyOf(row.entity, row.entityId)
      for (const spec of comesWithOf(row.entity, row.value, memberOf, now)) {
        const key = instanceKey(spec)
        if (this.inFlight.has(key) || this.comesWithSatisfied(spec, key)) continue
        specs.set(key, spec)
        let asked = this.askedComesWith.get(key)
        if (asked === undefined) {
          asked = new Set()
          this.askedComesWith.set(key, asked)
        }
        asked.add(holder)
      }
    }
    return [...specs.values()]
  }

  /**
   * POD-7159 — whether the device holds what a comes-with instance selects:
   * a pointer, when its one record is whole on the device; the holder's own
   * things, when its comes-with through that via is complete. An instance
   * that is no comes-with is held when its marker is in memory.
   */
  private comesWithSatisfied(spec: InstanceSpec, key = instanceKey(spec)): boolean {
    if (spec.via === undefined) return this.inMemoryMarker(key) !== undefined
    const disk = this.store.readDiskIndex()
    const target = pointerTargetOf(spec)
    if (target !== undefined) return disk.record(target)?.level === 'main'
    const holder = comesWithHolderOf(spec)
    if (holder === undefined) return false
    return (
      disk.record(holder)?.cw.includes(spec.via) === true ||
      this.comesWithAnswered.get(holder)?.has(key) === true
    )
  }

  /**
   * POD-7159 — the end of an answer: what it brought for its holders. A row a
   * holder's own comes-with instance selects carries the holder; and each
   * holder whose comes-with through a via is now all on the device gets that
   * via (the comes-with complete bit, design "The disk index"). The holders:
   * those of the instances the answer completed, the records it named, and
   * those the instances were asked for.
   */
  private completeComesWith(members: AnswerMembers): void {
    if (members.comesWith.size === 0) return
    const disk = this.store.readDiskIndex()
    const args = policyArgs(this.store.readPolicy())
    const now = this.now()
    const ops: ComesWithOperation[] = []
    const candidates = new Set<string>()
    for (const [key, spec] of members.comesWith) {
      const holder = comesWithHolderOf(spec)
      if (holder !== undefined) {
        candidates.add(holder)
        let answered = this.comesWithAnswered.get(holder)
        if (answered === undefined) {
          answered = new Set()
          this.comesWithAnswered.set(holder, answered)
        }
        answered.add(key)
        for (const member of members.membersOf(spec, args, this.ruleRows, now) ?? [])
          ops.push({ kind: 'held', member, holder })
      }
      for (const asked of this.askedComesWith.get(key) ?? []) candidates.add(asked)
      this.askedComesWith.delete(key)
    }
    for (const key of members.namedKeys()) candidates.add(key)
    const index = this.heldIndex()
    for (const key of candidates) {
      const { entity, entityId } = splitRowKey(key)
      const row = this.store.read(entity, entityId)
      const entry = disk.record(key)
      if (row === undefined || entry === undefined) continue
      const done = new Map<string, boolean>()
      const answered = this.comesWithAnswered.get(key)
      const memberOf = index.matching(entity, row.value, this.ruleRows, now)
      const specs = comesWithOf(entity, row.value, memberOf, now)
      for (const spec of specs) {
        const via = spec.via as string
        const specKey = instanceKey(spec)
        const target = pointerTargetOf(spec)
        const ok =
          members.comesWith.has(specKey) ||
          answered?.has(specKey) === true ||
          (target !== undefined ? disk.record(target)?.level === 'main' : entry.cw.includes(via))
        done.set(via, (done.get(via) ?? true) && ok)
      }
      const vias = [...done].filter(([, ok]) => ok).map(([via]) => via)
      if (answered !== undefined) {
        for (const spec of specs)
          if (vias.includes(spec.via as string)) answered.delete(instanceKey(spec))
        if (answered.size === 0) this.comesWithAnswered.delete(key)
      }
      const same = vias.length === entry.cw.length && vias.every((via) => entry.cw.includes(via))
      if (!same) ops.push({ kind: 'complete', record: key, vias })
    }
    if (ops.length > 0) this.store.applyAtomic({ operations: [], comesWith: ops })
  }

  /**
   * The rows a collection rule reads (a parent's id for a tree): the row in
   * memory, or the stub columns of a record that is only on disk (POD-7159:
   * the stub table is complete over everything the device holds).
   */
  private readonly ruleRows: HeldRows = {
    readRow: (entity, entityId) => {
      const row = this.store.readRow(entity, entityId)
      if (row !== undefined) return row
      const stub = this.store.readStubTable(entity)?.stubOf(entityId)
      return stub === undefined
        ? undefined
        : { entity, entityId, value: stub, provenance: { seq: -1 }, part: 'stub' }
    },
  }

  /**
   * Inside a load: fetch what its records come with, and what those come
   * with, before the load sweeps, so a reload never takes a companion row off
   * the screen only to bring it back. Bounded by the declared links: a
   * parent chain ends at a top-level issue.
   */
  private async fetchComesWith(generation: number): Promise<void> {
    let rows: readonly EntityRecord[] = this.store.readEntities()
    for (let round = 0; round < 64 && rows.length > 0; round += 1) {
      if (generation !== this.walkGeneration) return
      const specs = this.missingComesWith(rows)
      if (specs.length === 0) return
      // POD-7159: what is on disk comes from disk, the rest from the server.
      const device = specs.filter((spec) => this.onDevice(spec))
      const server = specs.filter((spec) => !this.onDevice(spec))
      if (device.length > 0) await this.loadFromDisk(device)
      // Direct, not queued: the load itself runs on the queue (`run`), so a
      // step queued behind it would wait for the load that waits for it.
      rows = server.length === 0 ? [] : await this.fetchInstances(server, undefined, true)
    }
  }

  /**
   * Load instances (the loader's way in, POD-7087; what held records come
   * with). TWO SOURCES (POD-7159, design POD-7157 "The loader: two sources"):
   * an instance with a marker on disk that is not in memory is read from disk
   * into memory, with no server request (it works offline); a one-record
   * instance whose record is whole on disk is answered from the device; the
   * rest is fetched from the server, written to disk and memory together.
   */
  async load(requests: readonly InstanceRequest[]): Promise<void> {
    const device: InstanceRequest[] = []
    const server: InstanceRequest[] = []
    for (const request of requests) {
      const source = this.sourceOf(request)
      if (source === 'disk' || source === 'local') device.push(request)
      else server.push(request)
    }
    await Promise.all([
      device.length === 0 ? undefined : this.loadFromDisk(device),
      server.length === 0 ? undefined : this.loadFromServer(server),
    ])
  }

  /**
   * Whether the device can answer a request itself (POD-7159): from disk, or
   * a one-record instance from the record it holds. The loader sends those
   * without a connection too.
   */
  onDevice(spec: InstanceSpec): boolean {
    const source = this.sourceOf(spec)
    return source === 'disk' || source === 'local'
  }

  /**
   * Where a request is answered from. In memory already counts as the
   * server's, as before: the loader skips what is complete, and an explicit
   * load of a complete instance asks again.
   */
  private sourceOf(request: InstanceSpec): 'disk' | 'local' | 'server' {
    // What a record comes with is asked only when the device lacks it.
    if (request.via !== undefined) return 'server'
    const key = instanceKey(request)
    const marker = this.store.readInstances().get(key)
    const index = this.store.readDiskIndex()
    if (marker !== undefined) {
      if (index.inMemory(key)) return 'server'
      if (marker.part === 'stub' || index.instance(key)?.indexed === true) return 'disk'
      return 'server'
    }
    const record = oneRecordKey(request)
    if (record !== undefined && index.record(record)?.level === 'main') return 'local'
    return 'server'
  }

  /** POD-7159 — the instances' rows from disk into memory, and what they come with; never the server. */
  private async loadFromDisk(requests: readonly InstanceRequest[]): Promise<void> {
    const waits: Promise<void>[] = []
    const fresh: InstanceRequest[] = []
    for (const request of requests) {
      const answer = this.diskLoads.get(instanceKey(request))
      if (answer !== undefined) waits.push(answer)
      else fresh.push(request)
    }
    if (fresh.length > 0) {
      const task = this.diskLoad(fresh)
      const tracked = task.catch((error) => {
        if (error instanceof ReplicaStoreCorruptError) this.onCorruption()
        else if (this.failure === undefined) this.failure = error
      })
      for (const request of fresh) {
        const key = instanceKey(request)
        this.diskLoads.set(key, tracked)
        void tracked.then(() => {
          if (this.diskLoads.get(key) === tracked) this.diskLoads.delete(key)
        })
      }
      this.fetching = Promise.all([this.fetching, tracked]).then(() => undefined)
      waits.push(task)
    }
    await Promise.all(waits)
  }

  private residentPort(): ResidentLoadPort {
    return {
      index: this.store.readDiskIndex(),
      markers: this.store.readInstances(),
      policy: this.store.readPolicy(),
      now: this.now(),
      resident: (key) => {
        const { entity, entityId } = splitRowKey(key)
        return this.store.read(entity, entityId) !== undefined
      },
      read: (keys) => this.store.readDiskRows(keys),
      install: (rows) => {
        this.store.installResident(rows)
      },
    }
  }

  private async diskLoad(requests: readonly InstanceRequest[]): Promise<void> {
    const instances: InstanceRequest[] = []
    const records: InstanceRequest[] = []
    for (const request of requests) {
      const source = this.sourceOf(request)
      if (source === 'disk') instances.push(request)
      else if (source === 'local') records.push(request)
    }
    const port = this.residentPort()
    const { loaded } = await loadInstancesFromDisk(
      port,
      instances.map((request) => instanceKey(request)),
      {
        install: (rows) => this.installFromDisk(rows),
        row: (key) => {
          const { entity, entityId } = splitRowKey(key)
          return this.store.read(entity, entityId)
        },
      },
    )
    // A member the read did not bring (it changed on disk meanwhile) is read
    // once more; an instance still short of a member is asked of the server.
    const index = this.store.readDiskIndex()
    const short = (key: string): string[] =>
      [...index.membersOf(key)].filter(
        (member) => index.record(member)?.level === 'main' && !port.resident(member),
      )
    const again = new Set<string>()
    for (const key of loaded) for (const member of short(key)) again.add(member)
    if (again.size > 0) await this.installFromDisk(await this.store.readDiskRows([...again]))
    const complete: string[] = []
    const refetch: InstanceRequest[] = []
    const markers = this.store.readInstances()
    for (const key of loaded) {
      const marker = markers.get(key)
      if (marker === undefined) continue
      if (short(key).length === 0) complete.push(key)
      else refetch.push(requestOf(marker))
    }
    for (const request of instances) {
      const key = instanceKey(request)
      if (!loaded.includes(key) && !index.inMemory(key)) refetch.push(request)
    }
    // Memory only, so not queued behind the frame commits: a load waiting
    // for what its records come with runs this from inside the queue.
    if (complete.length > 0) {
      this.store.markInMemory(complete)
      this.batchEvents(() => this.emit({ type: 'markers' }))
    }
    if (records.length > 0) await this.answerFromDevice(records)
    if (refetch.length > 0) await this.loadFromServer(refetch)
    // What the rows now in memory come with and the disk does not hold: the server's.
    const rows: EntityRecord[] = []
    for (const key of complete)
      for (const member of index.membersOf(key)) {
        const { entity, entityId } = splitRowKey(member)
        const row = this.store.read(entity, entityId)
        if (row !== undefined) rows.push(row)
      }
    this.request(this.missingComesWith(rows))
  }

  /** Put rows read from disk in memory, one chunk per task and one burst of events per chunk. */
  private async installFromDisk(rows: readonly EntityRecord[]): Promise<void> {
    for (let at = 0; at < rows.length; at += DISK_INSTALL_ROWS) {
      await this.takeInstallTurn()
      const installed = this.store.installResident(rows.slice(at, at + DISK_INSTALL_ROWS))
      if (installed.length === 0) continue
      this.batchEvents(() => {
        for (const record of installed) this.emit({ type: 'upserted', record, readmitted: false })
      })
    }
  }

  /**
   * One-record instances whose record is whole on the device (POD-7159): the
   * feed keeps such a record current and it is visible, so the instance is
   * complete as of the cursor without asking the server. Its row is read from
   * disk first when it is not in memory.
   */
  private async answerFromDevice(requests: readonly InstanceRequest[]): Promise<void> {
    const keys = requests.flatMap((request) => {
      const key = oneRecordKey(request)
      return key === undefined ? [] : [key]
    })
    const absent = keys.filter((key) => {
      const { entity, entityId } = splitRowKey(key)
      return this.store.read(entity, entityId) === undefined
    })
    if (absent.length > 0) await this.installFromDisk(await this.store.readDiskRows(absent))
    // A marker alone, beside rows the device already holds: not queued (see `diskLoad`).
    {
      const cursor = this.cursorValue
      if (cursor === null) return
      const instances: InstanceOperation[] = []
      for (const request of requests) {
        const record = oneRecordKey(request)
        if (record === undefined) continue
        const { entity, entityId } = splitRowKey(record)
        if (this.store.read(entity, entityId) === undefined) continue
        const key = instanceKey(request)
        instances.push({
          kind: 'mark',
          instance: {
            key,
            collection: request.collection,
            ...(request.args === undefined ? {} : { args: request.args }),
            part: request.part,
            ...(request.via === undefined ? {} : { via: request.via }),
            completeAt: { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq },
            ...(this.holds.has(key) ? {} : { releasedAt: this.now() }),
          },
          members: [record],
          at: this.now(),
        })
      }
      if (instances.length === 0) return
      this.store.applyAtomic({ operations: [], instances })
      this.batchEvents(() => this.emit({ type: 'markers' }))
    }
  }

  /**
   * POD-7159 — take instances out of memory, keeping them on disk (design
   * "Leaving memory is not leaving the device"). Each row no other instance
   * in memory holds leaves memory; its readers see LOADING and a disk load,
   * never a removal. The policy collections stay resident. POD-7161 decides
   * when to call it; it waits for the fetches and disk loads in flight.
   */
  async unload(instanceKeys: string | readonly string[]): Promise<void> {
    const policy = new Set(
      policyInstances(this.store.readPolicy()).map((spec) => instanceKey(spec)),
    )
    const keys = (typeof instanceKeys === 'string' ? [instanceKeys] : instanceKeys).filter(
      (key) => !policy.has(key),
    )
    if (keys.length === 0) return
    for (let guard = 0; guard < 50 && (this.fetchCount > 0 || this.diskLoads.size > 0); guard += 1)
      await Promise.all([this.fetching, ...this.diskLoads.values()])
    await this.serial(() => {
      const left = this.store.unload(keys)
      this.batchEvents(() => {
        for (const row of left)
          this.emit({ type: 'unloaded', entity: row.entity, entityId: row.entityId })
        this.emit({ type: 'markers' })
      })
    })
  }

  /**
   * POD-7159's test hook (POD-7161 decides when memory lets go): unload every
   * instance in memory that no view holds, the policy's excepted.
   */
  async unloadForTest(): Promise<void> {
    const held = new Set(this.holds.keys())
    await this.unload(
      [...this.store.readDiskIndex().memoryInstances()].filter((key) => !held.has(key)),
    )
  }

  /** Whether a record is whole on disk and not in memory: a reader gets LOADING and a disk load. */
  isUnloaded(entity: string, entityId: string): boolean {
    return (
      this.store.readDiskIndex().record(rowKeyOf(entity, entityId))?.level === 'main' &&
      this.store.read(entity, entityId) === undefined
    )
  }

  /** POD-7159 — records whole on disk and not in memory, read into memory by key (never the server). */
  async loadRecords(entity: string, entityIds: readonly string[]): Promise<void> {
    const keys = entityIds
      .filter((id) => this.isUnloaded(entity, id))
      .map((id) => rowKeyOf(entity, id))
    if (keys.length === 0) return
    await this.installFromDisk(await this.store.readDiskRows(keys))
  }

  /** The server's answer to instances (the old `load`): written to disk and memory together. */
  private async loadFromServer(requests: readonly InstanceRequest[]): Promise<void> {
    const signal = this.fetchAbort.signal
    // POD-7169: an instance another fetch is answering now resolves with that
    // answer, not at once without one: the loader reads a load that resolved
    // without a marker as the server refusing it, and the lookup as gone.
    const answering = requests.flatMap((request) => {
      const answer = this.inFlightAnswers.get(instanceKey(request))
      return answer === undefined ? [] : [answer]
    })
    await this.fetchInstances(requests)
    await Promise.allSettled(answering)
    // A fetch a reload cut off was answered by nobody: the loader asks again.
    if (signal.aborted) throw new Error('the fetch was cut off by a reload')
  }

  private async fetchInstances(
    requests: readonly InstanceRequest[],
    reload?: KindReload,
    insideLoad = false,
  ): Promise<readonly EntityRecord[]> {
    const authority = this.authority
    if (authority.collections === undefined) return []
    // Bound to the authority: a class source reads its own fields (`this`).
    const collections = authority.collections.bind(authority)
    const fresh = requests.filter((request) => !this.inFlight.has(instanceKey(request)))
    if (fresh.length === 0) return []
    for (const request of fresh) this.inFlight.set(instanceKey(request), request)
    this.inFlightVersion += 1
    this.seen ??= new Map()
    this.fetchCount += 1
    const signal = this.fetchAbort.signal
    const written: EntityRecord[] = []
    /** Every record the answer named, written or already current on the device. */
    const named = new Map<string, { readonly entity: string; readonly entityId: string }>()
    const members = new AnswerMembers()
    const task = (async () => {
      try {
        // The earliest answer of a reload: a row of its kinds current only as
        // of an earlier number was in none of its answers.
        let reloadedAt: BootstrapChunk | undefined
        // POD-7165: the chunks of an answer that have ARRIVED install together,
        // as one store write and one burst of events, up to INSTALL_BATCH_ROWS
        // (the first download's walk does the same, POD-7122). One install per
        // chunk made every view re-derive once per chunk: a deck's tree and the
        // sessions of its 1,000 issues froze the page for minutes. The fetch
        // never waits for more data to install what it has, so an answer that
        // stalls or breaks off keeps every chunk it delivered.
        const pending: BootstrapChunk[] = []
        let pendingRows = 0
        const install = async (): Promise<void> => {
          if (pending.length === 0) return
          await this.takeInstallTurn()
          if (pending.length === 0) return
          const chunk = mergeChunks(pending)
          pending.length = 0
          pendingRows = 0
          const write = (): void => {
            written.push(
              ...this.installChunk(chunk, {
                signal,
                members,
                ...(reload === undefined ? {} : { reload }),
              }),
            )
          }
          if (insideLoad) write()
          else if (reload === undefined && this.tail?.generation === this.walkGeneration) {
            // The load waits for its chunks to be durable, with nothing of its
            // last commit staged: this answer need not wait too (POD-7168).
            const { named } = this.tail
            for (const change of chunk.changes) named.add(entityKey(change.entity, change.entityId))
            for (const change of chunk.stubs ?? [])
              named.add(entityKey(change.entity, change.entityId))
            write()
          } else await this.serial(write)
        }
        for (let at = 0; at < fresh.length; at += FETCH_MAX_INSTANCES) {
          const batch = fresh.slice(at, at + FETCH_MAX_INSTANCES)
          const chunks = collections(batch, signal)[Symbol.asyncIterator]()
          try {
            for (;;) {
              const next = chunks.next()
              let step: IteratorResult<BootstrapChunk> | typeof NOT_YET =
                pending.length === 0 ? await next : await arrivedBy(next)
              if (step === NOT_YET) {
                await install()
                step = await next
              }
              if (step.done === true) break
              const chunk = step.value
              if (signal.aborted) return
              this.validateChunk(chunk)
              const cursor = this.cursorValue
              if (cursor === null || cursor.feedId !== chunk.feedId || cursor.epoch !== chunk.epoch)
                throw new Error('a collection answer is for another feed')
              if (reloadedAt === undefined || chunk.snapshotSeq < reloadedAt.snapshotSeq)
                reloadedAt = chunk
              if (!insideLoad)
                for (const change of chunk.changes)
                  named.set(entityKey(change.entity, change.entityId), change)
              // Chunks merge only as of one feed number: newest wins per record.
              if (pending.length > 0 && pending[0]?.snapshotSeq !== chunk.snapshotSeq)
                await install()
              pending.push(chunk)
              pendingRows += rowsOfChunk(chunk)
              if (chunk.last) break
              if (pendingRows >= INSTALL_BATCH_ROWS) await install()
            }
            await install()
          } catch (error) {
            // The answer broke off: the chunks that arrived whole stay (POD-7086).
            if (!signal.aborted) await install()
            throw error
          } finally {
            pending.length = 0
            pendingRows = 0
            void chunks.return?.()?.catch(() => undefined)
          }
        }
        // Swept once, after every batch: sweeping after the first would take
        // rows off the screen that a later batch is about to confirm.
        if (reload !== undefined && reloadedAt !== undefined && !signal.aborted)
          await this.serial(() => this.sweepKinds(reload, reloadedAt as BootstrapChunk))
        // What the answer's records come with, on their holders (POD-7159).
        if (!signal.aborted) {
          if (insideLoad) this.completeComesWith(members)
          else await this.serial(() => this.completeComesWith(members))
        }
      } finally {
        for (const request of fresh) this.inFlight.delete(instanceKey(request))
        this.inFlightVersion += 1
        this.fetchCount -= 1
        if (this.fetchCount === 0) {
          this.seen = null
          if (this.trimAfterFetches) {
            this.trimAfterFetches = false
            this.scheduleTrim()
          }
        }
      }
      if (signal.aborted) return
      // What the records this answer brought come with (design "One loader"):
      // outside a load, fetched in the next batch; inside one, by the load itself.
      // Outside a load that is every record the answer named, not only those it
      // wrote: a record the device already held current (the sidebar's root of a
      // tree) has entered the fetched instance too, and comes with what that
      // instance declares (POD-7087).
      // While a load waits for its chunks to be durable (POD-7168) the answer
      // installed at once, so what it comes with is asked for at once too.
      if (this.state !== 'bootstrapping' || this.tail?.generation === this.walkGeneration) {
        const entered: EntityRecord[] = []
        for (const { entity, entityId } of named.values()) {
          const row = this.store.readRow(entity, entityId)
          if (row !== undefined && row.part !== 'stub') entered.push(row)
        }
        this.request(this.missingComesWith(insideLoad ? written : entered))
      }
      this.scheduleTrim()
    })()
    const tracked = task.catch((error) => {
      if (error instanceof ReplicaStoreCorruptError) this.onCorruption()
      else if (this.failure === undefined && !signal.aborted) this.failure = error
    })
    for (const request of fresh) {
      const key = instanceKey(request)
      this.inFlightAnswers.set(key, tracked)
      void tracked.then(() => {
        if (this.inFlightAnswers.get(key) === tracked) this.inFlightAnswers.delete(key)
      })
    }
    this.fetching = Promise.all([this.fetching, tracked]).then(() => undefined)
    await task
    return written
  }

  /**
   * A record shape changed (the kind tokens moved): reload the collections of
   * those kinds through the fetch, the old rows readable meanwhile. Returns
   * false when only a full load can do it (no policy, or no fetch route).
   */
  private reloadKinds(kinds: ReadonlySet<string>): boolean {
    if (this.authority.collections === undefined || this.store.readPolicy() === null) return false
    if (this.cursorValue === null || this.state === 'bootstrapping') return false
    const args = policyArgs(this.store.readPolicy())
    const marked = [...this.store.readInstances().values()].filter((instance) => {
      const of = resolveInstance(instance, args)?.of
      return of !== undefined && kinds.has(of)
    })
    const policy = policyInstances(this.store.readPolicy()).filter((spec) => {
      const of = resolveInstance(spec, args)?.of
      return of !== undefined && kinds.has(of)
    })
    const requests = new Map<string, InstanceRequest>()
    for (const instance of [...policy, ...marked]) {
      const { collection, part, args: instanceArgs, via } = instance
      requests.set(instanceKey(instance), {
        collection,
        part,
        ...(instanceArgs === undefined ? {} : { args: instanceArgs }),
        ...(via === undefined ? {} : { via }),
      })
    }
    this.emit({ type: 'heal', rung: 2, cause: 'kind-shape', partial: true })
    this.counters.bootstraps += 1
    const reload: KindReload = { kinds, stubs: new Map() }
    void this.serial(() => {
      if (marked.length > 0) {
        this.store.applyAtomic({
          operations: [],
          instances: marked.map((instance) => ({ kind: 'drop' as const, key: instance.key })),
        })
        this.emit({ type: 'markers' })
      }
    })
      .then(() => this.fetchInstances([...requests.values()], reload))
      .catch(() => undefined)
    return true
  }

  /** After a kind reload: rows of those kinds its answer did not confirm leave; an issue keeps its stub. */
  private sweepKinds(reload: KindReload, answer: BootstrapChunk): void {
    const at = answer.snapshotSeq
    const operations: CacheOperation[] = []
    const events: ReplicaEvent[] = []
    // POD-7159: over every row on the device, in memory or only on disk.
    for (const [key, entry] of this.store.readDiskIndex().records()) {
      const row = splitRowKey(key)
      if (!reload.kinds.has(row.entity) || entry.seq >= at) continue
      const stub = entry.level === 'stub' ? undefined : reload.stubs.get(key)
      if (stub !== undefined) {
        operations.push({ ...stub, force: true })
        events.push({ type: 'released', entity: row.entity, entityId: row.entityId })
        continue
      }
      operations.push({ kind: 'remove', entity: row.entity, entityId: row.entityId })
      events.push({ type: 'released', entity: row.entity, entityId: row.entityId })
    }
    const cursor = this.cursorValue
    this.store.applyAtomic({
      operations,
      ...(cursor === null ? {} : { cursor, kindTokens: answer.kindTokens }),
    })
    this.batchEvents(() => {
      for (const event of events) this.emit(event)
    })
  }

  /**
   * Hold an instance for an open view (design "Two holders of an instance").
   * The trim never drops a held instance; releasing it makes it cache, the
   * most recently released last to go. Returns the release.
   */
  hold(spec: InstanceSpec): () => void {
    const key = instanceKey(spec)
    const entry = this.holds.get(key) ?? { spec, count: 0 }
    entry.count += 1
    this.holds.set(key, entry)
    this.store.touchInstance(key, this.now())
    let released = false
    return () => {
      if (released) return
      released = true
      entry.count -= 1
      if (entry.count > 0) return
      this.holds.delete(key)
      void this.serial(() => {
        if (this.store.readInstances().has(key))
          this.store.applyAtomic({
            operations: [],
            instances: [{ kind: 'release', key, at: this.now() }],
          })
      }).catch(() => undefined)
      this.scheduleTrim()
    }
  }

  /**
   * The marker of an instance the device holds complete IN MEMORY; `undefined`
   * when it does not (POD-7159: a marker on disk whose rows are not in memory
   * is not an answer yet — the loader reads it from disk).
   */
  isComplete(spec: InstanceSpec): InstanceRecord | undefined {
    const key = instanceKey(spec)
    return this.inMemoryMarker(key)
  }

  private inMemoryMarker(key: string): InstanceRecord | undefined {
    const marker = this.store.readInstances().get(key)
    return marker !== undefined && this.store.readDiskIndex().inMemory(key) ? marker : undefined
  }

  /** The stub part of a record the device holds, stub or whole; `undefined` when absent. */
  stubOf(entity: string, entityId: string): Readonly<Record<string, unknown>> | undefined {
    const table = this.store.readStubTable(entity)
    if (table !== undefined) return table.stubOf(entityId)
    const row = this.store.readRow(entity, entityId)
    return row === undefined ? undefined : stubOfValue(entity, row.value)
  }

  /** The ids of the issues whose parent is `parentId`, over every issue on the device. */
  stubsByParent(parentId: string): readonly string[] {
    const out: string[] = []
    for (const kind of STUB_KINDS) {
      const children = this.store.readStubTable(kind)?.childrenOf(parentId)
      if (children !== undefined) out.push(...children)
    }
    return out
  }

  /** The issue at a reference (repository and number), by the stubs; the lowest id when several. */
  stubIdAt(entity: string, repoId: string, seq: number): string | undefined {
    return this.store.readStubTable(entity)?.idAt(repoId, seq)
  }

  /**
   * The stub part of every record of `entity` on the device, stubs and whole
   * records alike: what counts over all history read (design "Counts"). One
   * array per change of a stub, in no particular order. The store's table
   * (POD-7115): the one copy of the stubs in memory, current with every write.
   */
  stubRows(entity: string): readonly StubRow[] {
    return this.store.readStubTable(entity)?.rows() ?? []
  }

  /** Whether a load can start now: the device has a feed to answer against. */
  get canFetch(): boolean {
    return this.cursorValue !== null && this.authority.collections !== undefined
  }

  /** Trim the cache by instance now (design "Memory, cache and leaving"). */
  async trim(): Promise<void> {
    await this.serial(() => this.trimNow())
  }

  private scheduleTrim(): void {
    if (this.trimScheduled || this.store.readPolicy() === null) return
    // POD-7165: one trim once the fetches are done and quiet (TRIM_QUIET_MS),
    // not one after each of them. What a fetch in flight brings is kept
    // anyway (POD-7155).
    if (this.fetchCount > 0) {
      this.trimAfterFetches = true
      return
    }
    this.trimScheduled = true
    const timer = setTimeout(() => {
      this.trimTimer = undefined
      // A fetch started meanwhile: the trim waits for it, and then for quiet again.
      if (this.fetchCount > 0) {
        this.trimScheduled = false
        this.trimAfterFetches = true
        return
      }
      void this.serial(() => {
        this.trimScheduled = false
        this.trimNow()
      }).catch(() => undefined)
    }, TRIM_QUIET_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.trimTimer = timer
  }

  private trimNow(): void {
    const policy = this.store.readPolicy()
    if (policy === null || this.state === 'bootstrapping') return
    this.counters.trims += 1
    const held = new Set<string>([
      ...policyInstances(policy).map((spec) => instanceKey(spec)),
      ...this.holds.keys(),
      ...this.inFlight.keys(),
    ])
    const plan = planTrim({
      rows: this.store.readEntities(),
      instances: this.store.readInstances(),
      held,
      inFlight: [...this.inFlight.values()],
      policy,
      cap: policy.cacheCap,
      now: this.now(),
      store: this.store,
    })
    // POD-7159: the trim reads the rows in memory only, so it cannot tell what
    // an instance whose rows are on disk alone keeps; it never drops such a
    // marker (one not in memory, or holding a member that is only on disk).
    // Leaving the device is pruning's (POD-7162), never a side effect of memory.
    const disk = this.store.readDiskIndex()
    const evaluable = (key: string): boolean => {
      if (!disk.inMemory(key)) return false
      for (const member of disk.membersOf(key)) {
        if (disk.record(member)?.level !== 'main') continue
        const { entity, entityId } = splitRowKey(member)
        if (this.store.read(entity, entityId) === undefined) return false
      }
      return true
    }
    const dropInstances = plan.dropInstances.filter(evaluable)
    if (dropInstances.length === 0 && plan.toStub.length === 0 && plan.remove.length === 0) return
    const operations: CacheOperation[] = [
      ...plan.toStub.map(
        (row): CacheOperation => ({
          kind: 'upsert',
          entity: row.entity,
          entityId: row.entityId,
          value: stubOfValue(row.entity, row.value),
          ...(row.revision === undefined ? {} : { revision: row.revision }),
          provenance: row.provenance,
          part: 'stub',
          asOf: rowAsOf(row),
          force: true,
        }),
      ),
      ...plan.remove.map(
        (row): CacheOperation => ({ kind: 'remove', entity: row.entity, entityId: row.entityId }),
      ),
    ]
    this.store.applyAtomic({
      operations,
      instances: dropInstances.map((key) => ({ kind: 'drop' as const, key })),
    })
    this.batchEvents(() => {
      for (const row of [...plan.toStub, ...plan.remove])
        this.emit({ type: 'released', entity: row.entity, entityId: row.entityId })
      if (dropInstances.length > 0) this.emit({ type: 'markers' })
    })
  }

  /** Wait for a task in which no fetched answer has installed yet, and take it. */
  private async takeInstallTurn(): Promise<void> {
    while (this.installTurn !== null) await this.installTurn
    this.installTurn = nextTask().then(() => {
      this.installTurn = null
    })
  }

  /** Run a store step in order with the frame commits, and let the caller see its outcome. */
  private serial(task: () => void): Promise<void> {
    const step = this.inflight.then(task)
    this.inflight = step.then(
      () => undefined,
      (error) => {
        if (error instanceof ReplicaStoreCorruptError) this.onCorruption()
      },
    )
    return step
  }

  // ─── Rung 5 ───────────────────────────────────────────────────────────────

  private onCorruption(): TransitionOutcome {
    const from = this.state
    this.rebootstrap('local-corruption')
    return this.outcome('D7-5-CORRUPT', from)
  }

  /**
   * Everything rung 3 rejects, in one place so no route into the store can skip
   * it: generic frame/range shape, plus the injected known-kind check.
   *
   * The asymmetry is D4's and it is deliberate — an UNKNOWN entity kind is
   * accepted with an opaque value and the cursor advances past it, because
   * quarantining it would create an invisible permanent gap that heals to the same
   * rows forever. A KNOWN kind that fails its schema, or whose embedded id
   * disagrees with the envelope, is a rung-3 rejection.
   */
  /**
   * ADR 2 D5 / D7 rung 2 — is this replica's cursor below what the authority
   * still retains?
   *
   * To be served a delta from `cursor.seq` the authority must still hold
   * `cursor.seq + 1`, so the boundary is `cursor.seq + 1 < minAvailableSeq` and
   * NOT `cursor.seq < minAvailableSeq`. The off-by-one matters in the one case
   * that is common rather than exotic: a replica sitting exactly at the last
   * pruned seq is still perfectly healable, and the stricter comparison would
   * throw away its whole cache and re-bootstrap it for nothing every time the
   * authority pruned up to its cursor.
   *
   * This is NOT arbitration. The Replica decides nothing about truth here; it
   * reads a fact the Authority published about its own log and skips a round trip
   * whose answer that fact already determines. The authority remains free to
   * answer `bootstrap-required` for reasons this cannot see, and the heal path
   * still handles that — this only removes the trip that is knowably futile.
   */
  private belowRetentionFloor(frame: DeltaFrame): boolean {
    const cursor = this.cursorValue
    if (cursor === null) return false
    return cursor.seq + 1 < frame.minAvailableSeq
  }

  private rejects(frame: DeltaFrame): string | null {
    const shape = validateFrame(frame)
    if (shape !== null) return shape
    const validator = this.validator
    if (validator === undefined) return null
    for (const change of frame.changes) {
      if (!validator.knows(change.entity)) continue
      const reason = validator.validate(change)
      if (reason !== null) return reason
    }
    return null
  }

  // ─── Plumbing ─────────────────────────────────────────────────────────────

  private readCursorSafely(): Cursor | null {
    try {
      return this.store.readCursor()
    } catch (error) {
      if (error instanceof ReplicaStoreCorruptError) return null
      throw error
    }
  }

  /**
   * Queue one async ladder step, and NEVER leave the chain rejected (POD-1162).
   *
   * The `throw error` this replaces poisoned `inflight` permanently: a rejected promise
   * makes every later `.then(task)` skip its task, so ONE refused durable commit stopped
   * the replica dead — `connect()` took its transition, no `changesSince` was ever
   * issued, the buffered frame sat there forever, and `settled()` replayed the same
   * stale error to every future caller. Measured: `changesSince` call count 0 after a
   * commit refusal. D7 requires every failure to resolve strictly DOWNWARD and
   * terminate; that terminated nothing, it just stopped.
   *
   * POD-1158 is why this became reachable. Before it, a multi-region commit threw
   * synchronously out of `receive()` and never entered this chain at all; routing that
   * failure class through `inflight` is what turned a caller-visible throw into a wedge.
   *
   * So a failure is now SURFACED ONCE through `settled()` and the chain stays usable.
   * Nothing else is needed to recover: the commit did not apply, so the cursor did not
   * advance, so the next frame is a gap and takes rung 1 — the ladder does the rest. The
   * error is held rather than swallowed because a refused durable write must never be
   * silent (ADR 6 D4.4).
   */
  private run(task: () => Promise<void>): void {
    this.inflight = this.inflight.then(task).catch((error) => {
      if (error instanceof ReplicaStoreCorruptError) {
        this.onCorruption()
        return
      }
      // Held for the next `settled()`. First one wins: a later failure cannot hide an
      // earlier unreported one.
      if (this.failure === undefined) this.failure = error
    })
  }

  private setPosture(next: Posture): void {
    if (next === this.state) return
    const previous = this.state
    this.state = next
    // A row's `to` is the posture its effect settles on, so seal here rather than
    // making callers remember. A row that changes no posture keeps to === from,
    // which is also correct.
    this.sealTransitions()
    this.emit({ type: 'posture', posture: next, previous })
  }

  private transitionTo(next: Posture, rowId: string): TransitionOutcome {
    const from = this.state
    this.setPosture(next)
    return this.outcome(rowId, from)
  }

  private note(rowId: string, from: Posture = this.state): string {
    transitionRow(rowId) // fails loudly on a row that is not in the ADR's table
    // Seal the previous row's `to` before opening a new one: by the time the next
    // row fires, the previous one's effect has finished.
    this.sealTransitions()
    this.trace.push(rowId)
    // `from` is the posture BEFORE this row's effect ran. Several effects
    // (startHeal, rebootstrap) change posture synchronously, so reading
    // this.state here would record the DESTINATION as the source and make the
    // table look wrong when it was right.
    this.transitions.push({ rowId, from, to: this.state })
    this.pendingTransition = true
    return rowId
  }

  /** Stamp the observed post-state onto any row whose effect has now completed. */
  private sealTransitions(): void {
    if (!this.pendingTransition) return
    const last = this.transitions.at(-1)
    if (last !== undefined) last.to = this.state
    this.pendingTransition = false
  }

  private outcome(rowId: string, from: Posture = this.state): TransitionOutcome {
    this.note(rowId, from)
    this.sealTransitions()
    return {
      rowId,
      posture: this.state,
      cursor: this.cursorValue,
      rung: transitionRow(rowId).rung,
    }
  }
}

/**
 * Every retirement one transaction owes, in FEED ORDER across every frame the
 * transaction includes, deduplicated by provenance identity.
 *
 * Aggregating across frames is the bootstrap case and it is the reason this is a
 * function over a LIST of change lists: one install commits the snapshot plus every
 * buffered frame it chained, and per-frame batches inside that one transaction
 * would each stage from the same pre-commit outbox snapshot — the resurrection bug
 * again, one level up.
 *
 * Deduplication matters because two changes in one transaction can carry the same
 * provenance (an edit and its own follow-up row, or the same command anchored
 * per-principal at a shared seq, D14.3). A duplicate intent is noise at best, and at
 * worst a second retirement of an entry the first already removed.
 */
function retirementsOf(
  frames: readonly (readonly ChangeEnvelope[])[],
): readonly RetirementIntent[] {
  const seen = new Set<string>()
  const batch: RetirementIntent[] = []
  for (const changes of frames) {
    for (const change of changes) {
      // ADR 2 D8 — retirement is EXACT, by envelope provenance, for EVERY op that
      // carries it. A delete I authored must retire its outbox entry exactly as an
      // edit I authored does; matching on values instead would be arbitration.
      if (change.causationId === undefined && change.mutationId === undefined) continue
      const intent: RetirementIntent = {
        entity: change.entity,
        entityId: change.entityId,
        causationId: change.causationId,
        mutationId: change.mutationId,
      }
      const key = `${intent.entity}\u0000${intent.entityId}\u0000${intent.mutationId ?? ''}\u0000${intent.causationId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      batch.push(intent)
    }
  }
  return batch
}

/** The record a change describes, built from the ENVELOPE rather than read back. */
function recordOf(change: ChangeEnvelope): EntityRecord {
  return {
    entity: change.entity,
    entityId: change.entityId,
    value: change.payload,
    revision: change.revision,
    provenance: {
      seq: change.seq,
      originId: change.originId,
      causationId: change.causationId,
      mutationId: change.mutationId,
    },
  }
}

/** What the feed-apply table decided for one batch of changes. */
interface FeedDecision {
  readonly mutation: CacheMutation
  /** Upserts the device does not keep. */
  readonly ignored: ReadonlySet<ChangeEnvelope>
  /** Upserts kept as the issue's stub only. */
  readonly stubbed: ReadonlySet<ChangeEnvelope>
  /** Changes older than the row they would replace: skipped, and not announced. */
  readonly skipped: ReadonlySet<ChangeEnvelope>
  /** What the records it keeps whole come with. */
  readonly needs: readonly InstanceSpec[]
}

/** A kind reload in flight: its kinds, and the stubs its answer brought for whole records. */
interface KindReload {
  readonly kinds: ReadonlySet<string>
  readonly stubs: Map<string, CacheOperation & { readonly kind: 'upsert' }>
}

/** An upsert of one change's record, current as of `asOf`. ADR 2 D8: provenance BESIDE the value. */
function upsertOf(
  change: ChangeEnvelope,
  value: unknown,
  asOf: number,
): CacheOperation & { readonly kind: 'upsert' } {
  return {
    kind: 'upsert',
    entity: change.entity,
    entityId: change.entityId,
    value,
    revision: change.revision,
    provenance: {
      seq: change.seq,
      originId: change.originId,
      causationId: change.causationId,
      mutationId: change.mutationId,
    },
    asOf,
  }
}

/** The row an upsert writes. */
function recordFromOp(op: CacheOperation & { readonly kind: 'upsert' }): EntityRecord {
  return {
    entity: op.entity,
    entityId: op.entityId,
    value: op.value,
    revision: op.revision,
    provenance: op.provenance,
    ...(op.part === undefined ? {} : { part: op.part }),
    ...(op.asOf === undefined ? {} : { asOf: op.asOf }),
  }
}

/**
 * The record a one-record instance (`<kind>.one`, `{ id }`) selects, as a
 * row key; `undefined` for any other instance.
 */
function oneRecordKey(spec: InstanceSpec): string | undefined {
  const id = spec.args?.['id']
  if (typeof id !== 'string' || spec.part !== 'main' || spec.via !== undefined) return undefined
  const collection = COLLECTIONS.get(spec.collection)
  if (collection === undefined || spec.collection !== `${collection.of}.one`) return undefined
  return rowKeyOf(collection.of, id)
}

/** The request that asks for a marker's instance again. */
function requestOf(marker: InstanceRecord): InstanceRequest {
  return {
    collection: marker.collection,
    part: marker.part,
    ...(marker.args === undefined ? {} : { args: marker.args }),
    ...(marker.via === undefined ? {} : { via: marker.via }),
  }
}

/** The record types with a stub (POD-7115: their tables are the store's). */
const STUB_KINDS: readonly string[] = RECORDS.filter((record) => record.stub.length > 0).map(
  (record) => record.kind,
)

function rungFor(cause: RebootstrapCause): HealRung {
  switch (cause) {
    case 'malformed':
      return 3
    case 'epoch-mismatch':
      return 4
    case 'local-corruption':
      return 5
    case 'schema-version':
      return 6
    default:
      // compacted, resync-required, rescope, cold-start
      return 2
  }
}

/**
 * ADR 2 D7 rung 3 — the shipped semantic validation, restated over the certified
 * frame. D7 calls these protocol law and says not to relitigate them: each one is
 * a class of silent permanent divergence. Amendment 1 D13 changes exactly one
 * thing — contiguity is certified by the covered RANGE, so change seqs need only
 * be non-decreasing and inside it (anchored per-principal rows may SHARE a seq,
 * D14.3) instead of adjacent.
 *
 * Returns a reason string, or null when the frame is well-formed.
 */
export function validateFrame(frame: DeltaFrame): string | null {
  if (!Number.isInteger(frame.fromSeq) || !Number.isInteger(frame.seq)) return 'non-integer range'
  if (frame.fromSeq < 0 || frame.seq < 0) return 'negative range'
  if (frame.fromSeq > frame.seq) return 'inverted covered range'
  // D5's retention floor is part of the certificate, so a malformed one is a
  // malformed frame (rung 3) rather than a value to be coerced. Coercing is how
  // an absent floor becomes a silent 0 — see the field's note in `types.ts`.
  if (!Number.isInteger(frame.minAvailableSeq)) return 'non-integer minAvailableSeq'
  if (frame.minAvailableSeq < 0) return 'negative minAvailableSeq'
  if (frame.minAvailableSeq > frame.seq) return 'minAvailableSeq above the covered range'
  if (frame.fromSeq === frame.seq && frame.changes.length > 0) return 'changes in an empty range'
  let previous = frame.fromSeq
  for (const change of frame.changes) {
    if (!Number.isInteger(change.seq)) return 'non-integer seq'
    if (change.seq <= frame.fromSeq || change.seq > frame.seq)
      return 'change outside the covered range'
    if (change.seq < previous) return 'decreasing seq'
    previous = change.seq
    if (change.entity === '' || change.entityId === '') return 'empty entity id'
    // A payload is what distinguishes an upsert from the removal family. Getting
    // this wrong is how an evict becomes indistinguishable from a delete.
    if (change.op === 'upsert' && change.payload === undefined) return 'upsert without payload'
    if (change.op !== 'upsert' && change.payload !== undefined) return `${change.op} with payload`
  }
  return null
}

/** Validate a bootstrap chunk the same way, for adapters that want it up front. */
export function validateBootstrapChunk(chunk: BootstrapChunk): string | null {
  for (const change of chunk.changes) {
    if (change.op !== 'upsert') return 'bootstrap carries a non-upsert row'
    if (change.payload === undefined) return 'bootstrap upsert without payload'
    if (change.seq > chunk.snapshotSeq) return 'bootstrap row above the snapshot point'
  }
  return null
}
