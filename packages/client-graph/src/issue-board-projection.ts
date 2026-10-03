import { compareStructural, reaction } from 'mobx'

export interface BoardProjection<T = unknown> {
  getSnapshot(): T | undefined
  subscribe(wake: () => void): () => void
  dispose(): void
}

/** Start tracking with the first React read, so subscribing does not rebuild
 * the whole board. An abandoned render releases in a microtask; a mounted
 * reader releases synchronously with its last subscriber. No standing query. */
export function createBoardProjection<T>(read: () => T, released: () => void): BoardProjection<T> {
  const listeners = new Set<() => void>()
  let snapshot: T | undefined
  let stop: (() => void) | undefined
  let disposed = false
  const clear = () => {
    stop?.(); stop = undefined; snapshot = undefined
    released()
  }
  const start = () => {
    if (stop || disposed) return
    stop = reaction(read, next => {
      snapshot = next
      for (const wake of listeners) wake()
    }, { equals: compareStructural, fireImmediately: true })
    queueMicrotask(() => { if (!listeners.size) clear() })
  }
  return {
    getSnapshot() { start(); return snapshot },
    subscribe(wake) {
      listeners.add(wake); start()
      return () => { listeners.delete(wake); if (!listeners.size) clear() }
    },
    dispose() { disposed = true; listeners.clear(); clear() },
  }
}
