/**
 * Side state a reactive reader cannot see (POD-7454).
 *
 * The pool's screens are MobX derivations. A derivation re-runs only when an
 * observable it read moved; a plain Map or Set it read moves nothing. POD-7422
 * was that shape: the pool read the replica's `exits` map inside a derivation,
 * the map changed back, and the header kept its stale answer.
 *
 * A `SideMap` / `SideSet` is a plain Map / Set whose READS (get, has, size,
 * iteration) call a hook the client installs. This package has no MobX: the
 * client graph installs a hook that knows whether the read runs inside a
 * derivation, warns once per call site in development and throws under tests.
 * With no hook installed (production) every read costs one `undefined` check.
 * Writes are never checked: maintenance writes side state on purpose.
 *
 * A read that IS covered — the reader observed a signal that moves whenever
 * this state's answer can — runs inside `signalledRead`. Each call site is
 * reviewed: it carries an `untracked-read` tag in the escape inventory
 * (`scripts/check-untracked-reads.ts`). So does `sideStateUpkeep`:
 * bookkeeping a derivation runs (a subscription, a hold) whose reads decide
 * no answer.
 */

/** What the client installs. */
export interface SideStateHook {
  /** A guarded collection named `name` was read. */
  read(name: string): void
  /** Run `read` as a reviewed read whose change a signal already carries. */
  signalled<T>(read: () => T): T
}

let hook: SideStateHook | undefined

/** Install (or with `undefined`, remove) the read hook; returns the previous one. */
export function installSideStateHook(next: SideStateHook | undefined): SideStateHook | undefined {
  const previous = hook
  hook = next
  return previous
}

/**
 * A reviewed read of side state whose changes reach the reader through a
 * signal it observed (or observes in this same call). Tag the call site.
 */
export function signalledRead<T>(read: () => T): T {
  return hook === undefined ? read() : hook.signalled(read)
}

/**
 * Bookkeeping a derivation runs that decides none of its answers: a
 * subscription, a hold or a registration made on first read. Its reads of
 * side state are not the derivation's dependencies. Tag the call site.
 */
export function sideStateUpkeep<T>(work: () => T): T {
  return hook === undefined ? work() : hook.signalled(work)
}

/** A Map whose reads are checked against the installed hook. */
export class SideMap<K, V> extends Map<K, V> {
  constructor(
    readonly sideName: string,
    entries?: Iterable<readonly [K, V]> | null,
  ) {
    // Map's constructor fills through `set`, which is never checked.
    super(entries)
  }

  override get(key: K): V | undefined {
    if (hook !== undefined) hook.read(this.sideName)
    return super.get(key)
  }

  override has(key: K): boolean {
    if (hook !== undefined) hook.read(this.sideName)
    return super.has(key)
  }

  override get size(): number {
    if (hook !== undefined) hook.read(this.sideName)
    return super.size
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    if (hook !== undefined) hook.read(this.sideName)
    super.forEach(callback, thisArg)
  }

  override keys(): MapIterator<K> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.keys()
  }

  override values(): MapIterator<V> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.values()
  }

  override entries(): MapIterator<[K, V]> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.entries()
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    if (hook !== undefined) hook.read(this.sideName)
    return super[Symbol.iterator]()
  }
}

/** A Set whose reads are checked against the installed hook. */
export class SideSet<T> extends Set<T> {
  constructor(
    readonly sideName: string,
    values?: Iterable<T> | null,
  ) {
    super(values)
  }

  override has(value: T): boolean {
    if (hook !== undefined) hook.read(this.sideName)
    return super.has(value)
  }

  override get size(): number {
    if (hook !== undefined) hook.read(this.sideName)
    return super.size
  }

  override forEach(callback: (value: T, key: T, set: Set<T>) => void, thisArg?: unknown): void {
    if (hook !== undefined) hook.read(this.sideName)
    super.forEach(callback, thisArg)
  }

  override keys(): SetIterator<T> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.keys()
  }

  override values(): SetIterator<T> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.values()
  }

  override entries(): SetIterator<[T, T]> {
    if (hook !== undefined) hook.read(this.sideName)
    return super.entries()
  }

  override [Symbol.iterator](): SetIterator<T> {
    if (hook !== undefined) hook.read(this.sideName)
    return super[Symbol.iterator]()
  }
}
