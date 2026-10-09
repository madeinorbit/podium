import { compareStructural, createAtom, type IAtom, Reaction, untracked } from 'mobx'
import { LOADING, type Loaded } from './worklist/rollup'

interface Item<T> {
  id: string
  order: string
  value: T
  point?: number
  matches?: readonly boolean[]
  totals?: readonly number[]
  partitionOrder?: string
}
interface Node<T> {
  item: Item<T>
  left?: Node<T>
  right?: Node<T>
  height: number
  size: number
  minPoint: number
  maxPoint: number
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
    minPoint: Math.min(
      item.point ?? Infinity,
      left?.minPoint ?? Infinity,
      right?.minPoint ?? Infinity,
    ),
    maxPoint: Math.max(
      item.point ?? -Infinity,
      left?.maxPoint ?? -Infinity,
      right?.maxPoint ?? -Infinity,
    ),
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
function put<T>(
  root: Node<T> | undefined,
  item: Item<T>,
  compareItems: (a: Item<T>, b: Item<T>) => number = compare<T>,
): Node<T> {
  if (!root) return node(item)
  const order = compareItems(item, root.item)
  return order < 0
    ? balance(root.item, put(root.left, item, compareItems), root.right)
    : order > 0
      ? balance(root.item, root.left, put(root.right, item, compareItems))
      : node(item, root.left, root.right)
}
function remove<T>(
  root: Node<T> | undefined,
  item: Item<T>,
  compareItems: (a: Item<T>, b: Item<T>) => number = compare<T>,
): Node<T> | undefined {
  if (!root) return undefined
  const order = compareItems(item, root.item)
  if (order < 0) return balance(root.item, remove(root.left, item, compareItems), root.right)
  if (order > 0) return balance(root.item, root.left, remove(root.right, item, compareItems))
  if (!root.left) return root.right
  if (!root.right) return root.left
  let next = root.right
  while (next.left) next = next.left
  return balance(next.item, root.left, remove(root.right, next.item, compareItems))
}
/** A value change at the same ordering key replaces one persistent path.
 * Removing it first would copy that path twice and rebalance an unchanged tree. */
function replace<T>(
  root: Node<T> | undefined,
  before: Item<T> | undefined,
  after: Item<T> | undefined,
  compareItems: (a: Item<T>, b: Item<T>) => number = compare<T>,
): Node<T> | undefined {
  if (before && (!after || compareItems(before, after) !== 0))
    root = remove(root, before, compareItems)
  return after ? put(root, after, compareItems) : root
}
/** Initial demand has no published root to preserve. Sort its entries once
 * and construct each immutable node once; subsequent edits use persistent paths. */
function build<T>(
  items: Item<T>[],
  compareItems: (a: Item<T>, b: Item<T>) => number = compare<T>,
): Node<T> | undefined {
  items.sort(compareItems)
  function range(start: number, end: number): Node<T> | undefined {
    if (start === end) return undefined
    const middle = (start + end) >>> 1
    return node(items[middle]!, range(start, middle), range(middle + 1, end))
  }
  return range(0, items.length)
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
const SNAPSHOT_ROOT = Symbol('orderedQuerySnapshot')
function snapshot<T>(root?: Node<T>): T[] {
  return arraySnapshot(size(root), (index) => valuesFrom(root, index), { root })
}

/** Join disjoint, ordered query snapshots without materializing their rows.
 * Each input's persistent root keeps the joined snapshot stable after updates. */
export function joinQueryResults<T>(results: readonly T[][]): T[] {
  const roots = results.map((result) => {
    const metadata = (result as T[] & { [SNAPSHOT_ROOT]?: { root?: Node<T> } })[SNAPSHOT_ROOT]
    if (!metadata) throw new Error('Expected an ordered query snapshot')
    return metadata.root
  })
  const length = roots.reduce((count, root) => count + size(root), 0)
  function* joined(start: number): Generator<T> {
    const cursors = roots.map((root) => orderedItems(root))
    const heads = cursors.map((cursor) => cursor.next().value)
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

function arraySnapshot<T>(
  length: number,
  iterate: (start: number) => Generator<T>,
  metadata?: { root?: Node<T> },
): T[] {
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
    }
    return detached
  }
  return new Proxy<T[]>([], {
    get(target, key, receiver) {
      if (key === SNAPSHOT_ROOT) return detached ? undefined : metadata
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
export interface KeyedAnswer<T> {
  has(id: string): boolean
  get(id: string): T | undefined
  first(): T | undefined
  after(value: T, id: string): T | undefined
  before(value: T, id: string): T | undefined
  /** First ordered answer after a pivot with a one-sided scalar bound.
   * Subtree extrema skip nonmatching history without visiting its entries. */
  firstBounded(bound: number, side: 'atMost' | 'above', after?: T, id?: string): T | undefined
  set(id: string, order: string, value: T): void
  delete(id: string): void
  snapshot(): T[]
  fork(): KeyedAnswer<T>
}
export function createKeyedAnswer<T>(
  compareValues?: (a: T, b: T) => number,
  point?: (value: T) => number,
  seed?: { root?: Node<T>; keys?: Node<Item<T>> },
): KeyedAnswer<T> {
  let root = seed?.root,
    keys = seed?.keys
  const item = (id: string): Item<T> | undefined => {
    let cursor = keys
    while (cursor) {
      if (id === cursor.item.id) return cursor.item.value
      cursor = id < cursor.item.id ? cursor.left : cursor.right
    }
    return undefined
  }
  const compareItems = compareValues
    ? (a: Item<T>, b: Item<T>) =>
        compareValues(a.value, b.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : compare<T>
  function neighbour(value: T, id: string, direction: number): T | undefined {
    const wanted = { id, order: item(id)?.order ?? '', value }
    let cursor = root, candidate: Item<T> | undefined
    while (cursor) {
      if (compareItems(wanted, cursor.item) * direction < 0) {
        candidate = cursor.item
        cursor = direction > 0 ? cursor.left : cursor.right
      } else cursor = direction > 0 ? cursor.right : cursor.left
    }
    return candidate?.value
  }
  return {
    has: (id: string) => item(id) !== undefined,
    get: (id: string) => item(id)?.value,
    first: () => at(root, 0),
    after: (value, id) => neighbour(value, id, 1),
    before: (value, id) => neighbour(value, id, -1),
    firstBounded(bound, side, after, id = '') {
      const pivot =
        after === undefined ? undefined : { id, order: item(id)?.order ?? '', value: after }
      const eligible = (value: number) => (side === 'atMost' ? value <= bound : value > bound)
      function search(cursor: Node<T> | undefined, lower?: Item<T>): T | undefined {
        if (!cursor || !eligible(side === 'atMost' ? cursor.minPoint : cursor.maxPoint))
          return undefined
        if (lower && compareItems(cursor.item, lower) <= 0) return search(cursor.right, lower)
        const left = search(cursor.left, lower)
        if (left !== undefined) return left
        if (eligible(cursor.item.point ?? NaN)) return cursor.item.value
        return search(cursor.right)
      }
      return search(root, pivot)
    },
    set(id: string, order: string, value: T): void {
      const before = item(id)
      if (before?.order === order && before.value === value) return
      const after = { id, order, value, ...(point ? { point: point(value) } : {}) }
      keys = put(keys, { id, order: id, value: after })
      root = replace(root, before, after, compareItems)
    },
    delete(id: string): void {
      const before = item(id)
      if (!before) return
      keys = remove(keys, { id, order: id, value: before })
      root = remove(root, before, compareItems)
    },
    snapshot: () => snapshot(root),
    fork: () => createKeyedAnswer(compareValues, point, { root, keys }),
  }
}

/** An unpublished bootstrap accumulator. Ordered reads finish it into the
 * ordinary persistent tree; the temporary map is released at that boundary. */
export function createKeyedAnswerBuilder<T>(
  compareValues?: (a: T, b: T) => number,
  point?: (value: T) => number,
): { answer: KeyedAnswer<T>; finish(): KeyedAnswer<T> } {
  let pending: Map<string, Item<T>> | undefined = new Map()
  let complete: KeyedAnswer<T> | undefined
  function finish(): KeyedAnswer<T> {
    if (pending) {
      const items = [...pending.values()]
      const compareItems = compareValues
        ? (a: Item<T>, b: Item<T>) =>
            compareValues(a.value, b.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : compare<T>
      complete = createKeyedAnswer(compareValues, point, {
        root: build(items, compareItems),
        keys: build(items.map((value) => ({ id: value.id, order: value.id, value }))),
      })
      pending = undefined
    }
    return complete!
  }
  return {
    finish,
    answer: {
      has: (id) => (pending ? pending.has(id) : finish().has(id)),
      get: (id) => (pending ? pending.get(id)?.value : finish().get(id)),
      set(id, order, value) {
        if (!pending) {
          finish().set(id, order, value)
          return
        }
        const before = pending.get(id)
        if (before?.order === order && before.value === value) return
        pending.set(id, { id, order, value, ...(point ? { point: point(value) } : {}) })
      },
      delete(id) {
        if (pending) pending.delete(id)
        else finish().delete(id)
      },
      first: () => finish().first(),
      after: (value, id) => finish().after(value, id),
      before: (value, id) => finish().before(value, id),
      firstBounded: (bound, side, after, id) => finish().firstBounded(bound, side, after, id),
      snapshot: () => finish().snapshot(),
      fork: () => finish().fork(),
    },
  }
}

export interface QueryResultSpec<T> {
  name: string
  ids(): Iterable<string>
  has(id: string): boolean
  read(id: string): Loaded<T>
  order?(id: string): string
  compareOrder?(a: string, b: string): number
  /** Parked duplicates publish one winner at their first member's position.
   * An active member keeps its entire group visible. Only the changed group
   * is reconsidered, using the demanded row summaries. */
  collapse?: {
    key(value: T): string | undefined
    keepsGroup(value: T): boolean
    compare(a: T, b: T): number
  }
  /** Small existential questions over the same answers, maintained per key. */
  matches?: readonly ((value: T) => boolean)[]
  /** Numeric facts are tracked per answer, independently of its order. */
  totals?: readonly ((value: T) => number)[]
  /** Split matched answers after retaining a bounded leading prefix. The
   * matching order may differ from the display order. */
  partition?: {
    order(value: T): string | undefined
    compareOrder(a: string, b: string): number
    keepFirst: number
    minimumSize: number
  }
  /** Membership deltas, already keyed by the declared question/relation. */
  subscribe(changed: (id: string | undefined) => void): () => void
  released?(): void
}

/** Demand-scoped answers. A row reaction compares only that row's answer;
 * a changed answer updates one tree path. Nothing remains after the last
 * reader releases the question, including its cold answers. */
export function createQueryResult<T>(spec: QueryResultSpec<T>) {
  const compareItems = spec.compareOrder
    ? (a: Item<T>, b: Item<T>) => spec.compareOrder!(a.order, b.order) || a.id.localeCompare(b.id)
    : compare<T>
  const entries = new Map<string, { stop(): void; item?: Item<T>; pending: boolean }>()
  const groups = new Map<string, { members: Map<string, Item<T>>; shown: Map<string, Item<T>> }>()
  let root: Node<T> | undefined,
    cached: T[] | undefined,
    summary: { rows: T[]; pending: number } | undefined,
    pending = 0
  let stopMembership: (() => void) | undefined
  let started = false
  let seeding = false
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
  const matches = (spec.matches ?? []).map((_test, index) => ({
    atom: makeAtom(`${spec.name}.match:${index}`),
    countAtom: makeAtom(`${spec.name}.count:${index}`),
    root: undefined as Node<T> | undefined,
    rowsAtom: makeAtom(`${spec.name}.matches:${index}`),
    cached: undefined as T[] | undefined,
  }))
  const totals = (spec.totals ?? []).map((_read, index) => ({
    value: 0, atom: makeAtom(`${spec.name}.total:${index}`),
  }))
  const countAtom = makeAtom(`${spec.name}.size`)
  let partitionRoot: Node<T> | undefined, shownRoot: Node<T> | undefined, hiddenRoot: Node<T> | undefined
  const shownAtom = makeAtom(`${spec.name}.visible`), hiddenAtom = makeAtom(`${spec.name}.hidden`)
  let shownSnapshot: T[] | undefined, hiddenSnapshot: T[] | undefined
  const partitionCompare = (a: Item<T>, b: Item<T>) =>
    spec.partition!.compareOrder(a.order, b.order) || a.id.localeCompare(b.id)
  const partitionItem = (item: Item<T> | undefined) => item?.partitionOrder === undefined
    ? undefined : { ...item, order: item.partitionOrder }
  function retained(tree: Node<T> | undefined, count: number): Set<string> {
    const ids = new Set<string>()
    for (let index = 0; index < Math.min(count, size(tree)); index++) ids.add(itemAt(tree, index)!.id)
    return ids
  }
  function hidden(item: Item<T> | undefined, tree: Node<T> | undefined, keep: Set<string>): boolean {
    return item !== undefined && size(tree) > spec.partition!.minimumSize && item.partitionOrder !== undefined && !keep.has(item.id)
  }
  function updatePartition(before: Item<T> | undefined, after: Item<T> | undefined, previousRoot: Node<T> | undefined) {
    if (!spec.partition) return
    const oldKeep = retained(partitionRoot, spec.partition.keepFirst)
    partitionRoot = replace(partitionRoot, partitionItem(before), partitionItem(after), partitionCompare)
    const newKeep = retained(partitionRoot, spec.partition.keepFirst)
    const affected = new Set([...oldKeep, ...newKeep])
    if (before) affected.add(before.id)
    if (after) affected.add(after.id)
    // Crossing the all-visible threshold can affect at most minimumSize+1 rows.
    if ((size(previousRoot) <= spec.partition.minimumSize) !== (size(root) <= spec.partition.minimumSize))
      for (const id of [...retained(previousRoot, spec.partition.minimumSize + 1), ...retained(root, spec.partition.minimumSize + 1)]) affected.add(id)
    for (const id of affected) {
      const oldItem = id === before?.id ? before : id === after?.id ? undefined : entries.get(id)?.item
      const newItem = id === after?.id ? after : id === before?.id ? undefined : entries.get(id)?.item
      const wasHidden = hidden(oldItem, previousRoot, oldKeep), isHidden = hidden(newItem, root, newKeep)
      shownRoot = replace(shownRoot, oldItem && !wasHidden ? oldItem : undefined, newItem && !isHidden ? newItem : undefined, compareItems)
      hiddenRoot = replace(hiddenRoot, wasHidden ? oldItem : undefined, isHidden ? newItem : undefined, compareItems)
    }
    shownSnapshot = hiddenSnapshot = undefined
    shownAtom.reportChanged(); hiddenAtom.reportChanged()
  }
  function replaceItem(before: Item<T> | undefined, after: Item<T> | undefined) {
    if (seeding) return
    const previousRoot = root
    const previousSize = size(root)
    root = replace(root, before, after, compareItems)
    if (size(root) !== previousSize) countAtom.reportChanged()
    updatePartition(before, after, previousRoot)
    for (let index = 0; index < totals.length; index++) {
      const total = totals[index]!
      const delta = (after?.totals?.[index] ?? 0) - (before?.totals?.[index] ?? 0)
      if (delta) { total.value += delta; total.atom.reportChanged() }
    }
    for (const [index, match] of matches.entries()) {
      const previous = at(match.root, 0)
      const beforeSize = size(match.root)
      match.root = replace(
        match.root,
        before?.matches?.[index] ? before : undefined,
        after?.matches?.[index] ? after : undefined,
        compareItems,
      )
      if (before?.matches?.[index] || after?.matches?.[index]) {
        match.cached = undefined
        match.rowsAtom.reportChanged()
      }
      if (at(match.root, 0) !== previous) match.atom.reportChanged()
      if (size(match.root) !== beforeSize) match.countAtom.reportChanged()
    }
  }
  function changed() {
    cached = undefined
    summary = undefined
    atom.reportChanged()
  }
  function reconcile(key: string): boolean {
    const group = groups.get(key)!
    let first: Item<T> | undefined, winner: Item<T> | undefined, active = false
    for (const item of group.members.values()) {
      if (!first || compare(item, first) < 0) first = item
      if (!winner || (spec.collapse!.compare(item.value, winner.value) || compare(item, winner)) < 0)
        winner = item
      active ||= spec.collapse!.keepsGroup(item.value)
    }
    const next = active ? new Map(group.members) : new Map<string, Item<T>>()
    if (!active && winner && first) next.set(winner.id, { ...winner, order: first.order })
    let updated = false
    for (const [id, before] of group.shown) {
      if (!next.has(id)) { replaceItem(before, undefined); updated = true }
    }
    for (const [id, after] of next) {
      const before = group.shown.get(id)
      if (before?.order === after.order && before.value === after.value) continue
      replaceItem(before, after)
      updated = true
    }
    group.shown = next
    if (!group.members.size) groups.delete(key)
    return updated
  }
  function updateItem(before: Item<T> | undefined, after: Item<T> | undefined): boolean {
    if (!spec.collapse) {
      replaceItem(before, after)
      return before !== undefined || after !== undefined
    }
    const beforeKey = before && spec.collapse.key(before.value),
      afterKey = after && spec.collapse.key(after.value)
    if (beforeKey !== undefined) groups.get(beforeKey)!.members.delete(before!.id)
    if (afterKey !== undefined) {
      let group = groups.get(afterKey)
      if (!group) {
        group = { members: new Map(), shown: new Map() }
        groups.set(afterKey, group)
      }
      group.members.set(after!.id, after!)
    }
    let updated = false
    if (beforeKey === undefined && before) { replaceItem(before, undefined); updated = true }
    if (!seeding) {
      if (beforeKey !== undefined) updated = reconcile(beforeKey) || updated
    }
    if (afterKey === undefined && after) { replaceItem(undefined, after); updated = true }
    if (!seeding && afterKey !== undefined && afterKey !== beforeKey)
      updated = reconcile(afterKey) || updated
    return updated
  }
  function witnessesChanged() {
    countAtom.reportChanged()
    shownAtom.reportChanged(); hiddenAtom.reportChanged()
    for (const total of totals) total.atom.reportChanged()
    for (const match of matches) {
      match.atom.reportChanged(); match.countAtom.reportChanged(); match.rowsAtom.reportChanged()
    }
  }
  function drop(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entry.stop()
    entries.delete(id)
    if (entry.pending) pending--
    const updated = updateItem(entry.item, undefined)
    if (entry.pending) witnessesChanged()
    if (updated || entry.pending) changed()
  }
  function sync(id: string) {
    if (!spec.has(id)) {
      drop(id)
      return
    }
    if (entries.has(id)) return
    const entry: { stop(): void; item?: Item<T>; pending: boolean } = { stop() {}, pending: false }
    entries.set(id, entry)
    let previous: { order: string; value: Loaded<T>; matches: boolean[]; totals: number[]; partitionOrder?: string } | undefined
    const row = new Reaction(`${spec.name}.row:${id}`, refresh)
    function refresh() {
      let next: typeof previous
      row.track(() => {
        const value = spec.read(id)
        const here = value !== undefined && value !== LOADING
        next = { order: spec.order?.(id) ?? id, value,
          matches: here ? (spec.matches ?? []).map(test => test(value)) : [],
          totals: here ? (spec.totals ?? []).map(read => read(value)) : [],
          partitionOrder: here ? spec.partition?.order(value) : undefined }
      })
      if (!next || compareStructural(previous, next)) return
      previous = next
      const { value } = next
      const wasPending = entry.pending
      entry.pending = value === LOADING
      pending += Number(entry.pending) - Number(wasPending)
      const oldItem = entry.item
      entry.item = value === undefined || value === LOADING ? undefined : { id, ...next, value }
      const updated = updateItem(oldItem, entry.item)
      if (wasPending !== entry.pending) witnessesChanged()
      if (updated || wasPending !== entry.pending) changed()
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
    groups.clear()
    root = undefined
    cached = undefined
    summary = undefined
    pending = 0
    for (const match of matches) { match.root = undefined; match.cached = undefined }
    for (const total of totals) total.value = 0
    partitionRoot = shownRoot = hiddenRoot = undefined
    shownSnapshot = hiddenSnapshot = undefined
    started = false
    if (release) spec.released?.()
  }
  function start() {
    if (started) return
    started = true
    // untracked-read: query-result-seed
    untracked(() => {
      seeding = true
      try {
        for (const id of spec.ids()) sync(id)
        for (const key of groups.keys()) reconcile(key)
      } finally {
        seeding = false
      }
      const items: Item<T>[] = []
      for (const entry of entries.values())
        if (entry.item && spec.collapse?.key(entry.item.value) === undefined) items.push(entry.item)
      for (const group of groups.values()) items.push(...group.shown.values())
      root = build(items, compareItems)
      for (const [index, match] of matches.entries())
        match.root = build(items.filter(item => item.matches?.[index]), compareItems)
      for (const [index, total] of totals.entries()) total.value = items.reduce((sum, item) => sum + (item.totals?.[index] ?? 0), 0)
      if (spec.partition) {
        partitionRoot = build(items.filter(item => item.partitionOrder !== undefined).map(item => partitionItem(item)!), partitionCompare)
        const keep = retained(partitionRoot, spec.partition.keepFirst)
        shownRoot = build(items.filter(item => !hidden(item, root, keep)), compareItems)
        hiddenRoot = build(items.filter(item => hidden(item, root, keep)), compareItems)
      }
    })
    stopMembership = spec.subscribe((id) => {
      if (id !== undefined) sync(id)
      else {
        // Slice replacement is the sole full reset, not a single-row update.
        clear(false)
        start()
        // An empty replacement has no row refresh to invalidate witnesses.
        // It can also resolve a formerly pending question to empty.
        witnessesChanged()
        changed()
      }
    })
  }
  /** Every answer shares the same demand lifetime; only its signal differs. */
  function read<R>(signal: IAtom, answer: () => R, partial?: false): Loaded<R>
  function read<R>(signal: IAtom, answer: () => R, partial: true): R
  function read<R>(signal: IAtom, answer: () => R, partial = false): Loaded<R> {
    start()
    const tracked = signal.reportObserved()
    const result = pending && !partial ? LOADING : answer()
    if (!tracked && !observed.size) clear()
    return result
  }
  function declared<R>(answers: readonly R[], index: number, kind: string): R {
    start()
    const answer = answers[index]
    if (!answer) throw new Error(`Undeclared query ${kind}: ${index}`)
    return answer
  }
  return {
    get: () => read(atom, () => cached ??= snapshot(root)),
    /** Partial answers and an exact pending count, without enumerating rows. */
    summary: () => read(atom, () => summary ??= { rows: cached ??= snapshot(root), pending }, true),
    firstMatch(index: number): Loaded<T> {
      const match = declared(matches, index, 'match')
      return read(match.atom, () => at(match.root, 0))
    },
    countMatch(index: number): Loaded<number> {
      const match = declared(matches, index, 'match')
      return read(match.countAtom, () => size(match.root))
    },
    getMatch(index: number): Loaded<T[]> {
      const match = declared(matches, index, 'match')
      return read(match.rowsAtom, () => match.cached ??= snapshot(match.root))
    },
    count: () => read(countAtom, () => size(root)),
    total(index: number): Loaded<number> {
      const total = declared(totals, index, 'total')
      return read(total.atom, () => total.value)
    },
    partition(hidden: boolean): Loaded<T[]> {
      if (!spec.partition) throw new Error('Undeclared query partition')
      return read(hidden ? hiddenAtom : shownAtom, () => hidden
        ? hiddenSnapshot ??= snapshot(hiddenRoot) : shownSnapshot ??= snapshot(shownRoot))
    },
    dispose: clear,
  }
}


/** Native list boundaries can map or concatenate persistent answers without
 * visiting members until the caller asks for those output positions. */
export function mapQueryResult<T, U>(source: readonly T[], map: (value: T) => U): U[] {
  function* mapped(start: number): Generator<U> {
    for (let index = start; index < source.length; index++) yield map(source[index]!)
  }
  return arraySnapshot(source.length, mapped)
}
export function concatQueryResults<T>(sources: readonly (readonly T[])[]): T[] {
  const length = sources.reduce((total, source) => total + source.length, 0)
  function* joined(start: number): Generator<T> {
    for (const source of sources) {
      if (start >= source.length) { start -= source.length; continue }
      for (let index = start; index < source.length; index++) yield source[index]!
      start = 0
    }
  }
  return arraySnapshot(length, joined)
}

/** Apply a bounded edit to a data answer without copying its unchanged slots. */
export function spliceQueryResult<T>(source: readonly T[], start: number, removeCount: number, ...inserted: T[]): T[] {
  const length = source.length - removeCount + inserted.length
  function* edited(index: number): Generator<T> {
    for (; index < length; index++) {
      if (index < start) yield source[index]!
      else if (index < start + inserted.length) yield inserted[index - start]!
      else yield source[index - inserted.length + removeCount]!
    }
  }
  return arraySnapshot(length, edited)
}
