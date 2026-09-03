/**
 * THE READ SCOPE: how long a cached read stays true [POD-3261, spec §3.6].
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * Three caches in this server exist because a fan-out asks the same question
 * thousands of times in one pass, and all three are invalidated by
 * `queueMicrotask`: the issues row cache (`store/issues.ts`, 5,163 `getIssue`
 * calls and 13 s of CPU in one measured frame), the users account cache
 * (`store/users.ts`, 1,221 reads of a one-row table), and the relay's
 * closed-issue memo (`relay.ts`, 280 full scans of `issues` in four minutes).
 *
 * `queueMicrotask` works because a microtask cannot run inside a synchronous
 * turn, so the cache lives exactly as long as the turn — and dies at the first
 * `await` anywhere in the pass. That premise is what this epic removes: after
 * the async flip every one of those passes acquires awaits, the caches
 * evaporate, and the 13 s fan-out comes back. Deleting the caches instead is
 * not the cheaper option; it is the regression.
 *
 * So the LIFETIME moves off the microtask queue and onto an explicit scope that
 * a pass opens around itself. `withReadScope(fn)` is that scope. It is
 * synchronous today and becomes `StoreExecutor.read(fn)`'s lease at the flip,
 * with the call sites unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHAT STATE A PASS SEES — the consistency contract, stated (spec rule 18)
 * ---------------------------------------------------------------------------
 *
 * A read scope provides **snapshot consistency as of scope entry** for every
 * value read through a {@link ReadScope.slot}, and **no consistency at all**
 * for values read outside one.
 *
 * Today that snapshot is provided by two things together: a scope body does not
 * yield, so nothing can commit inside it, and a slot memoises so the second ask
 * is the first ask's answer. After the flip it is provided by the read lease:
 * one connection, one SQLite snapshot, held for the scope. The contract does
 * not change across the flip; only what enforces it does.
 *
 * WHETHER AN AUTHORIZATION DECISION MAY BE ANSWERED FROM A SLOT IS PER SITE,
 * and deliberately so. Spec rule 18 leaves open whether ADR 9 D2 rule 4's live
 * obligation is per DECISION or per PASS, and escalates it to the pre-flip
 * checkpoint. This mechanism does not decide it — it is built so that either
 * answer is expressible without changing the mechanism:
 *
 *   per pass      → the site reads through a slot; every decision in the pass
 *                   is judged against one state.
 *   per decision  → the site does not use a slot; the read goes to the store
 *                   each time, exactly as it does today.
 *
 * Going through a slot is therefore an opt-in a site takes deliberately, never
 * something a scope does to a read on its behalf. `ownershipFromMachines`
 * (`machine-access.ts`) and `grants.listForResource` for machines take no slot
 * and are untouched by this file: they remain per-decision live reads until the
 * rule says otherwise. The feed's own grant reads DO take the per-pass form,
 * which spec §3.5 already rules on ("live means read under the lease that
 * applies or publishes the decision").
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO OPEN A SCOPE, ONE CACHE — and one of them is transitional
 * ---------------------------------------------------------------------------
 *
 * An EXPLICIT scope is opened by `withReadScope` and lives until it returns.
 * That is the real mechanism and the one that survives the flip.
 *
 * An AMBIENT TURN scope is opened lazily by the first slot read in a
 * synchronous turn that has no explicit scope, and is dropped by a
 * `queueMicrotask` — today's behaviour exactly. It is here because the landed
 * frame-cache suites assert that lifetime (`store-issues-frame-cache.test.ts`:
 * "the turn ends at the first await: the next read goes back to the table"),
 * and a conversion commit may not modify an existing test assertion; and
 * because a pass that has not yet been given an explicit scope must not lose
 * its cache in the meantime, which is precisely the regression the query-count
 * gate exists to catch.
 *
 * It is one cache with two lifetime owners, not two caches: both hand out the
 * same {@link ReadScope} over the same slots, and a site cannot tell which it
 * is in. The turn owner is the TRANSITIONAL half — at the flip it stops working
 * on its own (the first await drops it) and is deleted, leaving the explicit
 * scopes carrying it. Its deletion is filed as an instrument deletion issue.
 *
 * ---------------------------------------------------------------------------
 * WHY ASYNCLOCALSTORAGE, AND WHY THE STATE IS MODULE-LEVEL
 * ---------------------------------------------------------------------------
 *
 * The scope must reach a repository that was never told about it: repositories
 * take `(db, …)` and their constructor lines are owned by another issue in this
 * window, so the scope cannot arrive as a constructor argument. It travels with
 * the CALL instead, which is the same choice `store/executor/context.ts` makes
 * for transaction re-entrancy and for the same reason — with awaits in the
 * picture, anything keyed on a shared object is a shared counter.
 *
 * Slot keys are per-repository-instance object identities, so two
 * `SessionStore`s in one process (every test file opens several) never collide
 * even though the storage is module-level.
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
  /**
   * `true` for a scope a caller opened with {@link withReadScope}, `false` for
   * the ambient turn scope. Exposed for tests and for the flip's deletion of
   * the turn half; no production decision reads it.
   */
  readonly explicit: boolean
  /** This owner's cache for the lifetime of the scope, created on first ask. */
  slot<T>(key: ReadScopeSlotKey<T>): T
  /** Drop this owner's cache. A write invalidating its own cached reads. */
  clear<T>(key: ReadScopeSlotKey<T>): void
  /** Is this owner holding a cache in this scope? Never creates one. */
  has<T>(key: ReadScopeSlotKey<T>): boolean
}

let nextScopeId = 1

function createScope(explicit: boolean): ReadScope {
  const slots = new Map<ReadScopeSlotKey<unknown>, unknown>()
  return {
    id: nextScopeId++,
    explicit,
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

/**
 * The ambient turn scope: the transitional half. See the file header.
 *
 * Opened lazily so a turn that reads nothing cached costs no microtask, and
 * dropped by identity so a scope opened by a later turn is never cleared by an
 * earlier turn's callback.
 */
let turnScope: ReadScope | undefined

function currentTurnScope(): ReadScope {
  if (turnScope) return turnScope
  const opened = createScope(false)
  turnScope = opened
  queueMicrotask(() => {
    if (turnScope === opened) turnScope = undefined
  })
  return opened
}

/**
 * The scope a read is inside: the caller's explicit one, or this turn's.
 *
 * Never `undefined`, because the answer "there is no scope" would push the
 * same lifetime decision out to every call site, which is the arrangement this
 * module exists to end.
 */
export function currentReadScope(): ReadScope {
  return storage.getStore() ?? currentTurnScope()
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
 * The scope is discarded when the OUTERMOST call returns, on both arms: a throw
 * must not leave a scope installed for whatever runs next on this async
 * context.
 */
export function withReadScope<T>(fn: (scope: ReadScope) => T): T {
  const open = storage.getStore()
  if (open) return fn(open)
  const scope = createScope(true)
  return storage.run(scope, () => fn(scope))
}

/** Is an explicit scope open on this async context? Tests and diagnostics. */
export function inExplicitReadScope(): boolean {
  return storage.getStore() !== undefined
}
