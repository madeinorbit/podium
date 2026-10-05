/** Domain names and model attribution over the shared computedFn-style helper. */
import { keyedComputed } from '@podium/mobx-helpers'
import { compareDefault } from 'mobx'
import { debugName } from './debug-name'

/** A model group, shared only while observed; result comparison is identity. */
export function cachedGroup<T extends { readonly id: string }, V>(
  group: string,
  compute: (target: T) => V,
  equals: (previous: V, next: V) => boolean = compareDefault,
): (target: T) => V {
  return keyedComputed(
    (target: T) => debugName(() => `${target.constructor.name}@${target.id}.${group}`),
    compute,
    { equals, context: target => target, requiresReaction: debugName(() => group) !== undefined },
  )
}

/** An addressed service read. Imperative gestures compute directly. */
export function cachedKey<V>(
  owner: string,
  group: string,
  compute: (key: string) => V,
  equals: (previous: V, next: V) => boolean = compareDefault,
): (key: string) => V {
  return keyedComputed((key: string) => debugName(() => `${owner}@${key}.${group}`), compute, { equals })
}

/** Equal keys must describe equal bodies, including their captured arguments. */
export function keyedViews<V>(
  owner: string,
  group: string,
  equals: (previous: V, next: V) => boolean = compareDefault,
): (key: string, compute: () => V) => V {
  return keyedComputed(
    () => debugName(() => `${owner}.${group}`),
    (_key: string, compute: () => V) => compute(),
    { equals },
  )
}
