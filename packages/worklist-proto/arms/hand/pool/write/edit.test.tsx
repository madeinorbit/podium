import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom
/**
 * POD-4586 (Hc1) — optimistic edits on the hand-rolled pool's in-memory objects.
 *
 * - A title rename paints in one commit of that row, within the reads budget.
 * - A rejection rewinds in one commit, restores the prior value, and surfaces
 *   the error via `onRejected`.
 * - A rejected stage change leaves relations and order consistent (the order
 *   equals the oracle's before, during, and after; the relation check is empty).
 * - Mark-read rides `issues.markRead` and rewinds to null.
 *
 * Truth feed (W12): the kernel's fold still runs for the legacy app, so an
 * `overlaid` feed would deliver the same patch twice. The L4b regression run
 * stays `overlaid` with the layer idle (see `gate-with-edits.test.ts`).
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { mountArmForCounts, runCountScenario } from '../../../../harness/src/count-harness'
import { engineLocals, openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { startScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type {
  EditableStage,
  KernelCommand,
  TxId,
  WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { commandFor } from '@podium/client-graph/shared/write-contract'
import { diffRelations, knownTables } from '../enumerate'
import {
  harnessWritableHandPoolArm,
  snapshotPool,
  type HarnessWritableHandPoolHandle,
} from '../../../../harness/src/adapters/hand-pool'

interface FakeTransport extends WriteTransport {
  readonly sent: { txId: TxId; command: KernelCommand }[]
}

function fakeTransport(): FakeTransport {
  const sent: { txId: TxId; command: KernelCommand }[] = []
  return {
    sent,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe() {
      return () => {}
    },
    pending() {
      return []
    },
  }
}

/** The pool never auto-hydrates in these tests: loads land through the fence. */
const NEVER_AUTO = { schedule: () => () => {} } as const

describe('Hc1 hand edits on the model', () => {
  it('a title rename paints in one commit of that row, within budget', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const before = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      expect(before).toBeDefined()

      const edited = await runCountScenario(mounted, {
        scenario: 'handOptimisticRename',
        methodology: '#4-write',
        apply: () => {
          write.edit('issue', id, { title: 'Renamed visible row' })
        },
        expected: () => snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx)),
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Renamed visible row')
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0]!.command).toEqual(commandFor('issue', id, { title: 'Renamed visible row' }))
      expect(transport.sent[0]!.command.kind).toBe('issueUpdate')
      expect(edited.rowsCommitted).toBe(1)
      expect(edited.commitsByRow).toEqual({ [id]: 1 })
      expect(edited.readsPerChange).not.toBeNull()
      expect(edited.readsPerChange!).toBeLessThanOrEqual(3)
      // Optimism paints ahead of server truth: the server oracle still shows
      // the old title, so parity is false while pending.
      expect(edited.parity).toBe(false)
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a rejection rewinds in one commit and surfaces the error', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const priorTitle = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      const errors: { txId: TxId; message: string }[] = []
      write.onRejected((rejection) => {
        errors.push({ txId: rejection.txId, message: rejection.error.message })
      })

      let tx: TxId | null = null
      // The pre-edit snapshot: the pending paint must move it, the rewind
      // must restore it exactly (the engine oracle carries the known
      // unscanned-worktree gap, so it cannot serve as the restore target).
      const baseline = mounted.handle.snapshot()
      await runCountScenario(mounted, {
        scenario: 'handOptimisticRenamePending',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Rejected title' })
        },
        expected: () => baseline,
      }).then((pending) => {
        expect(pending.parity).toBe(false)
      })
      expect(tx).not.toBeNull()
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Rejected title')

      const rewound = await runCountScenario(mounted, {
        scenario: 'handOptimisticRenameRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx!, error: { message: 'refused (CONFLICT)', code: 'CONFLICT', parked: true } })
        },
        expected: () => baseline,
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe(priorTitle)
      expect(rewound.rowsCommitted).toBe(1)
      expect(rewound.commitsByRow).toEqual({ [id]: 1 })
      expect(rewound.parity).toBe(true)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.txId).toBe(tx)
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a rejected stage change leaves relations and order consistent', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const serverStage = (handle.pool.inputs.issue(id) as SliceIssue)?.stage as string
      const nextStage = (serverStage === 'review' ? 'in_progress' : 'review') as EditableStage

      const orderOf = (): string[] => Object.keys(mounted.handle.snapshot().rowsById).sort()
      const oracleOrderOf = (): string[] =>
        Object.keys(snapshotFromStore(referenceState(ctx.engine), engineLocals(ctx)).rowsById).sort()
      const relationsOf = (): string[] =>
        diffRelations(handle.pool.engine, knownTables(feeds.rows.source))

      const orderBefore = orderOf()
      expect(orderBefore).toEqual(oracleOrderOf())
      expect(relationsOf()).toEqual([])

      let tx: TxId = '' as TxId
      await act(async () => {
        tx = write.edit('issue', id, { stage: nextStage })
      })
      expect(transport.sent[0]!.command.kind).toBe('issueUpdate')
      // The edit is optimism only: the server oracle is unchanged, and the
      // pool's relations still resolve from scratch.
      expect(orderOf()).toEqual(oracleOrderOf())
      expect(relationsOf()).toEqual([])

      await act(async () => {
        write.reject({ txId: tx, error: { message: 'refused (CONFLICT)', parked: false } })
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.stage).toBe(serverStage)
      // Rewound re-sorts back: the visible order is the oracle's again and no
      // relation diverges from its scan.
      expect(orderOf()).toEqual(oracleOrderOf())
      expect(orderOf()).toEqual(orderBefore)
      expect(relationsOf()).toEqual([])
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('mark-read rides issues.markRead and rewinds to null', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      // The visible root: the mark-read paints a stamp, the rewind restores
      // whatever the server holds (null or an older stamp).
      const id = ctx.targets.visibleRootId

      const stamp = new Date(referenceState(ctx.engine).coarseNow).toISOString()
      let tx: TxId = '' as TxId
      await act(async () => {
        tx = write.edit('issue', id, { readAt: stamp })
      })
      expect(transport.sent[0]!.command.kind).toBe('issueMarkRead')
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.readAt).toBe(stamp)

      await act(async () => {
        write.reject({ txId: tx, error: { message: 'discarded', parked: false } })
      })
      const after = (handle.pool.inputs.issue(id) as SliceIssue)?.readAt ?? null
      const server = (handle.pool.tables.issue.get(id) as SliceIssue | undefined)?.readAt ?? null
      expect(after).toBe(server)
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a stacked rejection reveals the older pending value', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const prior = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      let t1: TxId = '' as TxId
      let t2: TxId = '' as TxId
      await act(async () => {
        t1 = write.edit('issue', id, { title: 'First pending' })
      })
      await act(async () => {
        t2 = write.edit('issue', id, { title: 'Second pending' })
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Second pending')
      await act(async () => {
        write.reject({ txId: t2, error: { message: 'refused', parked: true } })
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('First pending')
      await act(async () => {
        write.reject({ txId: t1, error: { message: 'refused', parked: true } })
      })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe(prior)
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a plant that rewinds to the current value instead of the kept prior is caught', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = mounted.handle.snapshot()
      const priorTitle = (handle.pool.inputs.issue(id) as SliceIssue)?.title

      const tx = await act(async () => write.edit('issue', id, { title: 'Planted title' }))
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Planted title')

      // PLANT: the log entry is removed but the overlay refresh is skipped —
      // exactly what a reject() that rewinds to the CURRENT display instead
      // of the kept prior leaves behind (the cp-mutant in NOTES). The stale
      // pending value stays painted with an empty log.
      await act(async () => {
        write.log.reject({ txId: tx, error: { message: 'refused', parked: false } })
      })
      expect(write.log.size).toBe(0)
      // The rewind did not happen: the row still shows the planted value,
      // and the snapshot diverges from the pre-edit baseline where a true
      // rewind converges (the rewind test above asserts parity there).
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Planted title')
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).not.toBe(priorTitle)
      expect(mounted.handle.snapshot()).not.toEqual(baseline)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('editing an unknown issue throws before any state changes', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableHandPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableHandPoolHandle
      const write = handle.write
      expect(() => write.edit('issue', 'i-does-not-exist', { title: 'x' })).toThrow()
      expect(transport.sent).toHaveLength(0)
      expect(write.log.size).toBe(0)
      expect(() => write.edit('issue', ctx.targets.visibleRootId, {} as never)).toThrow()
      expect(snapshotPool(handle.pool)).toBeDefined()
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
