/**
 * POD-4557 — the legacy control's store, read through the reads fence.
 *
 * The control ignores the per-row feed (see `arm.ts`, exception 1), so the
 * feed door of the fence never sees it. What the legacy derivation reads is
 * the store: its entity arrays (`issues`, `issueProjections`, `sessions`,
 * `repos`) and, through `store.replica`, the replica's row collections, which
 * the issue view cache re-reads on every session or issue batch
 * (`replica/issue-view-cache.ts` `relevantKinds`). This adapter hands
 * `worklistSlice.derive` a store whose tables are counted.
 *
 * INSTRUMENTATION, NEVER A BEHAVIOUR CHANGE. Array elements come back as the
 * raw rows (identity kept); each array and the store and replica are wrapped
 * ONCE per raw object, so identity memos inside the legacy code key on stable
 * wrappers. The legacy caches keyed on the store or replica object do see the
 * wrapper as a new key, so the first derive after mount rebuilds its caches;
 * the harness resets the fence after mount, and a disabled fence (timing runs)
 * never builds this adapter at all.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import type { ReadFence } from '../../../shared/src/instrument/reads'

/** Store array → entity name the fence counts it under. */
const STORE_TABLES: Readonly<Record<string, string>> = {
  issues: 'issue',
  issueProjections: 'issue',
  sessions: 'session',
  repos: 'repo',
}

/** Replica kind → entity name. One entity per logical row, so a wire row and
 *  its projection twin count as ONE issue read. */
const REPLICA_TABLES: Readonly<Record<string, string>> = {
  issues: 'issue',
  issueProjections: 'issue',
  sessions: 'session',
  repos: 'repo',
  issueDeps: 'issueDep',
}

type AnyRecord = Record<string, unknown>

function rowKey(row: unknown, index: number): string {
  if (row !== null && typeof row === 'object') {
    const record = row as AnyRecord
    for (const key of ['id', 'sessionId', 'path']) {
      const value = record[key]
      if (typeof value === 'string') return value
    }
  }
  return `#${index}`
}

function countedArray(fence: ReadFence, entity: string, rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  return fence.wrapTables({ [entity]: rows as readonly unknown[] }, { borrowed: false, keyOf: rowKey })[entity]
}

const storesByFence = new WeakMap<ReadFence, WeakMap<object, object>>()

function memo(fence: ReadFence): WeakMap<object, object> {
  let perFence = storesByFence.get(fence)
  if (perFence === undefined) {
    perFence = new WeakMap()
    storesByFence.set(fence, perFence)
  }
  return perFence
}

function fencedReplica(fence: ReadFence, replica: object): object {
  const cache = memo(fence)
  const existing = cache.get(replica)
  if (existing !== undefined) return existing
  const proxy = new Proxy(replica, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      if (prop === 'rows') {
        return (kind: string) => {
          const rows = (value as (kind: string) => unknown).call(target, kind)
          const entity = REPLICA_TABLES[kind]
          return entity === undefined ? rows : countedArray(fence, entity, rows)
        }
      }
      if (prop === 'row') {
        return (kind: string, id: string) => {
          const entity = REPLICA_TABLES[kind]
          if (entity !== undefined) fence.touch(entity, id, 'get')
          return (value as (kind: string, id: string) => unknown).call(target, kind, id)
        }
      }
      // Every other method runs on the raw replica (private state, listeners).
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  })
  cache.set(replica, proxy)
  return proxy
}

/**
 * The store the counted derive reads. Identity when the fence is disabled.
 */
export function fencedLegacyStore(
  fence: ReadFence,
  store: Store<PodiumClientApi>,
): Store<PodiumClientApi> {
  if (!fence.enabled) return store
  const cache = memo(fence)
  const existing = cache.get(store)
  if (existing !== undefined) return existing as Store<PodiumClientApi>
  const proxy = new Proxy(store as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof prop !== 'string') return value
      const entity = STORE_TABLES[prop]
      if (entity !== undefined) return countedArray(fence, entity, value)
      if (prop === 'replica' && value !== null && typeof value === 'object') {
        return fencedReplica(fence, value)
      }
      return value
    },
  })
  cache.set(store, proxy)
  return proxy as Store<PodiumClientApi>
}
