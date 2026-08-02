/**
 * EVENT-STREAM READ CURSOR WRITE FAMILY (POD-1380) — `readPosition.advance`.
 *
 * One command, because a cursor has one verb. `docs/multi-user-readiness.md` §3.3
 * puts read state in the per-user family so it FOLLOWS a person; until this family
 * the position lived only in one browser's ui-state, so a stream read on a laptop
 * was unread on a phone. The durable home is `user_read_position` keyed
 * `(user_id, stream_id)`; this file is the command half.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT NAMES A FEED AND A POSITION — NEVER A USER
 * ---------------------------------------------------------------------------
 * ADR 3 D7: identity comes from the authenticated transport. There is no `userId`
 * field to omit-check, because the schema has none: a frame claiming to advance
 * someone else's cursor is not a refused frame, it is an UNREPRESENTABLE one. The
 * handler keys the row from the principal it resolved.
 *
 * ---------------------------------------------------------------------------
 * `conflict: 'cmd'` — MONOTONIC, NOT LAST-WRITER
 * ---------------------------------------------------------------------------
 * The row is `(userId, streamId)`, so the only concurrent writers are one person's
 * own devices — but "single-writer" would be the wrong DECLARATION, because it
 * implies the order of those writes decides the value. It must not: a device that
 * writes before its hydration lands proposes a stale-but-legal position, and
 * last-writer-wins would move the cursor BACKWARD and re-mark read events unread.
 * The rule is `max`, spelled once in the model's `advanceReadPosition`, and declared
 * here because ADR 1 makes a `cmd` row carry its own rule or be refused.
 *
 * ---------------------------------------------------------------------------
 * `online-only`, AND WHY THIS FAMILY IS NOT ON THE OUTBOX
 * ---------------------------------------------------------------------------
 * Layout is offline-eligible: a person can fold a column on a plane. A cursor
 * advance names an event id that can only have been LEARNED from a live query of
 * the same log — offline, there is nothing newer to acknowledge, so there is no
 * offline write to queue. Queueing one would mean draining a position derived from
 * a log state the client no longer has, which is exactly the replay the
 * `direct-only` / `online-only` split exists to refuse. Losing an advance costs a
 * re-poll, not data: the next visible tick re-proposes the same position.
 */

import { READ_STREAM_IDS, isReadStreamId, MutationIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  ConflictDeclaration,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A feed from the closed vocabulary — an unknown stream fails as a schema error. */
const streamIdInput = z.string().superRefine((id: string, ctx: z.RefinementCtx) => {
  if (!isReadStreamId(id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `'${id}' is not a known event stream — one of ${READ_STREAM_IDS.join(', ')}`,
    })
  }
})

/**
 * Advance the calling principal's position in one stream.
 *
 * `seenAt` is the client's clock label for the divider and is DESCRIPTIVE: the
 * server neither orders nor arbitrates on it (the id does that), so a wrong device
 * clock mislabels a divider and cannot lose a read position.
 */
export const readPositionAdvanceInput = z.object({
  streamId: streamIdInput,
  lastEventId: z.number().int().nonnegative(),
  seenAt: z.string().nullable().optional(),
  mutationId: z.string().max(128).pipe(MutationIdField).optional(),
})
export type ReadPositionAdvanceInput = z.infer<typeof readPositionAdvanceInput>

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const SERVED_ON: readonly TransportTag[] = ['trpc']

const CURSOR_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. The position names an id learned from a live read of the same log, so there is ' +
    'no offline advance to hold: offline, nothing newer has arrived to acknowledge. A dropped ' +
    'advance is re-proposed by the next visible poll, which is why losing one costs a round trip ' +
    'and not a read position. Deliberately NOT on `outbox` — POD-402 routes replicated per-user ' +
    'writes through it, and this is the declared exception, not an omission.',
  applyTimeReauthorization:
    'Applied inline on an authenticated call; there is no enqueue/drain gap to re-authorize across. ' +
    'A principal with no on-behalf-of user is refused before the store is reached — the row IS its ' +
    'user, so there is no cursor to write for nobody.',
}

const CURSOR_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Nothing redacted. The input is a feed name from a closed vocabulary, an integer log position ' +
    'and a timestamp. No credential, no routing address, no prose.',
}

const CURSOR_OWNERSHIP: CreationOwnership = {
  creates: [],
  note:
    'Mints nothing. The row is materialised by the store on first advance and IS the user by its ' +
    'key; per-user state is non-grantable (ADR 9 D3 rule 4), so inheritanceOnCreate has nothing ' +
    'to decide.',
}

const CURSOR_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves stamped from the transport principal. The input carries no user field at all, so ' +
    'ADR 3 D7 is enforced by the SHAPE rather than by a check that could be forgotten.',
}

const CURSOR_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'The caller supplies a feed name from a CLOSED public vocabulary, never an entity id. Every ' +
    'admissible feed exists on every instance; an unknown one fails as a schema error and ' +
    'discloses only that the vocabulary is closed.',
}

const MONOTONIC: ConflictDeclaration = {
  conflict: 'cmd',
  conflictRule:
    'MONOTONIC MAX per (userId, streamId). The stored position is max(stored, proposed); a proposal ' +
    'at or below the stored id is a NO-OP, not an overwrite. Two devices of one person are two ' +
    'writers of one row, and last-writer-wins would let a device that writes before its hydration ' +
    'lands move the cursor backward and re-mark read events unread. `max` makes the order ' +
    'irrelevant. The rule is executed by @podium/model advanceReadPosition, not restated here.',
}

// ---------------------------------------------------------------------------
// readPosition.advance
// ---------------------------------------------------------------------------

/**
 * Move the calling principal's read position in one stream forward.
 *
 * `visibility: 'per-user-state'` — never `personal`. A `personal` classification
 * would key a per-user fact as a shareable one (the POD-351 / POD-731 trap), and
 * for a read cursor "shareable" is the exact defect: one person's read state
 * becoming another's looks identical to a working cursor until there are two
 * people.
 */
export const readPositionAdvanceContract = {
  name: 'readPosition.advance',
  version: 1,
  visibility: 'per-user-state',
  input: readPositionAdvanceInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A member advances their OWN cursor. `resource: "none"` because the row IS the principal ' +
      '(keyed userId) — there is no shared entity to gate and no grant verb on this class (ADR 9 ' +
      'D3 rule 4). No confirmation: the write is monotonic and marks nothing unread, so there is ' +
      'nothing to lose. No machineVerb: it places no work on owned compute.',
  },
  exposure: SERVED_ON,
  delivery: CURSOR_DELIVERY,
  redaction: CURSOR_REDACTION,
  ownership: CURSOR_OWNERSHIP,
  attribution: CURSOR_ATTRIBUTION,
  errorConsistency: CURSOR_ERRORS,
  ...MONOTONIC,
  cli: { summary: 'Advance the calling user’s read position in an event stream' },
} as const satisfies CommandContract<typeof readPositionAdvanceInput>

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const READ_POSITION_CONTRACTS = {
  'readPosition.advance': readPositionAdvanceContract,
} as const

export type ReadPositionContractName = keyof typeof READ_POSITION_CONTRACTS
export const READ_POSITION_CONTRACT_NAMES = Object.keys(
  READ_POSITION_CONTRACTS,
) as ReadPositionContractName[]
