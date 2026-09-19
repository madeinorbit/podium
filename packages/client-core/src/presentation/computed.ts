import type { ReadCell } from './model'

/** JSON-shaped presentation values only. Equality retains the old snapshot. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a), other = Object.keys(b)
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) &&
    sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

type Node = {
  key: string; owner: string; read: () => unknown; value: unknown; version: number
  dirty: boolean; direct: boolean; initialized: boolean; refs: number
  inputs: Set<string>; deps: Map<Node, number>; users: Set<Node>; listeners: Set<() => void>
}

/** Private to one principal. Observed roots retain their dependency DAG, not
 * subscriptions on every computed. Unobserved roots have a bounded LRU; evicting
 * a root recursively releases otherwise unused dependencies and source edges.
 * Handles do not pin nodes: a retained handle can recreate an evicted node. */
export function createComputedGraph(limit = 128) {
  const nodes = new Map<string, Node>(), inputs = new Map<string, Set<Node>>()
  const idle = new Map<string, Node>(), owners = new Map<string, Set<Node>>()
  let current: Node | undefined, destroyed = false
  function release(n: Node) {
    if (--n.refs > 0) return
    nodes.delete(n.key)
    const owned = owners.get(n.owner)
    owned?.delete(n)
    if (!owned?.size) owners.delete(n.owner)
    for (const key of n.inputs) {
      const set = inputs.get(key); set?.delete(n); if (!set?.size) inputs.delete(key)
    }
    for (const dep of n.deps.keys()) { dep.users.delete(n); release(dep) }
    n.deps.clear(); n.inputs.clear(); n.value = undefined
  }
  function remember(n: Node) {
    if (n.listeners.size) return
    if (idle.delete(n.key)) n.refs--
    idle.set(n.key, n); n.refs++
    while (idle.size > limit) {
      const oldest = idle.values().next().value!
      idle.delete(oldest.key); release(oldest)
    }
  }
  function evaluate(n: Node) {
    if (!n.dirty) return
    let changed = n.direct || !n.initialized
    for (const [dep, version] of n.deps) { evaluate(dep); if (dep.version !== version) changed = true }
    n.dirty = false
    if (!changed) return
    const prior = current, oldDeps = n.deps, oldInputs = n.inputs
    n.deps = new Map(); n.inputs = new Set(); current = n
    try {
      const next = n.read()
      if (!n.initialized || !sameValue(n.value, next)) { n.value = next; n.version++ }
      n.initialized = true; n.direct = false
    } catch (error) {
      n.dirty = true; n.direct = true
      throw error
    } finally {
      current = prior
      for (const dep of oldDeps.keys()) { if (!n.deps.has(dep)) dep.users.delete(n); release(dep) }
      for (const key of oldInputs) if (!n.inputs.has(key)) {
        const set = inputs.get(key); set?.delete(n); if (!set?.size) inputs.delete(key)
      }
    }
  }
  function node(key: string, owner: string, read: () => unknown): Node {
    let n = nodes.get(key)
    if (!n) {
      n = { key, owner, read, value: undefined, version: 0, dirty: true, direct: true, initialized: false,
        refs: 0, inputs: new Set(), deps: new Map(), users: new Set(), listeners: new Set() }
      nodes.set(key, n)
      let set = owners.get(owner); if (!set) owners.set(owner, set = new Set()); set.add(n)
    }
    return n
  }
  return {
    input<T>(key: string, read: () => T): T {
      if (current) {
        current.inputs.add(key)
        let set = inputs.get(key); if (!set) inputs.set(key, set = new Set()); set.add(current)
      }
      return read()
    },
    cell<T>(key: string, owner: string, read: () => T): ReadCell<T> {
      return {
        getSnapshot() {
          if (destroyed) return undefined as T
          const n = node(key, owner, read)
          n.refs++
          try {
            evaluate(n)
            if (current) {
              if (!current.deps.has(n)) { n.refs++; n.users.add(current) }
              current.deps.set(n, n.version)
            } else remember(n)
            return n.value as T
          } finally { release(n) }
        },
        subscribe(listener) {
          if (destroyed) return () => {}
          const n = node(key, owner, read)
          // Establish dependencies even when subscribe precedes first read.
          n.refs++
          try { evaluate(n) } catch (error) { release(n); throw error }
          const notify = () => { if (n.listeners.has(notify)) listener() }
          n.listeners.add(notify)
          if (idle.delete(key)) release(n)
          let live = true
          return () => {
            if (!live || destroyed) return
            live = false; n.listeners.delete(notify)
            // No permanently observed cache: last unmount releases the DAG.
            release(n)
          }
        },
      }
    },
    invalidate(keys: Iterable<string>) {
      const pending = new Set<Node>()
      function mark(n: Node) {
        if (pending.has(n)) return
        pending.add(n); n.dirty = true
        for (const user of n.users) mark(user)
      }
      for (const key of keys) for (const n of inputs.get(key) ?? []) { n.direct = true; mark(n) }
      // Mark the complete graph before evaluating or notifying any root.
      const notifications: Array<() => void> = [], errors: unknown[] = []
      const observed = [...pending].filter(n => n.listeners.size).map(n => ({ n, version: n.version }))
      for (const { n, version } of observed) {
        try { evaluate(n); if (n.version !== version) notifications.push(...n.listeners) } catch (error) { errors.push(error) }
      }
      for (const fn of notifications) { try { fn() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'Summary observer failed')
    },
    evict(owner: string) {
      for (const n of [...(owners.get(owner) ?? [])]) if (idle.delete(n.key)) release(n)
    },
    stats: () => ({ nodes: nodes.size, idleRoots: idle.size, observed: [...nodes.values()].reduce((sum, n) => sum + n.listeners.size, 0) }),
    destroy() {
      destroyed = true
      for (const n of nodes.values()) { n.listeners.clear(); n.deps.clear(); n.users.clear(); n.inputs.clear(); n.value = undefined }
      nodes.clear(); inputs.clear(); idle.clear(); owners.clear()
    },
  }
}
