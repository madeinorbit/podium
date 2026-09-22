/**
 * POD-4548 (L1c) — every sequence in
 * `docs/plans/pod-4545-round-three-write-contract.md`, run against each pending
 * log implementation, plus the mapping table pinned against the kernel's own
 * command, routing, park and TTL tables.
 *
 * An arm that writes its own {@link PendingLog} adds its factory to `LOGS`.
 */
import {
  AWAITING_TRUTH_TTL_MS,
  deadLetterHandlingFor,
  OUTBOX_COMMANDS,
  OUTBOX_ROUTING,
  shouldParkDeadLetter,
} from '@podium/client-core/engine'
import { asMutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  commandFor,
  createPendingLog,
  ECHO_TTL_MS,
  editForPendingWrite,
  type EditPatch,
  type FieldValues,
  type LogOutcome,
  type OutboxPendingWrite,
  type PendingLog,
  type TxId,
  WriteContractError,
} from './write-contract'

type Clock = { t: number }
const LOGS: ReadonlyArray<readonly [string, (clock: Clock) => PendingLog]> = [
  ['reference', (clock) => createPendingLog({ now: () => clock.t })],
]

type Issue = { title: string; stage: string; readAt: string | null }

/**
 * A minimal arm: one issue object whose identity changes on every write (the
 * hand-rolled shape; a MobX arm mutates in place and ignores identities), a
 * log, and a sent-command list standing in for the transport.
 */
function makeArm(log: PendingLog, seed: Issue) {
  let row: Readonly<Issue> = Object.freeze({ ...seed })
  let n = 0
  const sent: { txId: TxId; kind: string }[] = []
  const commits: Readonly<Issue>[] = []
  const write = (changes: FieldValues<'issue'>): void => {
    const next = { ...row, ...changes }
    if ((Object.keys(next) as (keyof Issue)[]).every((k) => Object.is(next[k], row[k]))) return
    row = Object.freeze(next)
    commits.push(row)
  }
  const apply = (out: LogOutcome | null): LogOutcome | null => {
    if (!out) return null
    if (out.restoreIdentity !== undefined) {
      row = out.restoreIdentity as Readonly<Issue>
      commits.push(row)
    } else write(out.changes as FieldValues<'issue'>)
    return out
  }
  return {
    get row() {
      return row
    },
    sent,
    commits,
    edit(patch: EditPatch<'issue'>): TxId {
      const command = commandFor('issue', 'i1', patch) // throws before any state change
      const txId = asMutationId(`tx${++n}`)
      const prior = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k as keyof Issue]]))
      const priorIdentity = row
      write(patch)
      log.append({ txId, kind: 'issue', id: 'i1', patch, prior, priorIdentity })
      sent.push({ txId, kind: command.kind })
      return txId
    },
    /** W11: bootstrap re-apply of one outbox entry — paint, log, no send. */
    restore(entry: OutboxPendingWrite): boolean {
      const e = editForPendingWrite(entry)
      if (!e) return false
      const prior = Object.fromEntries(Object.keys(e.patch).map((k) => [k, row[k as keyof Issue]]))
      write(e.patch)
      log.append({ txId: entry.txId, ...e, prior }, entry.base ? { base: entry.base } : undefined)
      if (entry.acked) apply(log.settle({ txId: entry.txId }))
      return true
    },
    settle: (txId: TxId) => apply(log.settle({ txId })),
    reject: (txId: TxId) => apply(log.reject({ txId, error: { message: 'refused', parked: false } })),
    supersede: (txId: TxId) => apply(log.supersede({ txId })),
    remote: (values: Partial<Issue>) => apply(log.remote('issue', 'i1', values)),
    expire: () => log.expire().map(apply),
  }
}

const SEED: Issue = { title: 'Old', stage: 'planning', readAt: null }

describe.each(LOGS)('pending log: %s', (_name, make) => {
  const setup = (seed: Issue = SEED) => {
    const clock = { t: 0 }
    const log = make(clock)
    return { clock, log, arm: makeArm(log, seed) }
  }

  describe('S1 happy path: edit -> paint -> command sent -> echo -> settle', () => {
    it('echo after the receipt settles on the echo', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ title: 'New' })
      expect(arm.row.title).toBe('New')
      expect(arm.commits).toHaveLength(1)
      expect(arm.sent).toEqual([{ txId: tx, kind: 'issueUpdate' }])
      expect(arm.settle(tx)?.left).toEqual([])
      expect(log.size).toBe(1)
      expect(arm.remote({ ...SEED, title: 'New' })?.left).toEqual([tx])
      expect(log.size).toBe(0)
      expect(arm.row.title).toBe('New')
      expect(arm.commits).toHaveLength(1) // the echo repaints nothing
    })

    it('echo before the receipt (broadcast beats the response) settles on the receipt', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ stage: 'review' })
      expect(arm.remote({ ...SEED, stage: 'review' })?.left).toEqual([])
      expect(log.pendingFor('issue', 'i1')).toHaveLength(1)
      expect(arm.settle(tx)?.left).toEqual([tx])
      expect(log.size).toBe(0)
      expect(arm.commits).toHaveLength(1)
    })

    it('a stamp field settles on the server clock, not the client one', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ readAt: '2026-09-22T10:00:00.000Z' })
      expect(arm.sent[0]!.kind).toBe('issueMarkRead')
      arm.settle(tx)
      arm.remote({ readAt: '2026-09-22T10:00:00.123Z' })
      expect(log.size).toBe(0)
      expect(arm.row.readAt).toBe('2026-09-22T10:00:00.123Z') // truthful second
    })

    it('a stamp echo before the receipt is recognised as the echo, so the receipt settles it', () => {
      // Distinguishes stamp coverage from the after-receipt overtake rule: the
      // server clock arrives while local still wins, and must count as the echo.
      const { log, arm } = setup({ ...SEED, readAt: '2026-09-21T00:00:00.000Z' })
      const tx = arm.edit({ readAt: '2026-09-22T10:00:00.000Z' })
      arm.remote({ readAt: '2026-09-22T10:00:00.123Z' })
      expect(arm.row.readAt).toBe('2026-09-22T10:00:00.000Z')
      expect(arm.settle(tx)?.left).toEqual([tx])
      expect(log.size).toBe(0)
      expect(arm.row.readAt).toBe('2026-09-22T10:00:00.123Z')
    })
  })

  describe('S2 rejection: edit -> paint -> reject -> rewind to prior -> error surfaced', () => {
    it('rewinds to the prior and restores the pre-edit identity', () => {
      const { log, arm } = setup()
      const before = arm.row
      const tx = arm.edit({ title: 'New', stage: 'review' })
      const out = arm.reject(tx)
      expect(out?.left).toEqual([tx])
      expect(out?.restoreIdentity).toBe(before)
      expect(arm.row).toBe(before)
      expect(log.size).toBe(0)
    })

    it('rewinds to the server value that landed while pending, not the stale prior', () => {
      const { arm } = setup()
      const tx = arm.edit({ title: 'Mine' })
      arm.remote({ ...SEED, title: 'Theirs' })
      expect(arm.row.title).toBe('Mine')
      const out = arm.reject(tx)
      expect(out?.restoreIdentity).toBeUndefined() // a server row landed: no identity restore
      expect(arm.row.title).toBe('Theirs')
    })

    it('a server row on another field forbids the identity restore but keeps the value rewind', () => {
      const { arm } = setup()
      const before = arm.row
      const tx = arm.edit({ title: 'New' })
      arm.remote({ ...SEED, readAt: '2026-09-22T09:00:00.000Z' })
      arm.reject(tx)
      expect(arm.row).not.toBe(before)
      expect(arm.row).toEqual({ ...SEED, readAt: '2026-09-22T09:00:00.000Z' })
    })

    it('stacked edits: rejecting the newest reveals the older pending value', () => {
      const { arm } = setup()
      const t1 = arm.edit({ title: 'A' })
      const t2 = arm.edit({ title: 'B' })
      arm.reject(t2)
      expect(arm.row.title).toBe('A')
      arm.reject(t1)
      expect(arm.row.title).toBe('Old')
    })

    it('stacked edits: rejecting an older one leaves the newer value painted', () => {
      const { arm } = setup()
      const before = arm.row
      const t1 = arm.edit({ title: 'A' })
      const t2 = arm.edit({ title: 'B' })
      const commits = arm.commits.length
      expect(arm.reject(t1)?.changes).toEqual({})
      expect(arm.commits).toHaveLength(commits)
      expect(arm.row.title).toBe('B')
      // The log now empties with no server row seen: the identity is the one
      // before the FIRST edit, not t2's.
      expect(arm.reject(t2)?.restoreIdentity).toBe(before)
    })
  })

  describe('S3 remote update on a pending field', () => {
    it('local wins until settle; non-pending fields take the remote value', () => {
      const { arm } = setup()
      arm.edit({ title: 'Mine' })
      arm.remote({ title: 'Theirs', stage: 'review', readAt: null })
      expect(arm.row).toEqual({ title: 'Mine', stage: 'review', readAt: null })
    })

    it('a remote value after the echo but before the receipt is shown at settle', () => {
      const { arm } = setup()
      const tx = arm.edit({ title: 'Mine' })
      arm.remote({ ...SEED, title: 'Mine' }) // our echo
      arm.remote({ ...SEED, title: 'Later' }) // a newer writer
      expect(arm.row.title).toBe('Mine')
      arm.settle(tx)
      expect(arm.row.title).toBe('Later')
    })

    it('after the receipt, a stale value (seen at receipt) waits; a third value overtakes', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ title: 'Mine' })
      arm.remote({ ...SEED, title: 'Older' }) // committed before ours, delivered before the receipt
      arm.settle(tx)
      arm.remote({ ...SEED, title: 'Older', stage: 'review' }) // same stale title riding another field's change
      expect(arm.row.title).toBe('Mine')
      expect(log.size).toBe(1)
      arm.remote({ ...SEED, title: 'Newer', stage: 'review' }) // our echo was skipped by a catch-up
      expect(log.size).toBe(0)
      expect(arm.row.title).toBe('Newer')
    })

    it('stacked edits: each echo confirms its own edit and everything older', () => {
      const { log, arm } = setup()
      const t1 = arm.edit({ title: 'B' })
      const t2 = arm.edit({ title: 'A' })
      const t3 = arm.edit({ title: 'B' })
      for (const t of [t1, t2, t3]) arm.settle(t)
      expect(arm.remote({ ...SEED, title: 'B' })?.left).toEqual([t1])
      expect(arm.row.title).toBe('B')
      expect(arm.remote({ ...SEED, title: 'A' })?.left).toEqual([t2])
      expect(arm.row.title).toBe('B') // t3 is still the newest pending
      expect(arm.remote({ ...SEED, title: 'B' })?.left).toEqual([t3])
      expect(log.size).toBe(0)
    })

    it('an edit touching two fields settles only when both are echoed', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ title: 'New', stage: 'review' })
      arm.settle(tx)
      arm.remote({ ...SEED, title: 'New' })
      expect(log.size).toBe(1)
      arm.remote({ ...SEED, title: 'New', stage: 'review' })
      expect(log.size).toBe(0)
    })
  })

  describe('S4 duplicate receipt is idempotent', () => {
    it('a second receipt, a late rejection, a receipt after a rejection: all no-ops', () => {
      const { log, arm } = setup()
      const tx = arm.edit({ title: 'New' })
      arm.settle(tx)
      expect(arm.settle(tx)).toBeNull()
      arm.remote({ ...SEED, title: 'New' })
      expect(arm.settle(tx)).toBeNull()
      expect(arm.reject(tx)).toBeNull()
      expect(arm.row.title).toBe('New')
      const t2 = arm.edit({ title: 'Other' })
      arm.reject(t2)
      expect(arm.settle(t2)).toBeNull()
      expect(arm.reject(t2)).toBeNull()
      expect(arm.row.title).toBe('New')
      expect(log.size).toBe(0)
    })

    it('an unknown txId is a no-op, a reused one is refused', () => {
      const { log } = setup()
      expect(log.settle({ txId: asMutationId('nope') })).toBeNull()
      const edit = { txId: asMutationId('t'), kind: 'issue' as const, id: 'i1', patch: { title: 'x' }, prior: { title: 'y' } }
      log.append(edit)
      expect(() => log.append(edit)).toThrow(WriteContractError)
      expect(() => log.append({ ...edit, txId: asMutationId('u'), prior: {} })).toThrow(/no prior/)
      expect(() => log.append({ ...edit, txId: asMutationId('v'), patch: {} })).toThrow(/empty patch/)
    })
  })

  describe('S5 refresh with pending edits', () => {
    it('re-applies queued and receipted outbox entries in queue order', () => {
      const { log, arm } = setup()
      const pending: OutboxPendingWrite[] = [
        { txId: asMutationId('q1'), kind: 'issueUpdate', input: { id: 'i1', patch: { title: 'Queued', color: 'red' } }, queuedAt: 1, acked: false },
        { txId: asMutationId('a1'), kind: 'issueMarkRead', input: { id: 'i1' }, queuedAt: Date.parse('2026-09-22T08:00:00Z'), acked: true, base: { readAt: null } },
        { txId: asMutationId('x1'), kind: 'rename', input: { sessionId: 's1', name: 'n' }, queuedAt: 2, acked: false },
      ]
      expect(pending.map((p) => arm.restore(p))).toEqual([true, true, false])
      expect(arm.row).toEqual({ ...SEED, title: 'Queued', readAt: '2026-09-22T08:00:00.000Z' })
      expect(arm.sent).toEqual([]) // the kernel replays its own queue; the arm never re-sends
      expect(log.pendingFor('issue', 'i1').map((e) => e.patch)).toEqual([
        { title: 'Queued' },
        { readAt: '2026-09-22T08:00:00.000Z' },
      ])
      // The server row as bootstrapped: the mark-read's echo already landed
      // before the reload, the rename has not reached the server.
      arm.remote({ ...SEED, readAt: '2026-09-22T08:00:00.050Z' })
      expect(log.pendingFor('issue', 'i1').map((e) => e.txId)).toEqual(['q1'])
      expect(arm.row).toEqual({ ...SEED, title: 'Queued', readAt: '2026-09-22T08:00:00.050Z' })
      arm.settle(asMutationId('q1')) // the kernel's replay drains it under the same id
      arm.remote({ ...SEED, title: 'Queued', readAt: '2026-09-22T08:00:00.050Z' })
      expect(log.size).toBe(0)
      expect(arm.row.title).toBe('Queued')
    })
  })

  describe('supersede and expiry', () => {
    it('a collapsed mark-read leaves without repaint; its successor carries the value', () => {
      const { log, arm } = setup()
      const t1 = arm.edit({ readAt: '2026-09-22T10:00:00.000Z' })
      const t2 = arm.edit({ readAt: '2026-09-22T10:00:05.000Z' })
      const commits = arm.commits.length
      arm.supersede(t1)
      expect(arm.commits).toHaveLength(commits)
      expect(log.pendingFor('issue', 'i1').map((e) => e.txId)).toEqual([t2])
    })

    it('a receipted edit whose echo never comes leaves after the TTL, showing server truth', () => {
      const { clock, log, arm } = setup()
      const before = arm.row
      const tx = arm.edit({ title: 'Lost' })
      clock.t = 5
      arm.settle(tx)
      clock.t = 5 + ECHO_TTL_MS - 1
      expect(arm.expire()).toEqual([])
      clock.t = 5 + ECHO_TTL_MS
      expect(arm.expire().map((o) => o?.left)).toEqual([[tx]])
      expect(log.size).toBe(0)
      expect(arm.row).toBe(before)
    })

    it('an unreceipted edit never expires (it may still be queued offline)', () => {
      const { clock, log, arm } = setup()
      arm.edit({ title: 'Offline' })
      clock.t = 10 * ECHO_TTL_MS
      expect(arm.expire()).toEqual([])
      expect(log.size).toBe(1)
    })
  })
})

describe('W3 edit -> kernel command', () => {
  it('title and stage ride issues.update; readAt rides issues.markRead', () => {
    expect(commandFor('issue', 'i1', { title: 'T' })).toEqual({ kind: 'issueUpdate', input: { id: 'i1', patch: { title: 'T' } } })
    expect(commandFor('issue', 'i1', { title: 'T', stage: 'review' })).toEqual({
      kind: 'issueUpdate',
      input: { id: 'i1', patch: { title: 'T', stage: 'review' } },
    })
    expect(commandFor('issue', 'i1', { readAt: '2026-09-22T00:00:00.000Z' })).toEqual({ kind: 'issueMarkRead', input: { id: 'i1' } })
    expect(OUTBOX_COMMANDS.issueUpdate.name).toBe('issues.update')
    expect(OUTBOX_COMMANDS.issueMarkRead.name).toBe('issues.markRead')
  })

  it('refuses a patch that is not one slice command, before any state changes', () => {
    const bad: unknown[] = [
      {},
      { color: 'red' },
      { title: undefined },
      { stage: 'done' },
      { stage: 'shipping' },
      { readAt: null },
      { readAt: '2026-09-22T00:00:00.000Z', title: 'T' },
    ]
    for (const patch of bad) expect(() => commandFor('issue', 'i1', patch as EditPatch<'issue'>)).toThrow(WriteContractError)
  })

  it('matches the kernel routing, park and TTL tables the rules rely on', () => {
    // Every slice edit shares the issue's partition, so same-row writes stay FIFO (W7).
    expect(OUTBOX_ROUTING.issueUpdate({ id: 'i1', patch: { title: 'T' } })).toEqual({ partitionKey: 'issue:i1' })
    // Only mark-read collapses, so only mark-read can be superseded (W9).
    expect(OUTBOX_ROUTING.issueMarkRead({ id: 'i1' })).toEqual({ partitionKey: 'issue:i1', collapseKey: 'issue-read:i1' })
    // A refused title parks (authored words); a refused stage snaps back; a refused read vanishes quietly.
    expect(shouldParkDeadLetter('issueUpdate', { id: 'i1', patch: { title: 'T' } })).toBe(true)
    expect(shouldParkDeadLetter('issueUpdate', { id: 'i1', patch: { stage: 'review' } })).toBe(false)
    expect(deadLetterHandlingFor('issueMarkRead')).toBe('discard-automatic')
    expect(ECHO_TTL_MS).toBe(AWAITING_TRUTH_TTL_MS)
  })
})
