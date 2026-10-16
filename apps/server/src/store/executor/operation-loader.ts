/**
 * PER-OPERATION LOADERS [POD-6149, server-data rule 2].
 *
 * Many call sites inside one operation each ask for one row by id — the
 * GraphQL-resolver shape. Asking the database once per call makes the
 * statement count grow with the number of rows the operation touches. The
 * standard answer is the DataLoader pattern, and this is the standard package
 * (`dataloader`), not a home-grown one: loads asked for in the same tick are
 * collected into ONE `IN (…)` query, and an id already loaded is answered from
 * the loader for the rest of the operation.
 *
 * SCOPED TO ONE OPERATION THROUGH THE READ SCOPE. Each loader lives in a
 * {@link readScopeSlot}, so an operation that opens `withReadScope` gets its
 * own DataLoader and nothing is reused by the next operation. A load outside an
 * explicit scope gets a fresh one-read scope, so it batches nothing and reuses
 * nothing: unscoped reads stay live, exactly as `read-scope.ts` promises. This
 * is a one-operation memo, not a cache (server-data "Caching" rule 1).
 *
 * A BATCH NEVER CROSSES CONTEXTS [POD-6197]. One read scope can hold loads made
 * at the root, inside a span and in a post-commit drain in the same tick. Their
 * answers are shared, but each context's misses go out in a batch of their own,
 * run in that context (see "Two layers" below).
 *
 * WRITES INVALIDATE. A repository calls {@link OperationLoader.invalidate} from
 * every write of the rows it loads. That moves the loader's version, and the
 * next load in ANY open scope starts a new DataLoader, so a read after a write
 * in the same operation sees the write. A load already in flight when the write
 * happened still resolves for its caller, who asked before the write.
 *
 * PER OPERATION, ACROSS WRITE SPANS, WHEN THE LOADER ASKS FOR IT [POD-6189].
 * A loader declared with `perOperation` keeps its memo for the whole OPERATION
 * (`operation-scope.ts`: a daemon frame, a tRPC call), before, inside and after
 * its write spans, so an operation that checks the same row in each phase reads
 * it once. Its rows must be written ONLY through the repository, which calls
 * `invalidate()` after each write AND after each commit of a write. Then an
 * answer held at the current version is what the database holds now, in any
 * scope: every write since it was read has moved the version, and so has every
 * commit, which closes the window in which a read on another connection saw
 * the state just before a write that was about to commit. What remains is the
 * span's own uncommitted writes, and that decides where the memo lives:
 *   - in a span that has NOT written these rows, the memo is the operation's
 *     (or, with no operation open, the explicit read scope's; with neither,
 *     the span's transaction unit, shared by its savepoints and gone with it);
 *   - once the span HAS written these rows, every later read goes to a memo on
 *     the innermost FRAME. A savepoint is its own frame, so a savepoint that
 *     rolls back takes its answers with it; its parent's answers are already
 *     stale by version, because the write moved it, and are read again. Nothing
 *     read after an uncommitted write reaches a memo that outlives the span.
 * Nothing is kept past the operation: an operation's memo ends with it, a read
 * scope with its pass, a unit or frame with its span. A loader without the
 * option keeps the read-scope behaviour everywhere.
 */

import DataLoader from 'dataloader'
import { currentScope, type TransactionUnit } from './context'
import { openSpanFrame } from './executor'
import { currentOperation, operationSlot } from './operation-scope'
import { currentReadScope, inExplicitReadScope, readScopeSlot } from './read-scope'

export interface OperationLoader<K, V> {
  /** One row by key, or `undefined` when none exists. Batched within a tick. */
  load(key: K): Promise<V | undefined>
  /** Several rows by key: one batch per `maxBatchSize`, sent at once, not on the next tick. */
  loadMany(keys: Iterable<K>): Promise<Map<K, V | undefined>>
  /**
   * Forget every loaded row in every open scope. Call from each write; a loader
   * with `perOperation` also from each commit of a write (see the file header).
   */
  invalidate(): void
}

export interface OperationLoaderOptions<V> {
  /**
   * Largest `IN (…)` list one batch sends. A larger tick is split into several
   * batches, so the statement count grows by one per `maxBatchSize` keys,
   * never by one per key. Default 500, under SQLite's bound-parameter limit.
   */
  readonly maxBatchSize?: number
  /**
   * Hand each caller its own copy of a shared row. A loader returns the same
   * object to every caller of the same key; when callers may mutate what they
   * get, pass a copy function so one caller cannot change another's answer.
   */
  readonly copy?: (value: V) => V
  /**
   * Memoise for the whole operation, write spans included (see the file
   * header). Only for rows whose EVERY write calls
   * {@link OperationLoader.invalidate}, after the write and after its commit.
   */
  readonly perOperation?: boolean
}

/**
 * Define a loader once, as a field of the repository that owns the rows.
 *
 * `batch` receives distinct keys and returns the rows it found keyed by the
 * same key; a key with no row is simply absent from the map.
 */
export function operationLoader<K, V>(
  batch: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>,
  options: OperationLoaderOptions<V> = {},
): OperationLoader<K, V> {
  let version = 0
  // A fetcher is a mutable box: it is created once per owner, and a write must
  // be able to replace its DataLoader while the owner stays open.
  type Held = { version: number; loader: DataLoader<K, V | undefined> | null }
  const fresh = (held: Held): DataLoader<K, V | undefined> => {
    if (held.loader !== null && held.version === version) return held.loader
    held.version = version
    held.loader = new DataLoader<K, V | undefined>(
      async (keys) => {
        const found = await batch(keys)
        return keys.map((key) => found.get(key))
      },
      { maxBatchSize: options.maxBatchSize ?? 500 },
    )
    return held.loader
  }
  const copy = options.copy ?? ((value: V) => value)
  const out = (value: V | undefined) => (value === undefined ? undefined : copy(value))

  // Two layers, and keeping them apart is what makes it safe. ANSWERS are
  // shared: a memo (the read scope's; with `perOperation` the operation's, or a
  // span unit's when neither is open) keeps each RESOLVED answer at the version
  // it was read at. FETCHES are not: a miss goes out through a DataLoader owned
  // by the EXECUTION CONTEXT it runs in: the transaction unit of any lane (with
  // `perOperation`, once a write unit has written these rows, the frame), the
  // post-commit drain, or, at the root, the memo's own. A DataLoader dispatches
  // its batch in the context of the FIRST caller, so one shared across contexts
  // runs a second caller's keys in the first caller's context: inside a span
  // that may be closed by then, or at the root while the second caller holds
  // the lease the root statement waits for, which deadlocks until the store
  // closes (POD-6189 hit both in one host sample; POD-6197 removed the same
  // sharing from the read-scope loaders).
  type Memo = {
    version: number
    answers: Map<K, V | undefined>
    held: Held
    /** A read-scope memo's fetchers, by the unit or drain they run in. */
    fetchers: WeakMap<object, Held>
  }
  const newMemo = (): Memo => ({ version, answers: new Map(), held: { version, loader: null }, fetchers: new WeakMap() })
  const memoSlot = readScopeSlot<Memo>(newMemo)
  const operationMemo = operationSlot<Memo>(newMemo)
  // Keyed weakly by the unit or frame that owns them, so an ended span's go
  // with it; and the units that have written these rows.
  const spans = new WeakMap<object, Memo>()
  const written = new WeakSet<TransactionUnit>()
  const memoOn = (owner: object): Memo => {
    const held = spans.get(owner)
    if (held) return held
    const opened = newMemo()
    spans.set(owner, opened)
    return opened
  }
  const current = (memo: Memo): Memo => {
    if (memo.version !== version) {
      memo.version = version
      memo.answers.clear()
    }
    return memo
  }
  // Where this call's answers are shared and its misses fetched, resolved ONCE
  // per call: outside every scope a read scope is fresh per ask, and resolving
  // it per key would split one call's batch into a statement per key.
  type Context = { shared: Memo | undefined; fetcher: Held }
  const context = (): Context => {
    const scope = currentScope()
    if (!options.perOperation) {
      // READ SCOPE. The fetchers live in the scope's memo, so a fetcher's own
      // DataLoader reuses no more than the scope does: outside an explicit
      // scope, each call is one live read wherever it runs.
      const shared = current(currentReadScope().slot(memoSlot))
      const owner = scope.kind === 'transaction' ? scope.frame.unit : scope.kind === 'post-commit' ? scope : undefined
      if (owner === undefined) return { shared, fetcher: shared.held }
      let fetcher = shared.fetchers.get(owner)
      if (!fetcher) {
        fetcher = { version, loader: null }
        shared.fetchers.set(owner, fetcher)
      }
      return { shared, fetcher }
    }
    const frame = openSpanFrame()
    if (frame && written.has(frame.unit)) {
      // After the span's own write: this frame only, gone if it rolls back.
      return { shared: undefined, fetcher: current(memoOn(frame)).held }
    }
    const operation = currentOperation()
    const shared = current(
      operation
        ? operation.slot(operationMemo)
        : frame && !inExplicitReadScope()
          ? memoOn(frame.unit)
          : currentReadScope().slot(memoSlot),
    )
    const fetcher =
      scope.kind === 'transaction' ? current(memoOn(scope.frame.unit)).held
        : scope.kind === 'post-commit' ? current(memoOn(scope)).held
          : shared.held
    return { shared, fetcher }
  }
  const loadOne = async ({ shared, fetcher }: Context, key: K): Promise<V | undefined> => {
    if (shared?.answers.has(key)) return shared.answers.get(key)
    const askedAt = version
    const value = await fresh(fetcher).load(key)
    // Kept only if nothing was written meanwhile: then it is still the answer.
    if (shared && version === askedAt && shared.version === askedAt) shared.answers.set(key, value)
    return value
  }
  return {
    async load(key) {
      return out(await loadOne(context(), key))
    },
    // A caller that knows its set needs no tick to collect it: the memo answers
    // what it holds and the misses go out NOW, as one statement per
    // `maxBatchSize`, in the caller's own context. Deferring them to the next
    // tick, as DataLoader does, let a writer queue for the lease in between, and
    // a root read queued behind a writer that waits on it never runs (POD-6189).
    async loadMany(keys) {
      const { shared } = context()
      const distinct = [...new Set(keys)]
      const result = new Map<K, V | undefined>()
      const misses = distinct.filter((key) => {
        if (!shared?.answers.has(key)) return true
        result.set(key, shared.answers.get(key))
        return false
      })
      const askedAt = version
      const size = options.maxBatchSize ?? 500
      for (let at = 0; at < misses.length; at += size) {
        const chunk = misses.slice(at, at + size)
        const found = await batch(chunk)
        for (const key of chunk) result.set(key, found.get(key))
      }
      if (shared && version === askedAt && shared.version === askedAt) {
        for (const key of misses) shared.answers.set(key, result.get(key))
      }
      return new Map(distinct.map((key) => [key, out(result.get(key))] as const))
    },
    invalidate() {
      version += 1
      if (!options.perOperation) return
      // A write inside a span: its later reads must not reach a memo that
      // outlives a rollback. A commit's call runs after the span: no frame.
      const frame = openSpanFrame()
      if (frame) written.add(frame.unit)
    },
  }
}
