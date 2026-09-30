// @vitest-environment happy-dom
/**
 * POD-4573 (Mc1) — optimistic edits on the MobX pool's in-memory objects.
 *
 * - A title rename paints in one commit of that row, within the reads budget.
 * - A rejection rewinds in one commit, restores the prior value, and surfaces
 *   the error via `onRejected`.
 * - A rejected stage change leaves relations and order consistent (the order
 *   equals the oracle's before, during, and after; the relation check is empty).
 * - Mark-read rides `issues.markRead` and rewinds to null.
 * - The model's setters (`issue.title = x`, `issue.update({...})`) are one
 *   transaction each and paint their row once; without a write layer they throw.
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
import { commandFor, WriteContractError } from '@podium/client-graph/shared/write-contract'
import { harnessMobxPoolArm, harnessWritableMobxPoolArm, poolPendingLoads, snapshotPool, tracked, type HarnessWritableMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { diffRelations, knownTables } from '../../../../harness/src/adapters/mobx-rebuild'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import { reaction, runInAction } from 'mobx'
import { rowViewOf } from '@podium/client-graph/models'
import type { RowSource } from '../../../../shared/src/arm'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { MobxPool } from '@podium/client-graph/pool'
import { createMobxWriteApi } from '@podium/client-graph/write/edit'
import { PendingOverlay } from '@podium/client-graph/write/overlay'

installMobxWarnTrap()

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

describe('Mc1 MobX edits on the model', () => {
  it('a title rename paints in one commit of that row, within budget', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const before = tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)
      expect(before).toBeDefined()

      const edited = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRename',
        methodology: '#4-write',
        apply: () => {
          write.edit('issue', id, { title: 'Renamed visible row' })
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
      })
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(
        'Renamed visible row',
      )
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const priorTitle = tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)
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
        scenario: 'mobxOptimisticRenamePending',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Rejected title' })
        },
        expected: () => baseline,
      }).then((pending) => {
        expect(pending.parity).toBe(false)
      })
      expect(tx).not.toBeNull()
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(
        'Rejected title',
      )

      const rewound = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRenameRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx!, error: { message: 'refused (CONFLICT)', code: 'CONFLICT', parked: true } })
        },
        expected: () => baseline,
      })
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(priorTitle)
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const serverStage = tracked(
        () => (handle.pool.inputs.issue(id) as SliceIssue)?.stage as string,
      )
      const nextStage = (serverStage === 'review' ? 'in_progress' : 'review') as EditableStage

      const orderOf = (): string[] => Object.keys(mounted.handle.snapshot().rowsById).sort()
      const oracleOrderOf = (): string[] =>
        Object.keys(snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)).rowsById).sort()
      const relationsOf = (): string[] =>
        runInAction(() => diffRelations(handle.pool.graph, knownTables(handle.pool, feeds.rows.source)))

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
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.stage)).toBe(serverStage)
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      // The visible root: the mark-read paints a stamp, the rewind restores
      // whatever the server holds (null or an older stamp).
      const id = ctx.targets.visibleRootId

      const stamp = new Date(ctx.engine.getSnapshot().coarseNow).toISOString()
      let tx: TxId = '' as TxId
      await act(async () => {
        tx = write.edit('issue', id, { readAt: stamp })
      })
      expect(transport.sent[0]!.command.kind).toBe('issueMarkRead')
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.readAt)).toBe(stamp)

      await act(async () => {
        write.reject({ txId: tx, error: { message: 'discarded', parked: false } })
      })
      const after = tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.readAt ?? null)
      const server = tracked(
        () => (handle.pool.tables.issue.get(id) as SliceIssue | undefined)?.readAt ?? null,
      )
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const prior = tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)
      let t1: TxId = '' as TxId
      let t2: TxId = '' as TxId
      await act(async () => {
        t1 = write.edit('issue', id, { title: 'First pending' })
      })
      await act(async () => {
        t2 = write.edit('issue', id, { title: 'Second pending' })
      })
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(
        'Second pending',
      )
      await act(async () => {
        write.reject({ txId: t2, error: { message: 'refused', parked: true } })
      })
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(
        'First pending',
      )
      await act(async () => {
        write.reject({ txId: t1, error: { message: 'refused', parked: true } })
      })
      expect(tracked(() => (handle.pool.inputs.issue(id) as SliceIssue)?.title)).toBe(prior)
      expect(write.log.size).toBe(0)
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      expect(() => write.edit('issue', 'i-does-not-exist', { title: 'x' })).toThrow()
      expect(transport.sent).toHaveLength(0)
      expect(write.log.size).toBe(0)
      expect(() => write.edit('issue', ctx.targets.visibleRootId, {} as never)).toThrow()
      // snapshot() settles through its own tracked context; wrapping it in
      // another tracked() would observe nothing and trip enforcement.
      expect(snapshotPool(handle.pool)).toBeDefined()
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})

/**
 * POD-4753: an edit on a row that is not in memory. The pool's one reader
 * answers LOADING and queues the row; the edit is refused while it loads (no
 * read by id, nothing painted, logged or sent), exactly that row is asked for
 * in one window, and once it lands the same edit leaves the pool as an
 * all-in-memory pool's edit leaves it.
 */
describe('an edit on a row not in memory', () => {
  it('is refused while the row loads, asks for exactly that row in one batch, then edits as if it had been in memory', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const loads: string[] = []
    const counted: RowSource = {
      snapshot: (kind) => feeds.rows.source.snapshot(kind),
      subscribe: (listener) => feeds.rows.source.subscribe(listener),
      row: (kind, id) => {
        loads.push(`${kind}:${id}`)
        return feeds.rows.source.row?.(kind, id)
      },
    }
    const windows: { run: () => void; cancelled: boolean }[] = []
    const lazyTransport = fakeTransport()
    const lazy = harnessWritableMobxPoolArm(lazyTransport, {
      schedule: (run) => {
        const timer = { run, cancelled: false }
        windows.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
    }).create(counted, feeds.locals.source) as HarnessWritableMobxPoolHandle
    // The all-in-memory pool: no residency, every row in its tables.
    const overlay = new PendingOverlay()
    const full = new MobxPool(feeds.locals.source.get(), undefined, undefined, overlay)
    full.apply({
      type: 'replace',
      rows: [
        ...feeds.rows.source.snapshot('session'),
        ...feeds.rows.source.snapshot('issue'),
        ...feeds.rows.source.snapshot('worktree'),
      ],
    })
    const fullTransport = fakeTransport()
    const fullWrite = createMobxWriteApi(full, overlay, fullTransport)
    try {
      const pool = lazy.pool
      // A closed issue the list does not show: cold by the rule.
      const id = pool.residency?.ids('issue')[0] as string
      expect(id).toBeDefined()
      expect(pool.residency?.isCold('issue', id)).toBe(true)
      loads.length = 0
      const patch = { title: 'Renamed while closed' }

      for (const attempt of [1, 2]) {
        expect(() => lazy.write.edit('issue', id, patch), `attempt ${attempt}`).toThrow(
          WriteContractError,
        )
        expect(() => lazy.write.edit('issue', id, patch)).toThrow(/is loading/)
      }
      // Nothing read by id, painted, logged or sent; exactly that row asked
      // for, in one window.
      expect(loads).toEqual([])
      expect(lazy.write.log.size).toBe(0)
      expect(lazyTransport.sent).toEqual([])
      expect(tracked(() => pool.resident('issue', id))).toBe('loading')
      expect(poolPendingLoads(pool)).toBe(1)
      expect(windows.filter((timer) => !timer.cancelled)).toHaveLength(1)

      // The window closes: the row lands in one batch, read once.
      const open = windows.find((timer) => !timer.cancelled)
      open!.cancelled = true
      open!.run()
      expect(loads).toEqual([`issue:${id}`])
      expect(tracked(() => pool.resident('issue', id))).toBe('resident')

      // The same edit now, and on the all-in-memory pool.
      lazy.write.edit('issue', id, patch)
      fullWrite.edit('issue', id, patch)
      expect(tracked(() => pool.row('issue', id))).toEqual(tracked(() => full.row('issue', id)))
      const entries = (log: typeof fullWrite.log) =>
        log.pendingFor('issue', id).map((entry) => ({ patch: entry.patch, prior: entry.prior }))
      expect(entries(lazy.write.log)).toEqual(entries(fullWrite.log))
      expect(entries(lazy.write.log)).toHaveLength(1)
      expect(lazyTransport.sent.map((sent) => sent.command)).toEqual(
        fullTransport.sent.map((sent) => sent.command),
      )
      expect(loads).toEqual([`issue:${id}`])
    } finally {
      fullWrite.dispose()
      full.dispose()
      lazy.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})

/**
 * Linear's edit shape on the model itself: `issue.title = x` and
 * `issue.update({...})` are the write layer's `edit` (one transaction of its
 * log: paint, remember, send), and reading the field back shows the pending
 * value through the pool's one reader.
 */
describe('model edit setters', () => {
  it('issue.title = x is one transaction and paints its row once', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      // What the first paint asked for lands first (the drawn rows' closed
      // families, POD-4754), so no load lands inside the measured step.
      act(() => {
        handle.settleLoads()
      })
      const id = ctx.targets.visibleRootId
      const issue = tracked(() => handle.pool.issue(id))
      if (issue === undefined) throw new Error('the visible root has a model')
      const serverTitle = tracked(() => issue.title)
      // Every paint of the row's view, as its observer sees it (React batches
      // a whole step into one commit, so the commit count alone cannot see an
      // interim paint).
      const paints: (string | undefined)[] = []
      const stop = reaction(
        () => rowViewOf(issue),
        (view) => paints.push(view?.title),
      )

      const edited = await runCountScenario(mounted, {
        scenario: 'mobxModelSetter',
        methodology: '#4-write',
        apply: () => {
          issue.title = 'Set on the model'
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
      })
      stop()
      // One transaction: one command sent, one pending edit in the log.
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0]!.command).toEqual(
        commandFor('issue', id, { title: 'Set on the model' }),
      )
      expect(handle.write.log.size).toBe(1)
      expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
      // One paint: that row's view changed once, and only that row committed.
      expect(paints).toEqual(['Set on the model'])
      expect(edited.rowsCommitted).toBe(1)
      expect(edited.commitsByRow).toEqual({ [id]: 1 })
      // Reading back shows the pending value (the one reader), as the row does.
      expect(tracked(() => issue.title)).toBe('Set on the model')
      expect(tracked(() => rowViewOf(handle.pool.issue(id))?.title)).toBe('Set on the model')
      expect(serverTitle).not.toBe('Set on the model')
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('issue.update({...}) is one transaction for every field it names', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const id = ctx.targets.visibleRootId
      const issue = tracked(() => handle.pool.issue(id))
      if (issue === undefined) throw new Error('the visible root has a model')
      const stage: EditableStage = tracked(() => issue.stage) === 'review' ? 'in_progress' : 'review'

      let tx: TxId | null = null
      const edited = await runCountScenario(mounted, {
        scenario: 'mobxModelUpdate',
        methodology: '#4-write',
        apply: () => {
          tx = issue.update({ title: 'Updated on the model', stage })
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
      })
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0]!.txId).toBe(tx)
      expect(transport.sent[0]!.command).toEqual(
        commandFor('issue', id, { title: 'Updated on the model', stage }),
      )
      expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
      expect(edited.commitsByRow[id]).toBe(1)
      expect(tracked(() => [issue.title, issue.stage])).toEqual(['Updated on the model', stage])
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a pool without a write layer refuses a model edit and changes nothing', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, NEVER_AUTO)
    try {
      const id = ctx.targets.visibleRootId
      const issue = tracked(() => handle.pool.issue(id))
      if (issue === undefined) throw new Error('the visible root has a model')
      const title = tracked(() => issue.title)
      expect(() => {
        issue.title = 'Nowhere to go'
      }).toThrow(WriteContractError)
      expect(tracked(() => issue.title)).toBe(title)
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
