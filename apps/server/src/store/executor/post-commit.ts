/**
 * The three post-commit mechanisms, with their separate failure contracts
 * [POD-3248, spec §3.3].
 *
 * Publication stays on the far side of commit, as it is today. What changes is
 * that "the tail" stops being one undifferentiated block of work whose failures
 * all mean the same thing. Three mechanisms, three contracts:
 *
 *   1. INTERNAL COMMIT APPLICATION — the baseline fold and the mandatory cache
 *      invalidations, in a defined order, NOT skippable. A failure here means
 *      the in-memory projection no longer matches the database: the store is
 *      marked unhealthy and refuses further work, which is today's contract
 *      (a reseed or a restart).
 *   2. DURABLE FOLLOW-UP WRITES — a write that used to be nested inside the span
 *      and is now an ordered follow-up on the same lease. Durable mail is never
 *      reclassified as best-effort, so these are AWAITED by the outer promise.
 *   3. EXTERNAL EFFECTS — sockets, notifications, process callbacks. Each is
 *      isolated by its own catch and reported to a sink; the outer promise does
 *      not wait for them.
 *
 * THE WAITING RULE, stated once: the promise `transact` returns resolves after
 * the COMMIT, after every commit application, and after every durable follow-up
 * (including those a follow-up itself registers). It does not wait for external
 * effects. A failure in (1) or (2) rejects that promise with an error that
 * carries `committed: true`, because the write DID commit and a caller must
 * never read the rejection as a rollback.
 *
 * ORDERING. The drain is a QUEUE, not recursion — the same shape, and for the
 * same reason, as the sync kernel's ordered pipe: a follow-up that commits
 * re-entrantly (a projection writing a derived row) pushes its batch and
 * returns, so batch N reaches every follow-up before N+1 begins. A plain
 * recursive call would deliver N+1 in the middle of N and hand delta clients a
 * permanent gap.
 */

import { PostCommitError, StoreUnhealthyError } from './errors'

export type PostCommitStep = () => void | Promise<void>

interface RegisteredStep {
  readonly step: PostCommitStep
  readonly label: string
}

/** What a body sees. Obtained from the ambient scope with `postCommit()`. */
export interface PostCommitRegistrar {
  /** Mechanism 1: ordered, not skippable, an invariant. */
  applyCommit(step: PostCommitStep, label?: string): void
  /** Mechanism 2: a durable write the outer promise waits for. */
  followUp(step: PostCommitStep, label?: string): void
  /** Mechanism 3: an external effect, isolated and not waited for. */
  effect(step: PostCommitStep, label?: string): void
}

/**
 * Steps registered by one scope. A savepoint's registry MERGES into its parent
 * on release and is DISCARDED on rollback, because a savepoint release is not a
 * commit: the work belongs to whoever actually commits.
 */
export class PostCommitRegistry implements PostCommitRegistrar {
  readonly commitApplications: RegisteredStep[] = []
  readonly followUps: RegisteredStep[] = []
  readonly effects: RegisteredStep[] = []

  applyCommit(step: PostCommitStep, label = 'commit-application'): void {
    this.commitApplications.push({ step, label })
  }

  followUp(step: PostCommitStep, label = 'follow-up'): void {
    this.followUps.push({ step, label })
  }

  effect(step: PostCommitStep, label = 'effect'): void {
    this.effects.push({ step, label })
  }

  get empty(): boolean {
    return (
      this.commitApplications.length === 0 &&
      this.followUps.length === 0 &&
      this.effects.length === 0
    )
  }

  mergeInto(parent: PostCommitRegistry): void {
    parent.commitApplications.push(...this.commitApplications)
    parent.followUps.push(...this.followUps)
    parent.effects.push(...this.effects)
    this.discard()
  }

  discard(): void {
    this.commitApplications.length = 0
    this.followUps.length = 0
    this.effects.length = 0
  }
}

export interface PostCommitRunnerOptions {
  /** Mechanism 1 failed: the projection and the database have diverged. */
  markUnhealthy: (error: unknown, label: string) => void
  /** Mechanism 3 failed: reported, never rethrown. */
  effectSink: (error: unknown, label: string) => void
}

/**
 * Drains registries for ONE lease, in order. There is one runner per lease
 * because phase 3 runs inside the scheduler's ordered operation.
 */
export class PostCommitRunner {
  private readonly queue: PostCommitRegistry[] = []
  private draining = false
  private readonly inFlightEffects = new Set<Promise<void>>()

  constructor(private readonly options: PostCommitRunnerOptions) {}

  /** True while a drain is in progress on this lease. */
  get busy(): boolean {
    return this.draining
  }

  /**
   * Run `registry`'s steps. When a drain is already in progress — the caller is
   * a follow-up committing re-entrantly — the registry is queued behind the
   * current batch and this returns at once; the outer drain runs it, and the
   * outer promise is still what waits for it.
   */
  async drain(registry: PostCommitRegistry): Promise<void> {
    if (!registry.empty) this.queue.push(registry)
    if (this.draining) return
    this.draining = true
    let failure: unknown
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.shift() as PostCommitRegistry
        for (const entry of batch.commitApplications) {
          try {
            await entry.step()
          } catch (error) {
            this.options.markUnhealthy(error, entry.label)
            // Not skippable and not recoverable: stop the drain rather than
            // fold further batches into a projection already known to be wrong.
            throw new StoreUnhealthyError(
              `commit application "${entry.label}" failed; the store is unhealthy and needs a ` +
                'reseed or a restart. The transaction itself committed.',
              error,
            )
          }
        }
        for (const entry of batch.followUps) {
          try {
            await entry.step()
          } catch (error) {
            // Keep draining: the remaining batches must still reach their
            // subscribers in order. The first failure is what the caller sees.
            failure ??= new PostCommitError(
              'follow-up',
              `durable follow-up "${entry.label}" failed after the transaction committed`,
              error,
            )
          }
        }
        for (const entry of batch.effects) this.dispatch(entry)
      }
    } finally {
      this.draining = false
    }
    if (failure) throw failure
  }

  /** Every external effect started on this lease and not yet settled. */
  async effectsSettled(): Promise<void> {
    while (this.inFlightEffects.size > 0) {
      await Promise.all([...this.inFlightEffects])
    }
  }

  private dispatch(entry: RegisteredStep): void {
    let result: void | Promise<void>
    try {
      result = entry.step()
    } catch (error) {
      this.options.effectSink(error, entry.label)
      return
    }
    if (!isThenable(result)) return
    const tracked = result.then(
      () => undefined,
      (error: unknown) => this.options.effectSink(error, entry.label),
    )
    this.inFlightEffects.add(tracked)
    void tracked.finally(() => this.inFlightEffects.delete(tracked))
  }
}

function isThenable(value: unknown): value is Promise<void> {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
