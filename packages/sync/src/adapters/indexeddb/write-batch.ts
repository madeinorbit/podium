import type { IdbObjectStoreLike, IdbRequestLike, IdbTransactionLike } from './idb'

type Write =
  | { readonly kind: 'put'; readonly store: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly store: string; readonly key: unknown }

/** Most requests issued in one task: the structured clone of a put runs on the page's thread. */
const SLICE_OPS = 256
/** Most time one task spends issuing requests. */
const SLICE_MS = 8
/** Every this many requests, a success event that may issue the next slice. */
const TRIGGER_STRIDE = 32

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/**
 * Bound synchronous structured-clone work without splitting the transaction.
 *
 * Requests go out in slices of at most {@link SLICE_OPS} (and {@link SLICE_MS}),
 * each from inside a success event of this transaction's own requests, where it
 * is active. No timer or unrelated await may keep it alive.
 *
 * POD-7170: the next slice does NOT wait for the previous one to finish. Every
 * {@link TRIGGER_STRIDE}th request's success event issues another slice, so the
 * database always has requests queued while the page's thread does other work.
 * IndexedDB costs per request (about 140 us on the agents VM, against 25 us of
 * clone on the page), and the old wait-for-the-last-request loop left it idle
 * whenever a page task ran in between: 8,500 puts took 4 s instead of about 1.2.
 */
export function enqueueWrites(tx: IdbTransactionLike, ops: readonly Write[]): Promise<void> {
  const stores = new Map<string, IdbObjectStoreLike>()
  let at = 0
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const failed = (error: unknown): void => {
      if (settled) return
      settled = true
      const cause = tx.error
      // Keep the initiating exception when available. Later requests can carry
      // AbortError after an earlier quota request aborted the transaction.
      reject(cause && (error as { name?: unknown } | null)?.name !== cause.name ? cause : error)
    }
    const issue = (): void => {
      if (settled) return
      try {
        const began = now()
        const end = Math.min(at + SLICE_OPS, ops.length)
        for (; at < end; at++) {
          const op = ops[at]!
          let store = stores.get(op.store)
          if (store === undefined) {
            store = tx.objectStore(op.store)
            stores.set(op.store, store)
          }
          const request: IdbRequestLike<unknown> =
            op.kind === 'put' ? store.put(op.value) : store.delete(op.key)
          if (at % TRIGGER_STRIDE === TRIGGER_STRIDE - 1 || at === end - 1) {
            request.onsuccess = issue
            request.onerror = () => failed(request.error ?? new Error('IndexedDB write failed'))
          }
          if ((at & 63) === 63 && now() - began >= SLICE_MS) {
            at += 1
            // The request just issued carries no trigger unless it is a stride
            // request; give it one, so the next slice has an event to run in.
            request.onsuccess = issue
            request.onerror = () => failed(request.error ?? new Error('IndexedDB write failed'))
            break
          }
        }
        if (at === ops.length) {
          // Completion belongs to the transaction; every request is issued.
          settled = true
          resolve()
        }
      } catch (error) {
        failed(error)
      }
    }
    issue()
  })
}
