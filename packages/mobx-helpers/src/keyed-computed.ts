import { createLogger } from '@podium/logger'
import {
  _getGlobalState,
  compareDefault,
  computed,
  getDebugName,
  type IComputedValue,
  onBecomeUnobserved,
  runInAction,
} from 'mobx'

const log = createLogger('mobx-helpers:keyed-computed')

/** Permit imperative reads while preserving dependencies for reactive callers. */
export function allowImperativeRead<T>(read: () => T): T {
  return _getGlobalState().trackingDerivation ? read() : runInAction(read)
}

/**
 * The derivation tracking reads right now (a computed or a reaction), or
 * `undefined` outside one, in an action and inside `untracked`. Opaque: only
 * compared by identity (the side-state guard, POD-7454).
 */
export function currentDerivation(): object | undefined {
  return _getGlobalState().trackingDerivation ?? undefined
}

/**
 * Development diagnostics: the live views observing an atom or computed,
 * through any number of computed fields. Call after the tracking run has
 * bound its dependencies. Keep MobX's observer identities inside this helper;
 * the public observer tree exposes names only, which are not unique.
 */
export function observingViews(value: object): { view: object; name: string }[] {
  const views = new Map<object, string>()
  const seen = new Set<object>()
  const visit = (node: object, via?: string): void => {
    if (seen.has(node)) return
    seen.add(node)
    if ('observers_' in node) {
      const observers = (node as { observers_: ReadonlySet<object> | null }).observers_
      for (const observer of observers ?? []) visit(observer, getDebugName(node))
    } else if (!(node as { isDisposed?: boolean }).isDisposed) {
      const name = getDebugName(node)
      views.set(node, /^(Autorun|Reaction)@/.test(name) && via ? via : name)
    }
  }
  visit(value)
  return [...views].map(([view, name]) => ({ view, name }))
}

/** Live render hooks must borrow their caller's reaction, even before data arrives. */
export function assertReactiveRead(name: string): void {
  if (!_getGlobalState().trackingDerivation) {
    throw new Error(`${name} must run inside an observer`)
  }
}

export interface KeyedComputedOptions<K, V> {
  equals?: (previous: V, next: V) => boolean
  context?: (key: K) => unknown
  /** Warn on an untracked read outside a batch, for development diagnostics. */
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
  const read = (...args: [K, ...A]): V => {
    const key = args[0]
    const cached = cache.get(key)
    if (cached) return cached.get()
    const derive = () => fn.apply(undefined, args)
    // One private read, equivalent to _isComputingDerivation, also lets the
    // diagnostic stay silent in a batch without creating a temporary computed.
    const state = _getGlobalState()
    if (!state.trackingDerivation) {
      if (requiresReaction && state.computedRequiresReaction && state.inBatch === 0) {
        log.warn(
          `Computed value '${typeof name === 'function' ? (name(key) ?? 'ComputedValue') : name}' is being read outside a reactive context. Doing a full recompute.`,
        )
      }
      return derive()
    }
    const value = computed(() => derive(), {
      equals,
      name: typeof name === 'function' ? name(key) : name,
      context: context?.(key),
    })
    cache.set(key, value)
    onBecomeUnobserved(value, () => {
      if (cache.get(key) === value) cache.delete(key)
    })
    return value.get()
  }
  return Object.defineProperty(
    Object.assign(read, {
      clear: () => cache.clear(),
      keys: () => cache.keys(),
    }),
    'size',
    { get: () => cache.size },
  ) as unknown as KeyedComputed<K, V, A>
}
