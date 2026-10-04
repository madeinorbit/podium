import { createKeyedInputs, type KeyedInputs, type LocalKey, type LocalsListener } from '../src/engine/keyed-inputs'
import type { EngineState } from '../src/engine/state'

/**
 * Keyed inputs over a hand-held snapshot store (fixtures and harness fakes
 * that publish whole snapshots): each publication is diffed key by key, and
 * a draft change names its session. The runtime never uses this; it emits
 * its own batch's keys.
 */
export function keyedInputsOverStore(store: {
  getSnapshot(): object
  subscribe(listener: () => void): () => void
}): KeyedInputs & { dispose(): void } {
  const state = () => (store.getSnapshot() ?? {}) as EngineState
  const channel = createKeyedInputs(state, true)
  // Only followed keys are compared (a fixture may forbid reading the rest),
  // and the store is followed only while someone follows a key, so an
  // adapter's dispose still releases the store's subscription.
  const followed = new Map<LocalKey, number>()
  // Following reads nothing. A key's previous value is the one the adapter
  // last read; a key it never read counts as moved at its first publication.
  const previous = new Map<LocalKey, unknown>()
  let off: (() => void) | null = null
  const publication = () => {
    const next = state()
    const changed = new Set<LocalKey>()
    const drafts = new Set<string>()
    for (const key of followed.keys()) {
      const value = next[key]
      if (previous.has(key) && Object.is(previous.get(key), value)) continue
      if (key === 'drafts') {
        const before = (previous.get(key) ?? {}) as Record<string, string>
        const after = (value ?? {}) as Record<string, string>
        for (const id of new Set([...Object.keys(before), ...Object.keys(after)]))
          if (before[id] !== after[id]) drafts.add(id)
      }
      previous.set(key, value)
      changed.add(key)
    }
    if (changed.size > 0) channel.emit(changed, drafts)
  }
  const follow = (keys: readonly LocalKey[], stop: () => void): (() => void) => {
    for (const key of keys) {
      followed.set(key, (followed.get(key) ?? 0) + 1)
    }
    if (off === null) off = store.subscribe(publication)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      stop()
      for (const key of keys) {
        const count = (followed.get(key) ?? 1) - 1
        if (count > 0) followed.set(key, count)
        else followed.delete(key)
      }
      if (followed.size === 0) {
        off?.()
        off = null
      }
    }
  }
  return {
    onLocals: (keys, listener) => follow(keys, channel.onLocals(keys, listener)),
    readLocal: (key) => {
      const value = channel.readLocal(key)
      previous.set(key, value)
      return value
    },
    onList: (name, listener) => follow([name], channel.onList(name, listener)),
    listIds: (name) => {
      previous.set(name, state()[name])
      return channel.listIds(name)
    },
    listRow: (name, id) => {
      if (!previous.has(name)) previous.set(name, state()[name])
      return channel.listRow(name, id)
    },
    onDraft: (listener) => follow(['drafts'], channel.onDraft(listener)),
    dispose() {
      off?.()
      off = null
      followed.clear()
      channel.dispose()
    },
  }
}

/** Give a fixture's whole-snapshot runtime the keyed surface, in place. */
export function withKeyedInputs<T extends { getSnapshot(): object; subscribe(listener: () => void): () => void }>(
  fake: T,
): T & KeyedInputs & { readonly access: ReturnType<T['getSnapshot']> } {
  const { dispose: _dispose, ...inputs } = keyedInputsOverStore(fake)
  const fixture = fake as T & { services?: object; replica?: { rowCount?: (kind: string) => number; rows(kind: string): unknown[] } }
  fixture.services ??= Object.fromEntries(Object.entries(fake.getSnapshot()).filter(([, value]) => typeof value === 'function'))
  if (fixture.replica && !fixture.replica.rowCount) fixture.replica.rowCount = kind => fixture.replica!.rows(kind).length
  return Object.defineProperty(Object.assign(fake, inputs), 'access', { get: () => fake.getSnapshot() }) as T & KeyedInputs & { readonly access: ReturnType<T['getSnapshot']> }
}
