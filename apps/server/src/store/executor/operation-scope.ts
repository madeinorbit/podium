/**
 * ONE OPERATION, AS A LIFETIME FOR MEMOS [POD-6189, server-data rule 2].
 *
 * An operation is one daemon frame, one tRPC call or one client request: the
 * unit of work the server does for one input. It may read, open a write span,
 * commit, and read again afterwards, and it often asks the same question in
 * each of those phases. POD-6189 measured the session and relay paths reading
 * the same session's grants three to five times per operation (an access check
 * before the span, a projection inside it, reprojections after it).
 *
 * WHY NOT THE READ SCOPE. `withReadScope` is the lifetime for READ PASSES, and
 * several of its slots rely on that: the relay's closed-issue, folder-owner
 * and scheduled-wakeup memos say nothing in their scope writes, and the issue
 * row cache switches itself off in a scope that writes. Opening a read scope
 * around a write operation would turn all of them on there. So an operation is
 * a separate lifetime, and only a loader that is exact across writes opts in
 * (`operationLoader`'s `perOperation`; see `operation-loader.ts` for the rules
 * that make it exact).
 *
 * WHAT BELONGS TO AN OPERATION. Its function, and the work it starts to finish
 * handling its input without waiting for it: the post-commit effects of its own
 * commits (the publication of its changes) and the bus listeners it notifies
 * (the follow-ups a session change triggers). Those dispatchers call
 * {@link holdOperation}, and the operation ends only when its function and all
 * of that have settled; its caller still gets its answer when the function
 * settles. A held step that never settles cannot keep it open: it ends at the
 * latest {@link OPERATION_HOLD_LIMIT_MS} after its function settled.
 *
 * A MEMO, NOT A CACHE. A slot is created on first use inside the operation and
 * is unreachable once the operation ends: anything that runs on after that (a
 * timer, a step it did not hold) sees NO operation, so it reads afresh, and
 * nothing an operation memoised is reused by anything else. Operations JOIN
 * rather than nest, as read scopes do.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** The identity of one memo inside an operation, owned by whoever declares it. */
export interface OperationSlotKey<T> {
  readonly create: () => T
}

export function operationSlot<T>(create: () => T): OperationSlotKey<T> {
  return { create }
}

export interface OperationScope {
  readonly id: number
  /** This owner's memo for the rest of the operation, created on first ask. */
  slot<T>(key: OperationSlotKey<T>): T
}

/** How long held work may keep an operation open after its function settled. */
export const OPERATION_HOLD_LIMIT_MS = 30_000

interface OpenOperation extends OperationScope {
  ended: boolean
  /** Held steps still running. */
  held: number
  /** Its function has settled. */
  settled: boolean
  /** End it: no later caller sees it, and its memos are released at once. */
  end(): void
}

let nextOperationId = 1
const storage = new AsyncLocalStorage<OpenOperation>()
const ending = new WeakMap<OpenOperation, ReturnType<typeof setTimeout>>()

/**
 * Keep the current operation open until `work` settles: for a dispatcher that
 * starts work belonging to the operation without awaiting it. Outside an open
 * operation it does nothing.
 */
export function holdOperation(work: PromiseLike<unknown>): void {
  const operation = storage.getStore()
  if (operation === undefined || operation.ended) return
  operation.held += 1
  const release = (): void => {
    operation.held -= 1
    if (operation.settled && operation.held === 0 && !operation.ended) {
      clearTimeout(ending.get(operation))
      operation.end()
    }
  }
  work.then(release, release)
}

function openOperation(): OpenOperation {
  const slots = new Map<OperationSlotKey<unknown>, unknown>()
  const operation: OpenOperation = {
    id: nextOperationId++,
    ended: false,
    held: 0,
    settled: false,
    end() {
      operation.ended = true
      // Work left running still holds the scope through its async context;
      // dropping the memos here keeps them from living as long as that work.
      slots.clear()
    },
    slot<T>(key: OperationSlotKey<T>): T {
      if (slots.has(key as OperationSlotKey<unknown>)) return slots.get(key as OperationSlotKey<unknown>) as T
      const created = key.create()
      slots.set(key as OperationSlotKey<unknown>, created)
      return created
    },
  }
  return operation
}

/**
 * The operation this code runs in, or undefined: none was opened, or the one
 * that was has ended (this is work it left running).
 */
export function currentOperation(): OperationScope | undefined {
  const operation = storage.getStore()
  return operation === undefined || operation.ended ? undefined : operation
}

/**
 * Run `fn` as an operation of its OWN, even inside an open one: for a unit of
 * work that serves several operations (a queue drained on behalf of whoever
 * filled it), so no caller's memo answers for another's input.
 */
export function withOwnOperation<T>(fn: () => T): T {
  return storage.exit(() => withOperation(fn))
}

/**
 * Run `fn` as one operation. Inside an open operation it joins that one. The
 * operation ends when `fn` returns or, for a promise, settles; its memos are
 * dropped then, whatever `fn` left running.
 */
export function withOperation<T>(fn: () => T): T {
  if (currentOperation() !== undefined) return fn()
  const operation = openOperation()
  const end = (): void => {
    operation.settled = true
    if (operation.held === 0) {
      operation.end()
      return
    }
    const limit = setTimeout(() => operation.end(), OPERATION_HOLD_LIMIT_MS)
    limit.unref?.()
    ending.set(operation, limit)
  }
  let result: T
  try {
    result = storage.run(operation, fn)
  } catch (error) {
    end()
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(end) as T
  }
  end()
  return result
}
