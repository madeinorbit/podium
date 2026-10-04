// @vitest-environment happy-dom
/**
 * POD-4453 — write-path spike (NOT the production path): one optimistic title
 * rename through the hand-rolled arm's own write idiom, reconciled against
 * the kernel echo and a rejection.
 *
 * Idiom under test: a pending delta applied to the tables with a pending mark
 * (a synthetic `update` event + a side map), reconciled by the kernel echo
 * (an ordinary stream update that clears the mark) or by rejection
 * (re-applying the saved prior row through the same dispatch). The spike
 * drives the REAL HandStore.dispatch — no production file imports this folder.
 *
 * Excluded from arm line counts; never imported outside spike/.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { mountArmForCounts, runCountScenario } from '../../../harness/src/count-harness'
import { snapshotFromStore } from '../../../harness/src/oracle/index'
import { writeTitleRename } from '../../../shared/src/scenarios'
import { handArm } from '../arm'
import { rebuildFromScratch } from '../rebuild'
import type { HandStore } from '../store'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

/** The spike's whole write API: pending delta + mark, echo clear, prior restore. */
class PendingTitles {
  private readonly marks = new Map<string, { prior: SliceIssue; title: string }>()
  constructor(private readonly store: HandStore) {}

  /** Optimistic write: synthetic update through dispatch, mark beside the tables. */
  applyPending(id: string, title: string): void {
    const prior = this.store.issues.rows.get(id)
    if (prior === undefined) throw new Error(`[spike] issue ${id} missing`)
    this.marks.set(id, { prior, title })
    this.store.dispatch({
      type: 'update',
      rows: [{ kind: 'issue', id, value: { ...prior, title } }],
    })
  }

  /** Kernel echo arrived via the stream: clear the mark when it matches. */
  noteEcho(id: string): void {
    const mark = this.marks.get(id)
    const current = this.store.issues.rows.get(id)
    if (mark !== undefined && current?.title === mark.title) this.marks.delete(id)
  }

  /** Kernel rejection (no echo): re-apply the saved prior row, clear the mark. */
  reject(id: string): void {
    const mark = this.marks.get(id)
    if (mark === undefined) throw new Error(`[spike] no pending mark for ${id}`)
    this.marks.delete(id)
    this.store.dispatch({ type: 'update', rows: [{ kind: 'issue', id, value: mark.prior }] })
  }

  has(id: string): boolean {
    return this.marks.has(id)
  }
}

describe('hand-rolled write-path spike: optimistic title rename', () => {
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('pending commits one row, echo reconciles, rejection restores the prior row', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.access.coarseNow,
    }
    const mounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
    const store = (mounted.handle as unknown as { store: HandStore }).store
    const pending = new PendingTitles(store)
    const checkOracle = (): void => {
      const rebuilt = rebuildFromScratch({
        issues: store.issues,
        sessions: store.sessions,
        worktrees: store.worktrees,
        selection: {
          selectedIssueId: store.locals.selectedIssueId,
          selectedIssueWasFolded: store.locals.selectedIssueWasFolded ?? false,
        },
        now: store.locals.coarseNow,
      })
      expect(mounted.handle.snapshot()).toEqual(rebuilt.snapshot)
    }
    try {
      const id = ctx.targets.visibleRootId
      const priorTitle = store.rows.rows.get(id)?.title
      expect(priorTitle).toBeDefined()

      // 1. Optimistic pending write: one row commits, oracle holds (the
      // rebuild sees the same tables the incremental path just derived).
      // The pending title matches what the kernel will confirm below, the
      // way a real echo confirms the value the client sent.
      const optimistic = await runCountScenario(mounted, {
        scenario: 'optimisticTitlePending',
        methodology: '#9-spike',
        apply: async () => {
          pending.applyPending(id, 'Renamed visible row')
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(store.rows.rows.get(id)?.title).toBe('Renamed visible row')
      expect(pending.has(id)).toBe(true)
      expect(optimistic.rowsCommitted).toBe(1)
      expect(optimistic.stats.rowsDerived).toBe(1)
      checkOracle()
      console.info(
        `[hand-spike] pending: committed=${optimistic.rowsCommitted} ` +
          `stats=${JSON.stringify(optimistic.stats)} title=${store.rows.rows.get(id)?.title}`,
      )

      // 2. Kernel echo through the real stream: mark clears, parity green.
      const echo = await runCountScenario(mounted, {
        scenario: 'optimisticTitleEcho',
        methodology: '#9-spike',
        apply: async () => {
          await writeTitleRename(ctx, id)
          source.flush()
          pending.noteEcho(id)
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      expect(echo.parity).toBe(true)
      expect(pending.has(id)).toBe(false)
      checkOracle()
      console.info(
        `[hand-spike] echo: committed=${echo.rowsCommitted} ` +
          `stats=${JSON.stringify(echo.stats)} parity=${echo.parity}`,
      )

      // 3. Second pending write, then rejection: the saved prior row
      // (the echo value) is re-applied, parity never diverged.
      const echoTitle = store.rows.rows.get(id)?.title
      await runCountScenario(mounted, {
        scenario: 'optimisticTitlePending2',
        methodology: '#9-spike',
        apply: async () => {
          pending.applyPending(id, 'Rejected title')
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(store.rows.rows.get(id)?.title).toBe('Rejected title')
      const rejected = await runCountScenario(mounted, {
        scenario: 'optimisticTitleRejected',
        methodology: '#9-spike',
        apply: async () => {
          pending.reject(id)
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      expect(store.rows.rows.get(id)?.title).toBe(echoTitle)
      expect(pending.has(id)).toBe(false)
      expect(rejected.parity).toBe(true)
      checkOracle()
      console.info(
        `[hand-spike] rejection: restored=${store.rows.rows.get(id)?.title === echoTitle} ` +
          `committed=${rejected.rowsCommitted} parity=${rejected.parity}`,
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
