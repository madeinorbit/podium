/**
 * Read-cache lifetime [POD-3261].
 *
 * A pass opens withReadScope around its reads. Slots memoize across awaits,
 * nested passes join the same scope, and separate passes start fresh. Scope
 * keys belong to repository instances, so stores never share cached rows.
 *
 * Reads outside an explicit scope receive a fresh one-read scope. They do not
 * share a cache, even in the same event-loop turn. The old microtask lifetime
 * cannot carry an async pass and has been removed [POD-3337].
 *
 * This module owns memoization, not database leases: a slot retains its first
 * answer until cleared, but opening a scope alone does not establish a SQLite
 * snapshot for uncached reads. Authorization passes opt in explicitly through
 * ownershipFromMachinesPerPass; direct ownershipFromMachines stays live.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The identity of one cache inside a scope.
 *
 * An OBJECT and not a string: a string key would be a namespace two repository
 * instances share, and the tests open many stores per process. The key is
 * created once, as a field of the thing that owns the cache, so identity is
 * ownership.
 */
export interface ReadScopeSlotKey<T> {
  /** Build this owner's empty cache. Called at most once per scope. */
  readonly create: () => T
}

/** Declare a cache a repository holds for the lifetime of a read scope. */
export function readScopeSlot<T>(create: () => T): ReadScopeSlotKey<T> {
  return { create }
}

/**
 * One unit of work's worth of reads.
 *
 * The ONLY memoising door is {@link slot}. A read that must stay live simply
 * does not open one — see the consistency contract in the file header.
 */
export interface ReadScope {
  readonly id: number
  /** This owner's cache for the lifetime of the scope, created on first ask. */
  slot<T>(key: ReadScopeSlotKey<T>): T
  /** Drop this owner's cache. A write invalidating its own cached reads. */
  clear<T>(key: ReadScopeSlotKey<T>): void
  /** Is this owner holding a cache in this scope? Never creates one. */
  has<T>(key: ReadScopeSlotKey<T>): boolean
}

let nextScopeId = 1

function createScope(): ReadScope {
  const slots = new Map<ReadScopeSlotKey<unknown>, unknown>()
  return {
    id: nextScopeId++,
    slot<T>(key: ReadScopeSlotKey<T>): T {
      // `has`, not a truthiness check on `get`: a slot is whatever its owner
      // builds, and an owner is entitled to a falsy one.
      if (slots.has(key as ReadScopeSlotKey<unknown>)) {
        return slots.get(key as ReadScopeSlotKey<unknown>) as T
      }
      const opened = key.create()
      slots.set(key as ReadScopeSlotKey<unknown>, opened)
      return opened
    },
    clear<T>(key: ReadScopeSlotKey<T>): void {
      slots.delete(key as ReadScopeSlotKey<unknown>)
    },
    has<T>(key: ReadScopeSlotKey<T>): boolean {
      return slots.has(key as ReadScopeSlotKey<unknown>)
    },
  }
}

const storage = new AsyncLocalStorage<ReadScope>()

/** The enclosing pass's scope, or a fresh scope for this one read. */
export function currentReadScope(): ReadScope {
  return storage.getStore() ?? createScope()
}

/**
 * Run `fn` inside one read scope.
 *
 * RE-ENTRANT, AND IT JOINS RATHER THAN NESTS. A pass that opens a scope and
 * calls into another pass that opens one must see one snapshot, not two: a
 * nested scope with its own slots would re-read rows the outer scope already
 * holds and — worse, once these are real leases — read them at a different
 * position from the answers the outer pass already handed out. Joining is also
 * what makes the wrapping safe to add site by site.
 *
 * The scope follows the callback across awaits. Returning or throwing restores
 * the caller's context; an async rejection cannot install a scope in that caller.
 */
export function withReadScope<T>(fn: (scope: ReadScope) => T): T {
  const open = storage.getStore()
  if (open) return fn(open)
  const scope = createScope()
  return storage.run(scope, () => fn(scope))
}

/** Is an explicit scope open on this async context? Tests and diagnostics. */
export function inExplicitReadScope(): boolean {
  return storage.getStore() !== undefined
}
