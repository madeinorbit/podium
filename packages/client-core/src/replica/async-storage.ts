/**
 * Async key-value → synchronous StorageApi bridge (React Native AsyncStorage,
 * or any Promise-based kv). The replica engine (and TanStack DB's localStorage
 * collections underneath it) needs SYNCHRONOUS reads/writes; AsyncStorage is
 * Promise-only. The standard bridge: hydrate every namespaced key into an
 * in-memory map up front (await `createAsyncStorageReplicaStorage` before
 * constructing the replica), then serve reads from the map and write through
 * to the async backing behind one ordered writer.
 *
 * Durability is write-behind: a crash between the sync write and the flush
 * loses at most the tail of the queue — the same "best effort, cold-start on
 * loss" posture the replica already has for quota-degraded web storage. The
 * Callers may mark hot, best-effort keys as coalescible. Those keys wait for a
 * short quiet window and retain only their latest pending value. Every other
 * key is an ordering fence: pending hot writes are sealed before it, so cursor,
 * migration and authored-work families retain their issue order.
 */

import type { StorageApi } from '@tanstack/db'
import { REPLICA_KEY_PREFIX } from './replica'

/** The subset of @react-native-async-storage/async-storage the bridge needs. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getAllKeys(): Promise<readonly string[]>
}

export interface AsyncReplicaStorage {
  /** Synchronous StorageApi over the hydrated cache — pass as `ReplicaInit.storage`. */
  storage: StorageApi
  /** Hydrated namespace inventory, updated with synchronous writes/removals. */
  keys(): string[]
  /** Resolves when every write issued so far has flushed to the async backing. */
  flush(): Promise<void>
}

export interface AsyncReplicaStorageOptions {
  /** Hot keys whose pending writes may collapse to their latest operation. */
  coalesce?: (key: string) => boolean
  /** Quiet window before coalesced writes start. Defaults to 250ms. */
  settleMs?: number
}

interface PendingOperation {
  readonly key: string
  readonly sequence: number
  readonly run: () => Promise<void>
}

/**
 * Hydrate all keys under `prefixes` from the async backing and return a
 * synchronous write-through StorageApi. Must be awaited BEFORE `createReplica`.
 */
export async function createAsyncStorageReplicaStorage(
  backing: AsyncKeyValueStorage,
  prefixes: readonly string[] = [REPLICA_KEY_PREFIX],
  options: AsyncReplicaStorageOptions = {},
): Promise<AsyncReplicaStorage> {
  const cache = new Map<string, string>()
  try {
    const keys = (await backing.getAllKeys()).filter((k) =>
      prefixes.some((p) => k === p || k.startsWith(p)),
    )
    await Promise.all(
      keys.map(async (k) => {
        const v = await backing.getItem(k)
        if (v !== null) cache.set(k, v)
      }),
    )
  } catch {
    // A failed hydrate cold-starts (spec invariant 2) — the cache stays empty
    // and the session runs write-through from scratch.
  }
  const coalesce = options.coalesce ?? (() => false)
  const settleMs = options.settleMs ?? 250
  const pending = new Map<string, PendingOperation>()
  const batches: PendingOperation[][] = []
  const flushWaiters = new Set<{ sequence: number; resolve: () => void }>()
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSettled = false
  let running = false
  let issuedSequence = 0
  let completedSequence = 0

  const resolveFlushWaiters = (): void => {
    for (const waiter of flushWaiters) {
      if (completedSequence < waiter.sequence) continue
      flushWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  const runBatches = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (batches.length > 0) {
        const batch = batches.shift()
        if (batch === undefined) continue
        for (const operation of batch) {
          try {
            await operation.run()
          } catch {
            // Best-effort, matching the bridge's previous write-behind queue.
          }
        }
        completedSequence = Math.max(
          completedSequence,
          ...batch.map((operation) => operation.sequence),
        )
        resolveFlushWaiters()
      }
    } finally {
      running = false
      if (pendingSettled) {
        pendingSettled = false
        sealPending()
      }
    }
  }

  const queueBatch = (batch: PendingOperation[]): void => {
    if (batch.length === 0) return
    batches.push(batch)
    void runBatches()
  }

  const sealPending = (): void => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
      settleTimer = undefined
    }
    if (pending.size === 0) return
    const batch = [...pending.values()].sort((a, b) => a.sequence - b.sequence)
    pending.clear()
    queueBatch(batch)
  }

  const schedulePending = (): void => {
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    pendingSettled = false
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      // Do not retain one sealed batch for every quiet interval while native
      // storage is slow. Keep coalescing in the map until the writer catches up.
      if (running || batches.length > 0) {
        pendingSettled = true
        return
      }
      sealPending()
    }, settleMs)
    settleTimer.unref?.()
  }

  const operation = (key: string, run: () => Promise<void>): PendingOperation => ({
    key,
    sequence: ++issuedSequence,
    run,
  })

  const enqueue = (next: PendingOperation): void => {
    if (coalesce(next.key)) {
      pending.set(next.key, next)
      schedulePending()
      return
    }
    // Ordered families fence the coalesced side cache on both sides. This keeps
    // cursor-after-data and copy-before-retire behavior byte-for-byte ordered.
    sealPending()
    queueBatch([next])
  }

  return {
    storage: {
      getItem: (k) => cache.get(k) ?? null,
      setItem: (k, v) => {
        cache.set(k, v)
        enqueue(operation(k, () => backing.setItem(k, v)))
      },
      removeItem: (k) => {
        cache.delete(k)
        enqueue(operation(k, () => backing.removeItem(k)))
      },
    },
    keys: () => [...cache.keys()],
    flush: () => {
      const through = issuedSequence
      sealPending()
      if (completedSequence >= through) return Promise.resolve()
      return new Promise<void>((resolve) => flushWaiters.add({ sequence: through, resolve }))
    },
  }
}
