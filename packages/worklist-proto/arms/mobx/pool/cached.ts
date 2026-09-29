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
 * Outside a reaction there is nothing to observe the result, so it is
 * computed afresh and not kept; with `computedRequiresReaction` on (the
 * tests) that read warns exactly as reading a declared computed does.
 */

import {
  _getGlobalState,
  _isComputingDerivation,
  compareStructural,
  computed,
  type IComputedValue,
  onBecomeUnobserved,
} from 'mobx'

/** `<Class>@<id>`: the object's debug name. */
function debugNameOf(target: { readonly id: string }): string {
  return `${target.constructor.name}@${target.id}`
}

/** A group `compute(target)`, cached per target while a reaction observes it. */
export function cachedGroup<T extends { readonly id: string }, V>(
  group: string,
  compute: (target: T) => V,
): (target: T) => V {
  const live = new Map<T, IComputedValue<V>>()
  return (target) => {
    const cached = live.get(target)
    if (cached !== undefined) return cached.get()
    if (!_isComputingDerivation()) {
      if (_getGlobalState().computedRequiresReaction) {
        console.warn(
          `[mobx] Computed value '${debugNameOf(target)}.${group}' is being read outside a reactive context. Doing a full recompute.`,
        )
      }
      return compute(target)
    }
    const value = computed(() => compute(target), {
      name: `${debugNameOf(target)}.${group}`,
      equals: compareStructural,
      context: target,
    })
    live.set(target, value)
    onBecomeUnobserved(value, () => {
      live.delete(target)
    })
    return value.get()
  }
}
