// @vitest-environment happy-dom
/**
 * POD-4455 — write-path spike (NOT the production path): one optimistic title
 * rename through TanStack DB's own optimistic idiom (`createOptimisticAction`
 * + direct collection updates staged as transaction-local state),
 * reconciled against the kernel echo and a rejection.
 *
 * Idiom under test: `onMutate` stages the pending title with
 * `entities.issues.collection.update` (transaction-local optimistic state —
 * never the sync interface, which stays kernel-owned); `mutationFn` is the
 * scenario-9-style transport stub (kernel dual-write + flush, then resolve;
 * reject with no kernel write). Verified library semantics below: derivations
 * follow optimistic state AND change events fire pre-commit (as `insert`),
 * but nothing drives the commit pass outside `dispatch` — so the spike
 * flushes through the arm's own commit pass (`finishCycle`, reached by cast;
 * production would expose it as `flush()`). Echo and rollback flow through
 * the ordinary query/rollup/commit path — the spike re-applies nothing by
 * hand: if rollback needed a manual restore, the idiom would fail the spike.
 *
 * Excluded from arm line counts; never imported outside spike/.
 */

import { describe, expect, it } from 'vitest'
import { createOptimisticAction } from '@tanstack/db'
import { createRowSource } from '../../../shared/src/row-source'
import { SMALL_CORPUS, startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceIssue } from '../../../shared/src/slice-types'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { mountArmForCounts, runCountScenario } from '../../../harness/src/count-harness'
import { snapshotFromStore } from '../../../harness/src/oracle/index'
import { writeTitleRename } from '../../../harness/src/scenario-writes'
import { tanstackArm } from '../arm'
import type { TanStackStore } from '../store'

const PENDING_TITLE = 'Renamed visible row'

/** The spike's whole write API: optimistic staging + the commit flush. */
class PendingTitles {
  private readonly gates = new Map<string, { resolve(): void; reject(reason?: unknown): void }>()
  private readonly txs = new Map<string, { isPersisted: Promise<unknown> }>()
  constructor(
    private readonly store: TanStackStore,
    private readonly flush: () => void,
  ) {}

  /**
   * Optimistic write: stage the pending title as transaction-local state on
   * the entity collection (the kernel's sync channel is untouched) and run
   * the arm's own commit pass so derivations + rows settle exactly like a
   * kernel write. The transport settles the returned gate: resolve on echo
   * (after the echo synced back), reject on server refusal.
   */
  applyPending(id: string, title: string): void {
    let resolve!: () => void
    let reject!: (reason?: unknown) => void
    const gate = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.gates.set(id, { resolve, reject })
    const action = createOptimisticAction<{ bid: string; btitle: string }>({
      onMutate: ({ bid, btitle }) => {
        this.store.entities.issues.collection.update(bid, (draft) => {
          ;(draft as unknown as SliceIssue).title = btitle
        })
      },
      mutationFn: () => gate,
    })
    const tx = action({ bid: id, btitle: title })
    this.txs.set(id, tx as unknown as { isPersisted: Promise<unknown> })
    // Derivations followed the staging and the rowsQ subscription marked
    // the row dirty (verified by probe); flush commits it.
    this.flush()
  }

  /** Settles when the transport settles (resolves on echo, rejects on refusal). */
  settled(id: string): Promise<unknown> {
    const tx = this.txs.get(id)
    return tx === undefined ? Promise.resolve() : tx.isPersisted.promise
  }

  /** Kernel echo arrived via the stream: the transport resolves after the
   *  echo synced back (the docs' sync-back rule); the shadow drops onto the
   *  identical value. No-op when the echo already settled the row. */
  noteEcho(id: string): void {
    this.gates.get(id)?.resolve()
    this.gates.delete(id)
  }

  /** Kernel rejection (no echo): the TRANSACTION rolls back — the spike
   *  re-applies nothing. The rollback's change events mark the row dirty;
   *  flush recommits the prior value (fresh identity, equal value). */
  reject(id: string, reason: unknown): void {
    this.gates.get(id)?.reject(reason)
    this.gates.delete(id)
  }
}

describe('tanstack write-path spike: optimistic title rename', () => {
  it('pending commits one row, echo settles, rejection restores the prior value', async () => {
    const ctx = await startScenarioEngine(SMALL_CORPUS)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(tanstackArm, source.source, locals)
    const store = (mounted.handle as unknown as { store: TanStackStore }).store
    // The proposed production bridge: the commit pass as a public flush.
    // Reached by cast here so the spike adds no production API.
    const flush = (): void =>
      (store as unknown as { finishCycle(): void }).finishCycle()
    const pending = new PendingTitles(store, flush)
    try {
      expect(mounted.handle.snapshot()).toEqual(
        snapshotFromStore(ctx.engine.getSnapshot(), locals),
      )
      const target = 'i0'
      const priorTitle = store.rows.get(target)?.title
      expect(priorTitle).toBe('Issue 0')

      // Pending: one row commits with the staged title; parity goes red
      // against the kernel oracle — the divergence IS optimism.
      const { act } = await import('react')
      let pendingCommits = -1
      await act(async () => {
        mounted.handle.stats.reset()
        mounted.log.reset()
        pending.applyPending(target, PENDING_TITLE)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
      // Read after act exits: the Profiler commit fires on re-render.
      pendingCommits = mounted.log.total()
      expect(mounted.handle.snapshot().rowsById[target]?.title).toBe(PENDING_TITLE)
      expect(mounted.handle.snapshot()).not.toEqual(
        snapshotFromStore(ctx.engine.getSnapshot(), locals),
      )
      console.info(
        `[tanstack-spike] pending: committed=${pendingCommits} title=${mounted.handle.snapshot().rowsById[target]?.title} parity=red`,
      )
      expect(pendingCommits).toBe(1)

      // Echo: the kernel confirms the same title; the transport resolves
      // after the echo synced back. The shadow drops onto the identical
      // value — zero commits — and parity goes green.
      const echoResult = await runCountScenario(mounted, {
        scenario: 'optimisticEcho',
        methodology: '#9 spike',
        apply: async () => {
          await writeTitleRename(ctx, target)
          source.flush()
          pending.noteEcho(target)
          await pending.settled(target)
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(echoResult.parity).toBe(true)
      expect(mounted.handle.snapshot().rowsById[target]?.title).toBe(PENDING_TITLE)
      console.info(
        `[tanstack-spike] echo: committed=${echoResult.rowsCommitted} ` +
          `stats=${JSON.stringify(echoResult.stats)} parity=${echoResult.parity}`,
      )
      expect(echoResult.rowsCommitted).toBe(0)

      // Rejection on a fresh rename: no kernel write ever arrives; the
      // transport rejects and the transaction rolls back by itself. The
      // rollback recommits the prior VALUE (fresh identity — the commit
      // layer assembles rows anew, unlike the MobX arm's borrowed
      // references) with parity green throughout the kernel's view.
      const SECOND_TITLE = 'Second pending title'
      await act(async () => {
        pending.applyPending(target, SECOND_TITLE)
      })
      expect(mounted.handle.snapshot().rowsById[target]?.title).toBe(SECOND_TITLE)
      const beforeReject = snapshotFromStore(ctx.engine.getSnapshot(), locals)
      const rejectResult = await runCountScenario(mounted, {
        scenario: 'optimisticRollback',
        methodology: '#9 spike',
        apply: async () => {
          pending.reject(target, new Error('[spike] server rejected the rename'))
          // Let the rollback's change events land before the commit pass.
          await pending.settled(target).catch(() => {})
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          flush()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        },
        expected: () => beforeReject,
      })
      console.info(
        `[tanstack-spike] reject: committed=${rejectResult.rowsCommitted} ` +
          `stats=${JSON.stringify(rejectResult.stats)} parity=${rejectResult.parity} ` +
          `title=${mounted.handle.snapshot().rowsById[target]?.title}`,
      )
      expect(rejectResult.parity).toBe(true)
      expect(mounted.handle.snapshot().rowsById[target]?.title).toBe(PENDING_TITLE)
      expect(rejectResult.rowsCommitted).toBe(1)
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
