import { jsonRowsEqual } from '../json-equal'
import type { EngineState } from './state'

/**
 * Keyed inputs (POD-5426 spec §4.10, plan steps 7-9): what the pool's
 * adapters consume from the runtime, keyed, so each one wakes only for its
 * own keys instead of re-reading the whole published snapshot.
 *
 * - **Locals.** `onLocals(keys, listener)` runs after a batch that changed
 *   one of `keys`, with the changed subset; `readLocal(key)` reads the value
 *   that batch published. A batch that touches none of a listener's keys
 *   costs it nothing (the index is by key).
 * - **Lists by id.** Discovery (machines, repos) and the window lists
 *   (approvals, file tabs, workspaces, super-threads) arrive as whole arrays.
 *   `onList(name, listener)` hands each listener the ids whose row changed
 *   and whether the order moved. The diff runs once per array change, at
 *   this producer, and only for a list someone follows. An unchanged row
 *   keeps its identity, so `listRow` is stable across RPC refreshes.
 *
 * The runtime is the only writer: it calls `emit` once per completed batch.
 */
export type LocalKey = keyof EngineState
export type LocalsListener = (changed: ReadonlySet<LocalKey>) => void

export interface KeyedListChange {
  /** Ids whose row was added, changed or removed. */
  readonly ids: ReadonlySet<string>
  /** The id order moved (membership or position). */
  readonly order: boolean
}

type Row<K extends LocalKey> = K extends unknown
  ? EngineState[K] extends readonly (infer R)[]
    ? R
    : EngineState[K] extends Readonly<Record<string, infer R>>
      ? R
      : never
  : never

/** One discovery repo's id: the scan root on its machine. */
export function discoveryRepoId(repo: {
  readonly machineId?: string | null
  readonly path: string
}): string {
  return JSON.stringify([repo.machineId ?? '', repo.path])
}

const LIST_KEYS = {
  machines: (row: { id: string }) => row.id,
  repos: discoveryRepoId,
  approvals: (row: { id: string }) => row.id,
  fileTabs: (row: { id: string }) => row.id,
  superThreads: (row: { id: string }) => row.id,
  /** A record: its keys are the ids, in insertion order. */
  workspaces: null,
} as const

export type KeyedListName = keyof typeof LIST_KEYS
export type KeyedListRow<N extends KeyedListName> = Row<N>

export interface KeyedInputs {
  onLocals(keys: readonly LocalKey[], listener: LocalsListener): () => void
  readLocal<K extends LocalKey>(key: K): EngineState[K]
  onList<N extends KeyedListName>(name: N, listener: (change: KeyedListChange) => void): () => void
  listIds(name: KeyedListName): readonly string[]
  listRow<N extends KeyedListName>(name: N, id: string): KeyedListRow<N> | undefined
}

/** Counted for the adapter wake meters (plan steps 7-9). */
export interface KeyedInputStats {
  /** Listener calls, locals and lists. */
  wakes: number
  /** Rows compared by the list diffs. */
  listRowsCompared: number
}

interface ListState {
  readonly name: KeyedListName
  from: unknown
  ids: readonly string[]
  rows: Map<string, unknown>
  readonly listeners: Set<(change: KeyedListChange) => void>
}

export interface KeyedInputsChannel extends KeyedInputs {
  readonly stats: KeyedInputStats
  /** The runtime's batch end: `changed` keys and the sessions whose draft moved. */
  emit(changed: ReadonlySet<LocalKey>): void
  dispose(): void
}

function entriesOf(name: KeyedListName, value: unknown): [string, unknown][] {
  const key = LIST_KEYS[name]
  if (key === null) return Object.entries((value ?? {}) as Record<string, unknown>)
  return ((value ?? []) as readonly never[]).map((row) => [
    (key as (row: never) => string)(row),
    row,
  ])
}

/** `read` returns the runtime's current state; the channel publishes from it
 *  only at `emit`, so a reader never sees a local it was not told about.
 *  `live` reads `read()` directly instead (fixtures that mutate a store in
 *  place and may never publish). */
export function createKeyedInputs(read: () => EngineState, live = false): KeyedInputsChannel {
  const snapshot: Partial<EngineState> = live ? {} : { ...read() }
  const current = (): Partial<EngineState> => (live ? read() : snapshot)
  const byKey = new Map<LocalKey, Set<{ keys: ReadonlySet<LocalKey>; listener: LocalsListener }>>()
  const lists = new Map<KeyedListName, ListState>()
  const stats: KeyedInputStats = { wakes: 0, listRowsCompared: 0 }
  let disposed = false

  function diff(list: ListState, value: unknown): KeyedListChange | null {
    if (Object.is(list.from, value)) return null
    list.from = value
    const rows = new Map<string, unknown>()
    const ids: string[] = []
    const changed = new Set<string>()
    for (const [id, row] of entriesOf(list.name, value)) {
      if (rows.has(id)) continue
      const previous = list.rows.get(id)
      stats.listRowsCompared++
      if (previous !== undefined && jsonRowsEqual(previous, row)) rows.set(id, previous)
      else {
        rows.set(id, row)
        changed.add(id)
      }
      ids.push(id)
    }
    for (const id of list.rows.keys()) if (!rows.has(id)) changed.add(id)
    const order = ids.length !== list.ids.length || ids.some((id, at) => list.ids[at] !== id)
    list.rows = rows
    if (order) list.ids = ids
    return changed.size > 0 || order ? { ids: changed, order } : null
  }

  function listState(name: KeyedListName, read = true): ListState {
    let list = lists.get(name)
    if (list === undefined) {
      list = { name, from: undefined, ids: [], rows: new Map(), listeners: new Set() }
      lists.set(name, list)
    }
    // A list nobody follows is not diffed at emit; catch it up on read.
    // Subscribing reads nothing.
    if (read) diff(list, current()[name])
    return list
  }

  function call<T>(listener: (value: T) => void, value: T): void {
    stats.wakes++
    try {
      listener(value)
    } catch {
      // One throwing adapter must not stop the others (row-source contract).
    }
  }

  return {
    stats,
    onLocals(keys, listener) {
      const entry = { keys: new Set(keys), listener }
      for (const key of entry.keys) {
        const set = byKey.get(key) ?? new Set()
        byKey.set(key, set)
        set.add(entry)
      }
      return () => {
        for (const key of entry.keys) byKey.get(key)?.delete(entry)
      }
    },
    readLocal: (key) => current()[key] as EngineState[typeof key],
    onList(name, listener) {
      const list = listState(name, false)
      list.listeners.add(listener)
      return () => {
        list.listeners.delete(listener)
      }
    },
    listIds: (name) => listState(name).ids,
    listRow: (name, id) => listState(name).rows.get(id) as never,
    emit(changed) {
      if (disposed) return
      const state = read()
      for (const key of changed) (snapshot as Record<string, unknown>)[key] = state[key]
      const published = current()
      const woken = new Map<LocalsListener, Set<LocalKey>>()
      for (const key of changed) {
        for (const entry of byKey.get(key) ?? []) {
          const keys = woken.get(entry.listener) ?? new Set<LocalKey>()
          woken.set(entry.listener, keys)
          keys.add(key)
        }
        const list = lists.get(key as KeyedListName)
        if (list !== undefined && list.listeners.size > 0) {
          const change = diff(list, published[key])
          if (change !== null) for (const listener of [...list.listeners]) call(listener, change)
        }
      }
      for (const [listener, keys] of woken) call(listener, keys)
    },
    dispose() {
      disposed = true
      byKey.clear()
      lists.clear()
    },
  }
}
