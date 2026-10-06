import { compareDefault, computed, type IComputedValue, onBecomeObserved, onBecomeUnobserved } from 'mobx'
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

/** A cached derived getter, like MobX's `@computed`, except that nothing is
 * allocated until a reaction reads the field and the cache is dropped when the
 * last reaction stops reading it. A read outside a reaction computes directly
 * and keeps nothing, as keyedComputed does. Standard (2022.3) decorators only. */
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
    const value = computed(() => get.call(this), {
      equals,
      name: debugName(() => `${this.constructor?.name ?? 'Object'}.${name}`),
      // The read below may be outside a reaction; that is a direct compute here, not a mistake.
      requiresReaction: false,
    })
    // Public MobX only: a read inside a reaction makes the new computed observed
    // during get(); outside one it never does, and the computed is garbage.
    let watched = false
    const stop = onBecomeObserved(value, () => { watched = true })
    try {
      return value.get()
    } finally {
      stop()
      if (watched) keep(this, field, value)
    }
  }
}

function keep(target: object, field: symbol, value: IComputedValue<unknown>): void {
  let slots = (target as Holder)[SLOTS]
  if (slots === undefined) {
    slots = new Map()
    Object.defineProperty(target, SLOTS, { value: slots })
  }
  slots.set(field, value)
  // MobX reports this when the batch in which the last reader left ends; until
  // then a read in that batch still finds the slot.
  onBecomeUnobserved(value, () => {
    if (slots.get(field) === value) slots.delete(field)
  })
}

/** Diagnostics and tests: how many lazy fields this object currently keeps. */
export function lazyKeptCount(target: object): number {
  return (target as Holder)[SLOTS]?.size ?? 0
}
