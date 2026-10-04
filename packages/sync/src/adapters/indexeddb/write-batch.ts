import type { IdbObjectStoreLike, IdbRequestLike, IdbTransactionLike } from './idb'

type Write =
  | { readonly kind: 'put'; readonly store: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly store: string; readonly key: readonly unknown[] }

/** Bound synchronous structured-clone work without splitting the transaction.
 * The next batch starts inside this transaction's own request success event,
 * where it is active. No timer or unrelated await may keep it alive. */
export function enqueueWrites(tx: IdbTransactionLike, ops: readonly Write[]): Promise<void> {
  const stores = new Map<string, IdbObjectStoreLike>()
  let at = 0
  return new Promise<void>((resolve, reject) => {
    const next = (): void => {
      try {
        const end = Math.min(at + 256, ops.length)
        let last: IdbRequestLike<unknown> | undefined
        for (; at < end; at++) {
          const op = ops[at]!
          let store = stores.get(op.store)
          if (store === undefined) {
            store = tx.objectStore(op.store)
            stores.set(op.store, store)
          }
          last = op.kind === 'put' ? store.put(op.value) : store.delete(op.key)
        }
        if (at === ops.length) {
          resolve()
          return
        }
        // Returning to the browser between request events lets it render while
        // a large eager cache write continues. Completion still belongs to tx.
        const request = last!
        request.onsuccess = next
        request.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB write failed'))
      } catch (error) {
        reject(tx.error ?? error)
      }
    }
    next()
  })
}
