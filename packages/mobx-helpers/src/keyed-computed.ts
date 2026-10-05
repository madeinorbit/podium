import { _isComputingDerivation, comparer, computed, type IComputedValue, onBecomeUnobserved } from 'mobx'

export interface KeyedComputedOptions<K, V> {
  equals?: (previous: V, next: V) => boolean
  context?: (key: K) => unknown
  /** Opt into MobX's public untracked-read assertion for development diagnostics. */
  requiresReaction?: boolean
}

/** Like mobx-utils computedFn, with one identity key. Equal keys must mean
 * equal computations, including any extra arguments captured on the first read. */
export function keyedComputed<K, V, A extends unknown[] = []>(
  name: string | ((key: K) => string | undefined),
  fn: (key: K, ...args: A) => V,
  { equals = comparer.default, context, requiresReaction = false }: KeyedComputedOptions<K, V> = {},
): ((key: K, ...args: A) => V) & { clear(): void } {
  const cache = new Map<K, IComputedValue<V>>()
  const read = (key: K, ...args: A): V => {
    const cached = cache.get(key)
    if (cached) return cached.get()
    const derive = () => fn(key, ...args)
    if (!_isComputingDerivation()) {
      // No cache entry without a reader. The public computed assertion also
      // stays silent inside actions/batches, as a declared computed would.
      return requiresReaction ? computed(derive, { requiresReaction, name: typeof name === 'function' ? name(key) : name }).get() : derive()
    }
    const value = computed(derive, {
      equals, name: typeof name === 'function' ? name(key) : name, context: context?.(key),
    })
    cache.set(key, value)
    onBecomeUnobserved(value, () => {
      if (cache.get(key) === value) cache.delete(key)
    })
    return value.get()
  }
  return Object.assign(read, { clear: () => cache.clear() })
}
