import { createLogger } from '@podium/logger'
import type { MetadataChange, MetadataEntityKind, Principal } from '@podium/protocol'
import type { ArbitrationRejection } from './authority/arbitration'
import { Authority } from './authority/authority'
import type {
  StagedChangeSpec as KernelChangeSpec,
  ScopedChange,
} from './authority/change-lifecycle'
import type {
  AuthorityCommit,
  BaselineFoldPort,
  PostCommitFollowUpPort,
  ProvenancePort,
  RecordSourcePort,
} from './authority/ports'
import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  type ChangeLogStore,
  pruneChangeLog,
} from './change-log'
import type { FeedVisibilityPolicy, VisibilityAnchorPort } from './feed/visibility'
import {
  CHANGE_LOG_OBSERVER,
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
} from './feed/visibility'
import { type WriteScope, WriteScopeIssuer, type WriteScopeMint } from './write-scope'

/** This package runs on BOTH hosts (server and client), so the namespace names
 *  the module and the `role` field on every record names the host — no
 *  host-specific import, and no second logger per platform. */
const log = createLogger('sync:ledger')

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
 * A commit names no records: the database captures which model rows its
 * write changed, and the Authority appends the whole records those rows reach
 * (POD-6920). Source writes and appends share the transaction, and the
 * outermost commit owns subscriber delivery.
 */

/**
 * One appended entity change in this facade's `id` spelling. Composed from
 * the kernel change shape; provenance passes through unchanged.
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
  transact: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Runs subscriber delivery after the OUTERMOST unit of work commits
   * [POD-3260, spec §3.3 mechanism 3]. Passed straight to the Authority — see
   * `AuthorityDeps.postCommit` for why a nested commit's own span is not the
   * boundary that matters. Unset means immediate, which is what the tests and
   * every client adapter want.
   */
  postCommit?: PostCommitFollowUpPort
  /**
   * Where a commit's `apply` waits for the OUTERMOST commit [POD-3328]. Unset
   * means it applies as soon as the commit returns, which is what a
   * pass-through `transact` in a unit test wants.
   */
  applyCommit?: BaselineFoldPort
  /** Monotonic clock seam for deterministic maintenance scheduling tests. */
  monotonicNow?: () => number
  visibility?: FeedVisibilityPolicy
  anchors?: VisibilityAnchorPort
  /** D14.4's terminal-path bound, passed to the Authority (its default when absent). */
  rescopeThreshold?: number
  listenerPrincipal?: Principal
  /** The command now appending, passed straight to the Authority — see
   *  `AuthorityDeps.provenance` (POD-6272). Unset stamps nothing. */
  provenance?: ProvenancePort
  /** The records built from the model tables and the drained change capture,
   *  passed straight to the Authority: see `AuthorityDeps.records` (POD-6920).
   */
  records: RecordSourcePort
}

export interface LedgerBootOptions {
  repo: ChangeLogStore
  now: () => number
  signal?: AbortSignal
  monotonicNow?: () => number
  onPruneMetrics?: Parameters<typeof pruneChangeLog>[1]['onMetrics']
}

/**
 * Real-server readiness gate: finish the sliced boot prune before
 * the server starts serving catch-up reads.
 */
export async function prepareLedgerBoot(options: LedgerBootOptions) {
  return await pruneChangeLog(options.repo, {
    keepRows: CHANGE_KEEP_ROWS,
    maxAgeMs: CHANGE_MAX_AGE_MS,
    now: options.now(),
    signal: options.signal,
    monotonicNow: options.monotonicNow,
    onMetrics: options.onPruneMetrics,
  })
}

export class AuthorityArbitrationRejected extends Error {
  constructor(
    readonly reason: ArbitrationRejection,
    readonly detail?: string,
  ) {
    super(`Authority rejected the write: ${reason}`)
    this.name = 'AuthorityArbitrationRejected'
  }
}

/**
 * ONE SPELLING OF `Ledger.commit`'s OP, so a narrow port cannot omit an arm
 * [POD-3366].
 *
 * Seven interfaces in `apps/server` declare a narrow ledger port for their own
 * feature — `IssueLedger`, `SessionLedger`, `MemoryLedger`, `KillLedger`,
 * `ShippingLedgerPort` and the two arbitration wrappers. Each of them restated
 * `{ write, changes }` by hand, so adding the `apply` arm to the facade left
 * every one of those ports unable to express it, and a call site that tried
 * failed to typecheck with "'apply' does not exist in type". Seven hand-copies
 * of one shape is the same failure this issue exists to remove, one layer up:
 * the next arm would have to be remembered in seven places.
 *
 * Composed rather than restated from here on. A port that wants to REFUSE an
 * arm now has to say so — `Omit<LedgerCommitOp<T>, 'apply'>` — which is a
 * decision in the type instead of an omission nobody notices.
 */
export interface LedgerCommitOp<T> {
  /**
   * The durable write. It receives the commit's {@link WriteScope}, which the
   * mutating methods of a synced table's repository require (ADR 12 D9,
   * POD-6594): a synced table is written only here, inside the commit that
   * appends its change entry, never beside it.
   */
  write: (scope: WriteScope) => Promise<T>
  /** Post-commit work, run on the OUTERMOST commit. See {@link Ledger.commit}. */
  apply?: (result: T, changes: MetadataChange[]) => void
  arbitrate?: AuthorityCommit<T>['arbitrate']
}

/** What {@link Ledger.commit} returns: the write's result and the appended rows. */
export interface LedgerCommitResult<T> {
  result: T
  changes: MetadataChange[]
}

/** The commit bound to one write scope. The scope is exposed only in `write`. */
export interface LedgerWriter {
  commit<T>(op: LedgerCommitOp<T>): Promise<LedgerCommitResult<T>>
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
  /** Who may write (ADR 12 D9): every commit names a scope this
   *  issuer handed out. */
  private readonly scopes = new WriteScopeIssuer()

  constructor(private readonly deps: LedgerDeps) {
    this.authority = new Authority({
      store: deps.repo,
      now: deps.now,
      transact: deps.transact,
      ...(deps.postCommit === undefined ? {} : { postCommit: deps.postCommit }),
      ...(deps.provenance === undefined ? {} : { provenance: deps.provenance }),
      records: deps.records,
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
      ...(deps.rescopeThreshold === undefined ? {} : { rescopeThreshold: deps.rescopeThreshold }),
    })
    // One subscription, translating the kernel's vocabulary into this facade's.
    // Registered in the CONSTRUCTOR rather than lazily on first listener: the
    // Authority delivers batches in append order through one queue, and joining
    // that queue late would put this facade's listeners behind changes they were
    // registered before.
    this.authority.subscribe(deps.listenerPrincipal ?? CHANGE_LOG_OBSERVER, (delivery) => {
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
          log.error('onAppended listener threw', { err })
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
   * `apply(result, changes)` is where a caller's own PROJECTION INSTALL goes —
   * the map write, the cache bump, the runtime teardown, the "this is now the
   * committed state" assignment that used to sit on the statement after this
   * call returned [POD-3366]. It runs as a commit application (spec §3.3
   * mechanism 1) of the OUTERMOST commit: registered through
   * {@link LedgerDeps.applyCommit} when a span is open, run inline when none is.
   *
   * IT TAKES THE APPENDED CHANGES AS WELL AS THE RESULT, because a site asked
   * for them and closing over them is not safe: `const { changes } = commit(…)`
   * is not assigned yet when the inline path calls `apply` from INSIDE the same
   * call, so a closure over the destructured binding is a temporal-dead-zone
   * error on exactly the path with no span open. The two arguments are what
   * this commit produced, handed to the arm rather than reached for.
   *
   * WHY THE ARM EXISTS AT ALL, AND WHY THE STATEMENT AFTER THE CALL IS WRONG.
   * This method runs its body inside `transact()`, and when the caller already
   * has a span open that `transact` is a SAVEPOINT. A savepoint release is not
   * a commit: the enclosing span can still roll back and take these rows with
   * it. So the statement after `commit()` returns runs on the success path of
   * something that has not necessarily succeeded, and an install placed there
   * records a fact the database may throw away. Thirteen of twenty-two audited
   * call sites did exactly that (POD-3328, POD-3361, and the audit attached to
   * POD-3361). The arm is how the caller says "after it is durable" without
   * having to know whether it is nested — which it cannot see.
   *
   * IT CANNOT LIVE IN `Authority.finalize`, where the baseline fold lives, and
   * that is not an accident of layering: `finalize` returns early when every
   * declared change deduped away, and a fully-deduped commit still made the
   * durable write whose install the caller owes. So the arm hangs off the
   * COMMIT, not off the appended rows.
   *
   * ORDER. With a span open the baseline fold registers first (inside
   * `authority.commit`) and this registers second, so the ledger's own baseline
   * is folded before the caller's projection reads it — the same order as the
   * inline path, where `finalize` applies the fold before this line is reached.
   *
   * NO ABORT ARM, deliberately. A rollback is not reported; work that never
   * became durable is dropped on the way IN, by whoever stages it, when it next
   * finds no span open. That is what makes the design hold under a crash and
   * not merely under a caught exception, and an abort hook would put a
   * must-not-forget obligation back where this arm just removed one.
   *
   * The optional arbitration request is a compatibility bridge for production
   * feature writers that still consume this facade. The decision is delegated to
   * the SAME Authority instance; this class does not compare revisions itself.
   */
  async commit<T>(scope: WriteScope, op: LedgerCommitOp<T>): Promise<LedgerCommitResult<T>> {
    this.scopes.check(scope)
    const outcome = await this.authority.commit({
      ...(op.arbitrate === undefined ? {} : { arbitrate: op.arbitrate }),
      write: async () => await op.write(scope),
    })
    if (outcome.outcome !== 'committed') {
      throw new AuthorityArbitrationRejected(outcome.reason, outcome.detail)
    }
    const changes = outcome.changes.map(toWireChange)
    if (op.apply) {
      // Asked AFTER the commit, when `spanOpen()` answers about the CALLER's
      // span rather than this commit's own.
      const apply = op.apply
      const fold = this.deps.applyCommit
      if (fold?.spanOpen()) {
        fold.onCommit(() => apply(outcome.result, changes), 'ledger-commit-application')
      } else {
        apply(outcome.result, changes)
      }
    }
    return { result: outcome.result, changes }
  }

  /**
   * THE MINT (ADR 12 D9, POD-6592), handed out once, to the composition root:
   * the sync write entry point gets its `sync` half, the server's declared
   * write origins their `system` scopes. Nothing else can make a scope.
   */
  takeScopeMint(): WriteScopeMint {
    return this.scopes.takeMint()
  }

  /**
   * The commit bound to one scope: what a write context hands a handler
   * or a service, so the scope is chosen once, where the context is made, and
   * not at every call. Checked here, so a foreign scope fails at binding.
   */
  writer(scope: WriteScope): LedgerWriter {
    this.scopes.check(scope)
    return {
      commit: async (op) => await this.commit(scope, op),
    }
  }

  /** In-process observer catch-up; null means the cursor cannot be served. */
  async changesSince(cursor: number | null): Promise<MetadataChange[] | null> {
    const delivery = await this.authority.changesSince(cursor, CHANGE_LOG_OBSERVER)
    if (delivery === null) return null
    if (delivery.kind !== 'batch') return null
    return delivery.changes.map(toWireChange)
  }

  /** Current cursor — the highest seq ever assigned (0 before any change). */
  async cursor(): Promise<number> {
    return await this.authority.cursor()
  }

  /** Fires after commit with the appended changes (never with
   *  an empty batch). Per-listener try/catch so a listener throw can't break the
   *  committer. Returns an unsubscribe. */
  onAppended(listener: (changes: MetadataChange[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
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
