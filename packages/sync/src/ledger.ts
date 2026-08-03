import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { type Principal } from '@podium/protocol'
import { Authority } from './authority/authority'
import {
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
  DEVICE_GRADE_PRINCIPAL,
} from './feed/visibility'
import type { FeedVisibilityPolicy, VisibilityAnchorPort } from './feed/visibility'
import type {
  StagedChangeSpec as KernelChangeSpec,
  ScopedChange,
} from './authority/change-lifecycle'
import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  type ChangeLogStore,
  pruneChangeLog,
} from './change-log'

/**
 * Ledger — now a FACADE over the Authority role (POD-305).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FACADE AND NOT A SECOND IMPLEMENTATION
 * ---------------------------------------------------------------------------
 *
 * POD-305 moved the write seam into `./authority`, where it is joined with the
 * funnel's authorize step and its ordered broadcast pipe. Two implementations of
 * "commit the entity write and the change append together" is precisely the
 * intermediate state this programme exists to stop creating — the two would
 * dedup differently the first time one was fixed — so there is ONE, and this
 * class delegates to it.
 *
 * What survives here is the OLD VOCABULARY, and only that: this spec spells the
 * target-id key `id` while the kernel and the model spell it `entityId`. Every
 * server call site passes `id`, so renaming it would have made this issue's diff
 * the migration of every call site in `apps/server` — the large surprise diff the
 * fan-out protocol names as the most common cause of a review round-trip. The
 * rename lands with POD-306/POD-308, which are already touching those sites.
 *
 * Callers of NEW code should use `Authority` directly. This exists so the cutover
 * is incremental rather than a flag day.
 *
 * ---------------------------------------------------------------------------
 * The original contract, unchanged and still true of the implementation:
 *
 * Where the old oplog sat at the BROADCAST seam and inferred changes by
 * diffing full entity lists at fan-out time, the Ledger captures changes at
 * the moment they are made: {@link commit} runs the entity write and the
 * change append inside ONE injected `transact()` span, so "the entity row
 * changed" and "the change log says so" commit or roll back together.
 *
 * Mapping from the oplog.s `partial` flag (issue #22):
 * - `capture()` explicitly appends non-row mutations owned by a service seam.
 *   Like commit it never diffs a list; unlike commit it has no entity-row write
 *   to share a transaction with.
 * - `commit()` NEVER diffs lists. The `changes()` callback declares exactly
 *   what the write touched; a declared `remove` is explicit. There is no
 *   subset/full-list ambiguity, so `partial` does not exist here.
 * - The full-list remove-diff survives ONLY in {@link reconcile}: a boot-only
 *   pass fed the full truth for one entity kind, which diffs against the
 *   baseline INCLUDING removes — covering anything that changed or vanished
 *   while the server was down (the oplog's full-truth `record()` mode).
 *
 * Dedup (./change-log.ts): byte-equality on the
 * serialized wire JSON, except conversations, which compare on the
 * stable-field projection (updatedAt/messageCount/statusHint excluded from
 * DETECTION while the durable payload stays the full wire value — the
 * 81MB/day churn fix). No-op upserts and removes of ids the log never
 * recorded are dropped; a fully-deduped commit appends nothing.
 *
 * The in-memory baseline is mutated only after the transact span returns
 * successfully — a throw anywhere inside (write, changes(), append) rolls the
 * durable state back and leaves the baseline untouched.
 */

/**
 * One declared entity change, as the PRE-CUTOVER facade spells it.
 *
 * Composed from {@link KernelChangeSpec} (`StagedChangeSpec`) rather than
 * restated (POD-1251): the only intentional difference is the target-id key
 * name — this facade still says `id`, the kernel says `entityId`. Provenance
 * remains optional on the kernel shape and is simply unused by current call
 * sites; it is not stripped, so a future writer can pass it without a second
 * type.
 *
 * `toKernelSpec` is the ONE place the two spellings meet.
 */
export type EntityChangeSpec = Omit<KernelChangeSpec, 'entityId'> & { id: string }

/**
 * The composite overlay key. RE-EXPORTED from the Authority rather than declared
 * twice: two implementations of one key function is one edit away from two
 * different separators, and the failure mode is silent key collision between the
 * baseline and whatever reads it.
 */
export { entityOverlayKey } from './authority/authority'

export interface LedgerDeps {
  repo: ChangeLogStore
  now: () => number
  /** Runs fn atomically with any ambient entity write. INJECTED — the Ledger
   *  never imports the sqlite helper; composition wires it later (to the
   *  nesting-safe `transaction(db, fn)` over the shared connection). Unit
   *  tests may pass a pass-through `(fn) => fn()`. */
  transact: <T>(fn: () => T) => T
  /** Monotonic clock seam for deterministic maintenance scheduling tests. */
  monotonicNow?: () => number
  /** Records each retention job's total duration and max uninterrupted slice. */
  onPruneMetrics?: Parameters<typeof pruneChangeLog>[1]['onMetrics']
  visibility?: FeedVisibilityPolicy
  anchors?: VisibilityAnchorPort
  listenerPrincipal?: Principal
}

export interface LedgerBootOptions {
  repo: ChangeLogStore
  now: () => number
  signal?: AbortSignal
  monotonicNow?: () => number
  onPruneMetrics?: Parameters<typeof pruneChangeLog>[1]['onMetrics']
}

/**
 * Real-server readiness gate [spec:SP-c29e]: finish the sliced boot prune before
 * any Ledger construction can fold or reconcile the retained change log.
 */
export function prepareLedgerBoot(options: LedgerBootOptions) {
  return pruneChangeLog(options.repo, {
    keepRows: CHANGE_KEEP_ROWS,
    maxAgeMs: CHANGE_MAX_AGE_MS,
    now: options.now(),
    signal: options.signal,
    monotonicNow: options.monotonicNow,
    onMetrics: options.onPruneMetrics,
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class Ledger {
  /**
   * THE implementation, and the composition root's seam onto it.
   *
   * PUBLIC so the server can hand the SAME instance to its write funnel. Two
   * Authority instances over one store would be a real bug and a quiet one:
   * each keeps its own dedup baseline, so a change committed through one would
   * look novel to the other and be appended twice, and each keeps its own
   * ordered broadcast queue, so the append-order guarantee would hold within
   * each and between neither.
   */
  readonly authority: Authority
  private readonly listeners = new Set<(changes: MetadataChange[]) => void>()
  private readonly shutdown = new AbortController()
  private pruneFlight: Promise<void> | undefined
  private pruneRerunRequested = false

  constructor(private readonly deps: LedgerDeps) {
    this.authority = new Authority({
      store: deps.repo,
      now: deps.now,
      transact: deps.transact,
      // THE DEVICE-GRADE HALF, DECLARED RATHER THAN DEFAULTED (POD-1077).
      //
      // POD-1075 landed real `UserAccount`s, per-user `client_sessions` and grant
      // edges as model types, so a principal is finally EXPRESSIBLE. It did not
      // land per-user login: `packages/runtime/src/auth-store.ts` is still one
      // shared password and `apps/server/src/gateway/client-principal.ts` still
      // asserts `CLIENT_PRINCIPAL_GRADE === 'device'`. Two connections presenting
      // that password are indistinguishable AS PERSONS.
      //
      // A filter is only as correct as the authenticator naming the principal it
      // filters for, so this composition root — the pre-cutover oplog facade —
      // names the ONE policy that matches its transport, by an exported name that
      // says what it is. `bun run audit:scoped-feed` holds the site list at
      // exactly this one, so a second `DeviceGradeUnscopedPolicy` cannot appear
      // quietly; when per-user login lands, deleting that export is what forces
      // every site to name a real policy.
      visibility: deps.visibility ?? new DeviceGradeUnscopedPolicy(),
      anchors: deps.anchors ?? new DeviceGradeNoAnchors(),
    })
    // One subscription, translating the kernel's vocabulary into this facade's.
    // Registered in the CONSTRUCTOR rather than lazily on first listener: the
    // Authority delivers batches in append order through one queue, and joining
    // that queue late would put this facade's listeners behind changes they were
    // registered before.
    this.authority.subscribe(deps.listenerPrincipal ?? DEVICE_GRADE_PRINCIPAL, (delivery) => {
      // D14.4's terminal arm is unreachable from here — `DeviceGradeNoAnchors`
      // reports no visibility edges, so no anchored row is ever derived and the
      // threshold cannot be crossed. Handled rather than cast, because "cannot
      // happen" plus a cast is how a silently dropped delivery ships.
      if (delivery.kind !== 'batch') {
        throw new Error(
          `Ledger: the Authority produced a '${delivery.kind}' delivery for the device-grade ` +
            `principal. This facade is the PRE-CUTOVER wire (POD-308 owns the new one) and cannot ` +
            `express it. A real visibility policy here needs the wire cutover first (ADR 2 Am1 D17.2).`,
        )
      }
      const wire = delivery.changes.map(toWireChange)
      for (const listener of this.listeners) {
        try {
          listener(wire)
        } catch (err) {
          console.error('[ledger] onAppended listener threw', err)
        }
      }
    })
  }

  /**
   * THE write seam: runs `write()` and the change append inside ONE `transact()`
   * span. `changes(result)` declares what changed; dedup drops no-op upserts (and
   * removes of ids not in the baseline). Returns the write result plus the
   * appended wire rows (empty if fully deduped). A throw from `write`, `changes`,
   * or the append rolls everything back and leaves the baseline untouched.
   *
   * No `authorize` and no `arbitrate` parameter, deliberately: this facade is the
   * pre-POD-305 contract, and adding the new steps to it would let a call site
   * take half the funnel. A caller that wants them uses `Authority` directly.
   */
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  } {
    const outcome = this.authority.commit({
      write: op.write,
      changes: (result: T) => op.changes(result).map(toKernelSpec),
    })
    // Unreachable while this facade passes no `arbitrate`: with no arbitration
    // request there is no verdict, so `commit` cannot reject. Asserted rather
    // than assumed, because "cannot happen" plus a cast is how a silently
    // dropped write ships.
    if (outcome.outcome !== 'committed') {
      throw new Error(
        `Ledger.commit: the Authority rejected a write this facade never asked it to arbitrate ` +
          `(${outcome.reason}). That is a kernel invariant break, not a caller error.`,
      )
    }
    return { result: outcome.result, changes: outcome.changes.map(toWireChange) }
  }

  /**
   * Capture an explicitly owned mutation with no durable entity-row write to bind
   * to (volatile session view state, an upstream mirror). The caller supplies the
   * exact upserts/removes; this never diffs a full list.
   */
  capture(specs: EntityChangeSpec[]): MetadataChange[] {
    return this.authority.capture(specs.map(toKernelSpec)).map(toWireChange)
  }

  /**
   * Boot-only reconciliation: `rows` is the FULL truth for one entity kind.
   * Diffs against the baseline INCLUDING removes — the only surviving full-list
   * diff path — so changes made while the server was down land in the log before
   * the first client reads it.
   */
  reconcile(entity: MetadataEntityKind, rows: { id: string; value: unknown }[]): MetadataChange[] {
    return this.authority.reconcile(entity, rows).map(toWireChange)
  }

  /** Catch-up read for `sync.changesSince` — null means "fall back to a
   *  snapshot" (bootstrap / compacted-past-cursor / future cursor / corrupt row). */
  changesSince(cursor: number | null): MetadataChange[] | null {
    const delivery = this.authority.changesSince(cursor, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) return null
    if (delivery.kind !== 'batch') return null
    return delivery.changes.map(toWireChange)
  }

  /** Current cursor — the highest seq ever assigned (0 before any change). */
  cursor(): number {
    return this.authority.cursor()
  }

  /** Cancel maintenance between bounded units during server shutdown. */
  dispose(): void {
    this.pruneRerunRequested = false
    this.shutdown.abort()
  }

  /** Fires after commit/capture/reconcile with the appended changes (never with
   *  an empty batch). Per-listener try/catch so a listener throw can't break the
   *  committer. Returns an unsubscribe. */
  onAppended(listener: (changes: MetadataChange[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * [spec:SP-c29e] Coalesce overlapping cadence triggers into the current
   * retention flight plus at most one rerun.
   */
  private schedulePrune(): void {
    if (this.shutdown.signal.aborted) return
    if (this.pruneFlight) {
      this.pruneRerunRequested = true
      return
    }
    const flight = this.drainPruneRequests()
    this.pruneFlight = flight
    const clear = () => {
      if (this.pruneFlight === flight) this.pruneFlight = undefined
    }
    void flight.then(clear, (err) => {
      clear()
      console.error('[ledger] retention prune failed (writes remain durable)', err)
    })
  }

  private async drainPruneRequests(): Promise<void> {
    let failed = false
    let failure: unknown
    do {
      this.pruneRerunRequested = false
      try {
        const { metrics } = await pruneChangeLog(this.deps.repo, {
          keepRows: CHANGE_KEEP_ROWS,
          maxAgeMs: CHANGE_MAX_AGE_MS,
          now: this.deps.now(),
          signal: this.shutdown.signal,
          monotonicNow: this.deps.monotonicNow,
          onMetrics: this.deps.onPruneMetrics,
        })
        if (metrics.exceededPlacementThreshold) {
          console.warn(
            `[ledger] retention job took ${metrics.totalDurationMs.toFixed(1)}ms; ` +
              'candidate for janitor placement',
          )
        }
      } catch (err) {
        if (!failed) failure = err
        failed = true
      }
    } while (this.pruneRerunRequested && !this.shutdown.signal.aborted)
    if (failed) throw failure
  }
}

/** This facade's `id` spelling → the kernel's `entityId`. The ONE place the two
 *  vocabularies meet, so the rename POD-306/POD-308 finish is one deletion. */
function toKernelSpec(spec: EntityChangeSpec): KernelChangeSpec {
  const base = { entity: spec.entity, entityId: spec.id, op: spec.op }
  return spec.op === 'upsert' ? { ...base, value: spec.value } : base
}

/** The kernel's sequenced change → the pre-cutover wire row. */
function toWireChange(change: ScopedChange): MetadataChange {
  // The PRE-CUTOVER wire has two ops (`@podium/protocol`'s `MetadataChange`);
  // `evict` is the third, and POD-308 owns bringing the wire onto the scoped
  // vocabulary. Refused loudly rather than silently coerced into `remove`, which
  // is exactly the substitution Amendment 1 D14.5 makes normative: the replica
  // would render a revoked share as a deletion, and a later re-grant as a
  // resurrection. Unreachable while this facade names `DeviceGradeNoAnchors`.
  if (change.op === 'evict') {
    throw new Error(
      `Ledger: an 'evict' row reached the pre-cutover wire, which cannot express it. ` +
        `'remove' is NOT a substitute (ADR 2 Am1 D14.5) — the wire cutover (POD-308) comes first.`,
    )
  }
  const base = { seq: change.seq, id: change.entityId, op: change.op }
  return (
    change.op === 'upsert'
      ? { ...base, entity: change.entity, value: change.value }
      : { ...base, entity: change.entity }
  ) as MetadataChange
}
