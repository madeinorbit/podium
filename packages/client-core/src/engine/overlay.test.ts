/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, and folding composes in queue order with stable
 * identities. Retirement is the outbox entry's (command-reducers.ts header).
 */

import { ISSUE_CONTRACTS, sessionStateCommand, sessionStateCommandNames } from '@podium/commands'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  asUserId,
  type IssueUserStateWire,
  issueUserStateRowId,
  sessionUserStateRowId,
} from '@podium/model'

import { describe, expect, it } from 'vitest'
import {
  foldRowOverlays,
  ISSUE_SERVER_RESOLVED_UPDATE_KEYS,
  issueUpdateRoute,
  overlaysForOutboxEntry,
  type PendingOverlay,
  PRESENCE_CONTRACTS_AS_RECORD_EDITS,
  PRESENCE_REDUCER_KINDS,
} from '../command-reducers'
import type { OutboxEntry } from '../outbox'
import { recordEditEntry, UNSET } from '../records'
import { ACTION_STATE_REDUCER_COMMANDS } from './actions'

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

/** My read state, snooze or tuck: a record edit of my own row (POD-6404). */
const mySession = (patch: object, unset?: string[]) =>
  entry('recordEdit', {
    kind: 'sessionUserState',
    id: sessionUserStateRowId(asUserId('u1'), asSessionId('s1')),
    patch,
    ...(unset === undefined ? {} : { unset }),
  })
const myIssue = (patch: object) =>
  entry('recordEdit', {
    kind: 'issueUserState',
    id: issueUserStateRowId(asUserId('u1'), asIssueId('i1')),
    patch,
  })

const userState = (over: Partial<IssueUserStateWire> = {}): IssueUserStateWire => ({
  userId: asUserId('u1'),
  entityId: asIssueId('i1'),
  readAt: null,
  tuckedAt: null,
  pinned: false,
  ...over,
})

describe('overlayForOutboxEntry projection', () => {
  // The session's labels are record edits (POD-6406): the parsed edit is the
  // paint, so a rename paints the trimmed name the server stores.
  const sessionEdit = (patch: Parameters<typeof recordEditEntry<'session'>>[1]) =>
    overlayForOutboxEntry(
      entry('recordEdit', recordEditEntry({ kind: 'session', id: 's1' }, patch)),
    )

  it('rename patches the trimmed name', () => {
    const o = sessionEdit({ name: ' hi ' })
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('sessions')
    expect(o.id).toBe('s1')
    expect(o.patch).toEqual({ name: 'hi' })
  })

  it('archive / work-state / snooze project patches on their owning rows', () => {
    const arch = sessionEdit({ archived: true, workState: 'done' })
    if (arch?.op !== 'patch') throw new Error('expected patch')
    expect(arch.patch).toEqual({ archived: true, workState: 'done' })

    const ws = sessionEdit({ workState: UNSET })
    if (ws?.op !== 'patch') throw new Error('expected patch')
    expect(ws.patch).toEqual({ workState: undefined })

    // The snooze is a record edit of my own row (POD-6404): `null` until the
    // next message, a cleared cell for none at all.
    const snooze = overlayForOutboxEntry(mySession({ snoozedUntil: '2026-07-10T00:00:00.000Z' }))
    if (snooze?.op !== 'patch') throw new Error('expected patch')
    expect(snooze.entity).toBe('sessionUserStates')
    expect(snooze.id).toBe('s1')
    expect(snooze.patch).toEqual({ snoozedUntil: '2026-07-10T00:00:00.000Z' })

    const clear = overlayForOutboxEntry(mySession({}, ['snoozedUntil']))
    if (clear?.op !== 'patch') throw new Error('expected patch')
    expect(clear.entity).toBe('sessionUserStates')
    expect(clear.patch).toEqual({ snoozedUntil: undefined })
    expect('snoozedUntil' in clear.patch).toBe(true)
  })

  // POD-1110 — "none of these" queues like every other row edit, and this is the
  // paint that keeps the bar gone while it waits (including across a reload).
  it('dismissOffer clears the offer', () => {
    const o = overlayForOutboxEntry(
      entry('dismissOffer', { sessionId: 's1', offerCreatedAt: 'T1' }),
    )
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('sessions')
    expect(o.id).toBe('s1')
    expect(o.patch).toEqual({ offer: undefined })
  })

  it('mark read/unread paint the readAt the edit carries, on my own row (POD-6404)', () => {
    const readAt = '2026-10-29T12:00:00.000Z'
    const read = overlayForOutboxEntry(mySession({ readAt }))
    if (read?.op !== 'patch') throw new Error('expected patch')
    expect(read.entity).toBe('sessionUserStates')
    expect(read.id).toBe('s1')
    expect(read.patch).toEqual({ readAt })

    const issueRead = overlayForOutboxEntry(myIssue({ readAt }))
    if (issueRead?.op !== 'patch') throw new Error('expected patch')
    expect(issueRead.entity).toBe('issueUserStates')
    expect(issueRead.id).toBe('i1')
    expect(issueRead.patch).toEqual({ readAt })

    const unread = overlayForOutboxEntry(myIssue({ readAt: null }))
    if (unread?.op !== 'patch') throw new Error('expected patch')
    expect(unread.patch).toEqual({ readAt: null })
  })

  // Tuck-away rides the SAME optimistic mechanism as the rest (POD-333), which is
  // what lets the fold be server state without the press feeling slow: the
  // edit paints tuckedAt until its entry retires — including across a reconnect
  // heal snapshot taken before the mutation got there.
  it('a tuck paints the tuckedAt the edit carries', () => {
    const tuck = overlayForOutboxEntry(myIssue({ tuckedAt: '2026-07-03T00:00:00.000Z' }))
    if (tuck?.op !== 'patch') throw new Error('expected patch overlay')
    expect(tuck.entity).toBe('issueUserStates')
    expect(tuck.id).toBe('i1')
    expect(tuck.patch).toEqual({ tuckedAt: '2026-07-03T00:00:00.000Z' })

    const untuck = overlayForOutboxEntry(myIssue({ tuckedAt: null }))
    if (untuck?.op !== 'patch') throw new Error('expected patch overlay')
    expect(untuck.patch).toEqual({ tuckedAt: null })
  })

  it.each([
    ['sessionMarkRead', { sessionId: 's1' }],
    ['snoozeClear', { sessionId: 's1' }],
    ['issueMarkRead', { id: 'i1' }],
    ['issueSetTucked', { id: 'i1', tucked: true }],
  ])('an older build’s queued %s drains but paints nothing (LEGACY)', (kind, input) => {
    expect(overlayForOutboxEntry(entry(kind, input))).toBeNull()
  })

  it('an unknown kind projects to nothing', () => {
    expect(overlayForOutboxEntry(entry('someFutureKind', {}))).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // POD-781 — the curation writes
  // ---------------------------------------------------------------------------

  it('issueUpdate paints the patch verbatim', () => {
    const o = overlayForOutboxEntry(
      entry('issueUpdate', { id: 'i1', patch: { title: 'Renamed', priority: 2 } }),
    )
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ title: 'Renamed', priority: 2 })
  })

  it('an EMPTY issueUpdate patch projects to null rather than parking a no-op overlay', () => {
    expect(overlayForOutboxEntry(entry('issueUpdate', { id: 'i1', patch: {} }))).toBeNull()
  })

  it('issueDelete stamps deletedAt from queuedAt', () => {
    const o = overlayForOutboxEntry(entry('issueDelete', { id: 'i1' }, 1751500800000))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.id).toBe('i1')
    expect(o.patch).toEqual({ deletedAt: new Date(1751500800000).toISOString() })
  })

  it('issueClose settles the stage and stamps the reason', () => {
    const o = overlayForOutboxEntry(entry('issueClose', { id: 'i1', reason: 'wontfix' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.patch).toEqual({ stage: 'done', closedReason: 'wontfix' })
  })

  it('issueClose with no reason paints only what the caller said — the stage', () => {
    const o = overlayForOutboxEntry(entry('issueClose', { id: 'i1' }))
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.patch).toEqual({ stage: 'done' })
  })

  // THE PLAIN FIELDS ARE RECORD EDITS (POD-6405): the edit, parsed with the
  // command's schema, is the paint. Archive, defer, unsnooze and labels have no
  // case of their own any more.
  const issueEdit = (patch: Parameters<typeof recordEditEntry<'issueProjection'>>[1]) =>
    overlayForOutboxEntry(
      entry('recordEdit', recordEditEntry({ kind: 'issueProjection', id: 'i1' }, patch)),
    )

  it('an archive paints `archived`, and the sidebar drops the row on it', () => {
    const o = issueEdit({ archived: true })
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.entity).toBe('issueProjections')
    expect(o.patch).toEqual({ archived: true })
  })

  it('a defer is an exact cell write; ending it clears the cell', () => {
    const until = issueEdit({ deferUntil: 'next-message' })
    if (until?.op !== 'patch') throw new Error('expected patch overlay')
    expect(until.patch).toEqual({ deferUntil: 'next-message' })

    const cleared = issueEdit({ deferUntil: UNSET })
    if (cleared?.op !== 'patch') throw new Error('expected patch overlay')
    expect(cleared.patch).toEqual({ deferUntil: undefined })
  })

  it('labels paint the set the server will store: trimmed, deduplicated, sorted', () => {
    const o = issueEdit({ labels: ['ui', ' bug ', 'bug', ''] })
    if (o?.op !== 'patch') throw new Error('expected patch overlay')
    expect(o.patch).toEqual({ labels: ['bug', 'ui'] })
    const none = issueEdit({ labels: [] })
    if (none?.op !== 'patch') throw new Error('expected patch overlay')
    expect(none.patch).toEqual({ labels: [] })
  })

  it.each([
    ['issueArchive', { id: 'i1' }],
    ['issueDefer', { id: 'i1', until: null }],
    ['issueUndefer', { id: 'i1' }],
    ['issueSetLabels', { id: 'i1', labels: ['bug'] }],
  ])('an older build’s queued %s drains but paints nothing (LEGACY)', (kind, input) => {
    expect(overlayForOutboxEntry(entry(kind, input))).toBeNull()
  })

  it('issueSetPlacement paints the PARENT LINK — into a mission, and back out of one', () => {
    const intoMission = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'mission', originId: 'origin-1' }),
    )
    if (intoMission?.op !== 'patch') throw new Error('expected patch overlay')
    expect(intoMission.entity).toBe('issueProjections')
    expect(intoMission.id).toBe('i1')
    expect(intoMission.patch).toEqual({ parentId: 'origin-1' })

    const ownThing = overlayForOutboxEntry(
      entry('issueSetPlacement', { id: 'i1', placement: 'own', originId: 'origin-1' }),
    )
    if (ownThing?.op !== 'patch') throw new Error('expected patch overlay')
    expect(ownThing.patch).toEqual({ parentId: null })
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
    const [issue, user] = overlays
    if (issue?.op !== 'patch' || user?.op !== 'patch') {
      throw new Error('expected patch overlays')
    }
    // One mutation: every part shares its key, and retires with its entry.
    expect(new Set(overlays.map((o) => o.key))).toEqual(new Set([issue.key]))
    // The description is a DOCUMENT on the normalized row — painted as one.
    expect(issue.patch).toEqual({ title: 'Renamed', description: { value: 'new prose' } })
    expect(user.patch).toEqual({ pinned: true })
  })

  it('every key `issues.update` accepts has exactly one home, so none paints a cell no row holds', () => {
    const keys = Object.keys(ISSUE_CONTRACTS.update.input.shape.patch.shape)
    expect(keys.length).toBeGreaterThan(20)
    // The one deliberate exception: keys the server resolves into another cell
    // land nowhere, and the set is exactly these (POD-6107/POD-6114).
    expect([...ISSUE_SERVER_RESOLVED_UPDATE_KEYS]).toEqual(['agentProfile'])
    for (const key of keys) {
      const { issue, user } = issueUpdateRoute({ [key]: 'x' })
      if (ISSUE_SERVER_RESOLVED_UPDATE_KEYS.has(key)) {
        expect([Object.keys(issue).length, Object.keys(user).length], key).toEqual([0, 0])
        continue
      }
      expect(
        [Object.keys(issue).length, Object.keys(user).length].sort(),
        `${key} must land on exactly one normalized row`,
      ).toEqual([0, 1])
    }
  })

  // POD-762: a wake is row-visible. The queue depth is the fact — the operator's
  // message is waiting on this session — and one field lights the wake up on
  // every surface at once.
  it('projects a queued message onto the woken session', () => {
    const wake = overlayForOutboxEntry(entry('resumeAndSend', { sessionId: 's1', text: 'x' }))
    if (wake?.op !== 'patch') throw new Error('expected patch overlay')
    expect(wake.entity).toBe('sessions')
    expect(wake.id).toBe('s1')
    expect(wake.patch).toEqual({ queuedMessageCount: 1 })
  })
})

describe('folding over an absent per-user row', () => {
  const key = (row: IssueUserStateWire): string => row.entityId
  const onAbsent = (e: OutboxEntry): PendingOverlay => {
    const o = overlayForOutboxEntry(e)
    if (o?.op !== 'patch') throw new Error('expected patch')
    return { ...o, absent: userState() }
  }

  const readAt = new Date(1751500800000).toISOString()

  it('paints a mark-read onto the "nothing set" row, in both folds', () => {
    const read = onAbsent(myIssue({ readAt }))
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [read])).toEqual(userState({ readAt }))
  })

  it('adds nothing for a patch that leaves the row saying "nothing set"', () => {
    const base: IssueUserStateWire[] = []
    const unread = onAbsent(myIssue({ readAt: null }))
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [unread])).toBeUndefined()
  })

  it('a present row wins over the absent one, and a patch without one paints nothing', () => {
    const present = userState({ tuckedAt: 'T' })
    const read = onAbsent(myIssue({ readAt }))
    const bare = overlayForOutboxEntry(myIssue({ readAt })) as PendingOverlay
    expect(foldRowOverlays<IssueUserStateWire>(undefined, [bare])).toBeUndefined()
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
    // ...or became a generic record edit, painted by the one record case
    // (POD-6404; the old route stays for older apps until POD-6359).
    const reduced = [
      ...Object.keys(PRESENCE_REDUCER_KINDS),
      ...PRESENCE_CONTRACTS_AS_RECORD_EDITS,
      ...ACTION_STATE_REDUCER_COMMANDS.filter((name) => sessionStateCommand(name) !== undefined),
    ]
    expect(reduced.sort()).toEqual(eligible.sort())
  })

  it('each mapped kind really produces an overlay — the map is not just names', () => {
    // Guards the guard above: a map whose kinds had no reducer case would satisfy
    // the totality test and still paint nothing.
    const inputs: Record<string, object> = {
      dismissOffer: { sessionId: 's1', offerCreatedAt: 'T1' },
    }
    const perUser = new Set<string>()
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
