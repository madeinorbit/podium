/** Test-only synchronous counters, independent of the screen census/meter.
 * Seed and parity checks stay outside measure(); only the named primitive runs
 * inside it. Native iteration, callback walks and keyed lookups are counted.
 * Plain indexed loops require counted fixture values (comparison probes do this).
 */
export interface PrimitiveWork {
  visits: number
  lookups: number
  reads: number
  comparisons: number
}

export function workProbe() {
  let active: PrimitiveWork | undefined
  const count = (key: keyof PrimitiveWork, amount = 1) => {
    if (active) active[key] += amount
  }
  return {
    count,
    measure<T>(body: () => T): { value: T; work: PrimitiveWork } {
      const work = { visits: 0, lookups: 0, reads: 0, comparisons: 0 }
      const restore: (() => void)[] = []
      function patch(target: object, key: PropertyKey, wrap: (original: Function) => Function) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key)!
        Object.defineProperty(target, key, { ...descriptor, value: wrap(descriptor.value) })
        restore.push(() => Object.defineProperty(target, key, descriptor))
      }
      for (const prototype of [Map.prototype, Set.prototype, Array.prototype]) {
        for (const key of [Symbol.iterator, 'keys', 'values', 'entries']) {
          patch(prototype, key, original => function (this: unknown, ...args: unknown[]) {
            const iterator = original.apply(this, args) as IterableIterator<unknown>
            return {
              next() {
                const next = iterator.next()
                if (!next.done) count('visits')
                return next
              },
              [Symbol.iterator]() { return this },
            }
          })
        }
        patch(prototype, 'forEach', original => function (
          this: unknown, callback: Function, context?: unknown,
        ) {
          return original.call(this, (...args: unknown[]) => {
            count('visits')
            return callback.apply(context, args)
          })
        })
      }
      for (const prototype of [Map.prototype, Set.prototype]) {
        for (const key of prototype === Map.prototype ? ['get', 'has'] : ['has']) {
          patch(prototype, key, original => function (this: unknown, ...args: unknown[]) {
            count('lookups')
            return original.apply(this, args)
          })
        }
      }
      for (const key of ['map', 'filter', 'some', 'every', 'find', 'findIndex']) {
        patch(Array.prototype, key, original => function (
          this: unknown, callback: Function, context?: unknown,
        ) {
          return original.call(this, (...args: unknown[]) => {
            count('visits')
            return callback.apply(context, args)
          })
        })
      }
      // Native splice moves slots without calling an iterator or callback.
      // Count deleted/inserted slots and the tail whose positions change.
      patch(Array.prototype, 'splice', original => function (this: unknown[], ...args: unknown[]) {
        const length = this.length
        const raw = Math.trunc(Number(args[0])) || 0
        const start = raw < 0 ? Math.max(length + raw, 0) : Math.min(raw, length)
        const removed = args.length === 0 ? 0 : args.length === 1 ? length - start
          : Math.min(Math.max(Math.trunc(Number(args[1])) || 0, 0), length - start)
        const inserted = Math.max(0, args.length - 2)
        count('visits', removed + inserted + (removed === inserted ? 0 : length - start - removed))
        return original.apply(this, args)
      })
      patch(Array.prototype, 'slice', original => function (this: unknown[], ...args: unknown[]) {
        const result = original.apply(this, args) as unknown[]
        count('visits', result.length)
        return result
      })
      for (const key of ['keys', 'values', 'entries']) {
        patch(Object, key, original => function (...args: unknown[]) {
          const result = original.apply(Object, args) as unknown[]
          count('visits', result.length)
          return result
        })
      }
      active = work
      try { return { value: body(), work } }
      finally {
        active = undefined
        for (let index = restore.length - 1; index >= 0; index--) restore[index]!()
      }
    },
  }
}
