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
 *
 * Truth feed (W12): the kernel's fold still runs for the legacy app, so an
 * `overlaid` feed would deliver the same patch twice. The L4b regression run
 * stays `overlaid` with the layer idle (see `gate-with-edits.test.ts`).
 */

import { describe, expect, it } from 'vitest'
import { mountArmForCounts, runCountScenario } from '../../../../harness/src/count-harness'
import { engineLocals, openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { rowViewsFromStore, snapshotFromStore } from '../../../../harness/src/oracle/index'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { startScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { KernelCommand, TxId, WriteTransport } from '../../../../shared/src/write-contract'
import { commandFor } from '../../../../shared/src/write-contract'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { diffRelations, knownTables } from '../enumerate'
import { installMobxWarnTrap } from '../mobx-trap'
import { tracked } from '../pool'
import { runInAction } from 'mobx'
import { createMobxWriteApi, type MobxWriteApi } from './edit'

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

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

/** A pool arm with the Mc1 write layer attached and the feed wired to its log. */
function writableArm(transport: FakeTransport): CheckableArm & {
  writeOf(handle: { pool: MobxPoolHandle['pool'] }): MobxWriteApi
} {
  let write: MobxWriteApi | null = null
  return {
    writeOf() {
      if (write === null) throw new Error('[write-test] no write layer yet')
      return write
    },
    create(source, locals, reads) {
      const handle = mobxPoolArm.create(source, locals, reads, {
        schedule: () => () => {},
      }) as MobxPoolHandle
      const api = createMobxWriteApi(handle.pool, transport)
      write = api
      const off = source.subscribe((event) => {
        for (const row of event.rows) {
          if (row.kind !== 'issue' || row.value === undefined) continue
          api.handleRemote('issue', row.id, editableOf(row.value as SliceIssue))
        }
      })
      const originalDispose = handle.dispose.bind(handle)
      return {
        ...handle,
        dispose() {
          off()
          api.dispose()
          originalDispose()
        },
      }
    },
  } as CheckableArm & { writeOf(handle: { pool: MobxPoolHandle['pool'] }): MobxWriteApi }
}

describe('Mc1 MobX edits on the model', () => {
  it('a title rename paints in one commit of that row, within budget', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle & { write?: MobxWriteApi }
      const write = arm.writeOf(handle)
      const id = ctx.targets.visibleRootId
      const before = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      expect(before).toBeDefined()

      const edited = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRename',
        methodology: '#4-write',
        apply: () => {
          write.edit('issue', id, { title: 'Renamed visible row' })
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
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
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle
      const write = arm.writeOf(handle)
      const id = ctx.targets.visibleRootId
      const priorTitle = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      const errors: { txId: TxId; message: string }[] = []
      write.onRejected((rejection) => {
        errors.push({ txId: rejection.txId, message: rejection.error.message })
      })

      let tx: TxId | null = null
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRenamePending',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Rejected title' })
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(tx).not.toBeNull()
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Rejected title')

      const rewound = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRenameRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx!, error: { message: 'refused (CONFLICT)', code: 'CONFLICT', parked: true } })
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
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
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle
      const write = arm.writeOf(handle)
      const id = ctx.targets.visibleRootId
      const serverStage = (handle.pool.inputs.issue(id) as SliceIssue)?.stage as string
      const nextStage = serverStage === 'review' ? 'in_progress' : 'review'

      const orderOf = (): string[] => Object.keys(mounted.handle.snapshot().rowsById).sort()
      const oracleOrderOf = (): string[] =>
        Object.keys(snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)).rowsById).sort()
      const relationsOf = (): string[] =>
        runInAction(() => diffRelations(handle.pool.graph, knownTables(handle.pool, feeds.rows.source)))

      const orderBefore = orderOf()
      expect(orderBefore).toEqual(oracleOrderOf())
      expect(relationsOf()).toEqual([])

      const tx = write.edit('issue', id, { stage: nextStage as 'review' })
      expect(transport.sent[0]!.command.kind).toBe('issueUpdate')
      // The edit is optimism only: the server oracle is unchanged, and the
      // pool's relations still resolve from scratch.
      expect(orderOf()).toEqual(oracleOrderOf())
      expect(relationsOf()).toEqual([])

      write.reject({ txId: tx, error: { message: 'refused (CONFLICT)', parked: false } })
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
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle
      const write = arm.writeOf(handle)
      // An unread visible row: the mark-read paints a stamp, the rewind clears it.
      const views = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
      const id = ctx.targets.markReadId
      expect(views[id]).toBeDefined()

      const stamp = new Date(ctx.engine.getSnapshot().coarseNow).toISOString()
      const tx = write.edit('issue', id, { readAt: stamp })
      expect(transport.sent[0]!.command.kind).toBe('issueMarkRead')
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.readAt).toBe(stamp)

      write.reject({ txId: tx, error: { message: 'discarded', parked: false } })
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
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle
      const write = arm.writeOf(handle)
      const id = ctx.targets.visibleRootId
      const prior = (handle.pool.inputs.issue(id) as SliceIssue)?.title
      const t1 = write.edit('issue', id, { title: 'First pending' })
      const t2 = write.edit('issue', id, { title: 'Second pending' })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('Second pending')
      write.reject({ txId: t2, error: { message: 'refused', parked: true } })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe('First pending')
      write.reject({ txId: t1, error: { message: 'refused', parked: true } })
      expect((handle.pool.inputs.issue(id) as SliceIssue)?.title).toBe(prior)
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
    const arm = writableArm(transport)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as MobxPoolHandle
      const write = arm.writeOf(handle)
      expect(() => write.edit('issue', 'i-does-not-exist', { title: 'x' })).toThrow()
      expect(transport.sent).toHaveLength(0)
      expect(write.log.size).toBe(0)
      expect(() => write.edit('issue', ctx.targets.visibleRootId, {} as never)).toThrow()
      expect(tracked(() => handle.pool.snapshot())).toBeDefined()
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
