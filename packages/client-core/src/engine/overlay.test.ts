/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, folding composes in queue order with stable identities,
 * and pruneAwaiting implements retirement rule (a) (see overlay.ts header).
 */

import { ISSUE_CONTRACTS, sessionStateCommand, sessionStateCommandNames } from '@podium/commands'
import { addSink, resetLevels, setLogLevel } from '@podium/logger'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  asUserId,
  type IssueProjection,
  type IssueUserStateWire,
  type SessionMeta,
  type SessionMetaInput,
  type SessionUserStateWire,
} from '@podium/model'

import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { ACTION_STATE_REDUCER_COMMANDS } from './actions'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  foldRowOverlays,
  insertOverlay,
  issueUpdateRoute,
  overlaysForOutboxEntry,
  type OverlayRow,
  type PendingOverlay,
  PRESENCE_REDUCER_KINDS,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'

const entry = (kind: string, input: unknown, queuedAt = 1751500800000): OutboxEntry => ({
  mutationId: asMutationId(`m-`),
  kind,
  input,
  queuedAt,
})

/** The one overlay of record an entry paints on its own row — every kind but
 *  a mixed `issueUpdate` has at most one. */
function overlayForOutboxEntry(e: OutboxEntry): PendingOverlay | null {
  const overlays = overlaysForOutboxEntry(e)
  expect(overlays.length).toBeLessThanOrEqual(1)
  return overlays[0] ?? null
}

const userState = (over: Partial<IssueUserStateWire> = {}): IssueUserStateWire => ({
  userId: asUserId('u1'),
  entityId: asIssueId('i1'),
  readAt: null,
  tuckedAt: null,
  pinned: false,
  ...over,
})

const sessionUserState = (over: Partial<SessionUserStateWire> = {}): SessionUserStateWire => ({
  userId: asUserId('u1'),
  sessionId: asSessionId('s1'),
  readAt: null,
  ...over,
})

const sess = (over: Partial<SessionMetaInput> = {}): SessionMeta =>
  ({
    sessionId: 's1',
    title: 's1',
    cwd: '/w',
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }) as unknown as SessionMeta

describe('overlayForOutboxEntry projection', () => {
  it('rename patches the trimmed name and is covered by a row carrying it', () => {
    const o = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: ' hi ' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('sessions')
    expect(o.id).toBe('s1')
    expect(o.patch).toEqual({ name: 'hi' })
    expect(o.coveredBy(sess({ name: 'hi' }))).toBe(true)
    expect(o.coveredBy(sess({ name: 'other' }))).toBe(false)
    expect(o.coveredBy(sess())).toBe(false)
  })

  it('archive / work-state / snooze project patches on their owning rows', () => {
    const arch = overlayForOutboxEntry(entry('setArchived', { sessionId: 's1', archived: true }))
    if (arch?.op !== 'patch') throw new Error('expected patch')
    expect(arch.patch).toEqual({ archived: true })
    expect(arch.coveredBy(sess({ archived: true }))).toBe(true)

    const ws = overlayForOutboxEntry(entry('setWorkState', { sessionId: 's1', workState: null }))
    if (ws?.op !== 'patch') throw new Error('expected patch')
    expect(ws.patch).toEqual({ workState: undefined })
    expect(ws.coveredBy(sess())).toBe(true)
    expect(ws.coveredBy(sess({ workState: 'done' } as Partial<SessionMetaInput>))).toBe(false)

    const snooze = overlayForOutboxEntry(
      entry('snoozeSet', { sessionId: 's1', until: '2026-07-10T00:00:00.000Z' }),
    )
    if (snooze?.op !== 'patch') throw new Error('expected patch')
    expect(snooze.entity).toBe('sessionUserStates')
    expect(snooze.patch).toEqual({ snoozedUntil: '2026-07-10T00:00:00.000Z' })
    expect(snooze.coveredBy(sessionUserState({ snoozedUntil: '2026-07-10T00:00:00.000Z' }))).toBe(true)

    const clear = overlayForOutboxEntry(entry('snoozeClear', { sessionId: 's1' }))
    if (clear?.op !== 'patch') throw new Error('expected patch')
    expect(clear.entity).toBe('sessionUserStates')
    expect(clear.patch).toEqual({ snoozedUntil: undefined })
    expect(clear.coveredBy(sessionUserState())).toBe(true)
    expect(clear.coveredBy(sessionUserState({ snoozedUntil: 'x' }))).toBe(false)
    expect(clear.coveredBy(sessionUserState({ snoozedUntil: null }))).toBe(false)
  })

  // POD-1110 — "none of these" queues like every other row edit, and this is the
  // paint that keeps the bar gone while it waits (including across a reload).
  it('dismissOffer clears the offer, and covering truth is ANY other standing offer', () => {
    const offer = (createdAt: string) =>
      ({ message: 'm', actions: [], createdAt }) as SessionMeta['offer']
    const o = overlayForOutboxEntry(
      entry('dismissOffer', { sessionId: 's1', offerCreatedAt: 'T1' }),
    )
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('sessions')
    expect(o.id).toBe('s1')
    expect(o.patch).toEqual({ offer: undefined })
    // The offer this dismissal names is still standing: pre-mutation truth, so
    // the bar stays hidden rather than flickering back mid-flight.
    expect(o.coveredBy(sess({ offer: offer('T1') } as Partial<SessionMetaInput>))).toBe(false)
    // The server cleared it.
    expect(o.coveredBy(sess())).toBe(true)
    // A NEWER offer arrived while this was in flight. It covers too — judging on
    // "no offer at all" would keep painting over an offer the operator has never
    // seen, which is the very thing the server's stamp guard refuses to do.
    expect(o.coveredBy(sess({ offer: offer('T2') } as Partial<SessionMetaInput>))).toBe(true)
  })

  it('mark read/unread target the owning readAt field; server clocks may differ', () => {
    const read = overlayForOutboxEntry(entry('sessionMarkRead', { sessionId: 's1' }, 1751500800000))
    if (read?.op !== 'patch') throw new Error('expected patch')
    expect(read.entity).toBe('sessionUserStates')
    expect(read.patch).toEqual({ readAt: new Date(1751500800000).toISOString() })
    // The server stamps its OWN clock — a different readAt still covers.
    expect(read.coveredBy(sessionUserState({ readAt: '2099-01-01T00:00:00.000Z' }))).toBe(true)
    expect(read.coveredBy(sessionUserState())).toBe(false)

    const issueRead = overlayForOutboxEntry(entry('issueMarkRead', { id: 'i1' }, 1751500800000))
    if (issueRead?.op !== 'patch') throw new Error('expected patch')
    expect(issueRead.entity).toBe('issueUserStates')
    expect(issueRead.patch).toEqual({ readAt: new Date(1751500800000).toISOString() })
    // Persistence stamps its own clock on this SAME row, so presence covers.
    expect(issueRead.coveredBy({ readAt: '2099-01-01T00:00:00.000Z' } as OverlayRow)).toBe(true)
    expect(issueRead.coveredBy({ readAt: null } as OverlayRow)).toBe(false)

    const reread = overlayForOutboxEntry({
      ...entry('issueMarkRead', { id: 'i1' }, 1751500800000),
      baseline: rowFingerprint({ id: 'i1', readAt: '2026-07-01T00:00:00.000Z' }),
    })
    if (reread?.op !== 'patch') throw new Error('expected patch')
    // An older non-null cursor is pre-mutation truth, not coverage. The server's
    // new covering cursor may use a different clock, so movement is sufficient.
    expect(reread.coveredBy({ readAt: '2026-07-01T00:00:00.000Z' } as OverlayRow)).toBe(false)
    expect(reread.coveredBy({ readAt: '2026-07-01T00:05:00.000Z' } as OverlayRow)).toBe(true)

    const unread = overlayForOutboxEntry(entry('issueMarkUnread', { id: 'i1' }))
    if (unread?.op !== 'patch') throw new Error('expected patch')
    expect(unread.entity).toBe('issueUserStates')
    expect(unread.patch).toEqual({ readAt: null })
    expect(unread.coveredBy({ readAt: null } as OverlayRow)).toBe(true)
  })

  // Tuck-away rides the SAME optimistic mechanism as the rest (POD-333), which is
  // what lets the fold be server state without the press feeling slow: the entry
  // paints tuckedAt until the server's own stamp lands — including across a
  // reconnect heal snapshot taken before the mutation got there.
  it('setTucked stamps tuckedAt from queuedAt; covering truth is judged on presence', () => {
    const tuck = overlayForOutboxEntry(
      entry('issueSetTucked', { id: 'i1', tucked: true }, 1751500800000),
    )
    if (tuck?.op !== 'patch') throw new Error('expected patch overlay')
    expect(tuck.entity).toBe('issueUserStates')
    expect(tuck.id).toBe('i1')
    expect(tuck.patch).toEqual({ tuckedAt: new Date(1751500800000).toISOString() })
    // The server stamps its own clock, so ANY stamp covers…
    expect(tuck.coveredBy({ tuckedAt: '2099-01-01T00:00:00.000Z' } as OverlayRow)).toBe(true)
    // …but pre-mutation truth (a heal snapshot mid-flight) does NOT: the row
    // stays folded instead of flickering back into the live list.
    expect(tuck.coveredBy({ tuckedAt: null } as OverlayRow)).toBe(false)
    expect(tuck.coveredBy({} as OverlayRow)).toBe(false)

    const untuck = overlayForOutboxEntry(entry('issueSetTucked', { id: 'i1', tucked: false }))
    if (untuck?.op !== 'patch') throw new Error('expected patch overlay')
    expect(untuck.patch).toEqual({ tuckedAt: null })
    expect(untuck.coveredBy({ tuckedAt: null } as OverlayRow)).toBe(true)
    expect(untuck.coveredBy({ tuckedAt: '2026-07-03T00:00:00.000Z' } as OverlayRow)).toBe(false)
  })

  it('an unknown kind projects to nothing', () => {
    expect(overlayForOutboxEntry(entry('someFutureKind', {}))).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // POD-781 — the curation writes
  // ---------------------------------------------------------------------------

  it('issueUpdate paints the patch verbatim, and is covered only when EVERY key it set reads back', () => {
    const o = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { title: 'Renamed', priority: 2 } }),
    )
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ title: 'Renamed', priority: 2 })
    expect(o.coveredBy({ title: 'Renamed', priority: 2 } as OverlayRow)).toBe(true)
    // HALF-landed truth is not coverage: a row carrying the rename but not the
    // priority must keep painting, or the second field flashes back.
    expect(o.coveredBy({ title: 'Renamed', priority: 0 } as OverlayRow)).toBe(false)
    expect(o.coveredBy({ title: 'Old', priority: 2 } as OverlayRow)).toBe(false)
    // A competing writer moving some OTHER field neither covers nor un-covers.
    // pruneAwaiting agrees: only a patched cell moving to a third value is a
    // competing write. An extra field on a fully-covered row is just coverage.
    expect(o.coveredBy({ title: 'Renamed', priority: 2, stage: 'done' } as OverlayRow)).toBe(true)
  })

  it('issueUpdate treats a cleared field as covered by an ABSENT one — null and undefined are one value', () => {
    // `issues.update` clears a colour with `color: null`; `OverlayRow.color` is
    // optional and simply absent once cleared. A strict `===` would leave every
    // clear painted until its TTL.
    const cleared = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { color: null } }),
    )
    if (cleared?.op !== 'patch') throw new Error('expected patch overlay')
    expect(cleared.coveredBy({} as OverlayRow)).toBe(true)
    expect(cleared.coveredBy({ color: undefined } as OverlayRow)).toBe(true)
    expect(cleared.coveredBy({ color: 'amber' } as unknown as OverlayRow)).toBe(false)
  })

  it('an EMPTY issueUpdate patch projects to null rather than parking a no-op overlay', () => {
    expect(overlayForOutboxEntry(entry('issueUpdate', { id: 'i1', patch: {} }))).toBeNull()
  })

  it('issueArchive is a one-way patch — the sidebar drops the row on `archived`', () => {
    const o = overlayForOutboxEntry(entry('issueArchive', { id: 'i1' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.patch).toEqual({ archived: true })
    expect(o.coveredBy({ archived: true } as OverlayRow)).toBe(true)
    expect(o.coveredBy({ archived: false } as OverlayRow)).toBe(false)
  })

  it('issueDelete stamps deletedAt from queuedAt; covering truth is judged on PRESENCE', () => {
    const o = overlayForOutboxEntry(entry('issueDelete', { id: 'i1' }, 1751500800000))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ deletedAt: new Date(1751500800000).toISOString() })
    // The server stamps its own tombstone clock, so any stamp covers…
    expect(o.coveredBy({ deletedAt: '2099-01-01T00:00:00.000Z' } as OverlayRow)).toBe(true)
    // …and a heal snapshot taken before the delete reached the server does not,
    // so the row cannot flicker back into the list mid-flight.
    expect(o.coveredBy({} as OverlayRow)).toBe(false)
  })

  it('issueClose settles the stage and stamps the reason, and is covered by the DERIVED closed fact', () => {
    const o = overlayForOutboxEntry(entry('issueClose', { id: 'i1', reason: 'wontfix' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.patch).toEqual({ stage: 'done', closedReason: 'wontfix' })
    // Covered on stage + a reason being PRESENT, not on the reason matching: the
    // server supplies its own default when the caller omits one.
    expect(o.coveredBy({ stage: 'done', closedReason: 'wontfix' } as OverlayRow)).toBe(true)
    expect(o.coveredBy({ stage: 'done', closedReason: 'done' } as OverlayRow)).toBe(true)
    // Half-landed truth is not coverage in either direction.
    expect(o.coveredBy({ stage: 'done' } as OverlayRow)).toBe(false)
    expect(o.coveredBy({ stage: 'review', closedReason: 'wontfix' } as OverlayRow)).toBe(false)
  })

  it('issueClose with no reason paints only what the caller said — the stage', () => {
    const o = overlayForOutboxEntry(entry('issueClose', { id: 'i1' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.patch).toEqual({ stage: 'done' })
  })

  it('issueDefer is an exact cell write, and clearing is covered by an absent field', () => {
    const until = overlayForOutboxEntry(entry('issueDefer', { id: 'i1', until: 'next-message' }))
    if (until?.op !== 'patch') throw new Error('expected patch overlay')
    expect(until.patch).toEqual({ deferUntil: 'next-message' })
    expect(until.coveredBy({ deferUntil: 'next-message' } as OverlayRow)).toBe(true)
    expect(until.coveredBy({ deferUntil: '2099-01-01' } as OverlayRow)).toBe(false)

    const cleared = overlayForOutboxEntry(entry('issueDefer', { id: 'i1', until: null }))
    if (cleared?.op !== 'patch') throw new Error('expected patch overlay')
    expect(cleared.coveredBy({} as OverlayRow)).toBe(true)
    expect(cleared.coveredBy({ deferUntil: '2099-01-01' } as OverlayRow)).toBe(false)
  })

  it('issueUndefer BACKDATES rather than clearing, and is covered by the row no longer being deferred', () => {
    const queuedAt = 1751500800000
    const o = overlayForOutboxEntry(entry('issueUndefer', { id: 'i1' }, queuedAt))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    // Not `null`: `deferUntil: null` is the QUIET clear that `defer(null)` is.
    // The unsnooze lands the row in returned-from-defer — top of WORK, wearing
    // the "Unsnoozed" tag — which is a past instant, not an absent one.
    const painted = (o.patch as { deferUntil: string }).deferUntil
    expect(Date.parse(painted)).toBeLessThan(queuedAt)
    // Coverage is the predicate, not the instant: the server backdates from its
    // OWN clock at apply time, so a queued undefer that drains late lands a
    // different timestamp than the one painted here.
    expect(o.coveredBy({ deferUntil: '2020-01-01T00:00:00.000Z' } as OverlayRow)).toBe(true)
    // A row with no defer at all covers it too: undefer on a non-deferred issue
    // is a server-side no-op, so there is nothing for truth to catch up to.
    expect(o.coveredBy({} as OverlayRow)).toBe(true)
    expect(o.coveredBy({ deferUntil: '2099-01-01T00:00:00.000Z' } as OverlayRow)).toBe(false)
    // The sentinel never lapses by time, so an un-drained `next-message` snooze
    // must not read as covered.
    expect(o.coveredBy({ deferUntil: 'next-message' } as OverlayRow)).toBe(false)
  })

  it('issueSetLabels paints the set the server will store, and is covered as a SET', () => {
    const o = overlayForOutboxEntry(
      entry('issueSetLabels', { id: 'i1', labels: ['ui', ' bug ', 'bug', ''] }),
    )
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    // Trimmed, de-duplicated, blank-free and sorted — what `setIssueLabels`
    // stores and what the read side returns, so the chip row does not repaint
    // when truth lands.
    expect(o.patch).toEqual({ labels: ['bug', 'ui'] })
    expect(o.coveredBy({ labels: ['bug', 'ui'] } as OverlayRow)).toBe(true)
    // Membership, not order: SQLite orders TEXT by byte and JS by UTF-16 code
    // unit, and a difference nobody can see must not hang the overlay to its TTL.
    expect(o.coveredBy({ labels: ['ui', 'bug'] } as OverlayRow)).toBe(true)
    expect(o.coveredBy({ labels: ['bug'] } as OverlayRow)).toBe(false)
    expect(o.coveredBy({ labels: ['bug', 'ui', 'perf'] } as OverlayRow)).toBe(false)
  })

  it('issueSetLabels clears to the empty set — covered by a row with no labels at all', () => {
    const o = overlayForOutboxEntry(entry('issueSetLabels', { id: 'i1', labels: [] }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.patch).toEqual({ labels: [] })
    expect(o.coveredBy({ labels: [] as string[] } as OverlayRow)).toBe(true)
    expect(o.coveredBy({} as OverlayRow)).toBe(true)
    expect(o.coveredBy({ labels: ['bug'] } as OverlayRow)).toBe(false)
  })

  it('issueSetPlacement paints the PARENT LINK — into a mission, and back out of one', () => {
    const intoMission = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'mission', originId: 'origin-1' }),
    )
    if (intoMission?.op !== 'patch') throw new Error('expected patch overlay')
    expect(intoMission.entity).toBe('issueProjections')
    expect(intoMission.id).toBe('i1')
    expect(intoMission.patch).toEqual({ parentId: 'origin-1' })
    expect(intoMission.coveredBy({ parentId: 'origin-1' } as OverlayRow)).toBe(true)
    expect(intoMission.coveredBy({ parentId: 'someone-else' } as OverlayRow)).toBe(false)
    expect(intoMission.coveredBy({} as OverlayRow)).toBe(false)

    const ownThing = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'own', originId: 'origin-1' }),
    )
    if (ownThing?.op !== 'patch') throw new Error('expected patch overlay')
    expect(ownThing.patch).toEqual({ parentId: null })
    // Top-level is spelled BOTH ways on the wire — `parentId` is optional — so
    // an absent field covers a cleared one, as it does for a cleared colour.
    expect(ownThing.coveredBy({} as OverlayRow)).toBe(true)
    expect(ownThing.coveredBy({ parentId: 'origin-1' } as OverlayRow)).toBe(false)
  })

  it('issueRestore clears the tombstone — the exact inverse of what issueDelete paints', () => {
    const del = overlayForOutboxEntry(entry('issueDelete', { id: 'i1' }, 1751500800000))
    const o = overlayForOutboxEntry(entry('issueRestore', { id: 'i1' }))
    if (del?.op !== 'patch' || o?.op !== 'patch') throw new Error('expected patch overlays')
    expect(o.entity).toBe('issueProjections')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ deletedAt: null })
    // They write the one cell, which is why they share a collapse key.
    expect(Object.keys(o.patch)).toEqual(Object.keys(del.patch))
    // Truth spells "not deleted" as an ABSENT field — `OverlayRow.deletedAt` is
    // optional, which is why the wire type refuses the null form below without a
    // cast, and why `sameCell` is what judges this rather than `===`.
    expect(o.coveredBy({ deletedAt: null } as unknown as OverlayRow)).toBe(true)
    expect(o.coveredBy({} as OverlayRow)).toBe(true)
    expect(o.coveredBy({ deletedAt: '2026-07-03T00:00:00.000Z' } as OverlayRow)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // POD-4969 — issue overlays of record land on the NORMALIZED rows, and the old
  // record gets a derived copy for the readers that have not moved yet.
  // ---------------------------------------------------------------------------

  it('routes an issueUpdate by home: durable fields to the projection, pinned to the per-user row', () => {
    const overlays = overlaysForOutboxEntry(
      entry('issueUpdate', {
        id: 'i1',
        patch: { title: 'Renamed', description: 'new prose', pinned: true },
      }),
    )
    expect(overlays.map((o) => o.entity)).toEqual(['issueProjections', 'issueUserStates'])
    const [issue, user, legacy] = overlays
    if (issue?.op !== 'patch' || user?.op !== 'patch' || legacy?.op !== 'patch') {
      throw new Error('expected patch overlays')
    }
    // One mutation: every part shares its key, so retirement can tell when the
    // whole entry is accounted for.
    expect(new Set(overlays.map((o) => o.key))).toEqual(new Set([issue.key]))
    // The description is a DOCUMENT on the normalized row — painted as one.
    expect(issue.patch).toEqual({ title: 'Renamed', description: { value: 'new prose' } })
    expect(user.patch).toEqual({ pinned: true })
    // Coverage reads the document's materialized value, not its bookkeeping.
    const echoed = {
      title: 'Renamed',
      description: { value: 'new prose', revision: 4 },
    } as unknown as IssueProjection
    expect(issue.coveredBy(echoed)).toBe(true)
    expect(
      issue.coveredBy({ ...echoed, description: { value: 'old prose' } } as IssueProjection),
    ).toBe(false)
    expect(user.coveredBy(userState({ pinned: true }))).toBe(true)
    expect(user.coveredBy(userState())).toBe(false)
  })

  it('every key `issues.update` accepts has exactly one home, so none paints where it can never be covered', () => {
    const keys = Object.keys(ISSUE_CONTRACTS.update.input.shape.patch.shape)
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      const { issue, user } = issueUpdateRoute({ [key]: 'x' })
      expect(
        [Object.keys(issue).length, Object.keys(user).length].sort(),
        `${key} must land on exactly one normalized row`,
      ).toEqual([0, 1])
    }
  })

  // POD-762: a wake is row-visible. The queue depth is the fact — the operator's
  // message is waiting on this session — and one field lights the wake up on
  // every surface at once.
  it('projects a queued message onto the woken session, until the server has its own opinion', () => {
    const wake = overlayForOutboxEntry(entry('resumeAndSend', { sessionId: 's1', text: 'x' }))
    if (wake?.op !== 'patch') throw new Error('expected patch overlay')
    expect(wake.entity).toBe('sessions')
    expect(wake.id).toBe('s1')
    expect(wake.patch).toEqual({ queuedMessageCount: 1 })

    // Still parked with nothing reported → the optimism stands.
    expect(wake.coveredBy({ status: 'hibernated' } as SessionMeta)).toBe(false)
    expect(wake.coveredBy({ status: 'exited' } as SessionMeta)).toBe(false)
    // The server reports a queue of its own → covered.
    expect(wake.coveredBy({ status: 'hibernated', queuedMessageCount: 1 } as SessionMeta)).toBe(
      true,
    )
    // It woke — covered even with an empty queue, because a drain that beat the
    // snapshot must not leave the row claiming a message is still waiting.
    expect(wake.coveredBy({ status: 'live' } as SessionMeta)).toBe(true)
    expect(wake.coveredBy({ status: 'starting' } as SessionMeta)).toBe(true)
  })
})

describe('foldOverlays', () => {
  const keyOf = (s: SessionMeta): string => s.sessionId

  it('returns the SAME base reference (and stable empty id set) when nothing applies', () => {
    const base = [sess()]
    const empty = foldOverlays(base, [], keyOf)
    expect(empty.rows).toBe(base)
    expect(empty.pendingInsertIds).toBe(EMPTY_ID_SET)
    // A patch whose target row isn't visible is a no-op, identity preserved.
    const miss = overlayForOutboxEntry(entry('rename', { sessionId: 'ghost', name: 'x' }))
    const folded = foldOverlays(base, [miss as PendingOverlay], keyOf)
    expect(folded.rows).toBe(base)
  })

  it('composes multiple patches on one row in queue order (later fields win)', () => {
    const base = [sess()]
    const first = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'first' }))
    const archived = overlayForOutboxEntry(entry('setArchived', { sessionId: 's1', archived: true }))
    const second = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'second' }))
    const { rows } = foldOverlays(base, [first, archived, second] as PendingOverlay[], keyOf)
    expect(rows[0]?.name).toBe('second')
    expect(rows[0]?.archived).toBe(true)
    expect(base[0]?.name).toBeUndefined() // base rows are never mutated
  })

  it('inserts placeholder rows only while the id is absent from base, and reports them as pending', () => {
    const placeholder = sess({
      sessionId: 'new-1',
      status: 'starting',
    } as Partial<SessionMetaInput>)
    const overlay = insertOverlay('sessions', 'new-1', placeholder)
    const empty = foldOverlays<SessionMeta>([], [overlay], keyOf)
    expect(empty.rows.map(keyOf)).toEqual(['new-1'])
    expect([...empty.pendingInsertIds]).toEqual(['new-1'])
    // Server truth (same id) landed: base wins, no duplicate, nothing pending.
    const confirmed = foldOverlays([sess({ sessionId: 'new-1' })], [overlay], keyOf)
    expect(confirmed.rows.map(keyOf)).toEqual(['new-1'])
    expect(confirmed.pendingInsertIds).toBe(EMPTY_ID_SET)
  })

  it('keeps ROW and ARRAY identity when a patch paints values already on the row', () => {
    // POD-1053. An overlay repaints on every recompute until covering truth is
    // judged to have landed, and `enqueueOverlayed` folds the same patch twice
    // by design. `store.issues` is the cache key for the shared view-model cache
    // and the published worklist, so a gratuitously fresh row re-derives the
    // whole worklist for a change nobody can see.
    const base = [
      sess({ name: 'already named' } as Partial<SessionMetaInput>),
      sess({ sessionId: 's2' }),
    ]
    const rename = overlayForOutboxEntry(
      entry('rename', { sessionId: 's1', name: 'already named' }),
    )
    const folded = foldOverlays(base, [rename as PendingOverlay], keyOf)
    expect(folded.rows).toBe(base)
    expect(folded.rows[0]).toBe(base[0])
  })

  it('clearing an absent snooze preserves identity, but a null snooze is a value', () => {
    const base = [sessionUserState()]
    expect(base[0] && 'snoozedUntil' in base[0]).toBe(false)
    const cleared = overlayForOutboxEntry(entry('snoozeClear', { sessionId: 's1' }))
    const key = (s: SessionUserStateWire): string => s.sessionId
    expect(foldOverlays(base, [cleared as PendingOverlay], key).rows).toBe(base)
    const untilMessage = [sessionUserState({ snoozedUntil: null })]
    const folded = foldOverlays(untilMessage, [cleared as PendingOverlay], key).rows
    expect(folded).not.toBe(untilMessage)
    expect(folded[0]?.snoozedUntil).toBeUndefined()
  })

  it('still mints a fresh row when the COMPOSED patches move a cell', () => {
    const base = [sess({ name: 'settled' } as Partial<SessionMetaInput>)]
    // The first patch alone would move the cell; the second puts it back. Only
    // the merged result knows the fold is a no-op.
    const away = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'away' }))
    const back = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'settled' }))
    expect(foldOverlays(base, [away, back] as PendingOverlay[], keyOf).rows).toBe(base)
    const moved = foldOverlays(base, [back, away] as PendingOverlay[], keyOf)
    expect(moved.rows).not.toBe(base)
    expect(moved.rows[0]?.name).toBe('away')
  })

  it('patches apply on top of inserted placeholder rows too', () => {
    const placeholder = sess({ sessionId: 'new-1' })
    const rename = overlayForOutboxEntry(entry('rename', { sessionId: 'new-1', name: 'named' }))
    const { rows } = foldOverlays<SessionMeta>(
      [],
      [insertOverlay('sessions', 'new-1', placeholder), rename as PendingOverlay],
      keyOf,
    )
    expect(rows[0]?.name).toBe('named')
  })
})

describe('foldRowOverlays (POD-4553: the per-row fold agrees with foldOverlays)', () => {
  const keyOf = (s: SessionMeta): string => s.sessionId
  const rename = (id: string, name: string) =>
    overlayForOutboxEntry(entry('rename', { sessionId: id, name })) as PendingOverlay
  const archived = (id: string) =>
    overlayForOutboxEntry(entry('setArchived', { sessionId: id, archived: true })) as PendingOverlay
  const cases: { name: string; base: SessionMeta[]; overlays: PendingOverlay[] }[] = [
    { name: 'no overlays', base: [sess()], overlays: [] },
    { name: 'patch on a missing row', base: [sess()], overlays: [rename('ghost', 'x')] },
    {
      name: 'composed patches',
      base: [sess()],
      overlays: [rename('s1', 'a'), archived('s1'), rename('s1', 'b')],
    },
    {
      name: 'no-op paint',
      base: [sess({ name: 'n' } as Partial<SessionMetaInput>), sess({ sessionId: 's2' })],
      overlays: [rename('s1', 'n')],
    },
    {
      name: 'composition back to base',
      base: [sess({ name: 'settled' } as Partial<SessionMetaInput>)],
      overlays: [rename('s1', 'away'), rename('s1', 'settled')],
    },
    {
      name: 'insert absent',
      base: [],
      overlays: [insertOverlay('sessions', 'new-1', sess({ sessionId: 'new-1' }))],
    },
    {
      name: 'insert covered by base',
      base: [sess({ sessionId: 'new-1' })],
      overlays: [
        insertOverlay('sessions', 'new-1', sess({ sessionId: 'new-1', title: 'placeholder' })),
      ],
    },
    {
      name: 'patch over an insert',
      base: [],
      overlays: [
        insertOverlay('sessions', 'new-1', sess({ sessionId: 'new-1' })),
        rename('new-1', 'named'),
      ],
    },
  ]
  for (const { name, base, overlays } of cases) {
    it(`agrees row by row: ${name}`, () => {
      const whole = foldOverlays(base, overlays, keyOf).rows
      const ids = new Set([...base.map(keyOf), ...overlays.map((o) => o.id)])
      for (const id of ids) {
        const expected = whole.find((row) => keyOf(row) === id)
        const baseRow = base.find((row) => keyOf(row) === id)
        const actual = foldRowOverlays(
          baseRow,
          overlays.filter((o) => o.id === id),
        )
        expect(actual).toEqual(expected)
        // Identity: an unmoved row is the base object in both folds.
        if (expected === baseRow) expect(actual).toBe(baseRow)
        else expect(actual).not.toBe(baseRow)
      }
    })
  }
})

// POD-4969: the per-user row is DELETED when its markers all clear, so the
// ledger hands a per-user patch the row its absence stands for. Both folds must
// paint over it, and both must leave a patch that paints only "nothing set" off
// the list.
describe('folding over an absent per-user row', () => {
  const key = (row: IssueUserStateWire): string => row.entityId
  const onAbsent = (kind: string, input: unknown): PendingOverlay => {
    const o = overlayForOutboxEntry(entry(kind, input))
    if (o?.op !== 'patch') throw new Error('expected patch')
    return { ...o, absent: userState() }
  }

  it('paints a mark-read onto the "nothing set" row, in both folds', () => {
    const read = onAbsent('issueMarkRead', { id: 'i1' })
    const whole = foldOverlays<IssueUserStateWire>([], [read], key).rows
    expect(whole).toEqual([userState({ readAt: new Date(1751500800000).toISOString() })])
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [read])).toEqual(whole[0])
  })

  it('adds nothing for a patch that leaves the row saying "nothing set"', () => {
    const base: IssueUserStateWire[] = []
    const unread = onAbsent('issueMarkUnread', { id: 'i1' })
    expect(foldOverlays(base, [unread], key).rows).toBe(base)
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [unread])).toBeUndefined()
  })

  it('a present row wins over the absent one, and a patch without one paints nothing', () => {
    const present = userState({ tuckedAt: 'T' })
    const read = onAbsent('issueMarkRead', { id: 'i1' })
    expect(foldOverlays([present], [read], key).rows[0]).toMatchObject({ tuckedAt: 'T' })
    const bare = overlayForOutboxEntry(entry('issueMarkRead', { id: 'i1' })) as PendingOverlay
    expect(foldOverlays<IssueUserStateWire>([], [bare], key).rows).toEqual([])
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [bare])).toBeUndefined()
  })
})

describe('rowFingerprint', () => {
  it('ignores TanStack $-metadata and key order — only DATA changes read as movement', () => {
    const stored = {
      sessionId: 's1',
      name: 'x',
      $synced: false,
      $origin: 'local',
      $collectionId: 'podium.replica.sessions#1',
    }
    const reloaded = {
      name: 'x',
      sessionId: 's1',
      $synced: true,
      $origin: 'remote',
      $collectionId: 'podium.replica.sessions#2',
    }
    expect(rowFingerprint(stored)).toBe(rowFingerprint(reloaded))
    expect(rowFingerprint(stored)).not.toBe(rowFingerprint({ sessionId: 's1', name: 'y' }))
    // A field assigned undefined equals one that is absent (the replica writes
    // cleared optionals as undefined — #170).
    expect(rowFingerprint({ sessionId: 's1', workState: undefined })).toBe(
      rowFingerprint({ sessionId: 's1' }),
    )
  })
})

describe('pruneAwaiting (retirement rule (a))', () => {
  const keyOf = (s: SessionMeta): string => s.sessionId
  const NOW = 1751500900000
  /** An awaiting rename with its ENQUEUE-time baseline taken from `row`. */
  const awaitRename = (
    row: SessionMeta | undefined,
    name = 'mine',
    mutationId = asMutationId(`m-`),
    resolvedAt = NOW,
  ): AwaitingTruth => {
    const o = overlayForOutboxEntry({
      ...entry('rename', { sessionId: 's1', name }),
      mutationId,
    })
    if (o?.op !== 'patch') throw new Error('expected patch')
    return { overlay: o, baseline: row === undefined ? undefined : rowFingerprint(row), resolvedAt }
  }

  it('keeps the entry while the row is byte-identical to the enqueue baseline', () => {
    const row = sess()
    const awaiting = [awaitRename(row)]
    expect(pruneAwaiting(awaiting, 'sessions', [row], keyOf, NOW)).toBe(awaiting) // same ref: nothing retired
  })

  it('retires when truth covers the mutation', () => {
    const awaiting = [awaitRename(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [sess({ name: 'mine' })], keyOf, NOW)).toEqual([])
  })

  it('retires when the row moved past the baseline WITHOUT covering (competing write wins)', () => {
    const awaiting = [awaitRename(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [sess({ name: 'theirs' })], keyOf, NOW)).toEqual([])
  })

  it('keeps a sortKey overlay when an unrelated issue cell changes (load-time snap-back)', () => {
    // The drop painted { sortKey: 'a1' }. Before that echo lands, a git-state
    // probe / description edit / revision bump republishes the same issue
    // with the OLD sortKey. Whole-row fingerprint divergence used to retire
    // the overlay and snap the row back; only a competing write on sortKey
    // itself (or coverage, or the TTL) may.
    const base = { id: 'i1', sortKey: 'c', title: 'Task', revision: 1 } as IssueProjection
    const o = overlayForOutboxEntry(entry('issueUpdate', { id: 'i1', patch: { sortKey: 'a1' } }))
    if (o?.op !== 'patch') throw new Error('expected patch')
    const awaiting: AwaitingTruth[] = [
      { overlay: o, baseline: rowFingerprint(base), resolvedAt: NOW },
    ]
    const issueKey = (i: IssueProjection): string => i.id
    const noisy = { ...base, title: 'Changed', revision: 4 } as IssueProjection
    expect(pruneAwaiting(awaiting, 'issueProjections', [noisy], issueKey, NOW)).toBe(awaiting)
    // A competing reorder of the SAME cell does retire.
    expect(
      pruneAwaiting(
        awaiting,
        'issueProjections',
        [{ ...base, sortKey: 'z9' } as IssueProjection],
        issueKey,
        NOW,
      ),
    ).toEqual([])
  })

  // POD-4969. The server DELETES a per-user row whose three markers all clear,
  // so for that entity absence is a value, and only the ledger knows whether it
  // means "nothing set" (the issue is in the slice) or "gone" (it left).
  it('judges an absent per-user row as the "nothing set" row it stands for, while the issue is in the slice', () => {
    const unread = overlayForOutboxEntry(entry('issueMarkUnread', { id: 'i1' }))
    if (unread?.op !== 'patch') throw new Error('expected patch')
    const awaiting: AwaitingTruth[] = [{ overlay: unread, baseline: undefined, resolvedAt: NOW }]
    const key = (row: IssueUserStateWire): string => row.entityId
    // In the slice: the deleted row is the covering truth of a mark-unread.
    expect(
      pruneAwaiting(awaiting, 'issueUserStates', [], key, NOW, undefined, () => userState()),
    ).toEqual([])
    const read = overlayForOutboxEntry(entry('issueMarkRead', { id: 'i1' }))
    if (read?.op !== 'patch') throw new Error('expected patch')
    const reading: AwaitingTruth[] = [{ overlay: read, baseline: undefined, resolvedAt: NOW }]
    // …and is NOT the covering truth of a mark-read, which keeps painting.
    expect(
      pruneAwaiting(reading, 'issueUserStates', [], key, NOW, undefined, () => userState()),
    ).toBe(reading)
    // Out of the slice: absence is real, and the overlay retires like any other.
    expect(
      pruneAwaiting(reading, 'issueUserStates', [], key, NOW, undefined, () => undefined),
    ).toEqual([])
  })

  it('an unrelated session cell change does not retire a rename overlay', () => {
    const row = sess()
    const awaiting = [awaitRename(row)]
    expect(
      pruneAwaiting(
        awaiting,
        'sessions',
        [sess({ lastActiveAt: '2099-01-01T00:00:00.000Z' })],
        keyOf,
        NOW,
      ),
    ).toBe(awaiting)
  })

  // REWRITTEN by POD-380 (was: "retires when the row is gone"). That name was a
  // true statement about the old behaviour and a false one about the rule the
  // function now implements, so it is replaced rather than joined by a second test
  // — a name is a claim, and adding coverage does not retract one.
  it('a REPORTED REMOVAL retires the overlay; ignores other entities', () => {
    const awaiting = [awaitRename(sess())]
    const removed = new Set([sess().sessionId])
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW, removed)).toEqual([])
    expect(pruneAwaiting(awaiting, 'issueProjections', [], (i: IssueProjection) => i.id, NOW, removed)).toBe(
      awaiting,
    )
  })

  it('an absent row retires the overlay so rescope or evict cannot fabricate visibility', () => {
    const awaiting = [awaitRename(sess())]

    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW)).toEqual([])
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW, new Set(['someone-else']))).toEqual(
      [],
    )
  })

  it('only the OLDEST awaiting entry per row may use the moved-past escape (#263 finding 3)', () => {
    // Two rapid renames enqueued back-to-back share the same baseline (the
    // replica stayed unpainted between them).
    const base = sess()
    const first = awaitRename(base, 'first', asMutationId('m-1'))
    const second = awaitRename(base, 'second', asMutationId('m-2'))
    // The FIRST echo lands: it covers only the first mutation, yet it moves the
    // row past BOTH baselines. The younger entry must survive — retiring it
    // would flash 'first' until its own echo arrives.
    const afterFirstEcho = pruneAwaiting(
      [first, second],
      'sessions',
      [sess({ name: 'first' })],
      keyOf,
      NOW,
    )
    expect(afterFirstEcho).toEqual([second])
    // The second echo covers it — retired normally.
    expect(
      pruneAwaiting(afterFirstEcho, 'sessions', [sess({ name: 'second' })], keyOf, NOW),
    ).toEqual([])
    // Had a COMPETING write landed instead, the survivor is now the oldest and
    // becomes escape-eligible on this later pass — server truth wins.
    expect(
      pruneAwaiting(afterFirstEcho, 'sessions', [sess({ name: 'theirs' })], keyOf, NOW),
    ).toEqual([])
  })

  it("archive's paired setArchived/setWorkState: the first echo retires only the first entry", () => {
    const base = sess()
    const arch = overlayForOutboxEntry(entry('setArchived', { sessionId: 's1', archived: true }))
    const ws = overlayForOutboxEntry({
      ...entry('setWorkState', { sessionId: 's1', workState: 'done' }),
      mutationId: asMutationId('m-ws'),
    })
    if (arch?.op !== 'patch' || ws?.op !== 'patch') throw new Error('expected patches')
    const awaiting: AwaitingTruth[] = [
      { overlay: arch, baseline: rowFingerprint(base), resolvedAt: NOW },
      { overlay: ws, baseline: rowFingerprint(base), resolvedAt: NOW },
    ]
    // Echo for setArchived only — workState not yet applied server-side.
    const echo1 = sess({ archived: true })
    const kept = pruneAwaiting(awaiting, 'sessions', [echo1], keyOf, NOW)
    expect(kept.map((a) => a.overlay.key)).toEqual(['m-ws']) // 'done' keeps painting
    // Echo carrying the work state retires the rest.
    const echo2 = sess({ archived: true, workState: 'done' } as Partial<SessionMetaInput>)
    expect(pruneAwaiting(kept, 'sessions', [echo2], keyOf, NOW)).toEqual([])
  })

  it('an entry with no baseline (row absent at enqueue) never uses the escape', () => {
    const awaiting = [awaitRename(undefined)]
    // The row appeared and even changed — without a baseline the escape cannot
    // judge movement; the entry holds until coveredBy / row-gone / TTL.
    expect(pruneAwaiting(awaiting, 'sessions', [sess({ name: 'theirs' })], keyOf, NOW)).toBe(
      awaiting,
    )
  })

  it('the TTL backstop retires a stuck entry (with a debug note), bounding the mask', () => {
    // The note travels as a record now. Capture with a REAL sink and no
    // `minLevel`, so it follows the namespace level exactly as production sinks
    // do — which means the level has to be raised to `debug` first, the same
    // act an operator performs to diagnose. A capture pinned at `trace` would
    // see records a real deployment never emits.
    const captured: { level: string; msg?: unknown }[] = []
    setLogLevel('debug')
    const restore = addSink({ name: 'overlay-test-capture', write: (r) => captured.push(r) })
    try {
      const row = sess()
      const awaiting = [awaitRename(row, 'mine', asMutationId('m-stuck'), NOW)]
      // Within the TTL: held (row still byte-identical to the baseline).
      expect(
        pruneAwaiting(awaiting, 'sessions', [row], keyOf, NOW + AWAITING_TRUTH_TTL_MS - 1),
      ).toBe(awaiting)
      // Past the TTL: retired even though truth never covered it.
      expect(
        pruneAwaiting(awaiting, 'sessions', [row], keyOf, NOW + AWAITING_TRUTH_TTL_MS + 1),
      ).toEqual([])
      expect(captured.some((r) => String(r.msg).includes('outlived its TTL'))).toBe(true)
    } finally {
      restore()
      resetLevels()
    }
  })
})

// ---------------------------------------------------------------------------
// POD-380 — every offline-eligible presence contract has an optimistic reducer
// ---------------------------------------------------------------------------

describe('the presence contracts and their optimistic reducers', () => {
  it('every OFFLINE-ELIGIBLE presence contract maps to an outbox kind that reduces', () => {
    const eligible = sessionStateCommandNames().filter(
      (name) => sessionStateCommand(name)?.offline === 'eligible',
    )
    // Totality: a new offline-eligible contract with no reducer would queue a write
    // that paints nothing, which reads to the user as the click not registering.
    const reduced = [
      ...Object.keys(PRESENCE_REDUCER_KINDS),
      ...ACTION_STATE_REDUCER_COMMANDS.filter((name) => sessionStateCommand(name) !== undefined),
    ]
    expect(reduced.sort()).toEqual(eligible.sort())
  })

  it('each mapped kind really produces an overlay — the map is not just names', () => {
    // Guards the guard above: a map whose kinds had no reducer case would satisfy
    // the totality test and still paint nothing.
    const inputs: Record<string, object> = {
      rename: { sessionId: 's1', name: 'n' },
      setArchived: { sessionId: 's1', archived: true },
      setWorkState: { sessionId: 's1', workState: 'done' },
      sessionMarkRead: { sessionId: 's1' },
      sessionMarkUnread: { sessionId: 's1' },
      dismissOffer: { sessionId: 's1', offerCreatedAt: 'T1' },
      snoozeSet: { sessionId: 's1', until: null },
      snoozeClear: { sessionId: 's1' },
    }
    const perUser = new Set(['sessionMarkRead', 'sessionMarkUnread', 'snoozeSet', 'snoozeClear'])
    for (const name of Object.keys(PRESENCE_REDUCER_KINDS)) {
      const kind = PRESENCE_REDUCER_KINDS[name] as string
      const overlay = overlayForOutboxEntry(entry(kind as never, inputs[kind] as never))
      expect(overlay, `${name} -> ${kind}`).not.toBeNull()
      expect(overlay?.entity, name).toBe(perUser.has(kind) ? 'sessionUserStates' : 'sessions')
    }
  })

  it('routes per-user rows to action-state reducers and keeps direct-only commands absent', () => {
    expect(ACTION_STATE_REDUCER_COMMANDS).toEqual(
      expect.arrayContaining(['pins.set', 'tabs.setOrder']),
    )
    for (const name of ['sessions.setIssueId', 'sessions.setDraft']) {
      expect(sessionStateCommand(name)?.offline).not.toBe('eligible')
      expect(Object.hasOwn(PRESENCE_REDUCER_KINDS, name), name).toBe(false)
    }
  })
})
