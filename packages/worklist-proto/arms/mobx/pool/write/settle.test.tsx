// @vitest-environment happy-dom
/**
 * POD-4574 (Mc2) — receipts, remote updates and rebuild with pending edits.
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
 * go through the replica facade (wire + projection dual-write, as
 * `gen/run.ts` does), so the feed emits them like any other server row.
 */

import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { asMutationId } from '@podium/model'
import { mountArmForCounts, runCountScenario } from '../../../../harness/src/count-harness'
import { engineLocals, openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { startScenarioEngine, upsert, type ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type {
  EditableStage,
  KernelCommand,
  OutboxPendingWrite,
  TxId,
  WriteEvent,
  WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { ECHO_TTL_MS } from '@podium/client-graph/shared/write-contract'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import { harnessMobxPoolArm, harnessWritableMobxPoolArm, tracked, type HarnessMobxPoolHandle, type HarnessWritableMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { createMobxWriteApi, type MobxWriteApi } from '@podium/client-graph/write/edit'
import { PendingOverlay } from '@podium/client-graph/write/overlay'

installMobxWarnTrap()

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
  const wire = ctx.cache.read('issue', id)?.value as Record<string, unknown> | undefined
  if (!wire) throw new Error(`issue ${id} missing from the server cache`)
  const projection = (ctx.cache.read('issueProjection', id)?.value ?? {}) as Record<string, unknown>
  // An echo carries the pending value; the stamp is an independent server
  // change with its own redraw (foldAt follows updatedAt), so the
  // echo-equality steps preserve it to isolate the settle rule.
  const updatedAt = opts.stamp === false ? wire['updatedAt'] : ctx.stamp()
  ctx.replica.batch(() => {
    upsert(ctx, 'issue', id, { ...wire, ...patch, updatedAt })
    upsert(ctx, 'issueProjection', id, { ...projection, ...patch, updatedAt })
  })
}

function titleOf(handle: HarnessWritableMobxPoolHandle, id: string): string | undefined {
  return tracked(() => (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.title)
}

function stageOf(handle: HarnessWritableMobxPoolHandle, id: string): string | undefined {
  return tracked(() => (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.stage as string | undefined)
}

describe('Mc2 MobX receipts and remote updates', () => {
  it('an echo with equal values settles with zero extra commits', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))

      let tx: TxId = '' as TxId
      const edited = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticEchoSettles',
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
        scenario: 'mobxOptimisticEchoReceipt',
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
        scenario: 'mobxOptimisticEchoArrives',
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
      // only by the known POD-4671 gap row, never by this row.
      expect(echoed.parityDiff ?? '').not.toContain(id)
      // The rebuild (pending-aware, nothing pending now) equals the snapshot.
      expect(handle.rebuildFromScratch()).toEqual(handle.snapshot())
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a remote update on a pending row commits once with local fields preserved', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const serverStage = stageOf(handle, id) as string
      const pendingStage = (serverStage === 'review' ? 'in_progress' : 'review') as EditableStage
      const baseline = () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))

      let tx: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRemotePendingEdit',
        methodology: '#4-write',
        apply: () => {
          // Stage is not drawn: the pending edit paints no row.
          tx = write.edit('issue', id, { stage: pendingStage })
        },
        expected: baseline,
      })
      expect(stageOf(handle, id)).toBe(pendingStage)

      // Another writer renames the row: title is not pending, so the object
      // takes it (one redraw); stage is pending, so the object keeps ours and
      // the server value becomes the rewind target.
      const remote = await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRemoteOnPending',
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

      // Rejecting now rewinds to the server value that landed while pending.
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRemotePendingRejected',
        methodology: '#4-write',
        apply: () => {
          write.reject({ txId: tx, error: { message: 'refused', parked: false } })
        },
        expected: baseline,
      })
      expect(stageOf(handle, id)).toBe(serverStage)
      expect(titleOf(handle, id)).toBe('Theirs remote title')
      expect(write.log.size).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a duplicate receipt is a no-op', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))

      let tx: TxId = '' as TxId
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticDuplicateEdit',
        methodology: '#4-write',
        apply: () => {
          tx = write.edit('issue', id, { title: 'Duplicate receipt title' })
        },
        expected: baseline,
      })
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticDuplicateReceipt',
        methodology: '#4-write',
        apply: () => {
          write.handleAccepted(tx)
        },
        expected: baseline,
      })
      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticDuplicateEcho',
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
        scenario: 'mobxOptimisticDuplicateReceiptAgain',
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
        scenario: 'mobxOptimisticDuplicateLateReject',
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
        scenario: 'mobxOptimisticDuplicateUnknown',
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
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a rebuild with pending edits re-applies them and shows the pending value', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const transport = fakeTransport()
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      const write = handle.write
      const id = ctx.targets.visibleRootId
      const baseline = () => snapshotFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))

      await runCountScenario(mounted, {
        scenario: 'mobxOptimisticRebuildPendingEdit',
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
      ctx.engine.destroy()
    }
  }, 120_000)

  it('pending edits survive a principal-preserving rebuild from the outbox', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const id = ctx.targets.visibleRootId
    const serverTitle = ctx.cache.read('issue', id)?.value as Record<string, unknown> | undefined
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
    const arm = harnessWritableMobxPoolArm(transport, NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as HarnessWritableMobxPoolHandle
      expect(titleOf(handle, id)).toBe('Bootstrapped title')
      expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
      expect(transport.sent).toEqual([])
      expect(handle.rebuildFromScratch()).toEqual(handle.snapshot())
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})

/**
 * POD-4742 — the W10 expiry timer: a receipted edit whose echo never arrives
 * is dropped at the TTL and the row shows server truth again.
 *
 * The api owns its timer, driven here by a manual clock (no fake timers):
 * while at least one receipted edit is pending it is armed for the earliest
 * receipt + `ECHO_TTL_MS`, and firing only calls `expire()`. The stack is the
 * pool with the write api over it and the arm's feed wiring mirrored, so an
 * echo settles through `handleRemote` exactly as in the arm.
 */
describe('MobX edit expiry timer (W10)', () => {
  /** A manual clock + timer queue for the api's `schedule`/`now` opts. */
  function manualClock() {
    let t = 1_000_000
    let next = 1
    const timers = new Map<number, { run: () => void; at: number }>()
    return {
      now: (): number => t,
      schedule: (run: () => void, ms: number): (() => void) => {
        const id = next++
        timers.set(id, { run, at: t + ms })
        return () => {
          timers.delete(id)
        }
      },
      pending: (): number => timers.size,
      advance: (ms: number): void => {
        const target = t + ms
        for (;;) {
          let best: number | null = null
          for (const [id, timer] of timers) {
            if (timer.at <= target && (best === null || timer.at < timers.get(best)!.at)) best = id
          }
          if (best === null) break
          const timer = timers.get(best)!
          timers.delete(best)
          t = timer.at
          timer.run()
        }
        t = target
      },
    }
  }

  interface ExpiryStack {
    readonly ctx: ScenarioEngine
    readonly id: string
    readonly pool: HarnessMobxPoolHandle['pool']
    readonly write: MobxWriteApi
    readonly clock: ReturnType<typeof manualClock>
    readonly feeds: ReturnType<typeof openFenceFeeds>
    readonly serverTitle: string
  }

  function titleOfStack(stack: ExpiryStack): string | undefined {
    return tracked(() => (stack.pool.inputs.issue(stack.id) as SliceIssue | undefined)?.title)
  }

  async function withExpiryStack(run: (stack: ExpiryStack) => Promise<void>): Promise<void> {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const clock = manualClock()
    const overlay = new PendingOverlay()
    const handle = harnessMobxPoolArm.create(
      feeds.rows.source,
      feeds.locals.source,
      undefined,
      NEVER_AUTO,
      overlay,
    )
    const write = createMobxWriteApi(handle.pool, overlay, fakeTransport(), {
      now: clock.now,
      schedule: clock.schedule,
    })
    // The arm's feed wiring (write/arm.ts): server rows land on pending
    // fields as the rewind target, and echoes settle their receipts there.
    const offRemote = feeds.rows.source.subscribe((event) => {
      for (const row of event.rows) {
        if (row.kind !== 'issue' || row.value === undefined) continue
        const value = row.value as SliceIssue
        write.handleRemote('issue', row.id, {
          title: value.title,
          stage: value.stage,
          readAt: (value.readAt ?? null) as never,
        })
      }
    })
    try {
      const id = ctx.targets.visibleRootId
      const serverTitle = tracked(
        () => (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.title,
      ) as string
      await run({ ctx, id, pool: handle.pool, write, clock, feeds, serverTitle })
    } finally {
      offRemote()
      write.dispose()
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }

  it('a receipted edit with no echo expires at the TTL and shows server truth', async () => {
    await withExpiryStack(async (stack) => {
      const { id, write, clock, serverTitle } = stack
      const tx = write.edit('issue', id, { title: 'Expiring title' })
      write.handleAccepted(tx)
      expect(clock.pending()).toBe(1)
      expect(titleOfStack(stack)).toBe('Expiring title')
      clock.advance(ECHO_TTL_MS - 1)
      expect(titleOfStack(stack)).toBe('Expiring title')
      expect(write.log.pendingFor('issue', id)).toHaveLength(1)
      clock.advance(1)
      expect(titleOfStack(stack)).toBe(serverTitle)
      expect(write.log.size).toBe(0)
      expect(clock.pending()).toBe(0)
    })
  }, 120_000)

  it('an edit with no receipt never expires', async () => {
    await withExpiryStack(async (stack) => {
      const { id, write, clock } = stack
      write.edit('issue', id, { title: 'Unreceipted title' })
      expect(clock.pending()).toBe(0)
      clock.advance(10 * ECHO_TTL_MS)
      expect(titleOfStack(stack)).toBe('Unreceipted title')
      expect(write.log.size).toBe(1)
      expect(clock.pending()).toBe(0)
    })
  }, 120_000)

  it('an echo before the TTL clears the timer', async () => {
    await withExpiryStack(async (stack) => {
      const { ctx, id, write, clock, feeds } = stack
      const tx = write.edit('issue', id, { title: 'Echoed title' })
      write.handleAccepted(tx)
      expect(clock.pending()).toBe(1)
      serverWrite(ctx, id, { title: 'Echoed title' }, { stamp: false })
      feeds.flush()
      expect(write.log.size).toBe(0)
      expect(clock.pending()).toBe(0)
      clock.advance(10 * ECHO_TTL_MS)
      expect(titleOfStack(stack)).toBe('Echoed title')
      expect(write.log.size).toBe(0)
    })
  }, 120_000)

  it('dispose clears the expiry timer', async () => {
    await withExpiryStack(async (stack) => {
      const { id, write, clock } = stack
      const tx = write.edit('issue', id, { title: 'Disposed title' })
      write.handleAccepted(tx)
      expect(clock.pending()).toBe(1)
      write.dispose()
      expect(clock.pending()).toBe(0)
      clock.advance(10 * ECHO_TTL_MS)
      expect(write.log.size).toBe(1)
    })
  }, 120_000)
})
