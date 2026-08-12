import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'

import {
  isInitialConnectivityError,
  OUTBOX_COMMANDS,
  OUTBOX_ROUTING,
  type OutboxKinds,
  outboxRoutingFor,
} from './wiring'

describe('isInitialConnectivityError', () => {
  it('recognizes only the expected cold-offline socket failures', () => {
    expect(isInitialConnectivityError('WebSocket connection failed')).toBe(true)
    expect(isInitialConnectivityError('WebSocket connection closed before connecting')).toBe(true)
    expect(isInitialConnectivityError('feed protocol rejected')).toBe(false)
    expect(isInitialConnectivityError('Invalid WebSocket URL')).toBe(false)
  })
})

/**
 * POD-785. The routing table is what actually stops the production failure: the
 * live client used to put every queued write into one `client-outbox` partition,
 * and ADR 3 D12 stops a partition at its first unresolved entry — so one
 * dead-lettered write wedged the whole queue and the app kept piling read
 * receipts behind it until the store gave out.
 *
 * The kernel-side behaviour (what collapse does, and everything it refuses to
 * touch) is pinned in packages/sync/src/outbox/capacity.test.ts. What is pinned
 * HERE is the wiring's two decisions per kind: where it sits, and whether a later
 * write makes it redundant.
 */

/** One representative input per queued kind, so the table below can be walked
 *  exhaustively rather than sampled. */
const SAMPLE: { [K in keyof OutboxKinds]: OutboxKinds[K] } = {
  pinSet: { kind: 'panel', id: 's-1', pinned: true } as OutboxKinds['pinSet'],
  tabSetOrder: {
    worktree: '/repo/wt-a',
    sessionIds: [asSessionId('s-1')],
  } as OutboxKinds['tabSetOrder'],
  layoutSet: { values: { density: 'compact' } } as OutboxKinds['layoutSet'],
  layoutClear: { keys: ['density'] } as OutboxKinds['layoutClear'],
  settingsUpdatePersonal: {
    values: { theme: 'dark' },
  } as OutboxKinds['settingsUpdatePersonal'],
  resumeAndSend: { sessionId: asSessionId('s-1'), text: 'hello' } as OutboxKinds['resumeAndSend'],
  rename: { sessionId: asSessionId('s-1'), name: 'new name' } as OutboxKinds['rename'],
  setArchived: { sessionId: asSessionId('s-1'), archived: true } as OutboxKinds['setArchived'],
  setWorkState: { sessionId: asSessionId('s-1'), workState: null } as OutboxKinds['setWorkState'],
  snoozeSet: { sessionId: asSessionId('s-1'), until: null } as OutboxKinds['snoozeSet'],
  snoozeClear: { sessionId: asSessionId('s-1') } as OutboxKinds['snoozeClear'],
  sessionMarkRead: { sessionId: asSessionId('s-1') } as OutboxKinds['sessionMarkRead'],
  sessionMarkUnread: { sessionId: asSessionId('s-1') } as OutboxKinds['sessionMarkUnread'],
  issueMarkRead: { id: 'POD-1' } as OutboxKinds['issueMarkRead'],
  issueMarkUnread: { id: 'POD-1' } as OutboxKinds['issueMarkUnread'],
  issueSetTucked: { id: 'POD-1', tucked: true } as OutboxKinds['issueSetTucked'],
  issueUpdate: { id: 'POD-1', patch: { title: 'renamed' } } as OutboxKinds['issueUpdate'],
  issueArchive: { id: 'POD-1' } as OutboxKinds['issueArchive'],
  issueDelete: { id: 'POD-1' } as OutboxKinds['issueDelete'],
  issueClose: { id: 'POD-1', reason: 'done' } as OutboxKinds['issueClose'],
  issueDefer: { id: 'POD-1', until: null } as OutboxKinds['issueDefer'],
  issueUndefer: { id: 'POD-1' } as OutboxKinds['issueUndefer'],
  issueSetLabels: { id: 'POD-1', labels: ['bug'] } as OutboxKinds['issueSetLabels'],
  issueSetPlacement: {
    id: 'POD-1',
    placement: 'mission',
    originId: 'POD-2',
  } as OutboxKinds['issueSetPlacement'],
  issueRestore: { id: 'POD-1' } as OutboxKinds['issueRestore'],
}

const kinds = Object.keys(OUTBOX_COMMANDS) as (keyof OutboxKinds)[]

const route = <K extends keyof OutboxKinds>(kind: K, input: OutboxKinds[K]) =>
  outboxRoutingFor(kind, input, 'mid-1')

describe('POD-785 — outbox routing keys every write by its target', () => {
  it('routes every queued kind, with no kind left on a shared global partition', () => {
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      const routed = outboxRoutingFor(kind, SAMPLE[kind], 'mid-1')
      expect(routed.partitionKey).toBeTruthy()
      // The constant that caused the incident must not come back.
      expect(routed.partitionKey).not.toBe('client-outbox')
    }
    // Every kind has an entry — the typed Record is the real guard, this catches
    // a table that drifted out of sync with OUTBOX_COMMANDS at runtime.
    expect(Object.keys(OUTBOX_ROUTING).sort()).toEqual([...kinds].sort())
  })

  it('gives different targets different partitions, so one refusal cannot wedge the rest', () => {
    expect(route('issueMarkRead', { id: 'POD-1' }).partitionKey).not.toBe(
      route('issueMarkRead', { id: 'POD-2' }).partitionKey,
    )
    expect(route('rename', { sessionId: asSessionId('s-1'), name: 'a' }).partitionKey).not.toBe(
      route('rename', { sessionId: asSessionId('s-2'), name: 'a' }).partitionKey,
    )
    // ...and a session write is not serialised behind an unrelated issue write.
    expect(route('rename', { sessionId: asSessionId('s-1'), name: 'a' }).partitionKey).not.toBe(
      route('issueMarkRead', { id: 'POD-1' }).partitionKey,
    )
  })

  it('keys per-worktree tab order by its worktree, not globally', () => {
    // The input names ONE worktree's order. A global `tabs` partition would have
    // serialised every worktree's tab writes against one another for no reason.
    const a = route('tabSetOrder', {
      worktree: '/repo/wt-a',
      sessionIds: [asSessionId('s-1')],
    } as OutboxKinds['tabSetOrder'])
    const b = route('tabSetOrder', {
      worktree: '/repo/wt-b',
      sessionIds: [asSessionId('s-2')],
    } as OutboxKinds['tabSetOrder'])
    expect(a.partitionKey).not.toBe(b.partitionKey)
    expect(a.collapseKey).not.toBe(b.collapseKey)
  })

  it('keeps writes to the SAME row in one partition, preserving their order', () => {
    // This is what the legacy `chained` flag tracked: two edits of one row must
    // not be able to reorder.
    const a = route('rename', { sessionId: asSessionId('s-1'), name: 'first' }).partitionKey
    const b = route('rename', { sessionId: asSessionId('s-1'), name: 'second' }).partitionKey
    const c = route('resumeAndSend', { sessionId: asSessionId('s-1'), text: 'typed' }).partitionKey
    expect(a).toBe(b)
    expect(a).toBe(c)
  })
})

describe('POD-785 — only writes a later one subsumes may collapse', () => {
  it('declares NO collapse key for content-bearing or partial-patch commands', () => {
    // Text into a live PTY: two sends are two sends (ADR 3 D11).
    expect(route('resumeAndSend', SAMPLE.resumeAndSend).collapseKey).toBeUndefined()
    // Partial patches — a later one carries only the keys it touches, so it does
    // NOT subsume an earlier one. Collapsing these would drop fields silently.
    expect(route('layoutSet', SAMPLE.layoutSet).collapseKey).toBeUndefined()
    expect(route('layoutClear', SAMPLE.layoutClear).collapseKey).toBeUndefined()
    expect(
      route('settingsUpdatePersonal', SAMPLE.settingsUpdatePersonal).collapseKey,
    ).toBeUndefined()
    // POD-781: `issues.update` is the same shape of partial patch — a rename and
    // a recolour of one issue are two different keys, and collapsing them on the
    // issue id would silently drop the rename.
    expect(route('issueUpdate', SAMPLE.issueUpdate).collapseKey).toBeUndefined()
  })

  it('collapses the one-way issue commands, which a repeat cannot add to', () => {
    // POD-781. `issues.archive` has no un-archive arm and `issues.delete` no
    // un-delete one (that is `issues.restore`), so a second queued copy of
    // either does exactly what the first did. Their keys are DISTINCT from the
    // patch kind's — which has none — so nothing can collapse an un-archive.
    const id = 'POD-1'
    expect(route('issueArchive', { id }).collapseKey).toBe(
      route('issueArchive', { id }).collapseKey,
    )
    expect(route('issueArchive', { id }).collapseKey).not.toBe(
      route('issueDelete', { id }).collapseKey,
    )
    expect(route('issueArchive', { id }).collapseKey).not.toBe(
      route('issueArchive', { id: 'POD-2' }).collapseKey,
    )
  })

  it('keeps every issue write on ONE partition per issue, so a rename cannot overtake its delete', () => {
    // POD-781: the curation writes join the per-user ones on `issue:<id>`.
    const id = 'POD-1'
    const partitions = new Set([
      route('issueUpdate', { id, patch: { title: 'x' } }).partitionKey,
      route('issueArchive', { id }).partitionKey,
      route('issueDelete', { id }).partitionKey,
      route('issueMarkRead', { id }).partitionKey,
      route('issueSetTucked', { id, tucked: true }).partitionKey,
      route('issueClose', { id, reason: 'done' }).partitionKey,
      route('issueDefer', { id, until: null }).partitionKey,
      route('issueUndefer', { id }).partitionKey,
      route('issueSetLabels', { id, labels: ['bug'] }).partitionKey,
      route('issueSetPlacement', { id, placement: 'own', originId: 'POD-9' }).partitionKey,
      route('issueRestore', { id }).partitionKey,
    ])
    expect([...partitions]).toEqual([`issue:${id}`])
    // ...and two DIFFERENT issues still never serialise against each other.
    expect(route('issueDelete', { id }).partitionKey).not.toBe(
      route('issueDelete', { id: 'POD-2' }).partitionKey,
    )
  })

  it('shares one collapse key between commands that write the same state cell', () => {
    // The user's last click on the cell wins, which is what they meant.
    const id = 'POD-1'
    expect(route('issueMarkRead', { id }).collapseKey).toBe(
      route('issueMarkUnread', { id }).collapseKey,
    )
    expect(route('snoozeSet', { sessionId: asSessionId('s-1'), until: null }).collapseKey).toBe(
      route('snoozeClear', { sessionId: asSessionId('s-1') }).collapseKey,
    )
    // POD-781: defer and undefer are the issue twins of that pair — two commands
    // writing `deferUntil`, so "snooze until Friday, no — unsnooze" sends the
    // last word rather than both in order.
    expect(route('issueDefer', { id, until: '2099-01-01' }).collapseKey).toBe(
      route('issueUndefer', { id }).collapseKey,
    )
  })

  it('collapses close and setLabels — each sends a whole cell a repeat cannot add to', () => {
    // POD-781. `close` names the closed cell and `setLabels` sends the WHOLE set
    // rather than a delta, so in both cases the later entry already contains
    // everything the earlier one said. Neither shares with `issueUpdate`, which
    // collapses with nothing — a reopen queued behind a close cannot be dropped.
    const id = 'POD-1'
    expect(route('issueClose', { id, reason: 'done' }).collapseKey).toBe(
      route('issueClose', { id, reason: 'wontfix' }).collapseKey,
    )
    expect(route('issueSetLabels', { id, labels: ['a'] }).collapseKey).toBe(
      route('issueSetLabels', { id, labels: ['b'] }).collapseKey,
    )
    expect(route('issueClose', { id, reason: 'done' }).collapseKey).not.toBe(
      route('issueSetLabels', { id, labels: ['a'] }).collapseKey,
    )
    expect(route('issueUpdate', { id, patch: { stage: 'backlog' } }).collapseKey).toBeUndefined()
  })

  it('shares the deleted cell between delete and restore, so an undo cancels the delete outright', () => {
    // POD-781 group 3, and the same reasoning as defer/undefer above: both write
    // `deletedAt`, so the operator's last word is the one that should travel. It
    // is the one pair where collapsing also SPARES work — a delete that never
    // leaves is a cascade that never kills the member sessions' PTYs, and the
    // row ends up restored either way.
    const id = 'POD-1'
    expect(route('issueDelete', { id }).collapseKey).toBe(route('issueRestore', { id }).collapseKey)
    expect(route('issueRestore', { id }).collapseKey).not.toBe(
      route('issueRestore', { id: 'POD-2' }).collapseKey,
    )
    // Archiving is a different cell, and an un-archive rides `issueUpdate`,
    // which collapses with nothing.
    expect(route('issueRestore', { id }).collapseKey).not.toBe(
      route('issueArchive', { id }).collapseKey,
    )
  })

  it('keys a placement by its ORIGIN as well as its issue', () => {
    // POD-781 group 3. A placement is absolute only RELATIVE TO ONE ORIGIN: the
    // command writes a `discovered-from` edge naming it. Keyed on the issue
    // alone, "own w.r.t. A" then "mission w.r.t. B" would collapse to the second
    // and A's edge — the whole content of the first decision — would never be
    // written. Same origin still collapses: that IS the operator changing their
    // mind about one question.
    const id = 'POD-1'
    expect(route('issueSetPlacement', { id, placement: 'own', originId: 'POD-2' }).collapseKey).toBe(
      route('issueSetPlacement', { id, placement: 'mission', originId: 'POD-2' }).collapseKey,
    )
    expect(
      route('issueSetPlacement', { id, placement: 'own', originId: 'POD-2' }).collapseKey,
    ).not.toBe(route('issueSetPlacement', { id, placement: 'own', originId: 'POD-3' }).collapseKey)
  })

  it('never shares a collapse key across different targets or different cells', () => {
    expect(route('issueMarkRead', { id: 'POD-1' }).collapseKey).not.toBe(
      route('issueMarkRead', { id: 'POD-2' }).collapseKey,
    )
    // Read state and tucked state are two cells on the same issue.
    expect(route('issueMarkRead', { id: 'POD-1' }).collapseKey).not.toBe(
      route('issueSetTucked', { id: 'POD-1', tucked: true }).collapseKey,
    )
    expect(route('rename', { sessionId: asSessionId('s-1'), name: 'a' }).collapseKey).not.toBe(
      route('setArchived', { sessionId: asSessionId('s-1'), archived: true }).collapseKey,
    )
  })

  it('confines a collapse key to its own partition', () => {
    // A collapse key that outran its partition would let the kernel drop an
    // entry whose order against the survivor is undefined.
    for (const kind of kinds) {
      const routed = outboxRoutingFor(kind, SAMPLE[kind], 'mid-1')
      if (routed.collapseKey === undefined) continue
      const other = outboxRoutingFor(kind, SAMPLE[kind], 'mid-2')
      expect(other.partitionKey).toBe(routed.partitionKey)
    }
  })
})
