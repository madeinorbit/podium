import {
  compareDefault,
  computed,
  createAtom,
  type IComputedValue,
  onBecomeObserved,
  onBecomeUnobserved,
  runInAction,
  untracked,
} from 'mobx'
import { debugName } from './debug-name'

export interface LazyOptions<V> {
  equals?: (previous: V, next: V) => boolean
}

type Getter<T, V> = (this: T) => V
type LazyDecorator<V> = <T extends object>(get: Getter<T, V>, context: ClassGetterDecoratorContext<T, V>) => Getter<T, V>

// The hidden slot holder: one per object, added on its first watched read, so
// an object nobody has watched carries nothing. Non-enumerable, so spreads,
// Object.assign and JSON never copy it.
const SLOTS = Symbol('lazy slots')
type Slots = Map<symbol, IComputedValue<unknown>>
type Holder = { [SLOTS]?: Slots }

// A field read with no reaction watching it, kept until the current
// synchronous code has finished so that a second read reuses the value.
// `release` is set when the entry keeps its data watched itself (a read
// outside any batch) and has to let go of it.
type Temporary = { value: IComputedValue<unknown>; release?: () => void }
// Kept apart from the objects, so an object only ever read this way carries
// nothing once the code has finished.
const temporaries = new Map<object, Map<symbol, Temporary>>()
let releaseQueued = false

// Whether the caller runs inside a MobX batch (an action or a reaction run).
// Public MobX only: inside a batch an unwatched computed keeps its value to the
// batch end, outside one it recomputes on every read.
let probeRuns = 0
const probe = computed(() => ++probeRuns, { name: 'lazy.inBatch', requiresReaction: false })
const inBatch = () =>
  // untracked-read: lazy-batch-probe
  untracked(() => probe.get() === probe.get())

/** A cached derived getter, like MobX's `@computed`, except that nothing is
 * allocated until the field is read and the cache is dropped when nothing
 * needs it any more. A read while a reaction watches the field keeps it until
 * the last reaction stops; a read with no reaction keeps it until the current
 * synchronous code has finished, so an action or a handler that reads a field
 * several times works it out once, and again only after its data changed.
 * Standard (2022.3) decorators only. */
export function lazy<T extends object, V>(get: Getter<T, V>, context: ClassGetterDecoratorContext<T, V>): Getter<T, V>
export function lazy<V>(options: LazyOptions<V>): LazyDecorator<V>
export function lazy<T extends object, V>(
  getOrOptions: Getter<T, V> | LazyOptions<V>,
  context?: ClassGetterDecoratorContext<T, V>,
): Getter<T, V> | LazyDecorator<V> {
  if (typeof getOrOptions === 'function') return decorate(getOrOptions, context, {})
  // A legacy (experimentalDecorators) build calls (prototype, key, descriptor).
  if (context !== undefined) throw new TypeError('@lazy needs standard decorators; this build compiled legacy ones')
  return (get, context) => decorate(get, context, getOrOptions)
}

function decorate<T extends object, V>(
  get: Getter<T, V>,
  context: ClassGetterDecoratorContext<T, V> | undefined,
  { equals = compareDefault }: LazyOptions<V>,
): Getter<T, V> {
  if (context?.kind !== 'getter') throw new TypeError('@lazy decorates getters only')
  const name = String(context.name)
  // One key per decorated getter, not per name: a subclass overriding a lazy
  // getter and reading super's keeps two separate slots.
  const field = Symbol(name)
  return function (this: T): V {
    const kept = (this as Holder)[SLOTS]?.get(field) as IComputedValue<V> | undefined
    if (kept !== undefined) return kept.get()
    const held = temporaries.get(this)?.get(field)
    // An entry made inside a batch is MobX's own batch cache: after that batch
    // it would recompute on every read, so outside a batch a new entry replaces it.
    if (held !== undefined && (held.release !== undefined || inBatch())) return held.value.get() as V
    // Inside a batch an unwatched computed already caches to the batch end and
    // MobX lets go of its data then, exactly as for @computed. Outside one only
    // keepAlive caches, and keepAlive needs a switch to let go of the data.
    const keepAlive = !inBatch()
    const off = keepAlive ? createAtom('lazy.release') : undefined
    let released = false
    const value = computed(
      off === undefined
        ? () => get.call(this)
        : () => {
          off.reportObserved()
          return released ? (undefined as V) : get.call(this)
        },
      {
        // A released entry answers undefined, which a custom equals need not accept.
        equals: off === undefined ? equals : (previous, next) => !released && equals(previous, next),
        keepAlive,
        name: debugName(() => `${this.constructor?.name ?? 'Object'}.${name}`),
        // The read below may be outside a reaction; that is intended here, not a mistake.
        requiresReaction: false,
      },
    )
    // Must run inside an action: the read drops the data, and MobX unhooks
    // dropped data only when a batch ends.
    const release = off && (() => {
      released = true
      off.reportChanged()
      value.get()
    })
    // Public MobX only: a read inside a reaction makes the new computed observed
    // during get(); outside one it never does.
    let watched = false
    // The observed hook is removed after get(), so this callback's first
    // call marks observation and every later call releases this same slot.
    // Reuse it for both hooks: one field needs one lifecycle callback.
    const lifecycle = () => {
      if (!watched) {
        watched = true
        return
      }
      const slots = (this as Holder)[SLOTS]
      if (slots?.get(field) === value) slots.delete(field)
      if (release) runInAction(release)
    }
    const stop = onBecomeObserved(value, lifecycle)
    try {
      return value.get()
    } finally {
      stop()
      if (watched) keep(this, field, value, lifecycle)
      else hold(this, field, { value, release }, lifecycle)
    }
  }
}

function keep(target: object, field: symbol, value: IComputedValue<unknown>, lifecycle: () => void): void {
  let slots = (target as Holder)[SLOTS]
  if (slots === undefined) {
    slots = new Map()
    Object.defineProperty(target, SLOTS, { value: slots })
  }
  slots.set(field, value)
  // MobX reports this when the batch in which the last reader left ends; until
  // then a read in that batch still finds the slot.
  onBecomeUnobserved(value, lifecycle)
}

function hold(target: object, field: symbol, temporary: Temporary, lifecycle: () => void): void {
  let fields = temporaries.get(target)
  if (fields === undefined) temporaries.set(target, fields = new Map())
  fields.set(field, temporary)
  // A reaction that reads the entry before the release makes it an ordinary
  // watched slot, released when that reaction leaves.
  const stop = onBecomeObserved(temporary.value, () => {
    stop()
    if (fields.get(field) === temporary) fields.delete(field)
    lifecycle()
    keep(target, field, temporary.value, lifecycle)
  })
  if (!releaseQueued) {
    releaseQueued = true
    queueMicrotask(releaseTemporaries)
  }
}

// One pass for everything read since the last one, in one action. A field
// first read while this pass lets go of data (an unobserved hook runs at the
// action's end) stays held and queues the next pass.
function releaseTemporaries(): void {
  releaseQueued = false
  runInAction(() => {
    for (const [target, fields] of temporaries) {
      temporaries.delete(target)
      for (const temporary of fields.values()) temporary.release?.()
    }
  })
}

/** Diagnostics and tests: how many lazy fields this object currently keeps. */
export function lazyKeptCount(target: object): number {
  return ((target as Holder)[SLOTS]?.size ?? 0) + (temporaries.get(target)?.size ?? 0)
}
