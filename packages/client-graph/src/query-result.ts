import { compareStructural, createAtom, type IAtom, Reaction, untracked } from 'mobx'
import { LOADING, type Loaded } from './worklist/rollup'

interface Item<T> {
  id: string
  order: string
  value: T
}
interface Node<T> {
  item: Item<T>
  left?: Node<T>
  right?: Node<T>
  height: number
  size: number
}
const height = <T>(node?: Node<T>) => node?.height ?? 0
const size = <T>(node?: Node<T>) => node?.size ?? 0
const compare = <T>(a: Item<T>, b: Item<T>) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
function node<T>(item: Item<T>, left?: Node<T>, right?: Node<T>): Node<T> {
  return {
    item,
    left,
    right,
    height: Math.max(height(left), height(right)) + 1,
    size: size(left) + size(right) + 1,
  }
}
function balance<T>(item: Item<T>, left?: Node<T>, right?: Node<T>): Node<T> {
  if (height(left) > height(right) + 1) {
    const top = left!
    if (height(top.right) > height(top.left)) {
      const middle = top.right!
      return node(
        middle.item,
        node(top.item, top.left, middle.left),
        node(item, middle.right, right),
      )
    }
    return node(top.item, top.left, node(item, top.right, right))
  }
  if (height(right) > height(left) + 1) {
    const top = right!
    if (height(top.left) > height(top.right)) {
      const middle = top.left!
      return node(
        middle.item,
        node(item, left, middle.left),
        node(top.item, middle.right, top.right),
      )
    }
    return node(top.item, node(item, left, top.left), top.right)
  }
  return node(item, left, right)
}
function put<T>(root: Node<T> | undefined, item: Item<T>): Node<T> {
  if (!root) return node(item)
  const order = compare(item, root.item)
  return order < 0
    ? balance(root.item, put(root.left, item), root.right)
    : order > 0
      ? balance(root.item, root.left, put(root.right, item))
      : node(item, root.left, root.right)
}
function remove<T>(root: Node<T> | undefined, item: Item<T>): Node<T> | undefined {
  if (!root) return undefined
  const order = compare(item, root.item)
  if (order < 0) return balance(root.item, remove(root.left, item), root.right)
  if (order > 0) return balance(root.item, root.left, remove(root.right, item))
  if (!root.left) return root.right
  if (!root.right) return root.left
  let next = root.right
  while (next.left) next = next.left
  return balance(next.item, root.left, remove(root.right, next.item))
}
function itemAt<T>(root: Node<T> | undefined, index: number): Item<T> | undefined {
  while (root) {
    const left = size(root.left)
    if (index === left) return root.item
    if (index < left) root = root.left
    else {
      index -= left + 1
      root = root.right
    }
  }
  return undefined
}
function at<T>(root: Node<T> | undefined, index: number): T | undefined {
  return itemAt(root, index)?.value
}
function* orderedItems<T>(root: Node<T> | undefined): Generator<Item<T>> {
  if (!root) return
  yield* orderedItems(root.left)
  yield root.item
  yield* orderedItems(root.right)
}
function* valuesFrom<T>(root: Node<T> | undefined, index: number): Generator<T> {
  if (!root) return
  const left = size(root.left)
  if (index < left) yield* valuesFrom(root.left, index)
  if (index <= left) yield root.item.value
  yield* valuesFrom(root.right, Math.max(0, index - left - 1))
}

/** An array snapshot backed by a persistent ordered tree. Updating one answer
 * shares the other branches, rather than copying every output slot. Iteration
 * is linear in the requested output; publication never materializes that output.
 * A caller's array mutation detaches its snapshot from the shared tree. */
const snapshotRoots = new WeakMap<object, Node<unknown> | undefined>()
function snapshot<T>(root?: Node<T>): T[] {
  const result = arraySnapshot(size(root), index => valuesFrom(root, index), () => snapshotRoots.delete(result))
  snapshotRoots.set(result, root)
  return result
}

/** Join disjoint, ordered query snapshots without materializing their rows.
 * Each input's persistent root keeps the joined snapshot stable after updates. */
export function joinQueryResults<T>(results: readonly T[][]): T[] {
  const roots = results.map(result => {
    if (!snapshotRoots.has(result)) throw new Error('Expected an ordered query snapshot')
    return snapshotRoots.get(result) as Node<T> | undefined
  })
  const length = roots.reduce((count, root) => count + size(root), 0)
  function* joined(start: number): Generator<T> {
    const cursors = roots.map(root => orderedItems(root))
    const heads = cursors.map(cursor => cursor.next().value)
    let position = 0
    while (true) {
      let next = -1
      for (let group = 0; group < heads.length; group++) {
        const head = heads[group]
        if (head && (next < 0 || compare(head, heads[next]!) < 0)) next = group
      }
      if (next < 0) return
      const value = heads[next]!.value
      heads[next] = cursors[next]!.next().value
      if (position++ >= start) yield value
    }
  }
  return arraySnapshot(length, joined)
}

function arraySnapshot<T>(length: number, iterate: (start: number) => Generator<T>, onDetach?: () => void): T[] {
  let detached: T[] | undefined
  let cursor = iterate(0),
    lastIndex = -1,
    lastValue: T | undefined
  const read = (index: number) => {
    if (index >= length) return undefined
    if (index === lastIndex) return lastValue
    if (index !== lastIndex + 1) cursor = iterate(index)
    lastIndex = index
    lastValue = cursor.next().value
    return lastValue
  }
  const indexOf = (key: PropertyKey) =>
    typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : undefined
  const detach = () => {
    if (!detached) {
      detached = [...iterate(0)]
      onDetach?.()
    }
    return detached
  }
  return new Proxy<T[]>([], {
    get(target, key, receiver) {
      if (detached) return Reflect.get(detached, key, receiver)
      if (key === 'length') return length
      const index = indexOf(key)
      // Keep the native array iterator, including external instrumentation.
      // Sequential index reads share a cursor: map/iteration stay linear.
      return index === undefined ? Reflect.get(target, key, receiver) : read(index)
    },
    has(target, key) {
      if (detached) return Reflect.has(detached, key)
      const index = indexOf(key)
      return index === undefined ? Reflect.has(target, key) : index < length
    },
    ownKeys() {
      return detached
        ? Reflect.ownKeys(detached)
        : [...Array.from({ length }, (_, index) => String(index)), 'length']
    },
    getOwnPropertyDescriptor(target, key) {
      if (detached) return Reflect.getOwnPropertyDescriptor(detached, key)
      if (key === 'length')
        return { value: length, writable: true, enumerable: false, configurable: false }
      const index = indexOf(key)
      return index !== undefined && index < length
        ? { value: read(index), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key)
    },
    set(_target, key, value) {
      return Reflect.set(detach(), key, value)
    },
    deleteProperty(_target, key) {
      return Reflect.deleteProperty(detach(), key)
    },
    defineProperty(_target, key, descriptor) {
      return Reflect.defineProperty(detach(), key, descriptor)
    },
  })
}

/** A declared identity answer, changed one key at a time. Every caller owns
 * its array facade; reading the answer does not copy the complete membership. */
export function createKeyedAnswer<T>() {
  let root: Node<T> | undefined
  const items = new Map<string, Item<T>>()
  return {
    has: (id: string) => items.has(id),
    set(id: string, order: string, value: T): void {
      const before = items.get(id)
      if (before?.order === order && before.value === value) return
      if (before) root = remove(root, before)
      const after = { id, order, value }
      items.set(id, after)
      root = put(root, after)
    },
    delete(id: string): void {
      const before = items.get(id)
      if (!before) return
      items.delete(id)
      root = remove(root, before)
    },
    snapshot: () => snapshot(root),
  }
}

export interface QueryResultSpec<T> {
  name: string
  ids(): Iterable<string>
  has(id: string): boolean
  read(id: string): Loaded<T>
  order?(id: string): string
  /** Small existential questions over the same answers, maintained per key. */
  matches?: readonly ((value: T) => boolean)[]
  /** Membership deltas, already keyed by the declared question/relation. */
  subscribe(changed: (id: string | undefined) => void): () => void
  released?(): void
}

/** Demand-scoped answers. A row reaction compares only that row's answer;
 * a changed answer updates one tree path. Nothing remains after the last
 * reader releases the question, including its cold answers. */
export function createQueryResult<T>(spec: QueryResultSpec<T>) {
  const entries = new Map<string, { stop(): void; item?: Item<T>; pending: boolean }>()
  let root: Node<T> | undefined,
    cached: T[] | undefined,
    pending = 0
  let stopMembership: (() => void) | undefined
  let started = false
  const observed = new Set<IAtom>()
  const makeAtom = (name: string) => {
    const atom = createAtom(
      name,
      () => observed.add(atom),
      () => {
        observed.delete(atom)
        if (!observed.size) clear()
      },
    )
    return atom
  }
  const atom = makeAtom(spec.name)
  const matches = (spec.matches ?? []).map((test, index) => ({
    test,
    atom: makeAtom(`${spec.name}.match:${index}`),
    root: undefined as Node<T> | undefined,
  }))
  function replaceItem(before: Item<T> | undefined, after: Item<T> | undefined) {
    if (before) root = remove(root, before)
    if (after) root = put(root, after)
    for (const match of matches) {
      const previous = at(match.root, 0)
      if (before && match.test(before.value)) match.root = remove(match.root, before)
      if (after && match.test(after.value)) match.root = put(match.root, after)
      if (at(match.root, 0) !== previous) match.atom.reportChanged()
    }
  }
  function changed() {
    cached = undefined
    atom.reportChanged()
  }
  function drop(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entry.stop()
    entries.delete(id)
    if (entry.pending) pending--
    replaceItem(entry.item, undefined)
    if (entry.pending) for (const match of matches) match.atom.reportChanged()
    changed()
  }
  function sync(id: string) {
    if (!spec.has(id)) {
      drop(id)
      return
    }
    if (entries.has(id)) return
    const entry: { stop(): void; item?: Item<T>; pending: boolean } = { stop() {}, pending: false }
    entries.set(id, entry)
    let previous: { order: string; value: Loaded<T> } | undefined
    const row = new Reaction(`${spec.name}.row:${id}`, refresh)
    function refresh() {
      let next: { order: string; value: Loaded<T> } | undefined
      row.track(() => {
        next = { order: spec.order?.(id) ?? id, value: spec.read(id) }
      })
      if (!next || compareStructural(previous, next)) return
      previous = next
      const { order, value } = next
      const wasPending = entry.pending
      if (entry.pending) pending--
      entry.pending = value === LOADING
      if (entry.pending) pending++
      const oldItem = entry.item
      entry.item = value === undefined || value === LOADING ? undefined : { id, order, value }
      replaceItem(oldItem, entry.item)
      if (wasPending !== entry.pending) for (const match of matches) match.atom.reportChanged()
      changed()
    }
    entry.stop = () => row.dispose()
    // reaction() schedules its initial run until the outer derivation ends.
    // A synchronous first read must already contain every demanded answer.
    refresh()
  }
  function clear(release = true) {
    stopMembership?.()
    stopMembership = undefined
    for (const entry of entries.values()) entry.stop()
    entries.clear()
    root = undefined
    cached = undefined
    pending = 0
    for (const match of matches) match.root = undefined
    started = false
    if (release) spec.released?.()
  }
  function start() {
    if (started) return
    started = true
    untracked(() => {
      for (const id of spec.ids()) sync(id)
    })
    stopMembership = spec.subscribe((id) => {
      if (id !== undefined) sync(id)
      else {
        // Slice replacement is the sole full reset, not a single-row update.
        clear(false)
        start()
        // An empty replacement has no row refresh to invalidate witnesses.
        // It can also resolve a formerly pending question to empty.
        for (const match of matches) match.atom.reportChanged()
        changed()
      }
    })
  }
  return {
    get(): Loaded<T[]> {
      start()
      const tracked = atom.reportObserved()
      if (!pending && !cached) cached = snapshot(root)
      const result = pending ? LOADING : cached!
      if (!tracked && !observed.size) clear()
      return result
    },
    firstMatch(index: number): Loaded<T> {
      start()
      const match = matches[index]
      if (!match) throw new Error(`Undeclared query match: ${index}`)
      const tracked = match.atom.reportObserved()
      const result = pending ? LOADING : at(match.root, 0)
      if (!tracked && !observed.size) clear()
      return result
    },
    dispose: clear,
  }
}
