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

export * from './ledger'
export * from './mirror'
export * from './outbox'
export * from './replica/index'
export * from './sync-repository'
export * from './upstream'
export * from './upstream-forwarder'
