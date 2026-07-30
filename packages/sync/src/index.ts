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
 * TWO `SyncSpan` DEFINITIONS EXIST AND THEY ARE NOT THE SAME TYPE (POD-1146).
 *
 * POD-369 (`./replica/ports`) declares `SyncSpan.join(participant)` with an
 * `OwnedSyncSpan` that commits or aborts and participants that
 * prepare/publish/discard. POD-370 (`./outbox/ports`) declares
 * `SyncSpan.onCommit(adopt)`. Both are the ADR 2 D10 unit-of-work seam, designed
 * independently by two siblings who each cite the other's findings — which is
 * precisely the parallel-definition drift POD-302 exists to end, arriving inside
 * the sync kernel itself.
 *
 * Until POD-1146 unifies them, the bare name is bound EXPLICITLY to the replica's
 * definition and the outbox's participant-side seam is exported only as
 * `OutboxSyncSpan`. Two reasons, and the second is the load-bearing one:
 *
 *  1. The asymmetry is real. The replica OPENS and owns the span (it decides when
 *     a frame's retirements commit together); the outbox PARTICIPATES in one it is
 *     handed. Opener-side is the sense a caller reaching for `SyncSpan` means.
 *  2. It fails LOUDLY rather than silently. Left as two `export *`s this was
 *     TS2308 in the barrel; bound the other way it would have compiled and handed
 *     POD-305/POD-373 — which wire BOTH modules — a name whose shape does not
 *     describe the object they receive. Passing this `SyncSpan` to
 *     `outbox.retireApplied` is now a type error at the wiring site, which is
 *     where the decision belongs.
 *
 * Each half keeps its own name internally (both import from their own `./ports`),
 * so nothing inside either module is renamed, and nothing outside packages/sync
 * imports either name today.
 */
export type { OwnedSyncSpan, SyncSpan, SyncSpanParticipant } from './replica/ports'
export type { SyncSpan as OutboxSyncSpan } from './outbox/ports'

export * from './ledger'
export * from './mirror'
export * from './outbox'
export * from './replica/index'
export * from './sync-repository'
export * from './upstream'
export * from './upstream-forwarder'
