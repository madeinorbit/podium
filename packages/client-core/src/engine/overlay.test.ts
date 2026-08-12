/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, folding composes in queue order with stable identities,
 * and pruneAwaiting implements retirement rule (a) (see overlay.ts header).
 */

import { sessionStateCommand, sessionStateCommandNames } from '@podium/commands'
import { addSink, resetLevels, setLogLevel } from '@podium/logger'
import {
  asMutationId,
  type IssueWire,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'

import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { ACTION_STATE_REDUCER_COMMANDS } from './actions'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  insertOverlay,
  legacyIssueReadOverlay,
  overlayForOutboxEntry,
  type PendingOverlay,
  PRESENCE_REDUCER_KINDS,
  projectionCurationOverlay,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'

const entry = (kind: string, input: unknown, queuedAt = 1751500800000): OutboxEntry => ({
  mutationId: asMutationId(`m-`),
  kind,
  input,
  queuedAt,
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

  it('archive / work-state / snooze project their exact old optimistic patches', () => {
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
    expect(snooze.patch).toEqual({ snoozedUntil: '2026-07-10T00:00:00.000Z' })
    expect(snooze.coveredBy(sess({ snoozedUntil: '2026-07-10T00:00:00.000Z' }))).toBe(true)

    const clear = overlayForOutboxEntry(entry('snoozeClear', { sessionId: 's1' }))
    if (clear?.op !== 'patch') throw new Error('expected patch')
    expect(clear.patch).toEqual({ snoozedUntil: undefined })
    expect(clear.coveredBy(sess())).toBe(true)
    expect(clear.coveredBy(sess({ snoozedUntil: 'x' }))).toBe(false)
  })

  it('mark read/unread target the owning readAt field; server clocks may differ', () => {
    const read = overlayForOutboxEntry(entry('sessionMarkRead', { sessionId: 's1' }, 1751500800000))
    if (read?.op !== 'patch') throw new Error('expected patch')
    expect(read.patch).toEqual({ readAt: new Date(1751500800000).toISOString(), unread: false })
    // The server stamps its OWN clock — a different readAt still covers.
    expect(read.coveredBy(sess({ unread: false, readAt: '2099-01-01T00:00:00.000Z' }))).toBe(true)
    expect(read.coveredBy(sess({ unread: true }))).toBe(false)

    const issueRead = overlayForOutboxEntry(entry('issueMarkRead', { id: 'i1' }, 1751500800000))
    if (issueRead?.op !== 'patch') throw new Error('expected patch')
    expect(issueRead.entity).toBe('issueProjections')
    expect(issueRead.patch).toEqual({ readAt: new Date(1751500800000).toISOString() })
    expect(issueRead.coveredBy({ readAt: '2099-01-01T00:00:00.000Z' } as never)).toBe(true)
    const legacyRead = legacyIssueReadOverlay(issueRead)
    if (legacyRead?.op !== 'patch') throw new Error('expected legacy compatibility patch')
    expect(legacyRead.patch).toEqual({
      readAt: new Date(1751500800000).toISOString(),
      unread: false,
    })

    const unread = overlayForOutboxEntry(entry('issueMarkUnread', { id: 'i1' }))
    if (unread?.op !== 'patch') throw new Error('expected patch')
    expect(unread.entity).toBe('issueProjections')
    expect(unread.patch).toEqual({ readAt: null })
    expect(unread.coveredBy({ readAt: null } as never)).toBe(true)
    const legacyUnread = legacyIssueReadOverlay(unread)
    if (legacyUnread?.op !== 'patch') throw new Error('expected legacy compatibility patch')
    expect(legacyUnread.patch).toEqual({ readAt: null, unread: true })
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
    expect(tuck.entity).toBe('issues')
    expect(tuck.id).toBe('i1')
    expect(tuck.patch).toEqual({ tuckedAt: new Date(1751500800000).toISOString() })
    // The server stamps its own clock, so ANY stamp covers…
    expect(tuck.coveredBy({ tuckedAt: '2099-01-01T00:00:00.000Z' } as IssueWire)).toBe(true)
    // …but pre-mutation truth (a heal snapshot mid-flight) does NOT: the row
    // stays folded instead of flickering back into the live list.
    expect(tuck.coveredBy({ tuckedAt: null } as IssueWire)).toBe(false)
    expect(tuck.coveredBy({} as IssueWire)).toBe(false)

    const untuck = overlayForOutboxEntry(entry('issueSetTucked', { id: 'i1', tucked: false }))
    if (untuck?.op !== 'patch') throw new Error('expected patch overlay')
    expect(untuck.patch).toEqual({ tuckedAt: null })
    expect(untuck.coveredBy({ tuckedAt: null } as IssueWire)).toBe(true)
    expect(untuck.coveredBy({ tuckedAt: '2026-07-03T00:00:00.000Z' } as IssueWire)).toBe(false)
  })

  it('an unknown kind projects to null', () => {
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
    expect(o.entity).toBe('issues')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ title: 'Renamed', priority: 2 })
    expect(o.coveredBy({ title: 'Renamed', priority: 2 } as IssueWire)).toBe(true)
    // HALF-landed truth is not coverage: a row carrying the rename but not the
    // priority must keep painting, or the second field flashes back.
    expect(o.coveredBy({ title: 'Renamed', priority: 0 } as IssueWire)).toBe(false)
    expect(o.coveredBy({ title: 'Old', priority: 2 } as IssueWire)).toBe(false)
    // A competing writer moving some OTHER field neither covers nor un-covers —
    // that judgement belongs to pruneAwaiting's moved-past-baseline escape.
    expect(o.coveredBy({ title: 'Renamed', priority: 2, stage: 'done' } as IssueWire)).toBe(true)
  })

  it('issueUpdate treats a cleared field as covered by an ABSENT one — null and undefined are one value', () => {
    // `issues.update` clears a colour with `color: null`; `IssueWire.color` is
    // optional and simply absent once cleared. A strict `===` would leave every
    // clear painted until its TTL.
    const cleared = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { color: null } }),
    )
    if (cleared?.op !== 'patch') throw new Error('expected patch overlay')
    expect(cleared.coveredBy({} as IssueWire)).toBe(true)
    expect(cleared.coveredBy({ color: undefined } as IssueWire)).toBe(true)
    expect(cleared.coveredBy({ color: 'amber' } as unknown as IssueWire)).toBe(false)
  })

  it('an EMPTY issueUpdate patch projects to null rather than parking a no-op overlay', () => {
    expect(overlayForOutboxEntry(entry('issueUpdate', { id: 'i1', patch: {} }))).toBeNull()
  })

  it('issueArchive is a one-way patch — the sidebar drops the row on `archived`', () => {
    const o = overlayForOutboxEntry(entry('issueArchive', { id: 'i1' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issues')
    expect(o.patch).toEqual({ archived: true })
    expect(o.coveredBy({ archived: true } as IssueWire)).toBe(true)
    expect(o.coveredBy({ archived: false } as IssueWire)).toBe(false)
  })

  it('issueDelete stamps deletedAt from queuedAt; covering truth is judged on PRESENCE', () => {
    const o = overlayForOutboxEntry(entry('issueDelete', { id: 'i1' }, 1751500800000))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issues')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ deletedAt: new Date(1751500800000).toISOString() })
    // The server stamps its own tombstone clock, so any stamp covers…
    expect(o.coveredBy({ deletedAt: '2099-01-01T00:00:00.000Z' } as IssueWire)).toBe(true)
    // …and a heal snapshot taken before the delete reached the server does not,
    // so the row cannot flicker back into the list mid-flight.
    expect(o.coveredBy({} as IssueWire)).toBe(false)
  })

  it('issueClose settles the stage and stamps the reason, and is covered by the DERIVED closed fact', () => {
    const o = overlayForOutboxEntry(entry('issueClose', { id: 'i1', reason: 'wontfix' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issues')
    expect(o.patch).toEqual({ stage: 'done', closedReason: 'wontfix' })
    // Covered on stage + a reason being PRESENT, not on the reason matching: the
    // server supplies its own default when the caller omits one.
    expect(o.coveredBy({ stage: 'done', closedReason: 'wontfix' } as IssueWire)).toBe(true)
    expect(o.coveredBy({ stage: 'done', closedReason: 'done' } as IssueWire)).toBe(true)
    // Half-landed truth is not coverage in either direction.
    expect(o.coveredBy({ stage: 'done' } as IssueWire)).toBe(false)
    expect(o.coveredBy({ stage: 'review', closedReason: 'wontfix' } as IssueWire)).toBe(false)
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
    expect(until.coveredBy({ deferUntil: 'next-message' } as IssueWire)).toBe(true)
    expect(until.coveredBy({ deferUntil: '2099-01-01' } as IssueWire)).toBe(false)

    const cleared = overlayForOutboxEntry(entry('issueDefer', { id: 'i1', until: null }))
    if (cleared?.op !== 'patch') throw new Error('expected patch overlay')
    expect(cleared.coveredBy({} as IssueWire)).toBe(true)
    expect(cleared.coveredBy({ deferUntil: '2099-01-01' } as IssueWire)).toBe(false)
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
    expect(o.coveredBy({ deferUntil: '2020-01-01T00:00:00.000Z' } as IssueWire)).toBe(true)
    // A row with no defer at all covers it too: undefer on a non-deferred issue
    // is a server-side no-op, so there is nothing for truth to catch up to.
    expect(o.coveredBy({} as IssueWire)).toBe(true)
    expect(o.coveredBy({ deferUntil: '2099-01-01T00:00:00.000Z' } as IssueWire)).toBe(false)
    // The sentinel never lapses by time, so an un-drained `next-message` snooze
    // must not read as covered.
    expect(o.coveredBy({ deferUntil: 'next-message' } as IssueWire)).toBe(false)
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
    expect(o.coveredBy({ labels: ['bug', 'ui'] } as IssueWire)).toBe(true)
    // Membership, not order: SQLite orders TEXT by byte and JS by UTF-16 code
    // unit, and a difference nobody can see must not hang the overlay to its TTL.
    expect(o.coveredBy({ labels: ['ui', 'bug'] } as IssueWire)).toBe(true)
    expect(o.coveredBy({ labels: ['bug'] } as IssueWire)).toBe(false)
    expect(o.coveredBy({ labels: ['bug', 'ui', 'perf'] } as IssueWire)).toBe(false)
  })

  it('issueSetLabels clears to the empty set — covered by a row with no labels at all', () => {
    const o = overlayForOutboxEntry(entry('issueSetLabels', { id: 'i1', labels: [] }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.patch).toEqual({ labels: [] })
    expect(o.coveredBy({ labels: [] as string[] } as IssueWire)).toBe(true)
    expect(o.coveredBy({} as IssueWire)).toBe(true)
    expect(o.coveredBy({ labels: ['bug'] } as IssueWire)).toBe(false)
  })

  it('issueSetPlacement paints the PARENT LINK — into a mission, and back out of one', () => {
    const intoMission = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'mission', originId: 'origin-1' }),
    )
    if (intoMission?.op !== 'patch') throw new Error('expected patch overlay')
    expect(intoMission.entity).toBe('issues')
    expect(intoMission.id).toBe('i1')
    expect(intoMission.patch).toEqual({ parentId: 'origin-1' })
    expect(intoMission.coveredBy({ parentId: 'origin-1' } as IssueWire)).toBe(true)
    expect(intoMission.coveredBy({ parentId: 'someone-else' } as IssueWire)).toBe(false)
    expect(intoMission.coveredBy({} as IssueWire)).toBe(false)

    const ownThing = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'own', originId: 'origin-1' }),
    )
    if (ownThing?.op !== 'patch') throw new Error('expected patch overlay')
    expect(ownThing.patch).toEqual({ parentId: null })
    // Top-level is spelled BOTH ways on the wire — `parentId` is optional — so
    // an absent field covers a cleared one, as it does for a cleared colour.
    expect(ownThing.coveredBy({} as IssueWire)).toBe(true)
    expect(ownThing.coveredBy({ parentId: 'origin-1' } as IssueWire)).toBe(false)
  })

  it('issueRestore clears the tombstone — the exact inverse of what issueDelete paints', () => {
    const del = overlayForOutboxEntry(entry('issueDelete', { id: 'i1' }, 1751500800000))
    const o = overlayForOutboxEntry(entry('issueRestore', { id: 'i1' }))
    if (del?.op !== 'patch' || o?.op !== 'patch') throw new Error('expected patch overlays')
    expect(o.entity).toBe('issues')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ deletedAt: null })
    // They write the one cell, which is why they share a collapse key.
    expect(Object.keys(o.patch)).toEqual(Object.keys(del.patch))
    // Truth spells "not deleted" as an ABSENT field — `IssueWire.deletedAt` is
    // optional, which is why the wire type refuses the null form below without a
    // cast, and why `sameCell` is what judges this rather than `===`.
    expect(o.coveredBy({ deletedAt: null } as unknown as IssueWire)).toBe(true)
    expect(o.coveredBy({} as IssueWire)).toBe(true)
    expect(o.coveredBy({ deletedAt: '2026-07-03T00:00:00.000Z' } as IssueWire)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // POD-781 — the curation mirror onto the normalized projection, which is what
  // the issue BOARD and the issue page read (the sidebar reads the legacy wire).
  // ---------------------------------------------------------------------------

  it('mirrors a curation patch onto the projection, or the board keeps painting the old value', () => {
    const source = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { title: 'Renamed', stage: 'review' } }),
    )
    if (source?.op !== 'patch') throw new Error('expected patch overlay')
    const mirror = projectionCurationOverlay(source)
    if (mirror?.op !== 'patch') throw new Error('expected a mirrored overlay')
    expect(mirror.entity).toBe('issueProjections')
    expect(mirror.id).toBe('i1')
    // `IssueProjection` carries the whole durable row, so it OVERRIDES the
    // overlaid wire in `useIssueViewModels`' merge. Both keys must travel.
    expect(mirror.patch).toEqual({ title: 'Renamed', stage: 'review' })
  })

  it('mirrors close, defer and labels too — the whole family, not just the patch kind', () => {
    const mirrored = (kind: string, input: unknown) => {
      const source = overlayForOutboxEntry(entry(kind, input))
      if (source?.op !== 'patch') throw new Error(`expected a patch overlay for ${kind}`)
      const mirror = projectionCurationOverlay(source)
      if (mirror?.op !== 'patch') throw new Error(`expected a mirror for ${kind}`)
      return mirror.patch
    }
    expect(mirrored('issueClose', { id: 'i1', reason: 'done' })).toEqual({
      stage: 'done',
      closedReason: 'done',
    })
    expect(mirrored('issueDefer', { id: 'i1', until: '2099-01-01' })).toEqual({
      deferUntil: '2099-01-01',
    })
    expect(mirrored('issueSetLabels', { id: 'i1', labels: ['bug'] })).toEqual({ labels: ['bug'] })
    expect(mirrored('issueArchive', { id: 'i1' })).toEqual({ archived: true })
    expect(mirrored('issueDelete', { id: 'i1' })).toEqual({
      deletedAt: new Date(1751500800000).toISOString(),
    })
  })

  it('mirrors NOTHING for a patch the projection has no home for', () => {
    // `pinned` and `tuckedAt` are per-user state and are not projection fields —
    // the board reads them off the overlaid wire, where they already paint.
    const pinned = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { pinned: true } }),
    )
    if (pinned?.op !== 'patch') throw new Error('expected patch overlay')
    expect(projectionCurationOverlay(pinned)).toBeNull()

    const tucked = overlayForOutboxEntry(entry('issueSetTucked', { id: 'i1', tucked: true }))
    if (tucked?.op !== 'patch') throw new Error('expected patch overlay')
    expect(projectionCurationOverlay(tucked)).toBeNull()

    // The op-stream DOCUMENTS are excluded by name: `description` is `{ value }`
    // on the projection and a plain string in the patch, so copying it across
    // would put a string where a document lives.
    const described = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { description: 'new prose' } }),
    )
    if (described?.op !== 'patch') throw new Error('expected patch overlay')
    expect(projectionCurationOverlay(described)).toBeNull()

    // A MIXED patch mirrors the half that has a home rather than nothing.
    const mixed = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { description: 'new prose', priority: 1 } }),
    )
    if (mixed?.op !== 'patch') throw new Error('expected patch overlay')
    const mirror = projectionCurationOverlay(mixed)
    if (mirror?.op !== 'patch') throw new Error('expected a mirrored overlay')
    expect(mirror.patch).toEqual({ priority: 1 })
  })

  it('never mirrors in the other direction — a projection overlay is not re-mirrored back', () => {
    // `legacyIssueReadOverlay` owns projection→wire. If this returned something
    // the two would feed each other on every fold.
    const read = overlayForOutboxEntry(entry('issueMarkRead', { id: 'i1' }))
    if (read?.op !== 'patch') throw new Error('expected patch overlay')
    expect(read.entity).toBe('issueProjections')
    expect(projectionCurationOverlay(read)).toBeNull()
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
    const unread = overlayForOutboxEntry(entry('sessionMarkUnread', { sessionId: 's1' }))
    const second = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'second' }))
    const { rows } = foldOverlays(base, [first, unread, second] as PendingOverlay[], keyOf)
    expect(rows[0]?.name).toBe('second')
    expect(rows[0]?.unread).toBe(true)
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

  // REWRITTEN by POD-380 (was: "retires when the row is gone"). That name was a
  // true statement about the old behaviour and a false one about the rule the
  // function now implements, so it is replaced rather than joined by a second test
  // — a name is a claim, and adding coverage does not retract one.
  it('a REPORTED REMOVAL retires the overlay; ignores other entities', () => {
    const awaiting = [awaitRename(sess())]
    const removed = new Set([sess().sessionId])
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW, removed)).toEqual([])
    expect(pruneAwaiting(awaiting, 'issues', [], (i: IssueWire) => i.id, NOW, removed)).toBe(
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
      snoozeSet: { sessionId: 's1', until: null },
      snoozeClear: { sessionId: 's1' },
    }
    for (const name of Object.keys(PRESENCE_REDUCER_KINDS)) {
      const kind = PRESENCE_REDUCER_KINDS[name] as string
      const overlay = overlayForOutboxEntry(entry(kind as never, inputs[kind] as never))
      expect(overlay, `${name} -> ${kind}`).not.toBeNull()
      expect(overlay?.entity, name).toBe('sessions')
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
