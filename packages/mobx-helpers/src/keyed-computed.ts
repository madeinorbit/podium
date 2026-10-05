import { _isComputingDerivation, compareDefault, computed, type IComputedValue, onBecomeUnobserved } from 'mobx'

export interface KeyedComputedOptions<K, V> {
  equals?: (previous: V, next: V) => boolean
  context?: (key: K) => unknown
  /** Opt into MobX's public untracked-read assertion for development diagnostics. */
  requiresReaction?: boolean
}

export type KeyedComputed<K, V, A extends unknown[] = []> = ((key: K, ...args: A) => V) & {
  clear(): void
  keys(): IterableIterator<K>
  readonly size: number
}

/** Like mobx-utils computedFn, with one identity key. Equal keys must mean
 * equal computations, including any extra arguments captured on the first read. */
export function keyedComputed<K, V, A extends unknown[] = []>(
  name: string | ((key: K) => string | undefined),
  fn: (key: K, ...args: A) => V,
  { equals = compareDefault, context, requiresReaction = false }: KeyedComputedOptions<K, V> = {},
): KeyedComputed<K, V, A> {
  const cache = new Map<K, IComputedValue<V>>()
  const read = (key: K, ...args: A): V => {
    const cached = cache.get(key)
    if (cached) return cached.get()
    const derive = () => fn(key, ...args)
    if (!_isComputingDerivation()) {
      // No cache entry without a reader. The public computed assertion also
      // stays silent inside actions/batches. Assert with an empty body so
      // the actual read cannot create nested tracking/cache entries in a batch.
      if (requiresReaction) computed(() => undefined, { requiresReaction, name: typeof name === 'function' ? name(key) : name }).get()
      return derive()
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
  return Object.defineProperty(Object.assign(read, {
    clear: () => cache.clear(), keys: () => cache.keys(),
  }), 'size', { get: () => cache.size }) as KeyedComputed<K, V, A>
}
