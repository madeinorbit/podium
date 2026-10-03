/**
 * POD-4746 — the work a change does, counted from OUTSIDE the arm.
 *
 * The scale check (`scale-check.ts`) asks one question: does the work a change
 * does grow with the amount of data? It needs the work counted the same way
 * for every arm, with nothing in the arm's own code. This module counts
 * derivations and collection elements; a supplied pool also counts its row
 * calls. Worklist arms continue to count feed reads through `ReadStats.data`.
 *
 * - ROWS: every call to the supplied pool's single row reader, including
 *   resident, summary, repeated and absent reads. Source callbacks count too.
 * - DERIVATIONS: derivation bodies run. Every MobX computed body
 *   (`ComputedValue.computeValue_`) and every reaction body (`Reaction.track`:
 *   autoruns, reactions and `observer` renders all run through it), and every
 *   hand-rolled cell body (`CellGraph.run`: `arms/hand/pool/cells.ts` — patched
 *   here, from OUTSIDE the hand arm, as the MobX patch is; nothing in the
 *   hand arm counts itself, POD-4934).
 * - ELEMENTS: the DISTINCT collection elements the arm iterated. Array, Set
 *   and Map iteration (`for…of`, spreads, `Array.from`, `new Set(iterable)`:
 *   all go through the patched iterators), `forEach` and the Array callback
 *   methods, the Array methods that walk the whole array without a callback
 *   (`indexOf`, `includes`, `join`, `sort`, `reverse`, …: every element) or
 *   build one (`slice`, `concat`, `flat`: the result's), and
 *   `Object.keys/values/entries`. MobX's observable collections are built on
 *   these, so they count through them; so does MobX's own fan-out to
 *   observers (`observers_.forEach`).
 *
 * DISTINCT, like rows read: the question is how much of the data a change
 * touched, and walking the same family three times (a roll-up, a sort, a
 * filter) is a constant factor, not growth. An element is its value when that
 * is an object or a string (a row, a node, an id), a Map entry is its key,
 * and any other primitive is its position in its container. A row's own MobX
 * node stands for its row (POD-4792): the arm names a row's derivations
 * `<Class>@<id>.<part>` (`arms/mobx/pool/cached.ts`, as the census attributes
 * them), and MobX's fan-out to a changed row's twenty-odd parts touches one
 * row, a constant factor like the three walks above. `visits` keeps
 * the raw count, and `elementsBy` splits the distinct count by the derivation
 * that walked it, to name where a count comes from.
 *
 * WHOSE WORK. The patches are process-wide, so they would also count the
 * scenario engine applying the write, the feed computing its events, React
 * reconciling, the harness's own oracle and happy-dom's DOM. Only the ARM's
 * work counts. The side is carried by an `AsyncLocalStorage`, so it follows
 * the code through awaits, microtasks and timers. `measureWork` runs its body
 * NOT as the arm; the arm's side is entered only where the arm's code is
 * called:
 *
 * - `insideArm`, where the harness calls the arm: the feed's row-event and
 *   locals listeners (`openFenceFeeds`), a lazy arm's `settleLoads`, and an
 *   adapter's derive (the legacy control's);
 * - every MobX derivation body (a computed, a reaction, an `observer`
 *   render): MobX is the arm's alone, so its bodies always run on the arm's
 *   side, wherever React or a timer calls them from. An `observer`'s
 *   invalidation is the one MobX step that is not: it asks React to redraw,
 *   and the redraw React schedules there must not inherit the arm's side.
 * - every hand cell body (`CellGraph.run`): the hand pool's alone, so its
 *   bodies always run on the arm's side too, wherever the pool, the drain or
 *   a render calls them from (POD-4934).
 *
 * What the arm schedules from there (its timers, its loads) stays the arm's.
 * React's own reconciliation is not counted: the full-list variants draw
 * every row (happy-dom has no layout), so React visits every sibling of a
 * redrawn row. The window and native variants draw bounded windows; the exact-commit fence
 * holds what React redraws. A plain (non-`observer`) component body is React's
 * side too. happy-dom's DOM mutation methods run outside while measuring, so
 * the DOM's own bookkeeping never counts, even when the arm calls it.
 *
 * WHAT IT CANNOT SEE: an index loop (`for (let i = 0; i < a.length; i++)`)
 * over a plain array (except the app projection comparer, observed through
 * `countedStructuralEqual`), and a walk inside a closure-held native structure the
 * patches do not reach (a typed array, a string). A full walk written that way
 * still reads rows, which the feed counts; a walk over ids only does not. That
 * stays a review item, as the copy sweep's blind spots do.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { MobxPool } from '@podium/client-graph/pool'
import { compareStructural, computed, isBoxedObservable, isObservableMap, isObservableSet, Reaction } from 'mobx'
import { CellGraph } from '../../arms/hand/pool/cells'

type Side = 'arm' | 'outside'

/**
 * The side follows the code through awaits (Node's `AsyncLocalStorage`). A
 * browser page has no `node:async_hooks` (its bundle stubs the module, so the
 * class is undefined there) and never measures work: the legacy control's
 * page imports `insideArm` through its arm, and there the side is simply not
 * tracked (POD-4747: constructing it unguarded threw at the page's load, so
 * the control page never booted).
 */
type SideStore = Pick<AsyncLocalStorage<Side>, 'run' | 'getStore'>
const UNTRACKED: SideStore = {
  run<R>(_store: Side, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return fn(...args)
  },
  getStore: () => undefined,
}
const side: SideStore =
  typeof AsyncLocalStorage === 'function' ? new AsyncLocalStorage<Side>() : UNTRACKED
const readerSide: Pick<AsyncLocalStorage<string>, 'run' | 'getStore'> = typeof AsyncLocalStorage ===
'function'
  ? new AsyncLocalStorage<string>()
  : {
      run<R>(_name: string, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
        return fn(...args)
      },
      getStore: () => undefined,
    }

/** Run `fn` as not-the-arm (the engine, the feed, the DOM): nothing it iterates counts. */
export function outsideArm<T>(fn: () => T): T {
  return side.run('outside', fn)
}

/** Run `fn` as the arm (a listener the feed calls, a load it lands): what it iterates counts. */
export function insideArm<T>(fn: () => T): T {
  return side.run('arm', fn)
}

/** Work counted by one `measureWork`. */
export interface WorkCounts {
  /** Derivation bodies run: MobX computeds recomputed plus reaction bodies tracked, plus hand cell bodies run. */
  derivations: number
  /** Bodies run per named derivation/consumer; a cheap reader cannot hide a growing one. */
  derivationsBy: Record<string, number>
  /** Pool row calls, including resident and summary reads (only when `pool` is supplied). */
  rows?: number
  rowsBy?: Record<string, number>
  /** Distinct collection elements the arm iterated (see the module note). */
  elements: number
  /**
   * `elements` split by the derivation that walked them (its name with
   * digits folded to `#`, so every node of one kind shares a key — a MobX
   * derivation or a hand cell, POD-4934), or
   * {@link ARM_CODE} for the arm's code outside any derivation. An element
   * two derivations walk counts in both.
   */
  elementsBy: Record<string, number>
  /** Element visits, repeats included: for diagnosis, not judged. */
  visits: number
}

/** The `elementsBy` key of the arm's code outside any MobX derivation (actions, listeners, loads). */
export const ARM_CODE = '(arm code)'

interface Tally {
  derivations: number
  derivationsBy: Map<string, number>
  rows: number
  rowsBy: Map<string, number>
  visits: number
  seen: Set<unknown>
  seenBy: Map<string, Set<unknown>>
  /** Visits per call site (first frames outside this module), when tracing. */
  sites: Map<string, number> | null
}

let tally: Tally | null = null

/** App/event readers run outside MobX too. Attribute and count their actual bodies. */
export function insideReader<T>(name: string, read: () => T): T {
  const by = `consumer:${name}`
  if (tally !== null) countDerivation(by)
  running.push(by)
  try {
    return readerSide.run(by, () => insideArm(read))
  } finally {
    running.pop()
  }
}

/** The app's structural comparer uses plain array index loops. Delegate its
 * equality decision to MobX, observing those reads through lazy, test-only
 * shadows. One proxy per object preserves shared references and cycles; the
 * empty targets also preserve access to frozen row/array values. */
export function countedStructuralEqual(before: unknown, next: unknown): boolean {
  if (tally === null || before === next) return compareStructural(before, next)
  const proxies = new WeakMap<object, object>()
  function wrap(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    return outsideArm(() => {
      const cached = proxies.get(value)
      if (cached) return cached
      const array = Array.isArray(value)
      const shadow = array ? [] : {}
      const prototype = Reflect.getPrototypeOf(value)
      const native = value instanceof Map || value instanceof Set || value instanceof Date ||
        value instanceof Number || value instanceof String || value instanceof Boolean ||
        (prototype !== null && (isObservableMap(prototype) || isObservableSet(prototype) || isBoxedObservable(prototype)))
      const proxy = new Proxy(shadow, {
        get(_target, key) {
          const item = Reflect.get(value, key, value)
          if (array && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
            const walk = startWalk()
            // Comparisons visit slots even when their cached values repeat.
            if (walk) visit(walk, identity(undefined, value, Number(key)))
          }
          if (typeof item === 'function' && native && key !== 'constructor') {
            if (key === 'entries' || key === 'values' || key === 'keys' || key === Symbol.iterator)
              return (...args: unknown[]) => {
                const iterator = item.apply(value, args) as Iterator<unknown>
                return {
                  next() {
                    const result = iterator.next()
                    return result.done ? result : { done: false, value: wrap(result.value) }
                  },
                  [Symbol.iterator]() { return this },
                }
              }
            return item.bind(value)
          }
          // MobX administration symbols must keep their original receiver.
          return typeof key === 'symbol' ? item : wrap(item)
        },
        ownKeys: () => Reflect.ownKeys(value),
        has: (_target, key) => Reflect.has(value, key),
        getPrototypeOf: () => Reflect.getPrototypeOf(value),
        getOwnPropertyDescriptor(_target, key) {
          if (array && key === 'length') return Reflect.getOwnPropertyDescriptor(shadow, key)
          const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
          return descriptor && { ...descriptor, configurable: true }
        },
      })
      proxies.set(value, proxy)
      return proxy
    })
  }
  return compareStructural(wrap(before), wrap(next))
}

function countDerivation(by: string): void {
  if (tally === null) return
  tally.derivations++
  tally.derivationsBy.set(by, (tally.derivationsBy.get(by) ?? 0) + 1)
}

function derivationOwner(name: unknown): string {
  const kind = kindOf(name)
  if (kind.startsWith('consumer:')) return kind
  for (let index = running.length - 1; index >= 0; index--) {
    const parent = running[index]!
    if (parent.startsWith('consumer:')) return `${parent.split('/')[0]}/${kind}`
  }
  const reader = readerSide.getStore()
  if (reader !== undefined) return `${reader}/${kind}`
  return kind
}

/**
 * The call site of a counted call: the first stack frames outside this
 * module. String methods and index loops only: a patched Array method here
 * would count itself and recurse.
 */
function siteOf(): string {
  const lines = (new Error().stack ?? '').split('\n')
  let site = ''
  let frames = 0
  for (let i = 1; i < lines.length && frames < 3; i += 1) {
    const line = lines[i]!
    if (line.includes('work-meter')) continue
    const frame = line
      .trim()
      .replace(/^at /, '')
      .replace(/\?[^:)]*/, '')
    site = frames === 0 ? frame : `${site} < ${frame}`
    frames += 1
  }
  return site
}

function traceSite(): string | null {
  const current = tally
  if (current === null || current.sites === null) return null
  // The stack's own formatting (source maps) iterates: not the arm's work.
  tally = null
  try {
    return siteOf()
  } finally {
    tally = current
  }
}

/** The derivations running now, innermost last (their kinds). */
const running: string[] = []

/** The kind of a derivation: its name with digits folded, so one key per kind of node. */
function kindOf(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\d+/g, '#') : '(unnamed)'
}

function owner(): string {
  return running.length === 0 ? (readerSide.getStore() ?? ARM_CODE) : running[running.length - 1]!
}

const containerIds = new WeakMap<object, number>()
let nextContainer = 0

/** `<Class>@<id>.<part>`: a row's MobX node, named for its row (`arms/mobx/pool/cached.ts`). */
const ROW_NODE = /^[A-Za-z]\w*@([^.]+)\./

/**
 * An element's identity: its row's id when it is a row's MobX node, else
 * itself when an object or a string, else its position in its container.
 */
function identity(value: unknown, container: unknown, position: unknown): unknown {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name_?: unknown }).name_
    const row = typeof name === 'string' ? ROW_NODE.exec(name) : null
    return row === null ? value : row[1]
  }
  if (typeof value === 'function') return value
  if (typeof container !== 'object' || container === null) return value
  let id = containerIds.get(container)
  if (id === undefined) {
    nextContainer += 1
    id = nextContainer
    containerIds.set(container, id)
  }
  return `\u0000${id}:${String(position)}`
}

/** Where a walk's elements go: decided when the walk starts. */
interface Walk {
  site: string | null
  seenBy: Set<unknown>
}

function startWalk(): Walk | null {
  if (tally === null || side.getStore() !== 'arm') return null
  const by = owner()
  let seenBy = tally.seenBy.get(by)
  if (seenBy === undefined) {
    seenBy = new Set()
    tally.seenBy.set(by, seenBy)
  }
  return { site: traceSite(), seenBy }
}

function visit(walk: Walk, element: unknown): void {
  if (tally === null) return
  tally.visits += 1
  tally.seen.add(element)
  walk.seenBy.add(element)
  if (tally.sites !== null && walk.site !== null) {
    tally.sites.set(walk.site, (tally.sites.get(walk.site) ?? 0) + 1)
  }
}

type Method = (this: unknown, ...args: unknown[]) => unknown

/** Save-and-replace for one window; restored in reverse order. */
class Patches {
  private readonly saved: [object, PropertyKey, PropertyDescriptor][] = []

  replace(target: object, key: PropertyKey, make: (original: Method) => Method): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new Error(`[work] cannot patch ${String(key)}: not an own method`)
    }
    this.saved.push([target, key, descriptor])
    Object.defineProperty(target, key, { ...descriptor, value: make(descriptor.value as Method) })
  }

  restore(): void {
    for (let i = this.saved.length - 1; i >= 0; i -= 1) {
      const [target, key, descriptor] = this.saved[i]!
      Object.defineProperty(target, key, descriptor)
    }
    this.saved.length = 0
  }
}

/** What a yielded step stands for, per iterator kind. */
type StepIdentity = (value: unknown, container: unknown, index: number) => unknown

const itself: StepIdentity = (value, container, index) => identity(value, container, index)
const entryValue: StepIdentity = (value, container, index) =>
  identity((value as unknown[])[1], container, index)
const entryKey: StepIdentity = (value, container, index) =>
  identity((value as unknown[])[0], container, index)

/**
 * An iterator-returning method whose every yielded element counts (the side
 * decided when the walk starts). `keyed` (a Map's `values`) walks the entries
 * instead, so each value counts as its key.
 */
function countedIterator(
  stepIdentity: StepIdentity,
  keyed?: (receiver: unknown) => Iterator<unknown>,
): (original: Method) => Method {
  return (original) =>
    function (this: unknown, ...args: unknown[]) {
      const walk = startWalk()
      if (walk === null) return original.apply(this, args)

      const source = (
        keyed === undefined ? original.apply(this, args) : keyed(this)
      ) as Iterator<unknown>
      const next = source.next
      let index = 0
      const step = (...nextArgs: unknown[]): IteratorResult<unknown> => {
        const result = (next as Method).apply(source, nextArgs) as IteratorResult<unknown>
        if (result.done === true) return result
        visit(
          walk,
          keyed === undefined
            ? stepIdentity(result.value, this, index)
            : entryKey(result.value, this, index),
        )
        index += 1
        return keyed === undefined ? result : { value: (result.value as unknown[])[1], done: false }
      }
      if (keyed === undefined) {
        Object.defineProperty(source, 'next', { configurable: true, writable: true, value: step })
        return source
      }
      return {
        next: step,
        [Symbol.iterator]() {
          return this
        },
        [Symbol.toStringTag]: 'Map Iterator',
      }
    }
}

/**
 * A method taking a callback first (`forEach`, `map`, …): each element it
 * hands the callback counts. `shape` names where the element is: Array and Set
 * `(element, index)`, a reducer `(accumulator, element, index)`, a Map
 * `(value, key)` (the key stands for it).
 */
function countedCallback(shape: 'element' | 'reducer' | 'map'): (original: Method) => Method {
  return (original) =>
    function (this: unknown, ...args: unknown[]) {
      const callback = args[0]
      const walk = typeof callback === 'function' ? startWalk() : null
      if (walk === null) return original.apply(this, args)
      const receiver = this
      const counted = function (this: unknown, ...callbackArgs: unknown[]) {
        visit(
          walk,
          shape === 'map'
            ? identity(callbackArgs[1], receiver, callbackArgs[1])
            : shape === 'reducer'
              ? identity(callbackArgs[1], receiver, callbackArgs[2])
              : identity(callbackArgs[0], receiver, callbackArgs[1]),
        )
        return (callback as Method).apply(this, callbackArgs)
      }
      const forwarded: unknown[] = [counted]
      for (let i = 1; i < args.length; i += 1) forwarded.push(args[i])
      return original.apply(this, forwarded)
    }
}

/** Every element of `list` (an index loop: never a patched walk). */
function visitAll(walk: Walk, list: unknown): void {
  const items = list as { length: number; [index: number]: unknown }
  for (let i = 0; i < items.length; i += 1) visit(walk, identity(items[i], list, i))
}

/** A method that walks the receiver whole (`indexOf`, `sort`, …): every element counts. */
function countedWholeWalk(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    const walk = startWalk()
    if (walk !== null) visitAll(walk, this)
    return original.apply(this, args)
  }
}

/** A method that builds a new array (`slice`, `concat`, `Object.keys`, …): its result's elements count. */
function countedResult(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args)
    const walk = startWalk()
    if (walk !== null) visitAll(walk, result)
    return result
  }
}

/** `Object.entries`: each entry counts as its key. */
function countedEntries(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args) as [string, unknown][]
    const walk = startWalk()
    if (walk !== null) for (let i = 0; i < result.length; i += 1) visit(walk, result[i]![0])
    return result
  }
}

/** A method that runs a MobX derivation body: counts one, and runs it as the arm. */
function countedDerivation(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    if (tally === null) return original.apply(this, args)
    const by = derivationOwner((this as { name_?: unknown }).name_)
    countDerivation(by)
    running.push(by)
    try {
      return insideArm(() => original.apply(this, args))
    } finally {
      running.pop()
    }
  }
}

/**
 * POD-4934 — a method that runs a hand-rolled cell body (`CellGraph.run`):
 * counts one, and runs it as the arm. Every cell body goes through `run`,
 * first runs included, wherever the cell was created — so cells built before
 * the window still count when a change re-runs them. Patched here, from
 * OUTSIDE the hand arm: nothing in `arms/hand` counts itself. `run` is
 * private to the graph, so it is reached by name (as the MobX patch reaches
 * `computeValue_`): the patch throws loudly when it is not an own method.
 */
function countedHandDerivation(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    if (tally === null) return original.apply(this, args)
    const by = derivationOwner((args[0] as { name?: unknown } | undefined)?.name)
    countDerivation(by)
    running.push(by)
    try {
      return insideArm(() => original.apply(this, args))
    } finally {
      running.pop()
    }
  }
}

/**
 * An `observer` component's invalidation hands the redraw to React
 * (`useSyncExternalStore`'s store change): React's side, so the render React
 * schedules there is not the arm's. The render body itself comes back to the
 * arm through `track`. mobx-react-lite names these reactions `observer…`.
 */
function reactSchedulesObserver(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    const name = (this as { name_?: unknown }).name_
    if (typeof name === 'string' && name.startsWith('observer')) {
      return outsideArm(() => original.apply(this, args))
    }
    // A `reaction`'s effect runs here, after its tracked body: its walks are
    // that reaction's.
    running.push(derivationOwner(name))
    try {
      return original.apply(this, args)
    } finally {
      running.pop()
    }
  }
}

/** A DOM method whose own bookkeeping is the DOM's work, not the arm's. */
function domSide(original: Method): Method {
  return function (this: unknown, ...args: unknown[]) {
    return outsideArm(() => original.apply(this, args))
  }
}

const ARRAY_CALLBACKS = [
  'forEach',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
] as const
const ARRAY_WHOLE_WALKS = [
  'indexOf',
  'lastIndexOf',
  'includes',
  'join',
  'sort',
  'reverse',
  'toSorted',
  'toReversed',
] as const
const ARRAY_RESULTS = ['slice', 'concat', 'flat'] as const
const DOM_METHODS: readonly (readonly [string, readonly string[]])[] = [
  ['Node', ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']],
  ['Element', ['setAttribute', 'removeAttribute', 'remove']],
  ['EventTarget', ['addEventListener', 'removeEventListener', 'dispatchEvent']],
]

function install(patches: Patches): void {
  const arrayProto = Array.prototype as unknown as object
  patches.replace(arrayProto, Symbol.iterator, countedIterator(itself))
  patches.replace(arrayProto, 'values', countedIterator(itself))
  patches.replace(arrayProto, 'keys', countedIterator(itself))
  patches.replace(arrayProto, 'entries', countedIterator(entryValue))
  for (const key of ARRAY_CALLBACKS) patches.replace(arrayProto, key, countedCallback('element'))
  patches.replace(arrayProto, 'reduce', countedCallback('reducer'))
  patches.replace(arrayProto, 'reduceRight', countedCallback('reducer'))
  for (const key of ARRAY_WHOLE_WALKS) {
    if (typeof (arrayProto as Record<string, unknown>)[key] === 'function') {
      patches.replace(arrayProto, key, countedWholeWalk)
    }
  }
  for (const key of ARRAY_RESULTS) patches.replace(arrayProto, key, countedResult)
  const setProto = Set.prototype as unknown as object
  for (const key of [Symbol.iterator, 'values', 'keys'] as const) {
    patches.replace(setProto, key, countedIterator(itself))
  }
  patches.replace(setProto, 'entries', countedIterator(entryKey))
  patches.replace(setProto, 'forEach', countedCallback('element'))
  const mapProto = Map.prototype as unknown as object
  const mapEntries = Map.prototype.entries as unknown as Method
  patches.replace(mapProto, Symbol.iterator, countedIterator(entryKey))
  patches.replace(mapProto, 'entries', countedIterator(entryKey))
  patches.replace(mapProto, 'keys', countedIterator(itself))
  patches.replace(
    mapProto,
    'values',
    countedIterator(itself, (receiver) => mapEntries.call(receiver) as Iterator<unknown>),
  )
  patches.replace(mapProto, 'forEach', countedCallback('map'))
  patches.replace(Object, 'keys', countedResult)
  patches.replace(Object, 'values', countedResult)
  patches.replace(Object, 'entries', countedEntries)
  // Derivations: the computed body and the reaction body.
  const computedProto = Object.getPrototypeOf(computed(() => 0)) as object
  patches.replace(computedProto, 'computeValue_', countedDerivation)
  patches.replace(Reaction.prototype as unknown as object, 'track', countedDerivation)
  patches.replace(Reaction.prototype as unknown as object, 'runReaction_', reactSchedulesObserver)
  // Hand derivations: the cell body (POD-4934, from outside the hand arm).
  patches.replace(CellGraph.prototype as unknown as object, 'run', countedHandDerivation)
  // The DOM's own work (happy-dom under the count lane) is not the arm's.
  for (const [name, methods] of DOM_METHODS) {
    const ctor = (globalThis as Record<string, unknown>)[name] as { prototype: object } | undefined
    if (ctor === undefined) continue
    for (const method of methods) {
      if (Object.hasOwn(ctor.prototype, method)) patches.replace(ctor.prototype, method, domSide)
    }
  }
}

/**
 * Run `fn` with the counters installed, NOT as the arm, and return what the
 * arm did inside it: the work of the arm code `fn` reaches through
 * `insideArm` and MobX (see the module note). Never nested: a second window
 * while one is open throws.
 *
 * `trace` (diagnosis only: a stack per walk is slow) fills `sites` with the
 * element visits per call site, to name where a count comes from.
 */
export async function measureWork<T>(
  fn: () => Promise<T>,
  options: { trace?: boolean; pool?: MobxPool } = {},
): Promise<{ value: T; work: WorkCounts; sites: Map<string, number> | null }> {
  if (tally !== null) throw new Error('[work] measureWork is already running')
  const patches = new Patches()
  const current: Tally = {
    derivations: 0,
    derivationsBy: new Map(),
    rows: 0,
    rowsBy: new Map(),
    visits: 0,
    seen: new Set(),
    seenBy: new Map(),
    sites: options.trace === true ? new Map() : null,
  }
  const pool = options.pool
  const descriptor = pool && Object.getOwnPropertyDescriptor(pool, 'row')
  const originalRow = pool?.row
  let value: T
  try {
    install(patches)
    if (pool && originalRow)
      Object.defineProperty(pool, 'row', {
        configurable: true,
        writable: true,
        value: function (this: MobxPool, ...args: Parameters<MobxPool['row']>) {
          if (tally !== null) {
            const by = owner()
            tally.rows++
            tally.rowsBy.set(by, (tally.rowsBy.get(by) ?? 0) + 1)
          }
          return originalRow.apply(this, args)
        },
      })
    tally = current
    value = await outsideArm(fn)
  } finally {
    tally = null
    running.length = 0
    patches.restore()
    if (pool) {
      if (descriptor) Object.defineProperty(pool, 'row', descriptor)
      else Reflect.deleteProperty(pool, 'row')
    }
  }
  const elementsBy: Record<string, number> = {}
  for (const [by, seen] of current.seenBy) elementsBy[by] = seen.size
  return {
    value,
    work: {
      derivations: current.derivations,
      derivationsBy: Object.fromEntries(current.derivationsBy),
      ...(pool ? { rows: current.rows, rowsBy: Object.fromEntries(current.rowsBy) } : {}),
      elements: current.seen.size,
      elementsBy,
      visits: current.visits,
    },
    sites: current.sites,
  }
}
