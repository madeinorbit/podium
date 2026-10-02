/**
 * A cached group: one structural computed per object, built the first time a
 * reaction reads it and dropped when nothing observes it any more.
 *
 * This is mobx-utils' `computedFn` (a computed per argument, created on first
 * read, disposed when unobserved), for one object argument. It was chosen
 * over one computed per group declared on every object by `makeObservable`
 * (the tracking census and the bootstrap bench are in
 * `docs/measurements/POD-4755-one-object.md`): the objects the worklist holds
 * cost nothing until their groups are read, and a group nobody reads (the row
 * view of a hidden issue, the roll-ups of a closed one) is never built.
 * Written here rather than imported because mobx-utils declares MobX 6 and
 * the pool runs MobX 7, and because the object is passed as the computed's
 * context, so its owner is the object (as a declared computed's is): it is
 * named `<Class>@<id>.<group>` and the census attributes it to its row.
 *
 * Read where no derivation is tracking (an action, an untracked read, no
 * reaction at all) there is nothing to observe the result, so it is computed
 * afresh and not kept; with `computedRequiresReaction` on (the tests) a read
 * outside every batch warns, exactly as reading a declared computed does.
 */

import {
  _getGlobalState,
  _isComputingDerivation,
  compareStructural,
  computed,
  type IComputedValue,
  onBecomeUnobserved,
} from 'mobx'
import { debugName } from './debug-name'

/** `<Class>@<id>`: the object's debug name. */
function debugNameOf(target: { readonly id: string }): string {
  return `${target.constructor.name}@${target.id}`
}

/** A group `compute(target)`, cached per target while a reaction observes it. */
export function cachedGroup<T extends { readonly id: string }, V>(
  group: string,
  compute: (target: T) => V,
  equals: (previous: V, next: V) => boolean = compareStructural,
): (target: T) => V {
  const live = new Map<T, IComputedValue<V>>()
  return (target) => {
    const cached = live.get(target)
    if (cached !== undefined) return cached.get()
    if (!_isComputingDerivation()) {
      // As a computed read with no observer: silent inside a batch (an action,
      // a reaction's run, an untracked read inside one), warned outside all.
      const state = _getGlobalState()
      if (state.inBatch === 0 && state.computedRequiresReaction) {
        console.warn(
          `[mobx] Computed value '${debugName(() => `${debugNameOf(target)}.${group}`) ?? 'ComputedValue'}' is being read outside a reactive context. Doing a full recompute.`,
        )
      }
      return compute(target)
    }
    const value = computed(() => compute(target), {
      name: debugName(() => `${debugNameOf(target)}.${group}`),
      equals,
      context: target,
    })
    live.set(target, value)
    onBecomeUnobserved(value, () => {
      live.delete(target)
    })
    return value.get()
  }
}
