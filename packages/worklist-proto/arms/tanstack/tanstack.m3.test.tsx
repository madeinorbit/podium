// @vitest-environment happy-dom
/**
 * POD-4455 — TanStack DB arm milestone 3: lifecycle (11–13), growth (14),
 * coexistence (15), the Q-T5 R3 fan-out check and the dispose contract.
 *
 * Counts only — no walls. Box load sits above the methodology hygiene line
 * and timing is owned by POD-4489; the verdict-carrying half (rows committed,
 * derivations, query-graph runs, scans, phase split, parity) does not move
 * with load. Browser walls (principalSwitch ≤ 2× control, coldBootstrap ≤
 * 1.1× control, retained heap ≤ 1.1×, rescope heap ±5%) are withheld for the
 * POD-4489 re-run; the count harness proves the mechanism here (fresh
 * replica, full-once installs, literal 2x rescope with tables back to
 * baseline, zero listeners surviving disposal, a post-dispose write that
 * touches nothing).
 *
 * TanStack has no rebuild oracle (H4: one query-graph path instead of
 * incremental + from-scratch); parity against `snapshotFromStore` plus the
 * over-commit check (every committed row ⊆ oracle-changed rows) is the
 * per-step proof.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import {
  GROWTH_CORPORA,
  SMALL_CORPUS,
  startScenarioEngine,
  type CorpusSpec,
} from '../../shared/src/scenarios'
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import {
  mountArmForCounts,
  runCountScenario,
  type CountResult,
  type MountedArm,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { legacyControlArmFor } from '../../harness/src/legacy-control/arm'
import {
  writeArchiveIssue,
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
} from '../../harness/src/scenario-writes'
import { tanstackArm } from './arm'
import type { GraphRuns } from './queries'
import type { TanStackStore } from './store'

function storeOf(mounted: MountedArm): TanStackStore {
  return (mounted.handle as unknown as { store: TanStackStore }).store
}

function resultsDirOf(): string {
  const cwd = process.cwd()
  return cwd.endsWith(join('packages', 'worklist-proto'))
    ? join(cwd, 'harness', 'browser', 'results')
    : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
}

const RUN_KEYS = [
  'narrow',
  'resolve',
  'verdict',
  'issuesNarrow',
  'child',
  'summary',
  'lane',
  'rows',
] as const

function snapshotRuns(runs: GraphRuns): {
  counters: Record<string, number>
  changes: Record<string, number>
  ms: Record<string, number>
} {
  const counters: Record<string, number> = {}
  for (const key of RUN_KEYS) counters[key] = runs[key]
  return { counters, changes: { ...runs.changes }, ms: { ...runs.ms } }
}

function diffRuns(
  before: { counters: Record<string, number>; changes: Record<string, number> },
  after: GraphRuns,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of RUN_KEYS) {
    const delta = after[key] - (before.counters[key] ?? 0)
    if (delta !== 0) out[key] = delta
  }
  for (const key of new Set([...Object.keys(before.changes), ...Object.keys(after.changes)])) {
    const delta = (after.changes[key] ?? 0) - (before.changes[key] ?? 0)
    if (delta !== 0) out[`changes:${key}`] = delta
  }
  return out
}

/** Per-query fn-wall deltas since the snapshot (M3 stats split input). */
function diffMs(before: { ms: Record<string, number> }, after: GraphRuns): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of new Set([...Object.keys(before.ms), ...Object.keys(after.ms)])) {
    const delta = (after.ms[key] ?? 0) - (before.ms[key] ?? 0)
    if (delta !== 0) out[key] = delta
  }
  return out
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

describe('tanstack arm milestone 3: lifecycle, growth, coexistence', () => {
  it('lifecycle: cold bootstrap, fresh-replica principal switch, literal 2x rescope and back, post-dispose silence', async () => {
    const lifecycle: Record<string, unknown> = {}
    // Cold bootstrap at live corpus: construction snapshots full, once.
    const cold = await startScenarioEngine(GROWTH_CORPORA.x1)
    const coldSource = createRowSource(cold.engine, cold.replica)
    const coldLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: cold.engine.getSnapshot().coarseNow,
    }
    const coldMounted = mountArmForCounts(tanstackArm, coldSource.source, coldLocals)
    try {
      const atMount = coldMounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(1000)
      expect(atMount).toEqual(snapshotFromStore(cold.engine.getSnapshot(), coldLocals))
      const coldStore = storeOf(coldMounted)
      console.info(
        `[tanstack-m3] coldBootstrap 1x: visible=${Object.keys(atMount.rowsById).length} ` +
          `issues=${coldStore.entities.issues.size} ` +
          `sessions=${coldStore.entities.sessions.size} ` +
          `worktrees=${coldStore.entities.worktrees.size} parity=true`,
      )
      lifecycle['coldBootstrap'] = {
        scale: '1x',
        visibleRows: Object.keys(atMount.rowsById).length,
        issues: coldStore.entities.issues.size,
        sessions: coldStore.entities.sessions.size,
        worktrees: coldStore.entities.worktrees.size,
        parity: true,
      }
    } finally {
      coldMounted.unmount()
      coldSource.dispose()
    }
    cold.engine.destroy()

    // Principal switch: dispose everything, rebuild over a FRESH replica.
    const first = await startScenarioEngine(SMALL_CORPUS, { principal: 'operator' })
    const firstSource = createRowSource(first.engine, first.replica)
    const firstLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: first.engine.getSnapshot().coarseNow,
    }
    const firstMounted = mountArmForCounts(tanstackArm, firstSource.source, firstLocals)
    const firstStore = storeOf(firstMounted)
    const firstVisible = Object.keys(firstMounted.handle.snapshot().rowsById).length
    expect(firstVisible).toBeGreaterThan(0)
    const beforeDispose = JSON.stringify(firstMounted.handle.snapshot())
    // The dispose contract: zero listeners survive, and a post-dispose
    // publication touches nothing (subscription dropped at dispose).
    firstMounted.unmount()
    expect(firstStore.listenerCount()).toBe(0)
    const notificationsBefore = firstStore.stats.notifications
    await writeHeartbeat(first)
    firstSource.flush()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(firstStore.listenerCount()).toBe(0)
    expect(firstStore.stats.notifications).toBe(notificationsBefore)
    expect(JSON.stringify(firstMounted.handle.snapshot())).toBe(beforeDispose)
    console.info(
      `[tanstack-m3] dispose: listeners=0 post-dispose heartbeat touches nothing ` +
        `(notifications=${notificationsBefore})`,
    )
    lifecycle['dispose'] = {
      corpus: 'small',
      listenersAfterDispose: 0,
      notificationsUnchanged: true,
      snapshotUnchanged: true,
    }
    firstSource.dispose()
    first.engine.destroy()

    const second = await startScenarioEngine(SMALL_CORPUS, { principal: 'operator-2' })
    const secondSource = createRowSource(second.engine, second.replica)
    const secondLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: second.engine.getSnapshot().coarseNow,
    }
    const secondMounted = mountArmForCounts(tanstackArm, secondSource.source, secondLocals)
    try {
      const atMount = secondMounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBe(firstVisible)
      expect(atMount).toEqual(snapshotFromStore(second.engine.getSnapshot(), secondLocals))
      console.info(
        `[tanstack-m3] principalSwitch fresh replica: visible=${Object.keys(atMount.rowsById).length} parity=true`,
      )
      lifecycle['principalSwitch'] = {
        corpus: 'small',
        visibleRows: Object.keys(atMount.rowsById).length,
        parity: true,
      }
    } finally {
      secondMounted.unmount()
      secondSource.dispose()
      second.engine.destroy()
    }

    // Rescope: literal 2x install then back, through `replace` events built
    // from a second engine's row source (the happy-dom proxy for the withheld
    // heap ±5% check is exact table-size return to baseline).
    const ctx = await startScenarioEngine(GROWTH_CORPORA.x1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(tanstackArm, source.source, locals)
    const grown = await startScenarioEngine(GROWTH_CORPORA.x2)
    const grownSource = createRowSource(grown.engine, grown.replica)
    try {
      const store = storeOf(mounted)
      const issuesBefore = store.entities.issues.size
      const sessionsBefore = store.entities.sessions.size
      const worktreesBefore = store.entities.worktrees.size
      const visibleBefore = Object.keys(mounted.handle.snapshot().rowsById).length

      const grownRows = [
        ...grownSource.source.snapshot('issue'),
        ...grownSource.source.snapshot('session'),
        ...grownSource.source.snapshot('worktree'),
      ]
      const { act } = await import('react')
      await act(async () => {
        store.dispatch({ type: 'replace', rows: grownRows })
        store.setCoarseNow(grown.engine.getSnapshot().coarseNow)
      })
      const grownLocals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: grown.engine.getSnapshot().coarseNow,
      }
      const grownSnapshot = mounted.handle.snapshot()
      expect(grownSnapshot).toEqual(snapshotFromStore(grown.engine.getSnapshot(), grownLocals))
      const issuesGrown = store.entities.issues.size
      const sessionsGrown = store.entities.sessions.size
      const visibleGrown = Object.keys(grownSnapshot.rowsById).length
      console.info(
        `[tanstack-m3] rescope 2x: visible ${visibleBefore}->${visibleGrown} ` +
          `issues ${issuesBefore}->${issuesGrown} sessions ${sessionsBefore}->${sessionsGrown} parity=true`,
      )

      const backRows = [
        ...source.source.snapshot('issue'),
        ...source.source.snapshot('session'),
        ...source.source.snapshot('worktree'),
      ]
      await act(async () => {
        store.dispatch({ type: 'replace', rows: backRows })
        store.setCoarseNow(ctx.engine.getSnapshot().coarseNow)
      })
      const after = mounted.handle.snapshot()
      expect(after).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))
      console.info(
        `[tanstack-m3] rescope back: visible=${Object.keys(after.rowsById).length} ` +
          `issues=${store.entities.issues.size} sessions=${store.entities.sessions.size} parity=true`,
      )
      expect(store.entities.issues.size).toBe(issuesBefore)
      expect(store.entities.sessions.size).toBe(sessionsBefore)
      expect(store.entities.worktrees.size).toBe(worktreesBefore)
      expect(Object.keys(after.rowsById).length).toBe(visibleBefore)
      lifecycle['rescope'] = {
        from: '1x',
        to: '2x',
        visibleBefore,
        visibleGrown,
        visibleBack: Object.keys(after.rowsById).length,
        issuesBefore,
        issuesGrown,
        issuesAfter: store.entities.issues.size,
        sessionsBefore,
        sessionsGrown,
        sessionsAfter: store.entities.sessions.size,
        worktreesBefore,
        worktreesAfter: store.entities.worktrees.size,
        parity: true,
      }
      const resultsDir = resultsDirOf()
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(join(resultsDir, 'tanstack-m3-lifecycle.json'), JSON.stringify(lifecycle, null, 2))
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
      grownSource.dispose()
      grown.engine.destroy()
    }
  }, 600_000)

  it('growth scenario 14: scenarios 1, 2, 3, 5 at 1x, 2x, 4x with scans, runs and phase split', async () => {
    const scales = [
      { name: '1x', spec: GROWTH_CORPORA.x1 },
      { name: '2x', spec: GROWTH_CORPORA.x2 },
      { name: '4x', spec: GROWTH_CORPORA.x4 },
    ] as const
    const table: Array<{
      scale: string
      issues: number
      sessions: number
      step: string
      rowsCommitted: number
      rowsDerived: number
      rollupsDerived: number
      indexUpdates: number
      scans: Record<string, number>
      runs: Record<string, number>
      fnMs: Record<string, number>
      phaseMs: { indexMs: number; rollupMs: number; rowMs: number }
      visibleRows: number
      parity: boolean
    }> = []
    const byScale = new Map<string, Record<string, { rows: number; deriv: string }>>()
    for (const { name, spec } of scales) {
      const ctx = await startScenarioEngine(spec as CorpusSpec)
      const source = createRowSource(ctx.engine, ctx.replica)
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const mounted = mountArmForCounts(tanstackArm, source.source, locals)
      const store = storeOf(mounted)
      const perStep: Record<string, { rows: number; deriv: string }> = {}
      try {
        expect(mounted.handle.snapshot()).toEqual(
          snapshotFromStore(ctx.engine.getSnapshot(), locals),
        )
        console.info(
          `[tanstack-m3] mount ${name}: visible=${Object.keys(mounted.handle.snapshot().rowsById).length} ` +
            `verdictQ=${(store.base.verdictQ.toArray as unknown[]).length} ` +
            `verdictR=${(store.base.verdictR.toArray as unknown[]).length} parity=true`,
        )
        const run = async (
          step: string,
          methodology: string,
          apply: () => Promise<unknown>,
        ): Promise<CountResult> => {
          const runsBefore = snapshotRuns(store.runs)
          const result = await runCountScenario(mounted, {
            scenario: step,
            methodology,
            apply: async () => {
              await apply()
              source.flush()
            },
            expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
          })
          const runsDelta = diffRuns(runsBefore, store.runs)
          const scans = store.scanCounts()
          const phaseMs = store.phaseMs()
          const fnMs = diffMs(runsBefore, store.runs)
          table.push({
            scale: name,
            issues: (spec as CorpusSpec).issues,
            sessions: (spec as CorpusSpec).sessions,
            step: `${methodology} ${step}`,
            rowsCommitted: result.rowsCommitted,
            rowsDerived: result.stats.rowsDerived,
            rollupsDerived: result.stats.rollupsDerived,
            indexUpdates: result.stats.indexUpdates,
            scans,
            runs: runsDelta,
            fnMs,
            phaseMs,
            visibleRows: result.visibleRows,
            parity: result.parity,
          })
          console.info(
            `[tanstack-m3] ${name} ${methodology} ${step}: committed=${result.rowsCommitted} ` +
              `stats=${JSON.stringify(result.stats)} scans=${JSON.stringify(scans)} ` +
              `phaseMs=${JSON.stringify(phaseMs)} runs=${JSON.stringify(runsDelta)} ` +
              `parity=${result.parity}${result.parityDiff ? ` DIFF ${result.parityDiff.slice(0, 300)}` : ''}`,
          )
          perStep[step] = {
            rows: result.rowsCommitted,
            deriv: `${result.stats.rowsDerived}+${result.stats.rollupsDerived}+${result.stats.indexUpdates}`,
          }
          expect(result.parity).toBe(true)
          return result
        }
        await run('#1 unrelatedHeartbeat', '#1', () => writeHeartbeat(ctx))
        await run('#2 visibleSessionPhaseChange', '#2', () => writePhaseChange(ctx))
        await run('#3 selectionClick', '#3', () => writeSelectionClick(ctx))
        await run('#5 stageMoveAcrossGroups', '#5', () => writeStageMove(ctx))
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
      byScale.set(name, perStep)
    }
    // Counts for 1–3 must not grow with scale (the flatness gate).
    for (const step of ['#1 unrelatedHeartbeat', '#2 visibleSessionPhaseChange', '#3 selectionClick']) {
      const at1 = byScale.get('1x')?.[step]
      const at2 = byScale.get('2x')?.[step]
      const at4 = byScale.get('4x')?.[step]
      expect(at2?.rows).toBe(at1?.rows)
      expect(at4?.rows).toBe(at1?.rows)
      expect(at2?.deriv).toBe(at1?.deriv)
      expect(at4?.deriv).toBe(at1?.deriv)
    }
    const resultsDir = resultsDirOf()
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(join(resultsDir, 'tanstack-m3-growth.json'), JSON.stringify(table, null, 2))
  }, 900_000)

  it('coexistence scenario 15: arm + control on one kernel match their solo counts', async () => {
    const soloRun = async (
      kind: 'arm' | 'control',
      scenario: 'heartbeat' | 'click',
    ): Promise<{
      rows: number
      stats: { rowsDerived: number; rollupsDerived: number; indexUpdates: number; notifications: number }
    }> => {
      const ctx = await startScenarioEngine(SMALL_CORPUS)
      const source = createRowSource(ctx.engine, ctx.replica)
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const arm = kind === 'arm' ? tanstackArm : legacyControlArmFor(ctx.engine)
      const mounted = mountArmForCounts(arm, source.source, locals)
      try {
        const apply =
          scenario === 'heartbeat'
            ? async (): Promise<void> => {
                await writeHeartbeat(ctx)
                source.flush()
              }
            : async (): Promise<void> => {
                await writeSelectionClick(ctx)
                source.flush()
              }
        const result = await runCountScenario(mounted, {
          scenario: scenario === 'heartbeat' ? 'unrelatedHeartbeat' : 'selectionClick',
          methodology: scenario === 'heartbeat' ? '#1' : '#3',
          apply,
          expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
        })
        return { rows: result.rowsCommitted, stats: result.stats }
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
    }
    const soloArmHeartbeat = await soloRun('arm', 'heartbeat')
    const soloControlHeartbeat = await soloRun('control', 'heartbeat')
    const soloArmClick = await soloRun('arm', 'click')
    const soloControlClick = await soloRun('control', 'click')

    const co: Record<string, unknown> = {
      soloArmHeartbeat,
      soloControlHeartbeat,
      soloArmClick,
      soloControlClick,
    }
    const coRun = async (scenario: 'heartbeat' | 'click'): Promise<void> => {
      const ctx = await startScenarioEngine(SMALL_CORPUS)
      const source = createRowSource(ctx.engine, ctx.replica)
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const armMounted = mountArmForCounts(tanstackArm, source.source, locals)
      const controlMounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, locals)
      try {
        // One shared publication, both sides reset before it, both read after:
        // neither may wake the other beyond what its solo run shows.
        armMounted.handle.stats.reset()
        armMounted.log.reset()
        controlMounted.handle.stats.reset()
        controlMounted.log.reset()
        const { act } = await import('react')
        await act(async () => {
          if (scenario === 'heartbeat') await writeHeartbeat(ctx)
          else await writeSelectionClick(ctx)
          source.flush()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        })
        const expected = snapshotFromStore(ctx.engine.getSnapshot(), locals)
        const armParity =
          JSON.stringify(armMounted.handle.snapshot()) === JSON.stringify(expected)
        const controlParity =
          JSON.stringify(controlMounted.handle.snapshot()) === JSON.stringify(expected)
        const armRows = armMounted.log.total()
        const controlRows = controlMounted.log.total()
        const armStats = armMounted.handle.stats
        const controlStats = controlMounted.handle.stats
        const soloArm = scenario === 'heartbeat' ? soloArmHeartbeat : soloArmClick
        const soloControl = scenario === 'heartbeat' ? soloControlHeartbeat : soloControlClick
        expect(armParity).toBe(true)
        expect(controlParity).toBe(true)
        // Arm counts equal its solo counts; control counts equal its solo counts.
        expect(armRows).toBe(soloArm.rows)
        expect(armStats.rowsDerived).toBe(soloArm.stats.rowsDerived)
        expect(armStats.rollupsDerived).toBe(soloArm.stats.rollupsDerived)
        expect(controlRows).toBe(soloControl.rows)
        expect(controlStats.rowsDerived).toBe(soloControl.stats.rowsDerived)
        expect(controlStats.rollupsDerived).toBe(soloControl.stats.rollupsDerived)
        co[scenario] = {
          armRows,
          armStats: {
            rowsDerived: armStats.rowsDerived,
            rollupsDerived: armStats.rollupsDerived,
            indexUpdates: armStats.indexUpdates,
            notifications: armStats.notifications,
          },
          controlRows,
          controlStats: {
            rowsDerived: controlStats.rowsDerived,
            rollupsDerived: controlStats.rollupsDerived,
            indexUpdates: controlStats.indexUpdates,
            notifications: controlStats.notifications,
          },
          parity: [armParity, controlParity],
        }
      } finally {
        armMounted.unmount()
        controlMounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
    }
    await coRun('heartbeat')
    await coRun('click')
    const resultsDir = resultsDirOf()
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(
      join(resultsDir, 'tanstack-m3-coexistence.json'),
      JSON.stringify({ corpus: 'small', ...co }, null, 2),
    )
    // The armed control still says NO on its own (detector not blinded by the
    // arm's presence): solo control heartbeat commits rows.
    expect(soloControlHeartbeat.rows).toBeGreaterThan(0)
  }, 300_000)

  it('Q-T5 fan-out: archiving an R3 anchor re-resolves the shared worktree with contained commits', async () => {
    const ctx = await startScenarioEngine(GROWTH_CORPORA.x1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(tanstackArm, source.source, locals)
    try {
      const store = storeOf(mounted)
      // Mount record: the fan-out surface (was verdictR 0 before POD-4496).
      const verdictRRows = store.base.verdictR.toArray as Array<{ owner: string; sid: string }>
      const sharing = new Map<string, number>()
      for (const row of verdictRRows) {
        sharing.set(row.owner, (sharing.get(row.owner) ?? 0) + 1)
      }
      const anchor = [...sharing.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      expect(verdictRRows.length).toBeGreaterThan(0)
      expect(anchor).toBeDefined()
      console.info(
        `[tanstack-m3] Q-T5 mount: verdictR=${verdictRRows.length} anchors=${sharing.size} ` +
          `top=${anchor} x${sharing.get(anchor ?? '')}`,
      )
      // Archive the anchor carrying the most R3-resolved sessions: the
      // worktree index re-resolves broadly; value-equal suppression must
      // contain commits to the oracle-changed rows.
      const before = snapshotFromStore(ctx.engine.getSnapshot(), locals)
      const runsBefore = snapshotRuns(store.runs)
      const result = await runCountScenario(mounted, {
        scenario: 'archiveR3Anchor',
        methodology: 'Q-T5',
        apply: async () => {
          await writeArchiveIssue(ctx, anchor!)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      const runsDelta = diffRuns(runsBefore, store.runs)
      const fnMsDelta = diffMs(runsBefore, store.runs)
      const changed = changedRows(before, snapshotFromStore(ctx.engine.getSnapshot(), locals))
      const committed = Object.keys(result.commitsByRow).sort()
      const over = committed.filter((id) => !changed.includes(id))
      console.info(
        `[tanstack-m3] Q-T5 archive ${anchor}: committed=${result.rowsCommitted} [${committed.join(',')}] ` +
          `oracleChanged=${changed.length} overCommit=[${over.join(',')}] ` +
          `stats=${JSON.stringify(result.stats)} runs=${JSON.stringify(runsDelta)} parity=${result.parity}`,
      )
      expect(result.parity).toBe(true)
      // The fan-out ran AND was contained: the R3 join re-evaluated
      // (verdictR fn walls > 0 — the shared `verdict` run counter cannot
      // separate verdictQ from verdictR, but the ms split can) while every
      // verdictR output settled value-equal (zero verdictR change events,
      // zero over-commits).
      expect(fnMsDelta['verdictR'] ?? 0).toBeGreaterThan(0)
      expect(runsDelta['changes:verdictR'] ?? 0).toBe(0)
      expect(over).toEqual([])
      const resultsDir = resultsDirOf()
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, 'tanstack-m3-fanout.json'),
        JSON.stringify(
          {
            anchor,
            sessionsOnAnchor: sharing.get(anchor ?? ''),
            verdictRRows: verdictRRows.length,
            anchors: sharing.size,
            rowsCommitted: result.rowsCommitted,
            committed,
            oracleChanged: changed,
            stats: result.stats,
            runs: runsDelta,
            fnMs: fnMsDelta,
            parity: result.parity,
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
  }, 300_000)
})
