/**
 * PER-USER STATE FAMILY — THE EVENT-STREAM READ CURSOR (POD-1380).
 *
 * ---------------------------------------------------------------------------
 * THE KEY POD-403 COULD NOT ROUTE, AND WHY IT ARRIVES HERE
 * ---------------------------------------------------------------------------
 * POD-403 made the client ui-state routing table TOTAL and found one key with no
 * legitimate home: `podium:superfeed:cursor`, the "you were here" marker over the
 * cross-project issue-event log. It was recorded as `known-unrouted` against this
 * issue rather than defaulted to device-local, because an undeclared exclusion is
 * indistinguishable from an oversight (POD-1350's vocabulary rule).
 *
 * It is per-user state, not device state. `docs/multi-user-readiness.md` §3.3 is
 * explicit — *"`readAt` is obviously mine"* — and read state that stays on one
 * machine means a stream read on a laptop is unread on a phone. Inert with one
 * device; wrong the moment there are two.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `IssueUserState`, AND WHY NOT A LAYOUT KEY
 * ---------------------------------------------------------------------------
 * `issue-state.ts`'s `readAt` is an ENTITY-level marker: one timestamp per
 * (user, issue), meaning "this person opened that issue". This is a POSITION IN AN
 * ORDERED LOG — one id per (user, feed), covering every issue at once. Different
 * granularity, different write frequency, and a different merge rule. Folding it
 * into `IssueUserState` would need a synthetic issue id for a value that is not
 * about any issue.
 *
 * It is also NOT a `user_layout` key, even though that table is mechanically a
 * per-user key/value store that would have been cheaper. Layout keys are
 * last-writer-wins per key, and LWW on a cursor can move it BACKWARD: a second
 * device that writes before its hydration lands re-marks already-read events as
 * unread. The fix is a MONOTONIC merge (`max`), which needs a handler of its own —
 * a generic key/value setter cannot have one. The conflict story is what makes
 * this its own member rather than a thirteenth layout key.
 *
 * The closest analogue named by the brief, `clientOutboxAndReplicaCursor`, is a
 * declared NON-member because the replica's progress is a fact about one device's
 * cache. This cursor names ids in a SERVER-side shared log, identical on every
 * device, so that reasoning does not transfer.
 *
 * ---------------------------------------------------------------------------
 * KEYED `(userId, streamId)`, NOT BY USER ALONE
 * ---------------------------------------------------------------------------
 * One row per person per FEED. A userId-only singleton would not compose the
 * family's one `perUserKey` fragment, which is the invariant `family.ts` exists to
 * assert. The feed half is a CLOSED vocabulary ({@link READ_STREAM_IDS}) with one
 * member today, so a free-form string cannot mint rows, and a future per-repo or
 * per-issue stream has a key shape waiting rather than a second table.
 *
 * The user half is never taken from a payload. ADR 3 D7: the writer is the
 * authenticated transport principal, and `readPosition.advance`'s input carries no
 * user field at all — there is nothing for a client to assert.
 */

import { z } from 'zod'
import { UserIdField } from '../ids'
import { perUserKeyOfString } from './session-state'

// ---------------------------------------------------------------------------
// The closed feed vocabulary
// ---------------------------------------------------------------------------

/**
 * Streams a person can hold a read position in. Exactly one today: the
 * cross-project issue-event log the superagent column's chat feed renders
 * (`useIssueEvents` / engraved-column.md §2.5).
 */
export const READ_STREAM_IDS = ['issueEvents'] as const
export type ReadStreamId = (typeof READ_STREAM_IDS)[number]

const FEED_ID_SET: ReadonlySet<string> = new Set(READ_STREAM_IDS)

/** Is this string a feed a cursor may name? Closed list, never a free string. */
export function isReadStreamId(id: string): id is ReadStreamId {
  return FEED_ID_SET.has(id)
}

/**
 * A feed id that IS a member of the closed vocabulary. Refined at the model
 * boundary — not only on the command input — so an unknown feed cannot parse as
 * durable state even when the command schema is bypassed (POD-402 review gap 3,
 * the same posture as `LayoutKeyField`).
 */
export const ReadStreamIdField = z.string().superRefine((id, ctx) => {
  if (!isReadStreamId(id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `'${id}' is not a known event stream (isReadStreamId), so it has no cursor row`,
    })
  }
})

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * ONE PERSON'S POSITION IN ONE STREAM — `(userId, entityId)` where `entityId` is
 * a {@link ReadStreamId}.
 *
 * An ABSENT ROW means "this person has never read this stream", the same rule the
 * rest of the family states for `readAt`: absence is meaningful and has exactly
 * one spelling. It is NOT stored as `lastEventId: 0`; the client's own "never
 * seen" default covers that, and storing the default back would make "never
 * looked" and "looked before anything happened" indistinguishable.
 *
 * `lastEventId` is a durable issue-event log id — server-assigned and monotonic,
 * so it means the same thing on every device of the same person. `seenAt` is the
 * clock label the divider renders, and is descriptive only: NOTHING arbitrates on
 * it, because a device clock is not an ordering (the id is).
 */
export const ReadPositionState = perUserKeyOfString().extend({
  /** Closed vocabulary — overrides the unbranded string from perUserKeyOfString. */
  entityId: ReadStreamIdField,
  /** Highest event id this person has acknowledged. Monotonic; never decreases. */
  lastEventId: z.number().int().nonnegative(),
  /** When the cursor last advanced. Descriptive label, never an arbitration input. */
  seenAt: z.string().nullable(),
})
export type ReadPositionState = z.infer<typeof ReadPositionState>

/**
 * Wire value of one cursor row on the metadata feed (entity kind
 * `userReadPosition`). Carries the owning user so a lagging client that only sees
 * the payload still knows whose row it is — and so a client that somehow received
 * a foreign row can drop it rather than render it as its own.
 */
export const ReadPositionWire = z.object({
  userId: UserIdField,
  streamId: ReadStreamIdField,
  lastEventId: z.number().int().nonnegative(),
  seenAt: z.string().nullable(),
})
export type ReadPositionWire = z.infer<typeof ReadPositionWire>

/**
 * Bootstrap / command-response SNAPSHOT for one principal: their position in
 * every stream they have read, as a plain map. Absent key = never read.
 */
export const ReadPositionSnapshot = z
  .record(z.string(), z.object({ lastEventId: z.number().int().nonnegative(), seenAt: z.string().nullable() }))
  .superRefine((snap, ctx) => {
    for (const id of Object.keys(snap)) {
      if (!isReadStreamId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `'${id}' is not a known event stream`,
        })
      }
    }
  })
export type ReadPositionSnapshot = z.infer<typeof ReadPositionSnapshot>

// ---------------------------------------------------------------------------
// The monotonic merge, spelled once
// ---------------------------------------------------------------------------

/**
 * THE ARBITRATION RULE, as a function, so the server handler and any client
 * projection cannot disagree about it.
 *
 * A cursor only ever moves FORWARD. Two devices of the same person are two
 * writers of one row, and the loser of a race is whichever wrote last — under
 * plain LWW that re-marks read events unread. `max` makes the order irrelevant:
 * the row converges to the furthest either device has read, which is the only
 * answer that never resurfaces something the person has already seen.
 *
 * Returns `null` when the write would not move the cursor, so the caller can skip
 * the write (and the feed publish) rather than storing an identical row.
 */
export function advanceReadPosition(
  current: { lastEventId: number; seenAt: string | null } | undefined,
  proposed: { lastEventId: number; seenAt: string | null },
): { lastEventId: number; seenAt: string | null } | null {
  if (current !== undefined && proposed.lastEventId <= current.lastEventId) return null
  return proposed
}

// ---------------------------------------------------------------------------
// Feed row identity — `(userId, streamId)` as one change-log entityId
// ---------------------------------------------------------------------------

const CURSOR_ROW_SEP = '\n'

/**
 * Change-log / feed id for one cursor row. Escaped join, same rule as
 * {@link layoutRowId}: a userId containing the separator must not be able to
 * collide with another pair.
 */
export function readPositionRowId(userId: string, streamId: string): string {
  const esc = (p: string) =>
    p.replaceAll('\\', '\\\\').replaceAll(CURSOR_ROW_SEP, `\\${CURSOR_ROW_SEP}`)
  return `${esc(userId)}${CURSOR_ROW_SEP}${esc(streamId)}`
}

/** Inverse of {@link readPositionRowId}. Throws on a malformed id. */
export function parseReadPositionRowId(id: string): { userId: string; streamId: string } {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== CURSOR_ROW_SEP) {
        throw new Error(`malformed feed cursor row id: ${JSON.stringify(id)}`)
      }
      current += next
      i += 1
    } else if (ch === CURSOR_ROW_SEP) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`malformed feed cursor row id: ${JSON.stringify(id)}`)
  }
  return { userId: parts[0]!, streamId: parts[1]! }
}

/**
 * The cursor-half members, as a list so `family.ts` composes rather than
 * redeclares — the shape every other half already has.
 */
export const READ_POSITION_USER_STATE_MEMBERS = [
  {
    name: 'issueEventReadCursor',
    schema: ReadPositionState,
    table: 'user_read_position',
  },
] as const
