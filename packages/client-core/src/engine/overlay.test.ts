/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, folding composes in queue order with stable identities,
 * and pruneAwaiting implements retirement rule (a) (see overlay.ts header).
 */

import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../outbox'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  insertOverlay,
  overlayForOutboxEntry,
  type PendingOverlay,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'

const entry = (kind: string, input: unknown, queuedAt = 1751500800000): OutboxEntry => ({
  mutationId: `m-${kind}`,
  kind,
  input,
  queuedAt,
})

const sess = (over: Partial<SessionMeta> = {}): SessionMeta =>
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
    expect(ws.coveredBy(sess({ workState: 'done' } as Partial<SessionMeta>))).toBe(false)

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

  it('mark read/unread stamp readAt from queuedAt; covering truth is judged on the unread flag', () => {
    const read = overlayForOutboxEntry(entry('sessionMarkRead', { sessionId: 's1' }, 1751500800000))
    if (read?.op !== 'patch') throw new Error('expected patch')
    expect(read.patch).toEqual({ readAt: new Date(1751500800000).toISOString(), unread: false })
    // The server stamps its OWN clock — a different readAt still covers.
    expect(read.coveredBy(sess({ unread: false, readAt: '2099-01-01T00:00:00.000Z' }))).toBe(true)
    expect(read.coveredBy(sess({ unread: true }))).toBe(false)

    const unread = overlayForOutboxEntry(entry('issueMarkUnread', { id: 'i1' }))
    if (unread?.op !== 'patch') throw new Error('expected patch')
    expect(unread.entity).toBe('issues')
    expect(unread.patch).toEqual({ readAt: null, unread: true })
    expect(unread.coveredBy({ unread: true } as unknown as IssueWire)).toBe(true)
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
    const placeholder = sess({ sessionId: 'new-1', status: 'starting' } as Partial<SessionMeta>)
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

  it('retires when the row is gone, and ignores other entities', () => {
    const awaiting = [awaitRename(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf, NOW)).toEqual([])
    expect(pruneAwaiting(awaiting, 'issues', [], (i: IssueWire) => i.id, NOW)).toBe(awaiting)
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
    const echo2 = sess({ archived: true, workState: 'done' } as Partial<SessionMeta>)
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
