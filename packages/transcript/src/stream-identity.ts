// Stream identity for a transcript item (POD-1761 W1; POD-2293).
//
// WHY THIS SITS IN packages/transcript RATHER THAN packages/agent-runtime
// (POD-2820). It began life on the Agent Runtime contract, next to the event
// types whose join it defines. But `packages/agent-runtime` RESTRICTS ITS
// CONSUMERS to the machine host and the build tier, because importing it means
// taking a host capability — and the join is not a capability. It is cursor
// arithmetic over a `TranscriptItem`: two lines of it, reading the very codec
// that already lives in this package. When the server grew its own consumer of
// the fragment stream (`turn-preview.ts`), it needed the join and nothing else
// around it, and the honest reading of `manifest-consumers` refusing that import
// was that the FUNCTION was filed on the wrong plane, not that the server was
// wrong to want it. So it moved down to the plane both halves may reach.
// `@podium/agent-runtime` re-exports it, so the contract's surface is unchanged
// and drivers still emit what the one named function returns.
//
// The other route was `@podium/agent-runtime/metadata`, the open entrypoint that
// package already declares for the server. It was not taken because this
// function's true home was never the contract: it is
// `encodeCursor({...decodeCursor(c), offset: 0})` with a fallback, a thin wrapper
// over two primitives that live HERE and that agent-runtime already depends on
// this package to get. Opening a door for it would have left it reaching back
// across an edge it should have been on the near side of.

import type { TranscriptItem } from '@podium/model'
import { decodeCursor, encodeCursor } from './cursor-codec'

/**
 * THE JOIN KEY BETWEEN A `{kind:'delta'}` FRAGMENT AND THE `{kind:'complete'}`
 * ITEM THAT SUPERSEDES IT.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTRACT NEEDS ONE NAMED FUNCTION FOR THIS
 * ---------------------------------------------------------------------------
 *
 * A consumer of the event stream accumulates token fragments into a preview and
 * must know WHICH complete item retires that preview. Get it wrong and the
 * preview never clears: the durable item lands beside it and the reply renders
 * twice, once whole and once as the orphaned fragments that built it. That is
 * the one streaming bug a user is guaranteed to notice, so the join is stated
 * here — in the contract — rather than re-derived per consumer.
 *
 * The families do not agree on what identity means, which is exactly why this
 * cannot be `item.id`:
 *
 *   - CODEX and GROK give an item a provider id that is stable for its whole
 *     life (`msg_…`, `grok-assistant-<eventId>`). Their deltas already carry it
 *     and their complete items already are it.
 *   - OPENCODE derives `id` from the part id AND ITS TEXT, so the id of a
 *     growing assistant message changes on every update. Its stamped `cursor`
 *     is closer but not stable either: the cursor's `offset` is the part's
 *     `timeUpdated`, and that moves from `time.start` to `time.end` the moment
 *     the part finishes — so the LAST complete item, the authoritative one, has
 *     a different cursor from every partial that preceded it.
 *
 * What IS stable across an opencode part's whole life is the rest of the cursor:
 * `(fileId, uuid=partId, sub)`. So the rule is: a cursor-stamped item's stream
 * identity is its cursor with the mutable offset zeroed; an unstamped item's is
 * its `id`. Both sides of the join call this, so they cannot drift apart.
 *
 * DRIVERS EMIT WHAT THIS RETURNS. A driver's `{kind:'delta'}` fragment must
 * carry, as `itemId`, the value this function returns for the complete item it
 * is building — see the conformance corpus's `delta identity` group, which
 * refuses a driver whose fragments join to nothing.
 */
export function streamItemIdOf(item: TranscriptItem): string {
  return item.cursor ? (streamIdOfCursor(item.cursor) ?? item.id) : item.id
}

/**
 * The same identity, derived from a cursor a driver holds directly.
 *
 * Producers reach for this when the complete item does not exist yet — which is
 * the normal case for a fragment stream, since the first token arrives before
 * anything has been assembled to stamp. Returns `undefined` for a cursor that
 * does not decode, so a caller can fall back rather than emit an identity it
 * invented.
 */
export function streamIdOfCursor(cursor: string): string | undefined {
  const parts = decodeCursor(cursor)
  if (!parts) return undefined
  return encodeCursor({ ...parts, offset: 0 })
}
