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
 * THE ISSUE ROWS. The derive walks every issue as an `IssueViewModel`
 * (`sidebarSections`, `unifiedWorkList`), and that model array is private to
 * the view cache (`issue-view-cache.ts` `modelsFor`): no wrapper from outside
 * can reach it. The cache's own per-snapshot pass can: `modelsFor` compares
 * each projection row with the input it built the model from and reuses the
 * model when nothing moved. So `issues` and `issueProjections` are wrapped
 * FRESH PER STORE SNAPSHOT. The cache sees a new array identity, runs its
 * identity pass over every issue row (counted), reuses every unchanged model,
 * and returns the same `all` array — same output, same identities (the
 * control test asserts commits and stats are equal with the fence on and
 * off). That is the one extra O(N) identity pass this adapter adds, in count
 * runs only; it counts the same distinct issue rows the derive walks as
 * models.
 *
 * Everything else — `sessions`, `repos`, the replica's row collections — is
 * wrapped ONCE per raw array, so identity memos key on stable wrappers
 * exactly as they key on the raw arrays. Elements come back raw. A disabled
 * fence (timing runs) never builds this adapter at all.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import type { ReadFence } from '../../../shared/src/instrument/reads'

/** Store array → entity name the fence counts it under. */
const STORE_TABLES: Readonly<Record<string, string>> = {
  issues: 'issue',
  issueProjections: 'issue',
  sessions: 'session',
  // The machine scan (`GitRepositoryWire`): repo-root lanes, keyed by path —
  // the schema's `worktree` entity, not the replicated `repo` row.
  repos: 'worktree',
}

/** Wrapped fresh per store snapshot (see "THE ISSUE ROWS" above). */
const PER_SNAPSHOT: ReadonlySet<string> = new Set(['issues', 'issueProjections'])

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

function countedArray(fence: ReadFence, entity: string, rows: unknown, reuse = true): unknown {
  if (!Array.isArray(rows)) return rows
  return fence.wrapTables({ [entity]: rows as readonly unknown[] }, { borrowed: false, keyOf: rowKey, reuse })[entity]
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
  // Per-snapshot wrappers, stable for every read of THIS snapshot.
  const perSnapshot = new Map<string, unknown>()
  const proxy = new Proxy(store as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof prop !== 'string') return value
      const entity = STORE_TABLES[prop]
      if (entity !== undefined && PER_SNAPSHOT.has(prop)) {
        if (!perSnapshot.has(prop)) perSnapshot.set(prop, countedArray(fence, entity, value, false))
        return perSnapshot.get(prop)
      }
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
