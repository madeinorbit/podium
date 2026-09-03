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
import { ParallelNestedTransactionError, StaleTransactionError } from './errors'
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

/** One `transact` scope: the top-level transaction, or a savepoint under it. */
export interface TransactionFrame {
  readonly id: number
  readonly lane: Lane
  readonly lease: Lease
  readonly depth: number
  readonly parent: TransactionFrame | undefined
  readonly token: TransactionToken
  readonly postCommit: PostCommitRegistry
  /** The open nested scope, if any. Only the innermost frame is addressable. */
  child: TransactionFrame | undefined
  active: boolean
}

export type StoreScope =
  | { readonly kind: 'root' }
  | { readonly kind: 'transaction'; readonly frame: TransactionFrame }
  | {
      readonly kind: 'post-commit'
      readonly lease: Lease
      readonly runner: PostCommitRunner
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
}): TransactionFrame {
  const id = nextFrameId++
  const frame: TransactionFrame = {
    id,
    lane: input.lane,
    lease: input.lease,
    depth: input.parent ? input.parent.depth + 1 : 0,
    parent: input.parent,
    postCommit: input.postCommit,
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
  if (!frame.active) {
    throw new StaleTransactionError(
      `transaction ${frame.id} is closed: an operation reached it after its scope ended. ` +
        'A promise the body did not await is the usual cause.',
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

/** Close a frame. Called before its body's result is returned, always. */
export function closeFrame(frame: TransactionFrame): void {
  frame.active = false
  if (frame.parent?.child === frame) frame.parent.child = undefined
}
