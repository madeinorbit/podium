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
 * `dispatchSessionCommand`) both do so in that order, and the audit
 * (`scripts/audit-session-commands.ts`) asserts it structurally rather than
 * trusting each caller.
 */

/**
 * The durable half, as the ledger needs it — the two `SyncRepository` methods and
 * nothing else.
 *
 * A structural `interface` rather than a `Pick<SyncRepository, …>` because the
 * ledger is also constructed over an in-memory double in tests, and because the
 * whole point of the relocation is that the ledger does not know what a store is.
 */
export interface AppliedMutationStore {
  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(mutationId: MutationId): string | undefined | Promise<string | undefined>
  recordAppliedMutation(
    mutationId: MutationId,
    proc: string,
    result: string,
    appliedAt: number,
  ): void | Promise<void>
}

/** Whether a call APPLIED its body or REPLAYED a recorded result. */
export type MutationOutcome = 'applied' | 'replayed'

export interface MutationApplication<T> {
  outcome: MutationOutcome
  value: T
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
  ): Promise<MutationApplication<Awaited<T>>> {
    if (!mutationId) return { outcome: 'applied', value: await body() }

    const inFlight = this.inFlight.get(mutationId)
    if (inFlight !== undefined) {
      return { outcome: 'replayed', value: (await inFlight).value as Awaited<T> }
    }

    // Establish the join point BEFORE the durable lookup yields. Two deliveries
    // arriving together must not both observe a missing row and run the body.
    const owner = (async (): Promise<MutationApplication<Awaited<T>>> => {
      const prior = await this.store.getAppliedMutation(mutationId)
      if (prior !== undefined) {
        return { outcome: 'replayed', value: JSON.parse(prior) as Awaited<T> }
      }
      const value = await body()
      await this.record(mutationId, proc, value)
      return { outcome: 'applied', value: value as Awaited<T> }
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
  ): Promise<Awaited<T>> {
    return (await this.apply(mutationId, proc, body)).value
  }

  private async record(mutationId: MutationId, proc: string, value: unknown): Promise<void> {
    await this.store.recordAppliedMutation(
      mutationId,
      proc,
      JSON.stringify(value ?? null),
      this.now(),
    )
  }
}

/**
 * The ledger as a CONSUMER declares it.
 *
 * A `Pick` of the real class rather than a hand-written pair of signatures: a
 * restated signature is a second declaration that typechecks while drifting, and
 * the class above is where these two methods are already documented.
 */
export type MutationLedgerPort = Pick<MutationLedger, 'apply' | 'once'>
