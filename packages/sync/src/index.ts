/**
 * @podium/sync — the node⇄hub sync layer (issue #196): the durable metadata
 * change log + outbox write path (SyncRepository, Ledger), the node→hub
 * dialer and issue write forwarder (UpstreamSync, UpstreamForwarder), and the
 * transcript-lake mirror (MirrorService). Depends only on @podium/protocol and
 * @podium/runtime — never apps/*; apps/server injects its store repositories
 * through the narrow interfaces each class declares. The change-log internals
 * (./change-log.ts) are private to the package.
 */
/**
 * ADR 2 D10's unit of work has ONE definition site: `./span` (POD-1146).
 *
 * It used to have two. POD-369 (`./replica/ports`) declared
 * `SyncSpan.join(participant)` with an `OwnedSyncSpan` that commits or aborts;
 * POD-370 (`./outbox/ports`) declared `SyncSpan.onCommit(adopt)`. Left as two
 * `export *`s that was TS2308 here, and the provisional fix bound the bare name to
 * the replica's so that handing it to `outbox.retireApplied` failed loudly at the
 * wiring site rather than silently.
 *
 * There is now nothing to disambiguate: one span carries both hooks, and the
 * opener/participant asymmetry that motivated the provisional binding is expressed
 * where it belongs — `OwnedSyncSpan extends SyncSpan` with `commit`/`abort` on the
 * owner alone. POD-305 and POD-373 wire both modules against this one type.
 *
 * `OutboxSyncSpan` is deliberately NOT re-introduced as an alias: a second name
 * for one type is how the drift starts again.
 */
export * from './span'
/**
 * The cross-hop conformance suite (POD-373). Exported from the package because it is
 * PARAMETERIZED BY INSTANTIATION: POD-307, POD-308, POD-309, POD-374 and POD-375 each
 * supply a `SyncInstantiation` and call `describeSyncConformance(it)`, and none of them
 * may edit the suite to be admitted.
 */
export * from './conformance/index'

/**
 * The AUTHORITY role (POD-305, 2.1) — the write funnel and the Ledger, joined.
 * `./ledger` remains exported beside it during the cutover: POD-306 and POD-308
 * still consume it, and deleting it in the same commit that introduced its
 * replacement would have made this issue's diff the migration of every call site.
 */
export * from './authority/index'
export * from './ledger'
export * from './mirror'
/**
 * Framework idempotency (POD-382): the ONE implementation of mutationId dedup,
 * relocated out of `SessionsService.withMutation`. Exported because it is a
 * framework property every command envelope shares — the session presence class,
 * the session command plane and the issue registry all call it — and a property
 * reachable only through one app's service graph is a property the next transport
 * can forget.
 */
export * from './mutation-ledger'
export * from './outbox'
export * from './replica/index'
export * from './adapters/sqlite/sync-repository'
/**
 * The WEB replica storage adapter (POD-374) — ADR 6 D1's transactional
 * IndexedDB, as a sibling of the SQLite adapter and held to the same rule 11:
 * DOM is named there and nowhere else in this package.
 *
 * Exported so POD-307's client wiring can construct it. `./adapters/indexeddb/idb`
 * comes with it because `browserIndexedDb()` is the composition helper that reads
 * the global — nothing inside the adapter calls it, which is what keeps the adapter
 * instantiable in a worker and against a test factory.
 *
 * `./adapters/indexeddb/conformance` and `./adapters/indexeddb/test-support` are
 * deliberately NOT here: the first pulls in the conformance instantiation and the
 * second imports `fake-indexeddb`, and neither belongs in a shipped browser bundle.
 */
export * from './adapters/indexeddb/idb'
export * from './adapters/indexeddb/schema'
export * from './adapters/indexeddb/store'
export * from './upstream'
export * from './upstream-forwarder'
