/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, folding composes in queue order with stable identities,
 * and pruneAwaiting implements retirement rule (a) (see overlay.ts header).
 */

import { sessionStateCommand, sessionStateCommandNames } from '@podium/commands'
import type { IssueWire, SessionMeta, SessionMetaInput } from '@podium/model'

import { describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../outbox'
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
  pruneAwaiting,
  rowFingerprint,
} from './overlay'

const entry = (kind: string, input: unknown, queuedAt = 1751500800000): OutboxEntry => ({
  mutationId: `m-${kind}`,
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

  it('kinds without row-visible optimism (resumeAndSend, unknown) project to null', () => {
    expect(overlayForOutboxEntry(entry('resumeAndSend', { sessionId: 's1', text: 'x' }))).toBeNull()
    expect(overlayForOutboxEntry(entry('someFutureKind', {}))).toBeNull()
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
    mutationId = `m-${name}`,
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

  it('a row absent WITHOUT a removal is out-of-slice, not deleted — the overlay is KEPT', () => {
    // docs/multi-user-readiness.md §3.1/§3.1.2: a replica holds its principal's
    // slice, so a row can vanish through an un-share or POD-1077's `evict` rather
    // than through a delete. Reading that as a deletion is the specific bug ADR 2
    // says `remove` must not be reused for.
    const awaiting = [awaitRename(sess())]

    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW)).toBe(awaiting)
    // And an UNRELATED id being removed does not retire it either — the check is on
    // identity, not on "some removal happened".
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW, new Set(['someone-else']))).toBe(
      awaiting,
    )
  })

  it('an out-of-slice row that RETURNS UNCHANGED finds its overlay still pending', () => {
    // The consequence that makes the rule worth having: rescoped back in, the
    // optimistic value is still painted instead of having been silently dropped.
    //
    // The row must return BYTE-IDENTICAL to its enqueue baseline for this to be the
    // eviction case. A row that comes back DIFFERENT is a competing write, and the
    // moved-past-baseline escape retires it — correctly, and for an unrelated
    // reason. Getting that wrong is how this test would appear to fail for the
    // rule it is actually asserting.
    const row = sess()
    const awaiting = [awaitRename(row)]
    const whileGone = pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW)
    expect(whileGone).toBe(awaiting)

    expect(pruneAwaiting(whileGone, 'sessions', [row], keyOf, NOW)).toBe(whileGone)
  })

  it('the TTL still bounds an absent row, so a permanently evicted overlay cannot wedge', () => {
    // Keeping the overlay must not mean keeping it forever: the tradeoff
    // AWAITING_TRUTH_TTL_MS documents (bounding beats wedging) applies to the
    // absent case too, or an un-shared row would pin a durable outbox entry.
    const awaiting = [awaitRename(sess())]

    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW + AWAITING_TRUTH_TTL_MS - 1)).toBe(
      awaiting,
    )
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW + AWAITING_TRUTH_TTL_MS + 1)).toEqual(
      [],
    )
  })

  it('only the OLDEST awaiting entry per row may use the moved-past escape (#263 finding 3)', () => {
    // Two rapid renames enqueued back-to-back share the same baseline (the
    // replica stayed unpainted between them).
    const base = sess()
    const first = awaitRename(base, 'first', 'm-1')
    const second = awaitRename(base, 'second', 'm-2')
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
      mutationId: 'm-ws',
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
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const row = sess()
      const awaiting = [awaitRename(row, 'mine', 'm-stuck', NOW)]
      // Within the TTL: held (row still byte-identical to the baseline).
      expect(
        pruneAwaiting(awaiting, 'sessions', [row], keyOf, NOW + AWAITING_TRUTH_TTL_MS - 1),
      ).toBe(awaiting)
      // Past the TTL: retired even though truth never covered it.
      expect(
        pruneAwaiting(awaiting, 'sessions', [row], keyOf, NOW + AWAITING_TRUTH_TTL_MS + 1),
      ).toEqual([])
      expect(dbg.mock.calls.some((c) => String(c[0]).includes('outlived its TTL'))).toBe(true)
    } finally {
      dbg.mockRestore()
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
    expect(Object.keys(PRESENCE_REDUCER_KINDS).sort()).toEqual(eligible.sort())
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

  it('the DIRECT-ONLY presence contracts are deliberately absent from the map', () => {
    for (const name of ['pins.set', 'tabs.setOrder', 'sessions.setIssueId', 'sessions.setDraft']) {
      expect(sessionStateCommand(name)?.offline).not.toBe('eligible')
      expect(Object.hasOwn(PRESENCE_REDUCER_KINDS, name), name).toBe(false)
    }
  })
})
