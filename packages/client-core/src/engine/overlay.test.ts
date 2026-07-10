/**
 * Unit pins for the unified optimistic overlay (#263 [spec:SP-3fe2]): the
 * outbox-entry → overlay projection mirrors the old direct-replica patches
 * field for field, folding composes in queue order with stable identities,
 * and pruneAwaiting implements retirement rule (a) (see overlay.ts header).
 */

import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../outbox'
import {
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  insertOverlay,
  overlayForOutboxEntry,
  type PendingOverlay,
  pruneAwaiting,
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

describe('pruneAwaiting (retirement rule (a))', () => {
  const keyOf = (s: SessionMeta): string => s.sessionId
  const await1 = (row: SessionMeta): AwaitingTruth => {
    const o = overlayForOutboxEntry(entry('rename', { sessionId: 's1', name: 'mine' }))
    if (o?.op !== 'patch') throw new Error('expected patch')
    return { overlay: o, fingerprint: JSON.stringify(row) }
  }

  it('keeps the entry while the row is byte-identical to the resolution fingerprint', () => {
    const row = sess()
    const awaiting = [await1(row)]
    expect(pruneAwaiting(awaiting, 'sessions', [row], keyOf)).toBe(awaiting) // same ref: nothing retired
  })

  it('retires when truth covers the mutation', () => {
    const awaiting = [await1(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [sess({ name: 'mine' })], keyOf)).toEqual([])
  })

  it('retires when the row moved past the fingerprint WITHOUT covering (competing write wins)', () => {
    const awaiting = [await1(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [sess({ name: 'theirs' })], keyOf)).toEqual([])
  })

  it('retires when the row is gone, and ignores other entities', () => {
    const awaiting = [await1(sess())]
    expect(pruneAwaiting(awaiting, 'sessions', [], keyOf)).toEqual([])
    expect(pruneAwaiting(awaiting, 'issues', [], (i: IssueWire) => i.id)).toBe(awaiting)
  })
})
