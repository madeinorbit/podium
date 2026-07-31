/**
 * WIRE FRAME → KERNEL FRAME (POD-376).
 *
 * ---------------------------------------------------------------------------
 * WHY A MAPPING EXISTS AT ALL, WHEN THE TWO SHAPES LOOK IDENTICAL
 * ---------------------------------------------------------------------------
 *
 * `packages/protocol`'s `FeedDeltaMessage` and `packages/sync`'s `DeltaFrame`
 * carry the same five range fields and the same rows, and it is tempting to cast.
 * They are still two types, and the reason is stated in `replica/types.ts`: those
 * are the KERNEL's types, defined so the Replica can be a pure state machine over
 * ports without importing the wire. A cast would weld them together, and the next
 * wire version would have to move the kernel with it.
 *
 * The mapping is written FIELD BY FIELD rather than by spread for one measured
 * reason. A spread carries `type: 'feedDelta'` into an object the kernel
 * discriminates on `kind`, so the result would have both, satisfy the type, and
 * differ from a hand-built frame in a way no golden fixture can see — the
 * restatement class `rearch-audit`'s `change-row-typings` item counts. Naming
 * every field means a new required field on either side is a compile error here.
 *
 * ---------------------------------------------------------------------------
 * `value` → `payload`, AND WHY THE RENAME IS NOT COSMETIC
 * ---------------------------------------------------------------------------
 *
 * The wire says `value`; the kernel says `payload`, and its `ChangeEnvelope`
 * documents `payload` as present iff `op === 'upsert'`. `remove` and `evict`
 * carry no payload, so this function does not emit the key at all for them —
 * rather than emitting `payload: undefined`, which is a different object and
 * would make an `evict` compare unequal to a hand-built one in exactly the tests
 * that check the removal family stays distinguishable.
 */

import type {
  FeedBootstrapMessage,
  FeedChangeRow,
  FeedDeltaMessage,
  FeedRescopeMessage,
  FeedResyncRequiredMessage,
} from '@podium/protocol'
import type { BootstrapChunk, ChangeEnvelope, ServerFrame } from '@podium/sync/replica'

/**
 * One row of either frame family — the PROTOCOL's own row type, not a structural
 * restatement of it.
 *
 * The first draft declared a local `interface WireChange { seq; entity; entityId;
 * op; value? }`, which `rearch-audit`'s `change-row-typings` item counted as a
 * hand-restated change-row field list, correctly. `FeedChangeRow` is the row the
 * frames and the catch-up reply both carry, composed in `messages/feed.ts` from
 * the model's change field schemas, so this mapper cannot drift from the wire it
 * is mapping.
 */
type WireChange = FeedChangeRow

/**
 * One change row.
 *
 * NO PROVENANCE, and that is a real gap rather than an omission — say so here
 * rather than let a reader infer it from an absent field. ADR 2 D8 puts
 * `originId` / `causationId` / `mutationId` on the envelope, and the kernel's
 * `ChangeEnvelope` has all three; the v2 WIRE change row does not carry them yet
 * (`packages/protocol/src/messages/feed.ts` — `changeRowArm('entityId', …)`).
 *
 * The consequence is bounded and worth naming: outbox retirement by
 * `causationId` cannot fire from a frame, so a client's own command retires on
 * its command ACK rather than on the frame that confirms it. That is the
 * pre-cutover behaviour, unchanged, and it is why POD-376's comparison basis
 * excludes provenance from its digest — the two paths legitimately carry
 * different provenance for the same row, because on this wire neither carries
 * any.
 */
function toEnvelope(change: WireChange): ChangeEnvelope {
  const base = { seq: change.seq, entity: change.entity, entityId: change.entityId }
  return change.op === 'upsert'
    ? { ...base, op: 'upsert', payload: change.value }
    : { ...base, op: change.op }
}

/** A `feedDelta` as the kernel's rung-0 acceptance rule reads it. */
export function toDeltaFrame(message: FeedDeltaMessage): Extract<ServerFrame, { kind: 'delta' }> {
  return {
    kind: 'delta',
    feedId: message.feedId,
    epoch: message.epoch,
    fromSeq: message.fromSeq,
    seq: message.seq,
    minAvailableSeq: message.minAvailableSeq,
    changes: message.changes.map(toEnvelope),
  }
}

/**
 * A `feedRescope` — D14.4, "your rights changed".
 *
 * The wire's `seq` is DROPPED, and dropping it is correct rather than lossy: the
 * kernel's `RescopeFrame` has no seq field because the frame tells a replica to
 * abandon its cursor, and a control frame carrying a position invites someone to
 * treat it as one. `cause` is dropped for the same reason — it is a wire literal
 * with one value; the kernel records the cause as `'rescope'` on its own ladder.
 */
export function toRescopeFrame(
  message: FeedRescopeMessage,
): Extract<ServerFrame, { kind: 'rescope' }> {
  return {
    kind: 'rescope',
    feedId: message.feedId,
    epoch: message.epoch,
    ...(message.reason === undefined ? {} : { reason: message.reason }),
  }
}

export function toResyncFrame(
  message: FeedResyncRequiredMessage,
): Extract<ServerFrame, { kind: 'resync-required' }> {
  return {
    kind: 'resync-required',
    feedId: message.feedId,
    epoch: message.epoch,
    ...(message.reason === undefined ? {} : { reason: message.reason }),
  }
}

/**
 * A `feedBootstrap` chunk.
 *
 * `snapshotSeq` comes from the frame's `seq`, which is the position the world was
 * read at — `FeedServing.serveWorld` sets it from `world.throughSeq` in the same
 * synchronous pass as the rows. `fromSeq` is 0 on every bootstrap chunk and has
 * no kernel counterpart; the kernel's `BootstrapChunk` states the same claim by
 * being a bootstrap.
 */
export function toBootstrapChunk(message: FeedBootstrapMessage): BootstrapChunk {
  return {
    feedId: message.feedId,
    epoch: message.epoch,
    snapshotSeq: message.seq,
    changes: message.changes.map(toEnvelope),
    last: message.last,
  }
}
