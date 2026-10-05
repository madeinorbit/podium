import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { upsertIssue } from '../../../../shared/src/scenarios'

// @vitest-environment happy-dom
/**
 * POD-4587 (Hc2) — receipts, remote updates and rebuild with pending edits.
 *
 * - An echo with equal values settles with zero extra commits: edit paints
 *   one row, the receipt repaints nothing (the echo still has to confirm),
 *   and the echo carrying the pending value repaints nothing either (the
 *   display already shows it; PITFALL: never rewrite with an equal echo).
 * - A remote update on a pending row commits once with local fields
 *   preserved: the pending stage stays local while the remote title is taken.
 * - A duplicate receipt is a no-op: settling twice commits nothing and a late
 *   rejection after a settle is a no-op too.
 * - A rebuild with pending edits outstanding re-applies them: the rebuild
 *   overlays the pending display onto the feed's server rows, so it equals
 *   the live snapshot; and a fresh arm bootstraps the same pending entries
 *   from the outbox without re-sending.
 *
 * Truth feed (W12): server rows arrive without the kernel's ledger overlay,
 * so a remote value on a pending field is visible to the log. Server writes
 * go through the replica facade (projection + companion update, as
 * `gen/run.ts` does), so the feed emits them like any other server row.
 */

import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type {
  EditableStage,
  KernelCommand,
  OutboxPendingWrite,
  TxId,
  WriteEvent,
  WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { asMutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type HarnessWritableHandPoolHandle,
  harnessWritableHandPoolArm,
} from '../../../../harness/src/adapters/hand-pool'
import { mountArmForCounts, runCountScenario } from '../../../../harness/src/count-harness'
import { engineLocals, openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { type ScenarioEngine, startScenarioEngine } from '../../../../shared/src/scenarios'

interface FakeTransport extends WriteTransport {
  readonly sent: { txId: TxId; command: KernelCommand }[]
  readonly events: WriteEvent[]
  fire(event: WriteEvent): void
}

function fakeTransport(pending: readonly OutboxPendingWrite[] = []): FakeTransport {
  const sent: { txId: TxId; command: KernelCommand }[] = []
  const listeners = new Set<(event: WriteEvent) => void>()
  return {
    sent,
    events: [],
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending() {
      return pending
    },
    fire(event: WriteEvent) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/** The pool never auto-hydrates in these tests: loads land through the fence. */
const NEVER_AUTO = { schedule: () => () => {} } as const

/** Server truth for one issue's editable fields, through the replica facade. */
function serverWrite(
  ctx: ScenarioEngine,
  id: string,
  patch: { title?: string; stage?: string },
  opts: { stamp?: boolean } = {},
): void {
  const wire = ctx.cache.read('issueProjection', id)?.value as Record<string, unknown> | undefined
  if (!wire) throw new Error(`issue ${id} missing from the server cache`)
  const projection = (ctx.cache.read('issueProjection', id)?.value ?? {}) as Record<string, unknown>
  // An echo carries the pending value; the stamp is an independent server
  // change with its own redraw (foldAt follows updatedAt), so the
  // echo-equality steps preserve it to isolate the settle rule.
  const updatedAt = opts.stamp === false ? wire['updatedAt'] : ctx.stamp()
  ctx.replica.batch(() => {
    upsertIssue(ctx, id, { ...wire, ...patch, updatedAt })
  })
}

function titleOf(handle: HarnessWritableHandPoolHandle, id: string): string | undefined {
  return (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.title
}

function stageOf(handle: HarnessWritableHandPoolHandle, id: string): string | undefined {
  return (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.stage as string | undefined
}

describe('Hc2 hand receipts and remote updates', () => {
  it('an echo with equal values settles with zero extra commits', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      let tx: TxId = '' as TxId
      const edited = await runCountScenario(mounted, {
        scenario: 'handOptimisticEchoSettles',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Echo settles title' })
        },
        expected: baseline,
      })
      expect(titleOf(handle, id)).toBe('Echo settles title')
      expect(edited.rowsCommitted).toBe(1)
      expect(edited.commitsByRow).toEqual({ [id]: 1 })
      expect(edited.parity).toBe(false)
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)

      // The receipt alone confirms nothing: the echo still has to arrive.
      const receipted = await runCountScenario(mounted, {
        scenario: 'handOptimisticEchoReceipt',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(tx)
        },
        expected: baseline,
      })
      expect(receipted.rowsCommitted).toBe(0)
      expect(receipted.commitsByRow).toEqual({})
      expect(titleOf(handle, id)).toBe('Echo settles title')
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)

      // The echo carries the pending value: it settles the entry and paints
      // nothing (the display already shows it).
      const echoed = await runCountScenario(mounted, {
        scenario: 'handOptimisticEchoArrives',
        methodology: '#4-write',
        apply: () => {
          serverWrite(ctx, id, { title: 'Echo settles title' }, { stamp: false })
        },
        expected: baseline,
      })
      expect(echoed.rowsCommitted).toBe(0)
      expect(echoed.commitsByRow).toEqual({})
      expect(titleOf(handle, id)).toBe('Echo settles title')
      expect(write.log.size).toBe(0)
      // Settled: the row shows server truth now, so the engine oracle differs
      // only by the known gap rows, never by this row.
      expect(echoed.parityDiff ?? '').not.toContain(id)
      // The rebuild (pending-aware, nothing pending now) equals the snapshot.
      expect(handle.rebuildFromScratch()).toEqual(handle.snapshot())
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('a remote update on a pending row commits once with local fields preserved', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const serverStage = stageOf(handle, id) as string
      const pendingStage = (serverStage === 'review' ? 'in_progress' : 'review') as EditableStage
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      let tx: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'handOptimisticRemotePendingEdit',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { stage: pendingStage })
        },
        expected: baseline,
      })
      expect(stageOf(handle, id)).toBe(pendingStage)

      // Another writer renames the row: title is not pending, so the object
      // takes it (one redraw); stage is pending, so the object keeps ours and
      // the server value becomes the rewind target.
      const remote = await runCountScenario(mounted, {
        scenario: 'handOptimisticRemoteOnPending',
        methodology: '#4-write',
        apply: () => {
          serverWrite(ctx, id, { title: 'Theirs remote title' })
        },
        expected: baseline,
      })
      expect(remote.rowsCommitted).toBe(1)
      expect(remote.commitsByRow).toEqual({ [id]: 1 })
      expect(titleOf(handle, id)).toBe('Theirs remote title')
      expect(stageOf(handle, id)).toBe(pendingStage)
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)

      // The server moves the pending field itself to a THIRD value: the
      // display keeps the local value, and the new server value becomes the
      // rewind target (W5).
      const thirdStage = (['backlog', 'planning', 'in_progress', 'review'] as const).find(
        (s) => s !== serverStage && s !== pendingStage,
      ) as EditableStage
      await runCountScenario(mounted, {
        scenario: 'handOptimisticRemoteOnPendingField',
        methodology: '#4-write',
        apply: () => {
          serverWrite(ctx, id, { stage: thirdStage }, { stamp: false })
        },
        expected: baseline,
      })
      expect(stageOf(handle, id)).toBe(pendingStage)
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)

      // Rejecting now rewinds to the server value that landed while pending
      // — not to the edit-time value (a stale restore would show serverStage).
      await runCountScenario(mounted, {
        scenario: 'handOptimisticRemotePendingRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx, error: { message: 'refused', parked: false } })
        },
        expected: baseline,
      })
      expect(stageOf(handle, id)).toBe(thirdStage)
      expect(titleOf(handle, id)).toBe('Theirs remote title')
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('a duplicate receipt is a no-op', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      let tx: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateEdit',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Duplicate receipt title' })
        },
        expected: baseline,
      })
      await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateReceipt',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(tx)
        },
        expected: baseline,
      })
      await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateEcho',
        methodology: '#4-write',
        apply: () => {
          serverWrite(ctx, id, { title: 'Duplicate receipt title' }, { stamp: false })
        },
        expected: baseline,
      })
      expect(write.log.size).toBe(0)
      expect(titleOf(handle, id)).toBe('Duplicate receipt title')

      // The server dedupes a replayed send by mutation id and answers again.
      const dup = await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateReceiptAgain',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(tx)
        },
        expected: baseline,
      })
      expect(dup.rowsCommitted).toBe(0)
      expect(dup.commitsByRow).toEqual({})
      expect(titleOf(handle, id)).toBe('Duplicate receipt title')
      expect(write.log.size).toBe(0)
      // A receipt never re-sends: the kernel dedupes by mutation id itself.
      expect(transport.sent).toHaveLength(1)

      // A late rejection for a settled transaction is a no-op too.
      const late = await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateLateReject',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx, error: { message: 'late', parked: false } })
        },
        expected: baseline,
      })
      expect(late.rowsCommitted).toBe(0)
      expect(titleOf(handle, id)).toBe('Duplicate receipt title')

      // An unknown txId is always a no-op.
      const unknown = await runCountScenario(mounted, {
        scenario: 'handOptimisticDuplicateUnknown',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(asMutationId('no-such-tx'))
        },
        expected: baseline,
      })
      expect(unknown.rowsCommitted).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('a superseded mark-read leaves without repaint; the successor carries the value', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      const first = new Date(referenceState(ctx.engine).coarseNow).toISOString()
      let t1: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'handOptimisticSupersedeFirst',
        methodology: '#4-write',
        apply: () => {
          t1 = write.edit('issue', id, { readAt: first })
        },
        expected: baseline,
      })
      const second = new Date(referenceState(ctx.engine).coarseNow + 1).toISOString()
      let t2: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'handOptimisticSupersedeSecond',
        methodology: '#4-write',
        apply: () => {
          t2 = write.edit('issue', id, { readAt: second })
        },
        expected: baseline,
      })
      expect(write.log.pendingFor('issue', id)).toHaveLength(2)

      // The outbox collapses the still-queued first entry into the second
      // (W9): it leaves without repainting — the successor carries the value.
      const dropped = await runCountScenario(mounted, {
        scenario: 'handOptimisticSuperseded',
        methodology: '#4-write',
        apply: () => {
          write.handleSuperseded(t1)
        },
        expected: baseline,
      })
      expect(dropped.rowsCommitted).toBe(0)
      expect(dropped.commitsByRow).toEqual({})
      expect((handle.pool.inputs.issue(id) as SliceIssue | undefined)?.readAt).toBe(second)
      expect(write.log.pendingFor('issue', id).map((e) => e.txId)).toEqual([t2])

      // Rejecting the successor rewinds to server truth.
      await runCountScenario(mounted, {
        scenario: 'handOptimisticSupersedeRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: t2, error: { message: 'refused', parked: false } })
        },
        expected: baseline,
      })
      const server = (handle.pool.tables.issue.get(id) as SliceIssue | undefined)?.readAt ?? null
      expect((handle.pool.inputs.issue(id) as SliceIssue | undefined)?.readAt ?? null).toBe(server)
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('expiry never drops an unreceipted edit', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      let tx: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'handOptimisticExpireEdit',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Unexpired title' })
        },
        expected: baseline,
      })
      // Unreceipted edits never expire (W10): the TTL only bounds lost echoes.
      await runCountScenario(mounted, {
        scenario: 'handOptimisticExpireUnreceipted',
        methodology: '#4-write',
        apply: () => {
          write.expire()
        },
        expected: baseline,
      })
      expect(titleOf(handle, id)).toBe('Unexpired title')
      expect(write.log.pendingFor('issue', id).map((e) => e.txId)).toEqual([tx])
      // A receipted edit whose echo is still within its TTL stays too.
      await runCountScenario(mounted, {
        scenario: 'handOptimisticExpireReceipted',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(tx)
          write.expire()
        },
        expected: baseline,
      })
      expect(titleOf(handle, id)).toBe('Unexpired title')
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('a rebuild with pending edits re-applies them and shows the pending value', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx))

      await runCountScenario(mounted, {
        scenario: 'handOptimisticRebuildPendingEdit',
        methodology: '#4-write',
        apply: () => {
          write.edit('issue', id, { title: 'Pending rebuild title' })
        },
        expected: baseline,
      })
      // Live and rebuild agree on the pending display — never on server
      // truth while an edit is outstanding.
      expect(handle.snapshot().rowsById[id]?.title).toBe('Pending rebuild title')
      expect(handle.rebuildFromScratch()).toEqual(handle.snapshot())
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)

  it('pending edits survive a principal-preserving rebuild from the outbox', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const id = ctx.targets.visibleRootId
    const serverTitle = ctx.cache.read('issueProjection', id)?.value as
      | Record<string, unknown>
      | undefined
    expect(typeof serverTitle?.['title']).toBe('string')

    // The outbox still holds the queued rename under its mutation id; the
    // arm re-applies it on creation without re-sending.
    const pending: OutboxPendingWrite[] = [
      {
        txId: asMutationId('q-bootstrap-1'),
        kind: 'issueUpdate',
        input: { id, patch: { title: 'Bootstrapped title' } },
        queuedAt: 1,
        acked: false,
      },
    ]
    const transport = fakeTransport(pending)
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      expect(titleOf(handle, id)).toBe('Bootstrapped title')
      expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
      expect(transport.sent).toEqual([])
      expect(handle.rebuildFromScratch()).toEqual(handle.snapshot())
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)
})
