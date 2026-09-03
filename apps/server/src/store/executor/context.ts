/**
 * Ambient scope: what an executor call is inside, and whether it may still run
 * [POD-3248, spec §3.1/§3.2].
 *
 * Re-entrancy is decided by AsyncLocalStorage, NOT by handle identity as
 * today's `transaction(db, fn)` helper decides it. Handle identity was sound
 * only because nothing could yield: with awaits in the picture two unrelated
 * bodies share the handle, so depth keyed on it is a shared counter, and the
 * store already had to open a second unwrapped handle to work around that
 * (`store/repos.ts`). The scope is the caller's, so it travels with the call.
 *
 * THREE VALUES, and every operation routes on them:
 *   root         — no transaction open. Statements go through the scheduler.
 *   transaction  — inside a body. Statements go to that transaction's session,
 *                  after the token check.
 *   post-commit  — inside phase 3, on the lease that just committed. Routes to
 *                  the ROOT (the transaction is closed) but stays inside the
 *                  scheduler's ordered operation, so a later commit cannot
 *                  overtake publication.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Lane } from './driver'
import {
  ParallelNestedTransactionError,
  StaleTransactionError,
  TransactionPoisonedError,
} from './errors'
import type { PostCommitRegistry, PostCommitRunner } from './post-commit'
import type { Lease } from './scheduler'

/**
 * The handle an operation is checked against. It is the TOKEN, not the callback
 * boundary, that enforces "nothing runs after its commit": a promise the body
 * forgot to await resolves later and finds its token dead.
 */
export interface TransactionToken {
  readonly id: number
  active(): boolean
}

/**
 * State shared by a top-level transaction and every savepoint under it.
 *
 * `poisoned` holds the boundary failure that made the engine's transaction
 * state unknown. It is on the UNIT rather than the frame because a savepoint's
 * failure is the whole transaction's problem: the frame stack no longer
 * describes what the engine holds.
 */
export interface TransactionUnit {
  poisoned: unknown
  /**
   * Statements this unit has ADMITTED and that have not yet resolved.
   *
   * The token refuses work that arrives after a scope ended; it says nothing
   * about work that was let through and is still parked inside
   * `DriverSession.execute` when the body returns. On the remote driver that
   * statement is a round trip in flight on the connection the scope is about to
   * commit and hand back, so the scope must WAIT for it rather than commit
   * underneath it. It is on the UNIT, not the frame, because a savepoint's
   * statements run on the same session as its parent's.
   */
  readonly inFlight: InFlight
}

/**
 * A count of admitted-but-unresolved work, and a way to wait for it to reach
 * zero. See {@link TransactionUnit.inFlight} for why waiting is the answer here
 * rather than refusing.
 */
export interface InFlight {
  readonly count: number
  /** Count `work` while it runs. The count drops BEFORE the caller resumes. */
  track<T>(work: () => Promise<T>): Promise<T>
  /** Resolves once the count reaches zero. */
  settled(): Promise<void>
}

export function createInFlight(): InFlight {
  let count = 0
  let waiting: (() => void)[] = []
  const done = (): void => {
    count--
    if (count > 0) return
    const waiters = waiting
    waiting = []
    for (const resolve of waiters) resolve()
  }
  return {
    get count() {
      return count
    },
    track(work) {
      count++
      return work().then(
        (value) => {
          done()
          return value
        },
        (error: unknown) => {
          done()
          throw error
        },
      )
    },
    settled() {
      if (count === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
    },
  }
}

/**
 * Wait until nothing this tracker admitted is still running.
 *
 * A LOOP, not one await: a continuation the body dropped can be resumed by the
 * very statement we are waiting for and admit another one before the scope has
 * closed, so a single `settled()` would return with work still in flight.
 */
export async function settleInFlight(inFlight: InFlight): Promise<void> {
  while (inFlight.count > 0) await inFlight.settled()
}

/** One `transact` scope: the top-level transaction, or a savepoint under it. */
export interface TransactionFrame {
  readonly id: number
  readonly lane: Lane
  readonly lease: Lease
  readonly depth: number
  readonly parent: TransactionFrame | undefined
  readonly token: TransactionToken
  readonly unit: TransactionUnit
  readonly postCommit: PostCommitRegistry
  /**
   * An EXTERNAL lifetime this frame is bound to, on top of its own token.
   *
   * A phase-3 transaction runs on the lease the post-commit drain holds, and
   * that drain can end while one of the transaction's own awaits is still in
   * flight — a follow-up that started a `transact` and did not return its
   * promise. The frame's `active` cannot see that: nothing closes the frame,
   * because nobody told it. So the frame carries the scope's own liveness and
   * refuses with it. The root path passes {@link ALWAYS_ALIVE}.
   */
  readonly alive: () => boolean
  /** The open nested scope, if any. Only the innermost frame is addressable. */
  child: TransactionFrame | undefined
  active: boolean
}

/** A frame with no lifetime beyond its own token: everything at the root. */
export const ALWAYS_ALIVE = (): boolean => true

export type StoreScope =
  | { readonly kind: 'root' }
  | { readonly kind: 'transaction'; readonly frame: TransactionFrame }
  | {
      readonly kind: 'post-commit'
      readonly lease: Lease
      readonly runner: PostCommitRunner
      /** Statements this scope admitted on the held lease. See {@link TransactionUnit.inFlight}. */
      readonly inFlight: InFlight
      /**
       * The post-commit scope has the SAME lifetime problem a transaction frame
       * has, and needs the same token: the lease it routes to is released when
       * the drain ends, so a continuation that resolves later would address a
       * connection the scheduler has handed back.
       */
      active(): boolean
    }

const ROOT: StoreScope = { kind: 'root' }

const storage = new AsyncLocalStorage<StoreScope>()

export function currentScope(): StoreScope {
  return storage.getStore() ?? ROOT
}

export function runInScope<T>(scope: StoreScope, fn: () => T): T {
  return storage.run(scope, fn)
}

/**
 * Run `fn` at the ROOT scope, whatever scope the caller is in.
 *
 * This is how an external effect is dispatched. An effect is not waited for, so
 * its continuation resumes after the drain returned and the lease was released;
 * inheriting the post-commit scope would send that continuation to a connection
 * the scheduler no longer owns — which on a reusable remote client means
 * executing out of order on someone else's session rather than failing. At the
 * root it queues through admission like any other caller.
 */
export function runAtRoot<T>(fn: () => T): T {
  return storage.run(ROOT, fn)
}

let nextFrameId = 1

export function createFrame(input: {
  lane: Lane
  lease: Lease
  parent: TransactionFrame | undefined
  postCommit: PostCommitRegistry
  alive?: () => boolean
}): TransactionFrame {
  const id = nextFrameId++
  const frame: TransactionFrame = {
    id,
    lane: input.lane,
    lease: input.lease,
    depth: input.parent ? input.parent.depth + 1 : 0,
    parent: input.parent,
    unit: input.parent ? input.parent.unit : { poisoned: undefined, inFlight: createInFlight() },
    postCommit: input.postCommit,
    // A savepoint inherits its parent's: the whole unit dies with the lease.
    alive: input.alive ?? input.parent?.alive ?? ALWAYS_ALIVE,
    child: undefined,
    active: true,
    token: {
      id,
      active: () => frame.active,
    },
  }
  return frame
}

/**
 * The check every operation makes. Two refusals, one rule: you may only address
 * the innermost frame that is still open.
 *
 * Savepoints are a stack, so two nested branches running at once would release
 * each other's boundaries; and a statement issued on the parent while a child
 * savepoint is open is the same interleaving in the other direction.
 */
export function assertAddressable(frame: TransactionFrame): void {
  if (frame.unit.poisoned !== undefined) {
    throw new TransactionPoisonedError(
      `transaction ${frame.id} is poisoned: a savepoint boundary failed, so what the engine ` +
        'still holds open is unknown and nothing further may be issued on it.',
      frame.unit.poisoned,
    )
  }
  if (!frame.active) {
    throw new StaleTransactionError(
      `transaction ${frame.id} is closed: an operation reached it after its scope ended. ` +
        'A promise the body did not await is the usual cause.',
    )
  }
  if (!frame.alive()) {
    throw new StaleTransactionError(
      `transaction ${frame.id} ran on a lease that has been released: the post-commit drain ` +
        'that held the connection ended while this transaction was still in flight. A ' +
        'follow-up that did not return its transaction promise is the usual cause.',
    )
  }
  if (frame.child) {
    throw new ParallelNestedTransactionError(
      `transaction ${frame.id} has an open nested scope (${frame.child.id}); only the ` +
        'innermost scope may be addressed. Two nested transactions in parallel are not ' +
        'supported: savepoints are a stack.',
    )
  }
}

/**
 * Record a boundary failure on the frame's unit. The FIRST one is kept: it is
 * the point after which the transaction state stopped being known.
 */
export function poisonUnit(frame: TransactionFrame, cause: unknown): void {
  if (frame.unit.poisoned === undefined) frame.unit.poisoned = cause
}

/**
 * Close a frame. Called before its body's result is returned, always.
 *
 * It CASCADES, because a nested scope whose promise the body dropped is never
 * closed by anyone: `runNested` claimed it on the parent and then parked. Left
 * open it stays addressable, so a statement resuming inside it passes the token
 * check and reaches a session its parent has already committed and handed back
 * to the scheduler. Closing the chain is what makes that a refusal.
 */
export function closeFrame(frame: TransactionFrame): void {
  frame.active = false
  for (let abandoned = frame.child; abandoned; abandoned = abandoned.child) {
    abandoned.active = false
  }
  if (frame.parent?.child === frame) frame.parent.child = undefined
}
