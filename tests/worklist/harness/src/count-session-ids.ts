/**
 * POD-4683 — session-id iteration counter, shared by both arms' member-parts
 * tests (one module, same instrument, no arm-specific exception).
 *
 * Counts session-id element visits while `run` runs, filtered to `sessionIds`
 * so order sorts over issue ids never count. Patches, process-wide for the
 * one run only (restored in `finally`):
 * - Array and Set iterators (`Symbol.iterator`), plus ObservableSet's;
 * - Map and ObservableMap iteration: `keys`, `values`, `entries`,
 *   `Symbol.iterator` (entries) and `forEach`;
 * - Array iteration methods (`filter`, `map`, `every`, `some`, `find`,
 *   `findIndex`, `forEach`, `reduce`, `reduceRight`, `flatMap`) by wrapping
 *   the callback, plus `values`/`entries` iterators;
 * - `slice` (MobX's computedStruct unwrap copies) counting the session ids in
 *   the copy, and `sort` counting the session ids it orders (family sorts
 *   count; visible-order sorts over issue ids do not).
 *
 * Single-key probes (`get`/`has`/`size`) are never counted: they are O(1),
 * not iteration. Every patch calls through with `.apply` and builds argument
 * lists by index — never a spread inside a patch — so patched iteration never
 * re-enters itself (a spread would route back through the patched
 * `Symbol.iterator`).
 */
import { ObservableMap, ObservableSet } from 'mobx'

type Fn = (...args: never[]) => unknown

export function countSessionIds(sessionIds: ReadonlySet<string>, run: () => void): number {
  let total = 0
  const isSession = (v: unknown): boolean => typeof v === 'string' && sessionIds.has(v)

  const saved: [object, string | symbol, unknown][] = []
  const patch = (obj: object, key: string | symbol, value: unknown): void => {
    saved.push([obj, key, (obj as Record<string | symbol, unknown>)[key]])
    ;(obj as Record<string | symbol, unknown>)[key] = value
  }

  /** Wrap an iterator-returning method so each yielded session id counts once. */
  const wrapIteratorMethod =
    (orig: Fn, pick: (value: unknown) => number): Fn =>
    function (this: unknown, ...args: never[]) {
      const it = (orig as (this: unknown, ...a: never[]) => Iterator<unknown>).apply(this, args)
      const origNext = it.next.bind(it) as (this: unknown, ...a: never[]) => IteratorResult<unknown>
      ;((it as unknown) as Record<string, unknown>).next = function (...nargs: never[]) {
        const step = (origNext as (this: unknown, ...a: never[]) => IteratorResult<unknown>).apply(
          it,
          nargs,
        )
        if (step.done !== true) total += pick(step.value)
        return step
      }
      return it
    }

  const one = (value: unknown): number => (isSession(value) ? 1 : 0)
  const pair = (value: unknown): number =>
    Array.isArray(value)
      ? (isSession(value[0]) ? 1 : 0) + (isSession(value[1]) ? 1 : 0)
      : 0

  const arrIter = Array.prototype[Symbol.iterator] as unknown as Fn
  const setIter = Set.prototype[Symbol.iterator] as unknown as Fn
  patch(Array.prototype as unknown as object, Symbol.iterator, wrapIteratorMethod(arrIter, one))
  patch(Set.prototype as unknown as object, Symbol.iterator, wrapIteratorMethod(setIter, one))

  const obsSetProto = ObservableSet.prototype as unknown as Record<symbol, unknown>
  const obsSetIter = obsSetProto[Symbol.iterator] as unknown as Fn | undefined
  if (typeof obsSetIter === 'function') {
    patch(obsSetProto as unknown as object, Symbol.iterator, wrapIteratorMethod(obsSetIter, one))
  }
  const obsSetForEach = (ObservableSet.prototype as unknown as Record<string, unknown>).forEach as
    | Fn
    | undefined
  if (typeof obsSetForEach === 'function') {
    const origForEach = obsSetForEach
    patch(ObservableSet.prototype as unknown as object, 'forEach', function (
      this: unknown,
      ...args: never[]
    ) {
      const cb = args[0] as unknown
      if (typeof cb !== 'function') {
        return (origForEach as (this: unknown, ...a: never[]) => unknown).apply(this, args)
      }
      const wrapped = (...cbArgs: never[]): unknown => {
        total += one(cbArgs[0])
        return (cb as Fn).apply(undefined, cbArgs)
      }
      const newArgs: never[] = [wrapped as never]
      for (let i = 1; i < args.length; i += 1) newArgs.push(args[i] as never)
      return (origForEach as (this: unknown, ...a: never[]) => unknown).apply(this, newArgs)
    })
  }

  const setForEach = Set.prototype.forEach as unknown as Fn
  patch(Set.prototype as unknown as object, 'forEach', function (this: unknown, ...args: never[]) {
    const cb = args[0] as unknown
    if (typeof cb !== 'function') {
      return (setForEach as (this: unknown, ...a: never[]) => unknown).apply(this, args)
    }
    const wrapped = (...cbArgs: never[]): unknown => {
      total += one(cbArgs[0])
      return (cb as Fn).apply(undefined, cbArgs)
    }
    const newArgs: never[] = [wrapped as never]
    for (let i = 1; i < args.length; i += 1) newArgs.push(args[i] as never)
    return (setForEach as (this: unknown, ...a: never[]) => unknown).apply(this, newArgs)
  })

  // Maps: keys, values, entries, the default (entries) iterator and forEach.
  const mapMethods = ['keys', 'values', 'entries', Symbol.iterator] as const
  for (const key of mapMethods) {
    const orig = (Map.prototype as unknown as Record<string | symbol, unknown>)[key] as
      | Fn
      | undefined
    if (typeof orig !== 'function') continue
    const pick = key === 'keys' || key === 'values' ? one : pair
    patch(Map.prototype as unknown as object, key, wrapIteratorMethod(orig, pick))
  }
  const mapForEach = Map.prototype.forEach as unknown as Fn
  patch(Map.prototype as unknown as object, 'forEach', function (this: unknown, ...args: never[]) {
    const cb = args[0] as unknown
    if (typeof cb !== 'function') {
      return (mapForEach as (this: unknown, ...a: never[]) => unknown).apply(this, args)
    }
    const wrapped = (...cbArgs: never[]): unknown => {
      total += one(cbArgs[0]) + one(cbArgs[1])
      return (cb as Fn).apply(undefined, cbArgs)
    }
    const newArgs: never[] = [wrapped as never]
    for (let i = 1; i < args.length; i += 1) newArgs.push(args[i] as never)
    return (mapForEach as (this: unknown, ...a: never[]) => unknown).apply(this, newArgs)
  })

  const obsMapProto = ObservableMap.prototype as unknown as Record<string | symbol, unknown>
  for (const key of mapMethods) {
    const orig = obsMapProto[key] as Fn | undefined
    if (typeof orig !== 'function') continue
    const pick = key === 'keys' || key === 'values' ? one : pair
    patch(obsMapProto as unknown as object, key, wrapIteratorMethod(orig, pick))
  }
  const obsMapForEach = obsMapProto.forEach as Fn | undefined
  if (typeof obsMapForEach === 'function') {
    const origForEach = obsMapForEach
    patch(obsMapProto as unknown as object, 'forEach', function (this: unknown, ...args: never[]) {
      const cb = args[0] as unknown
      if (typeof cb !== 'function') {
        return (origForEach as (this: unknown, ...a: never[]) => unknown).apply(this, args)
      }
      const wrapped = (...cbArgs: never[]): unknown => {
        total += one(cbArgs[0]) + one(cbArgs[1])
        return (cb as Fn).apply(undefined, cbArgs)
      }
      const newArgs: never[] = [wrapped as never]
      for (let i = 1; i < args.length; i += 1) newArgs.push(args[i] as never)
      return (origForEach as (this: unknown, ...a: never[]) => unknown).apply(this, newArgs)
    })
  }

  const arrayMethods = [
    'filter',
    'map',
    'every',
    'some',
    'find',
    'findIndex',
    'forEach',
    'reduce',
    'reduceRight',
    'flatMap',
  ] as const
  for (const name of arrayMethods) {
    const orig = (Array.prototype as unknown as Record<string, unknown>)[name] as Fn | undefined
    if (typeof orig !== 'function') continue
    const origFn = orig
    patch(Array.prototype as unknown as object, name, function (this: unknown, ...args: never[]) {
      const cb = args[0] as unknown
      if (typeof cb !== 'function') {
        return (origFn as (this: unknown, ...a: never[]) => unknown).apply(this, args)
      }
      const wrapped = (...cbArgs: never[]): unknown => {
        total += one(cbArgs[0])
        return (cb as Fn).apply(undefined, cbArgs)
      }
      const newArgs: never[] = [wrapped as never]
      for (let i = 1; i < args.length; i += 1) newArgs.push(args[i] as never)
      return (origFn as (this: unknown, ...a: never[]) => unknown).apply(this, newArgs)
    })
  }

  const arrValues = Array.prototype.values as unknown as Fn | undefined
  if (typeof arrValues === 'function') {
    patch(Array.prototype as unknown as object, 'values', wrapIteratorMethod(arrValues, one))
  }
  const arrEntries = Array.prototype.entries as unknown as Fn | undefined
  if (typeof arrEntries === 'function') {
    patch(Array.prototype as unknown as object, 'entries', wrapIteratorMethod(arrEntries, pair))
  }

  const origSlice = Array.prototype.slice as unknown as Fn
  patch(Array.prototype as unknown as object, 'slice', function (this: unknown, ...args: never[]) {
    const out = (origSlice as (this: unknown, ...a: never[]) => unknown[]).apply(this, args)
    for (let i = 0; i < out.length; i += 1) total += one(out[i])
    return out
  })

  const origSort = Array.prototype.sort as unknown as Fn
  patch(Array.prototype as unknown as object, 'sort', function (this: unknown, ...args: never[]) {
    const arr = this as unknown[]
    for (let i = 0; i < arr.length; i += 1) total += one(arr[i])
    return (origSort as (this: unknown, ...a: never[]) => unknown).apply(this, args)
  })

  try {
    run()
  } finally {
    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const [obj, key, orig] = saved[i]!
      ;(obj as Record<string | symbol, unknown>)[key] = orig
    }
  }
  return total
}
