import type { MutationId } from '@podium/model'
/**
 * FRAMEWORK IDEMPOTENCY — the ONE implementation (POD-382, closing POD-312's
 * "idempotency is framework-owned" clause).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY IT MOVED HERE
 * ---------------------------------------------------------------------------
 *
 * Until this issue the dedup mechanism was a METHOD ON A SESSION SERVICE —
 * `SessionsService.withMutation(mutationId, proc, fn)` — which every write wrapped
 * itself in, and which the issue registry reached by having the relay thread the
 * session service's method into its dependency literal. That shape had three
 * separate problems and only the first is obvious:
 *
 *   1. A per-proc wrapper is a per-proc chance to FORGET. POD-379's idempotency
 *      oracle exists because omitting it on one route is a silent, real regression.
 *   2. It made the issue family depend on the session family for a property that
 *      belongs to neither — `withMutation(mutationId, 'issues.close', …)` reads as
 *      an issue command borrowing a session service.
 *   3. It hid the async subtlety in a 5,600-line service, where the next author of
 *      a second copy would not find it. `JSON.stringify(promise)` is `'{}'`, so a
 *      naive copy durably records an empty result and poisons every replay.
 *
 * It lives in `@podium/sync` rather than in `apps/server` because the durable
 * mechanism it wraps is this package's (`SyncRepository.getAppliedMutation` /
 * `recordAppliedMutation`, docs/spec/outbox-write-path.md §2.1) and because a
 * framework property must not be reachable only through one app's service graph.
 *
 * ---------------------------------------------------------------------------
 * THE SEMANTICS, PRESERVED EXACTLY
 * ---------------------------------------------------------------------------
 *
 * The original relocation preserved these behaviors. Async store admission now
 * uses an in-flight reservation rather than an uninterrupted event-loop turn.
 *
 *   - No `mutationId` ⇒ no dedup at all. The write runs, every time, and NOTHING
 *     is recorded. (POD-379 pins this as must-not-change: the client outbox stamps
 *     an id only for the entries it queues.)
 *   - A recorded id returns its RECORDED result without running the body. The
 *     result travels through JSON, so a replay is deep-equal and not identical.
 *   - Check-run-record may yield at lookup, body, and receipt recording. The id is
 *     reserved before the lookup yields, so a replay joins rather than re-runs
 *     throughout that span, including for a synchronous body.
 *   - An async body records its RESOLVED value, and a REJECTED body records
 *     nothing — a failed mutation must be retryable, and recording it as applied
 *     would durably convert a transient failure into a permanent one.
 *   - A replay arriving while an async original is still in flight JOINS the same
 *     promise (both calls in one tRPC HTTP batch is the shipped case).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES *NOT* DO — the ordering, which belongs to the caller
 * ---------------------------------------------------------------------------
 *
 * Dedup must run AFTER authorization, never before: a replay of a write whose
 * grant has since been revoked has to be REJECTED, not served out of the dedup
 * cache (ADR 3 D8 / readiness §3.1.3 A1 — the cache must not launder a write the
 * principal may no longer make). This class therefore takes no principal and makes
 * no authorization decision; it is called by an envelope that has already
 * authorized. The two session envelopes (`PresenceRegistry.execute`,
 * `dispatchSessionCommand`) both do so in that order; a write route reaches a
 * handler only through its registration's entry point (ADR 12 D9,
 * `apps/server/src/modules/write-routes/write-routes.test.ts`).
 */

/**
 * The durable half, as the ledger needs it — the two `SyncRepository` methods and
 * nothing else.
 *
 * A structural `interface` rather than a `Pick<SyncRepository, …>` because the
 * ledger is also constructed over an in-memory double in tests, and because the
 * whole point of the relocation is that the ledger does not know what a store is.
 */
/** A prior storage key eligible only before an immutable upgrade boundary. */
export interface AppliedMutationFallback {
  readonly mutationId: MutationId
  readonly before: number
}

export interface AppliedMutationStore {
  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(
    mutationId: MutationId,
    fallback?: AppliedMutationFallback,
  ): string | undefined | Promise<string | undefined>
  recordAppliedMutation(
    mutationId: MutationId,
    proc: string,
    result: string,
    appliedAt: number,
  ): void | Promise<void>
}

/**
 * THE LARGEST RESULT A RECEIPT STORES WHOLE (POD-7035), in characters of its JSON.
 *
 * A receipt holds its command's answer so that a replay can return it. Some
 * answers are bulky: an issue command answers with the whole issue report, and
 * one task's panel made that 235 KB; `issues.mailInbox` answered with the whole
 * mailbox, 344 KB a call. Stored whole, they made `applied_mutations` the
 * largest table on the operator's database (760 MB, up to 150 MB a day). A
 * result above this size is stored as its command's DIGEST instead, when the
 * command can rebuild its answer from one ({@link ReceiptCompaction}); a command
 * that cannot still stores it whole.
 */
export const RECEIPT_RESULT_INLINE_MAX = 4096

/**
 * How a command whose answer can be large keeps its receipt small (POD-7035).
 *
 * EXACTLY ONCE IS UNCHANGED: a replay still never runs the body, so the write
 * still applies once. What a digest gives up is the byte-identical answer: the
 * replay rebuilds it from the digest and the current rows (an issue report as it
 * is now, a mailbox's messages as they are now with the original's unread
 * markers), which is what a caller that lost the first answer would read next.
 */
export interface ReceiptCompaction<T = unknown> {
  /**
   * The stand-in stored for `value`, a few hundred bytes of JSON; `undefined`
   * when this answer has none, and the result is stored whole.
   */
  digest(value: T): unknown
  /** The replay's answer, rebuilt from the stored digest. Runs no write. */
  replay(digest: unknown): Promise<T>
}

/** The one key of a stored digest, so a replay can tell it from a result. */
const DIGEST_KEY = '$receiptDigest'

/** The digest a stored receipt holds, or `undefined` when it holds a whole result. */
function storedDigest(stored: unknown): { digest: unknown } | undefined {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return undefined
  const keys = Object.keys(stored)
  if (keys.length !== 1 || keys[0] !== DIGEST_KEY) return undefined
  return { digest: (stored as Record<string, unknown>)[DIGEST_KEY] }
}

/** Whether a call APPLIED its body or REPLAYED a recorded result. */
export type MutationOutcome = 'applied' | 'replayed'

export interface MutationApplication<T> {
  outcome: MutationOutcome
  value: T
}

/**
 * Runs `fn` as ONE unit of work: everything it writes commits together or not at
 * all. The server passes its store's `transact`.
 */
export type MutationUnitOfWork = <T>(fn: () => Promise<T>) => Promise<T>

export interface MutationApplyOptions {
  /** An authorized legacy key, looked up with the current key in one statement. */
  readonly fallback?: AppliedMutationFallback
  /**
   * THE DEDUP RECORD INSIDE THE UNIT (ADR 2 D10, ADR 12 D2 step 7; POD-6273).
   *
   * Without a unit the body runs, and its result is recorded AFTER it returns, in
   * a write of its own. A failure between the two leaves a write that applied with
   * no record of it, and the client's retry applies it a second time.
   *
   * With a unit, the body and the record run inside it: they commit together, and
   * a rollback takes both, so the retry finds no record and runs again. The
   * durable lookup and the in-flight join stay outside the unit, so a replay opens
   * no transaction at all.
   *
   * With no `mutationId` the body still runs inside the unit; nothing is recorded.
   */
  readonly unit?: MutationUnitOfWork
  /**
   * How this command's large answers are stored and replayed
   * ({@link RECEIPT_RESULT_INLINE_MAX}). Without one, every result is stored
   * whole, and a stored digest cannot be replayed.
   */
  readonly compaction?: ReceiptCompaction
}

export class MutationLedger {
  /**
   * Mutations admitted by this ledger instance, held through durable recording.
   * A replay joins the SAME result instead of re-running. This is process-local
   * admission, not a database claim across independently constructed ledgers.
   */
  private readonly inFlight = new Map<string, Promise<MutationApplication<unknown>>>()

  constructor(
    private readonly store: AppliedMutationStore,
    private readonly now: () => number,
  ) {}

  /**
   * Run `body` at most once per `mutationId`, and say which happened.
   *
   * `proc` is the dotted command name the receipt is recorded under. It is
   * recorded but never READ by this class: dedup is keyed on the mutationId
   * ALONE, deliberately, because the client outbox replays one entry under one id
   * and a proc-qualified key would let the same queued write apply twice by
   * arriving on two transports.
   */
  async apply<T>(
    mutationId: MutationId | undefined,
    proc: string,
    body: () => T | Promise<T>,
    options: MutationApplyOptions = {},
  ): Promise<MutationApplication<Awaited<T>>> {
    const unit = options.unit
    if (!mutationId) {
      const value = unit ? await unit(async () => await body()) : await body()
      return { outcome: 'applied', value }
    }

    const inFlight = this.inFlight.get(mutationId)
    if (inFlight !== undefined) {
      return { outcome: 'replayed', value: (await inFlight).value as Awaited<T> }
    }

    // Establish the join point BEFORE the durable lookup yields. Two deliveries
    // arriving together must not both observe a missing row and run the body.
    const owner = (async (): Promise<MutationApplication<Awaited<T>>> => {
      const prior = await this.store.getAppliedMutation(mutationId, options.fallback)
      if (prior !== undefined) {
        const stored: unknown = JSON.parse(prior)
        const compacted = storedDigest(stored)
        if (compacted === undefined) return { outcome: 'replayed', value: stored as Awaited<T> }
        if (options.compaction === undefined) {
          // A receipt holds a digest only when a call with a compaction stored
          // it. A replay through a door without one cannot rebuild the answer,
          // and returning the digest as if it were the answer would be a lie.
          throw new Error(`the receipt of ${proc} holds a digest this call cannot replay`)
        }
        const value = (await options.compaction.replay(compacted.digest)) as Awaited<T>
        return { outcome: 'replayed', value }
      }
      const run = async (): Promise<Awaited<T>> => {
        const value = await body()
        await this.record(mutationId, proc, value, options.compaction)
        return value
      }
      const value = unit ? await unit(run) : await run()
      return { outcome: 'applied', value }
    })()
    // Share the promise the owner awaits: a derived value-only promise would
    // reject unobserved when no concurrent delivery joins it.
    this.inFlight.set(mutationId, owner)
    try {
      return await owner
    } finally {
      if (this.inFlight.get(mutationId) === owner) this.inFlight.delete(mutationId)
    }
  }

  /** {@link apply} when the caller does not need the outcome — the common case. */
  async once<T>(
    mutationId: MutationId | undefined,
    proc: string,
    body: () => T | Promise<T>,
    options: MutationApplyOptions = {},
  ): Promise<Awaited<T>> {
    return (await this.apply(mutationId, proc, body, options)).value
  }

  private async record(
    mutationId: MutationId,
    proc: string,
    value: unknown,
    compaction: ReceiptCompaction | undefined,
  ): Promise<void> {
    await this.store.recordAppliedMutation(
      mutationId,
      proc,
      storedResult(value, compaction),
      this.now(),
    )
  }
}

/** What a receipt stores for `value`: the result, or its digest when the result is large. */
export function storedResult(value: unknown, compaction: ReceiptCompaction | undefined): string {
  const whole = JSON.stringify(value ?? null)
  if (compaction === undefined || whole.length <= RECEIPT_RESULT_INLINE_MAX) return whole
  const digest = compaction.digest(value)
  if (digest === undefined) return whole
  return JSON.stringify({ [DIGEST_KEY]: digest })
}

/**
 * The ledger as a CONSUMER declares it.
 *
 * A `Pick` of the real class rather than a hand-written pair of signatures: a
 * restated signature is a second declaration that typechecks while drifting, and
 * the class above is where these two methods are already documented.
 */
export type MutationLedgerPort = Pick<MutationLedger, 'apply' | 'once'>
