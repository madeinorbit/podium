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
  return liveCache((target: T) => `${debugNameOf(target)}.${group}`, compute, equals, true)
}

/**
 * The same cache keyed by a plain id, for a service with no per-id object
 * (`mission.ts`). Named `<owner>@<key>.<group>`, released when unobserved,
 * and never kept alive by a reaction of its own. A gesture (a click handler,
 * the navigation port) reads it outside every derivation by design: that read
 * computes afresh, as {@link cachedGroup}'s does, without the warning.
 */
export function cachedKey<V>(
  owner: string,
  group: string,
  compute: (key: string) => V,
  equals: (previous: V, next: V) => boolean = compareStructural,
): (key: string) => V {
  return liveCache((key: string) => `${owner}@${key}.${group}`, compute, equals, false)
}

function liveCache<K, V>(
  nameOf: (key: K) => string,
  compute: (key: K) => V,
  equals: (previous: V, next: V) => boolean,
  /** cachedGroup: the key object owns the computed, and an unobserved read warns. */
  ownedByKey: boolean,
): (key: K) => V {
  const live = new Map<K, IComputedValue<V>>()
  return (key) => {
    const cached = live.get(key)
    if (cached !== undefined) return cached.get()
    if (!_isComputingDerivation()) {
      // As a computed read with no observer: silent inside a batch (an action,
      // a reaction's run, an untracked read inside one), warned outside all.
      const state = _getGlobalState()
      if (ownedByKey && state.inBatch === 0 && state.computedRequiresReaction) {
        console.warn(
          `[mobx] Computed value '${debugName(() => nameOf(key)) ?? 'ComputedValue'}' is being read outside a reactive context. Doing a full recompute.`,
        )
      }
      return compute(key)
    }
    const value = computed(() => compute(key), {
      name: debugName(() => nameOf(key)),
      equals,
      ...(ownedByKey ? { context: key } : {}),
    })
    live.set(key, value)
    onBecomeUnobserved(value, () => {
      if (live.get(key) === value) live.delete(key)
    })
    return value.get()
  }
}
