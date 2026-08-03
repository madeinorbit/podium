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
  tabSetOrder: { order: ['a', 'b'] } as OutboxKinds['tabSetOrder'],
  layoutSet: { values: { density: 'compact' } } as OutboxKinds['layoutSet'],
  layoutClear: { keys: ['density'] } as OutboxKinds['layoutClear'],
  settingsUpdatePersonal: { theme: 'dark' } as OutboxKinds['settingsUpdatePersonal'],
  resumeAndSend: { sessionId: 's-1', text: 'hello' } as OutboxKinds['resumeAndSend'],
  rename: { sessionId: 's-1', name: 'new name' } as OutboxKinds['rename'],
  setArchived: { sessionId: 's-1', archived: true } as OutboxKinds['setArchived'],
  setWorkState: { sessionId: 's-1', workState: null } as OutboxKinds['setWorkState'],
  snoozeSet: { sessionId: 's-1', until: null } as OutboxKinds['snoozeSet'],
  snoozeClear: { sessionId: 's-1' } as OutboxKinds['snoozeClear'],
  sessionMarkRead: { sessionId: 's-1' } as OutboxKinds['sessionMarkRead'],
  sessionMarkUnread: { sessionId: 's-1' } as OutboxKinds['sessionMarkUnread'],
  issueMarkRead: { id: 'POD-1' } as OutboxKinds['issueMarkRead'],
  issueMarkUnread: { id: 'POD-1' } as OutboxKinds['issueMarkUnread'],
  issueSetTucked: { id: 'POD-1', tucked: true } as OutboxKinds['issueSetTucked'],
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
    expect(route('rename', { sessionId: 's-1', name: 'a' }).partitionKey).not.toBe(
      route('rename', { sessionId: 's-2', name: 'a' }).partitionKey,
    )
    // ...and a session write is not serialised behind an unrelated issue write.
    expect(route('rename', { sessionId: 's-1', name: 'a' }).partitionKey).not.toBe(
      route('issueMarkRead', { id: 'POD-1' }).partitionKey,
    )
  })

  it('keeps writes to the SAME row in one partition, preserving their order', () => {
    // This is what the legacy `chained` flag tracked: two edits of one row must
    // not be able to reorder.
    const a = route('rename', { sessionId: 's-1', name: 'first' }).partitionKey
    const b = route('rename', { sessionId: 's-1', name: 'second' }).partitionKey
    const c = route('resumeAndSend', { sessionId: 's-1', text: 'typed' }).partitionKey
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
  })

  it('shares one collapse key between commands that write the same state cell', () => {
    // The user's last click on the cell wins, which is what they meant.
    const id = 'POD-1'
    expect(route('issueMarkRead', { id }).collapseKey).toBe(
      route('issueMarkUnread', { id }).collapseKey,
    )
    expect(route('snoozeSet', { sessionId: 's-1', until: null }).collapseKey).toBe(
      route('snoozeClear', { sessionId: 's-1' }).collapseKey,
    )
  })

  it('never shares a collapse key across different targets or different cells', () => {
    expect(route('issueMarkRead', { id: 'POD-1' }).collapseKey).not.toBe(
      route('issueMarkRead', { id: 'POD-2' }).collapseKey,
    )
    // Read state and tucked state are two cells on the same issue.
    expect(route('issueMarkRead', { id: 'POD-1' }).collapseKey).not.toBe(
      route('issueSetTucked', { id: 'POD-1', tucked: true }).collapseKey,
    )
    expect(route('rename', { sessionId: 's-1', name: 'a' }).collapseKey).not.toBe(
      route('setArchived', { sessionId: 's-1', archived: true }).collapseKey,
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
