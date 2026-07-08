/**
 * Async key-value → synchronous StorageApi bridge (React Native AsyncStorage,
 * or any Promise-based kv). The replica engine (and TanStack DB's localStorage
 * collections underneath it) needs SYNCHRONOUS reads/writes; AsyncStorage is
 * Promise-only. The standard bridge: hydrate every namespaced key into an
 * in-memory map up front (await `createAsyncStorageReplicaStorage` before
 * constructing the replica), then serve reads from the map and write through
 * to the async backing behind a per-key serialization queue.
 *
 * Durability is write-behind: a crash between the sync write and the flush
 * loses at most the tail of the queue — the same "best effort, cold-start on
 * loss" posture the replica already has for quota-degraded web storage. The
 * cursor honesty invariant is preserved by ordering: setItem calls flush in
 * issue order, so the cursor key never lands before the entity blobs queued
 * ahead of it.
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
  /** Resolves when every write issued so far has flushed to the async backing. */
  flush(): Promise<void>
}

/**
 * Hydrate all keys under `prefixes` from the async backing and return a
 * synchronous write-through StorageApi. Must be awaited BEFORE `createReplica`.
 */
export async function createAsyncStorageReplicaStorage(
  backing: AsyncKeyValueStorage,
  prefixes: readonly string[] = [REPLICA_KEY_PREFIX],
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
  // FIFO write-behind queue: preserves issue order across keys (cursor-after-
  // data), collapses nothing (writes are small), never throws into callers.
  let tail: Promise<void> = Promise.resolve()
  const enqueue = (op: () => Promise<void>): void => {
    tail = tail.then(op).catch(() => {})
  }
  return {
    storage: {
      getItem: (k) => cache.get(k) ?? null,
      setItem: (k, v) => {
        cache.set(k, v)
        enqueue(() => backing.setItem(k, v))
      },
      removeItem: (k) => {
        cache.delete(k)
        enqueue(() => backing.removeItem(k))
      },
    },
    flush: () => tail,
  }
}
