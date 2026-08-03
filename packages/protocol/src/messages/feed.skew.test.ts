/**
 * WHAT A BUNDLE OLDER THAN ITS SERVER DOES TO A FEED FRAME (POD-1610).
 *
 * The observed outage: a web dist built three days before the server it was
 * served against dropped EVERY `feedBootstrap` frame and rendered an empty
 * board, with one `console.warn` to show for it. Two independent mechanisms
 * produced that, and this file pins both — the first as a schema property that
 * is now impossible, the second as a degradation that is now partial and loud
 * instead of total and silent.
 *
 *  1. THE CATCH-ALL DISAGREED WITH THE UNION. `UnknownFeedChange` excluded
 *     `MetadataEntityKind.options` — a list from another file — so a kind on
 *     that list with no arm here failed the strict union AND the catch-all, and
 *     the whole frame threw. That is not only a stale-bundle story: at the time
 *     of writing, `userLayout` and `userReadPosition` are exactly such kinds on
 *     HEAD. `unknownArmShape` below reconstructs the old rule and shows it
 *     refusing a frame the new one accepts.
 *
 *  2. A KNOWN KIND WITH A CHANGED PAYLOAD. The stale bundle required
 *     `IssueWire.blockedBy` where the server had moved to `blockedByNotes`, so
 *     every issue row failed its arm. No catch-all can save that one — the kind
 *     IS known — so the frame must survive by QUARANTINING the row, which is
 *     what `parseServerMessageLenient` now does for the feed family.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ScopedChangeOp } from '../planes/scoped-feed'
import { changeRowArm } from './change-row'
import { parseServerMessageLenient } from './codec'
import { FEED_ENTITY_KINDS, FeedBootstrapMessageLenient, FeedChange } from './feed'
import { ServerMessage } from './server'
import { MetadataEntityKind } from './sync'

const frame = (changes: unknown[], type = 'feedBootstrap') => ({
  type,
  feedId: 'feed-01J',
  epoch: 'epoch-01J',
  fromSeq: 0,
  seq: 12,
  minAvailableSeq: 0,
  changes,
  ...(type === 'feedBootstrap' ? { last: true } : {}),
})

/** A row of a kind the strict union has no arm for. `remove` carries no payload,
 *  so the row is well-formed on every dimension except its kind — which is the
 *  dimension under test. */
const rowOfKind = (entity: string, seq: number) => ({
  seq,
  entity,
  entityId: `${entity}_1`,
  op: 'remove' as const,
})

/** THE OLD RULE, reconstructed: a catch-all keyed on v1's kind enum rather than
 *  on the arms that do the parsing. Same shape, same position, one different
 *  list — which is the entire defect. */
const oldUnknownArm = changeRowArm(
  'entityId',
  z.string().refine((e) => !MetadataEntityKind.options.includes(e as never)),
  ScopedChangeOp,
  z.unknown(),
)
const oldLenientRow = z.union([FeedChange, oldUnknownArm])

describe('a kind the union has no arm for', () => {
  /** Non-vacuity: this whole file is about kinds in one list and not the other,
   *  so the two lists really have to differ. If a later change gives every v1
   *  kind an arm, this fails and says so rather than testing nothing. */
  const armless = MetadataEntityKind.options.filter((kind) => !FEED_ENTITY_KINDS.includes(kind))

  it('exists on HEAD — the drift is real, not hypothetical', () => {
    expect(armless.length).toBeGreaterThan(0)
    expect(FEED_ENTITY_KINDS).not.toContain(armless[0])
  })

  it('REPRODUCES the outage under the old rule: the whole frame is refused', () => {
    const row = rowOfKind(armless[0] as string, 7)
    // Both doors shut: no arm to take it, and the catch-all calls it "known".
    expect(FeedChange.safeParse(row).success).toBe(false)
    expect(oldUnknownArm.safeParse(row).success).toBe(false)
    expect(oldLenientRow.safeParse(row).success).toBe(false)

    const refused = z
      .object({ changes: z.array(oldLenientRow) })
      .safeParse({ changes: [rowOfKind('issue', 6), row] })
    expect(refused.success).toBe(false)
  })

  it('is ignored, not fatal, under the derived rule — the frame survives whole', () => {
    const parsed = parseServerMessageLenient(
      JSON.stringify(frame([rowOfKind('issue', 6), rowOfKind(armless[0] as string, 7)])),
    )
    expect(parsed.dropped).toBe(0)
    expect(parsed.message?.type).toBe('feedBootstrap')
    expect(FeedBootstrapMessageLenient.parse(parsed.message).changes).toHaveLength(2)
  })

  it('still refuses a kind that HAS an arm but a bad row — no sneaking through', () => {
    // The property the exclusion exists for: `issue` has an arm, so an issue row
    // with a nonsense op must fail rather than fall to the catch-all untyped.
    const bad = { seq: 8, entity: 'issue', entityId: 'iss_1', op: 'nonsense' }
    const parsed = parseServerMessageLenient(JSON.stringify(frame([bad])))
    expect(parsed.dropped).toBe(1)
    expect(FeedBootstrapMessageLenient.parse(parsed.message).changes).toHaveLength(0)
  })
})

describe('a known kind whose payload this build cannot read', () => {
  // The `blockedBy` → `blockedByNotes` half. An `issue` row whose value fails
  // `IssueWire` is unparseable by construction on the old build; what must not
  // happen is the other rows going down with it.
  const unreadable = { seq: 9, entity: 'issue', entityId: 'iss_2', op: 'upsert', value: { no: 1 } }

  it('REPRODUCES the outage under the old rule: the strict envelope takes it all', () => {
    // What the codec used to do with a feed frame — `ServerMessage.parse`, no
    // per-element pass. One unreadable row, and the caller sees a throw and zero
    // rows: the empty board, exactly.
    const raw = frame([rowOfKind('session', 8), unreadable, rowOfKind('repo', 10)])
    expect(ServerMessage.safeParse(raw).success).toBe(false)
  })

  it('quarantines the row and keeps the rest of the frame', () => {
    const parsed = parseServerMessageLenient(
      JSON.stringify(frame([rowOfKind('session', 8), unreadable, rowOfKind('repo', 10)])),
    )
    expect(parsed.dropped).toBe(1)
    const kept = FeedBootstrapMessageLenient.parse(parsed.message)
    expect(kept.changes.map((c) => c.entityId)).toEqual(['session_1', 'repo_1'])
    // The certified range is untouched: the frame still says what it covered, so
    // the replica advances rather than heal-looping over a row it cannot read.
    expect(kept.seq).toBe(12)
    expect(kept.fromSeq).toBe(0)
  })

  it('does the same for a delta frame', () => {
    const parsed = parseServerMessageLenient(
      JSON.stringify(frame([unreadable, rowOfKind('session', 10)], 'feedDelta')),
    )
    expect(parsed.dropped).toBe(1)
    expect(parsed.message?.type).toBe('feedDelta')
  })

  it('CAN SAY NO: a frame this build reads fully quarantines nothing', () => {
    const parsed = parseServerMessageLenient(
      JSON.stringify(frame([rowOfKind('session', 8), rowOfKind('issue', 9)])),
    )
    expect(parsed.dropped).toBe(0)
    expect(FeedBootstrapMessageLenient.parse(parsed.message).changes).toHaveLength(2)
  })
})
