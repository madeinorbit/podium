// @vitest-environment happy-dom
/**
 * POD-4451 — MobX arm milestone 2: structural scenarios #4–#10 through the
 * G4 count harness at live corpus (1x), with oracle parity after every step.
 *
 * One engine, methodology order (#4 rename, #5 stage move, #6a new, #6b
 * archive, #6c evict, #6d keeper setup + keeper evict, #7 reparent, #8
 * clock, #9 optimism in four steps, #10 burst50). Each step records rows
 * committed, arm stats, scans, and parity into a table; budget assertions
 * run when `PROTO_M2_STRICT=1` (the gate), otherwise the table is printed
 * for the before/after record. Corpus scale via `PROTO_M2_SPEC=small`
 * (iteration) or the default 1x (the record).
 *
 * MobX has no rebuild oracle (H4: one computed path instead of incremental +
 * from-scratch); parity against `snapshotFromStore` plus the over-commit
 * check (every committed row ⊆ oracle-changed rows) is the per-step proof.
 * Row identity for #9 is the `IssueModel` object: models are created once and
 * mutated (`prev.value = …`), never replaced, so the model must survive all
 * four optimism steps while its borrowed value settles back (`Snapshot`
 * rows are fresh objects per read by construction, so identity there is
 * meaningless — the model is the idiom's identity unit).
 *
 * Counts only — no walls under box load (methodology §5.7).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import {
  mountArmForCounts,
  runCountScenario,
  type CountResult,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  armMarkReadRejection,
  writeArchiveIssue,
  writeBurst50,
  writeEvictIssue,
  writeEvictKeeperIssue,
  writeKeeperPair,
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'
import { mobxArm } from './arm'
import type { MobXStore } from './store'

const SPEC = process.env.PROTO_M2_SPEC === 'small' ? SMALL_CORPUS : 1
const STRICT = process.env.PROTO_M2_STRICT === '1'

interface StepRecord {
  scenario: string
  methodology: string
  rowsCommitted: number
  commitsByRow: Record<string, number>
  visibleRows: number
  stats: CountResult['stats']
  scans: Record<string, number>
  parity: boolean
  parityDiff: string | null
}

function changedRows(before: SliceSnapshot, after: SliceSnapshot): string[] {
  const out = new Set<string>()
  for (const id of new Set([...Object.keys(before.rowsById), ...Object.keys(after.rowsById)])) {
    if (JSON.stringify(before.rowsById[id] ?? null) !== JSON.stringify(after.rowsById[id] ?? null)) {
      out.add(id)
    }
  }
  return [...out].sort()
}

describe('mobx arm milestone 2: structural scenarios', () => {
  it('scenarios #4-#10 with parity and budgets', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(SPEC)
    const source = createRowSource(ctx.engine, ctx.replica)
    let locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(mobxArm, source.source, locals)
    const store = (mounted.handle as unknown as { store: MobXStore }).store
    const records: StepRecord[] = []

    const step = async (
      scenario: string,
      methodology: string,
      apply: () => unknown,
      expectedLocals: SliceLocals = locals,
      allowOver: string[] = [],
    ): Promise<CountResult> => {
      const before = snapshotFromStore(ctx.engine.getSnapshot(), expectedLocalsFor(scenario))
      const result = await runCountScenario(mounted, {
        scenario,
        methodology,
        apply: async () => {
          await apply()
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals),
      })
      const changed = changedRows(before, snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals))
      const committed = Object.keys(result.commitsByRow).sort()
      const over = committed.filter((id) => !changed.includes(id))
      const scans = store.scanCounts()
      console.info(
        `[mobx-m2] ${methodology} ${scenario}: visible=${result.visibleRows} ` +
          `committed=${result.rowsCommitted} [${committed.slice(0, 8).join(',')}${committed.length > 8 ? '…' : ''}] ` +
          `oracleChanged=${changed.length} overCommit=[${over.join(',')}] ` +
          `stats=${JSON.stringify(result.stats)} scans=${JSON.stringify(scans)} ` +
          `parity=${result.parity}${result.parityDiff ? ` DIFF ${result.parityDiff.slice(0, 300)}` : ''}`,
      )
      records.push({ ...result, scenario, methodology, scans })
      expect(result.parity, `${scenario}: parity ${result.parityDiff ?? ''}`).toBe(true)
      // POD-4491/POD-4496: #4 rename commits i1 for its R4 origin tick
      // (spinOffOriginId, mission.ts:479-483; tick UnifiedIssueRow.tsx:450-460).
      // The tick is UI-only, outside the SliceSnapshot oracle projection
      // (spec §7), so the oracle reports no change for i1 while the arm
      // correctly re-renders it. Allowed, not a leak.
      expect(over, `${scenario}: every committed row must be oracle-changed`).toEqual(allowOver)
      return result
    }

    // `before` for the clock step is captured with pre-tick locals; every
    // other step shares the current locals.
    const expectedLocalsFor = (_scenario: string): SliceLocals => locals

    try {
      const atMount = mounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))

      const rename = await step('visibleTitleRename', '#4', () => writeTitleRename(ctx), locals, ['i1'])
      const stageMove = await step('stageMoveAcrossGroups', '#5', () => writeStageMove(ctx))
      const newIssue = await step('newIssue', '#6a', () => writeNewIssue(ctx, SPEC))
      const archive = await step('archiveIssue', '#6b', () => writeArchiveIssue(ctx))
      const evict = await step('evictWithoutRevision', '#6c', () => writeEvictIssue(ctx))
      // #6d — keeper setup seeds the rescue pair (POD-4503: the seed corpus
      // carries no rescue rows), then the keeper leaf is evicted and its
      // rescue parent must leave with it.
      const keeperSetup = await step('keeperPairSetup', '#6d setup', () => writeKeeperPair(ctx, SPEC))
      const keeperEvict = await step('evictKeeperWithoutRevision', '#6d', () =>
        writeEvictKeeperIssue(ctx),
      )
      const reparent = await step('parentReassignment', '#7', () => writeParentReassignment(ctx))

      // #8 — the coarse clock ticks with no row change: time is a local.
      const tickTo = store.locals.coarseNow + 60_000
      const tickLocals: SliceLocals = { ...locals, coarseNow: tickTo }
      const tick = await step(
        'clockTick',
        '#8',
        () => {
          store.setCoarseNow(tickTo)
        },
        tickLocals,
      )
      locals = tickLocals

      // #9 — optimistic press, server echo, second press, definitive
      // rejection. The IssueModel is the identity unit: it must survive all
      // four steps, and the borrowed value must settle back to the pre-press
      // content (deep-equal; the stream delivers fresh objects, so object
      // identity of the VALUE is not the invariant — model identity is).
      const target = 'i6'
      const prePressModel = store.issues.get(target)
      expect(prePressModel, 'optimism target exists').toBeDefined()
      const press1 = await step('optimisticPress', '#9a', () => writeOptimisticPress(ctx, target))
      const echo = await step('optimisticEcho', '#9b', () => writeOptimisticEcho(ctx, target))
      // The rollback restores the ECHO value (the confirmed server state),
      // not the pre-press value — the echo is a genuine kernel write in
      // between. That is the baseline the rejection must settle back to.
      const echoValue = JSON.parse(JSON.stringify(store.issues.get(target)?.value))
      armMarkReadRejection(ctx)
      const press2 = await step('optimisticPressRejected', '#9c', () =>
        writeOptimisticPress(ctx, target),
      )
      const rejected = await step('optimisticRollback', '#9d', () => Promise.resolve())
      const finalModel = store.issues.get(target)
      console.info(
        `[mobx-m2] #9 identity: modelKept=${finalModel === prePressModel} ` +
          `valueRestored=${JSON.stringify(finalModel?.value) === JSON.stringify(echoValue)}`,
      )

      // #9 supplement (not a G3 scenario): the same optimistic press on a
      // VISIBLE row. readAt moves no derived value, so nothing may commit and
      // the model must survive press + confirm untouched.
      const visibleTarget = 'i0'
      const visibleBefore = store.issues.get(visibleTarget)
      expect(visibleBefore, 'supplement needs a visible row').toBeDefined()
      expect(visibleBefore?.row, 'supplement needs a visible row').toBeDefined()
      const pressVisible = await step('optimisticPressVisible', '#9 suppl.', () =>
        writeOptimisticPress(ctx, visibleTarget),
      )
      const visibleAfter = store.issues.get(visibleTarget)
      console.info(
        `[mobx-m2] #9 suppl. identity: kept=${visibleAfter === visibleBefore} ` +
          `committed=${pressVisible.rowsCommitted} evals=${pressVisible.stats.rollupsDerived}`,
      )

      const burst = await step('burst50', '#10', () => writeBurst50(ctx, SPEC))

      if (STRICT) {
        // #4: the renamed row plus its R4 spin-off's tick (POD-4491/POD-4496:
        // i1->i0 discovered-from, spinOffOriginId mission.ts:479-483; the tick
        // is UI-only, outside the SliceSnapshot oracle, hence the allowed
        // over-commit above). Derivation bodies arm-relative (methodology
        // Q-H3/M3: the cross-arm metric is rows committed). One event, one
        // notification.
        expect(rename.rowsCommitted).toBe(2)
        expect(rename.commitsByRow).toEqual({ i0: 1, i1: 1 })
        expect(rename.stats.rowsDerived).toBe(2)
        expect(rename.stats.rollupsDerived).toBe(3)
        expect(rename.stats.notifications).toBe(1)
        // #5: the moved row only (its child's aggregate reads its own
        // subtree, never the parent) + order/group deltas, one pass.
        expect(stageMove.rowsCommitted).toBe(1)
        expect(stageMove.stats.rowsDerived).toBe(1)
        expect(stageMove.stats.notifications).toBe(1)
        // #6a: the arriving row mounts (mount-phase renders are excluded by
        // the RowShell by design, so commits stay 0) — the work is order +
        // one row derivation, one pass.
        expect(newIssue.rowsCommitted).toBe(0)
        expect(newIssue.stats.rowsDerived).toBe(1)
        expect(newIssue.stats.notifications).toBe(1)
        // #6b: the leaving row unmounts (likewise uncounted); its parent's
        // chain commits. #6c: the evicted row unmounts with no chain effect.
        expect(archive.rowsCommitted).toBe(1)
        expect(archive.stats.rowsDerived).toBe(2)
        expect(archive.stats.notifications).toBe(1)
        expect(evict.rowsCommitted).toBe(0)
        expect(evict.stats.notifications).toBe(1)
        // #6d setup: two arrivals mount (commits stay 0); #6d evict: the
        // keeper leaf unmounts and its rescue parent leaves with it
        // (POD-4503: the armed eviction check).
        expect(keeperSetup.rowsCommitted).toBe(0)
        expect(keeperSetup.stats.notifications).toBe(1)
        expect(keeperEvict.rowsCommitted).toBe(0)
        expect(keeperEvict.stats.notifications).toBe(1)
        // #7: both chains (old parent, new parent); the moved row itself is
        // value-stable (its subtree did not change).
        expect(reparent.rowsCommitted).toBe(2)
        expect(reparent.stats.rowsDerived).toBe(2)
        expect(reparent.stats.notifications).toBe(1)
        // #8: no band boundary crosses on +60s at 1x, so nothing commits —
        // and the over-commit check above already proves every commit would
        // have to be oracle-changed. Locals dispatch no row-source event, so
        // notifications stay 0 by construction (the arm commits via MobX
        // reactions, not via a dispatch counter).
        expect(tick.rowsCommitted).toBe(0)
        expect(tick.stats.notifications).toBe(0)
        // #9: every step bounded like a phase change; the model survives all
        // four steps and the value settles back; never a full rebuild.
        for (const [name, r] of [
          ['press1', press1],
          ['echo', echo],
        ] as const) {
          expect(r.rowsCommitted, name).toBe(0)
          expect(r.visibleRows, `${name} never a full rebuild`).toBeGreaterThan(10)
        }
        expect(press2.stats.notifications, 'press2 optimistic + rollback').toBe(2)
        expect(rejected.rowsCommitted, 'rollback').toBe(0)
        expect(rejected.stats.notifications, 'rollback quiet').toBe(0)
        expect(finalModel, 'rollback keeps the model').toBe(prePressModel)
        expect(finalModel?.value, 'rollback restores the echo value').toEqual(echoValue)
        expect(pressVisible.rowsCommitted, 'visible press').toBe(0)
        expect(visibleAfter, 'visible press keeps the model').toBe(visibleBefore)
        // #10: one event, work bounded by the burst size plus chains.
        expect(burst.stats.notifications).toBe(1)
        expect(burst.rowsCommitted).toBeLessThanOrEqual(64)
        expect(burst.stats.rowsDerived).toBeLessThanOrEqual(64)
      }

      const elapsedMs = performance.now() - started
      const cwd = process.cwd()
      const resultsDir = cwd.endsWith(join('packages', 'worklist-proto'))
        ? join(cwd, 'harness', 'browser', 'results')
        : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, `mobx-m2-counts-${process.env.PROTO_M2_SPEC === 'small' ? 'small' : '1x'}.json`),
        JSON.stringify(
          {
            arm: 'mobx',
            milestone: 2,
            spec: process.env.PROTO_M2_SPEC === 'small' ? 'small' : '1x',
            strict: STRICT,
            runtimeSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
              encoding: 'utf-8',
            }).trim(),
            capturedAt: new Date().toISOString(),
            elapsedMs: Math.round(elapsedMs),
            steps: records,
          },
          null,
          2,
        ),
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 600_000)
})
