// @vitest-environment happy-dom
/**
 * POD-4454 — write-path spike (NOT the production path): one optimistic title
 * rename through the MobX arm's own write idiom, reconciled against the
 * kernel echo and a rejection.
 *
 * Idiom under test: an action on the model setting fields plus a pending flag
 * (a synthetic `update` event through `store.apply` — the single write path —
 * plus a side map), reconciled by the kernel echo (an ordinary stream update
 * that clears the flag) or by rejection (re-applying the captured prior value
 * inside the same action). The spike drives the REAL MobXStore.apply — no
 * production file imports this folder.
 *
 * Excluded from arm line counts; never imported outside spike/.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../../shared/src/row-source'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceIssue } from '../../../shared/src/slice-types'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { mountArmForCounts, runCountScenario } from '../../../harness/src/count-harness'
import { snapshotFromStore } from '../../../harness/src/oracle/index'
import { writeTitleRename } from '../../../shared/src/scenarios'
import { mobxArm } from '../arm'
import type { MobXStore } from '../store'

/** The spike's whole write API: pending flag + mark, echo clear, prior restore. */
class PendingTitles {
  private readonly marks = new Map<string, { prior: SliceIssue; title: string }>()
  constructor(private readonly store: MobXStore) {}

  /**
   * Optimistic write: capture the model's borrowed value, set the pending
   * title through the single write path (`store.apply` is the action — one
   * publication, one notification pass), flag beside the tables.
   */
  applyPending(id: string, title: string): void {
    const prior = this.store.issues.get(id)?.value
    if (prior === undefined) throw new Error(`[spike] issue ${id} missing`)
    this.marks.set(id, { prior, title })
    this.store.apply({
      type: 'update',
      rows: [{ kind: 'issue', id, value: { ...prior, title } }],
    })
  }

  /** Kernel echo arrived via the stream: clear the flag when it matches. */
  noteEcho(id: string): void {
    const mark = this.marks.get(id)
    const current = this.store.issues.get(id)?.value
    if (mark !== undefined && current?.title === mark.title) this.marks.delete(id)
  }

  /**
   * Kernel rejection (no echo): restore the captured prior value inside the
   * same action the stream speaks — a re-apply of the prior row object.
   */
  reject(id: string): void {
    const mark = this.marks.get(id)
    if (mark === undefined) throw new Error(`[spike] no pending mark for ${id}`)
    this.marks.delete(id)
    this.store.apply({ type: 'update', rows: [{ kind: 'issue', id, value: mark.prior }] })
  }

  has(id: string): boolean {
    return this.marks.has(id)
  }
}

describe('mobx write-path spike: optimistic title rename', () => {
  it('pending commits one row, echo reconciles, rejection restores the prior row', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(mobxArm, source.source, locals)
    const store = (mounted.handle as unknown as { store: MobXStore }).store
    const pending = new PendingTitles(store)
    try {
      const id = ctx.targets.visibleRootId
      const priorTitle = store.issues.get(id)?.value.title
      expect(priorTitle).toBeDefined()

      // 1. Optimistic pending write: one row commits through the ordinary
      // dataflow (tables → buckets → summary → rollup → order/groups → row).
      const optimistic = await runCountScenario(mounted, {
        scenario: 'optimisticTitlePending',
        methodology: '#9-spike',
        apply: async () => {
          pending.applyPending(id, 'Renamed visible row')
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(store.issues.get(id)?.value.title).toBe('Renamed visible row')
      expect(pending.has(id)).toBe(true)
      // The renamed row plus any VISIBLE R4 spin-off's origin tick, which
      // quotes the renamed title and rides the commit (M2 rename commits the
      // same set). POD-4550: computed from the fixture, not pinned ids.
      const spinOffs = ctx.corpus.issues
        .filter(
          (i) =>
            mounted.handle.snapshot().rowsById[i.id] !== undefined &&
            (i.deps ?? []).some((d) => d.id === id && d.type === 'discovered-from'),
        )
        .map((i) => i.id)
      expect(optimistic.commitsByRow).toEqual(
        Object.fromEntries([id, ...spinOffs].map((rowId) => [rowId, 1])),
      )
      expect(optimistic.rowsCommitted).toBe(1 + spinOffs.length)
      expect(optimistic.stats.rowsDerived).toBe(1 + spinOffs.length)

      // 2. Kernel echo through the real stream: flag clears, parity green.
      // The echo carries the same title the pending write set (a real echo
      // confirms the value the client sent), so it settles with zero commits.
      const echo = await runCountScenario(mounted, {
        scenario: 'optimisticTitleEcho',
        methodology: '#9-spike',
        apply: async () => {
          await writeTitleRename(ctx, id)
          source.flush()
          pending.noteEcho(id)
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(echo.parity).toBe(true)
      expect(pending.has(id)).toBe(false)

      // 3. Second pending write, then rejection: the captured prior row
      // (the echo value) is re-applied inside the action, parity green.
      const echoTitle = store.issues.get(id)?.value.title
      await runCountScenario(mounted, {
        scenario: 'optimisticTitlePending2',
        methodology: '#9-spike',
        apply: async () => {
          pending.applyPending(id, 'Rejected title')
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(store.issues.get(id)?.value.title).toBe('Rejected title')
      const rejected = await runCountScenario(mounted, {
        scenario: 'optimisticTitleRejected',
        methodology: '#9-spike',
        apply: async () => {
          pending.reject(id)
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(store.issues.get(id)?.value.title).toBe(echoTitle)
      expect(pending.has(id)).toBe(false)
      expect(rejected.parity).toBe(true)
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
