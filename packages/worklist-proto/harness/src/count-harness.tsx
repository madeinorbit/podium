// @vitest-environment happy-dom
/**
 * POD-4445 — the ONE way every round-two arm is counted in CI.
 *
 * Mounts any `Arm` under happy-dom, replays a scenario's input, and reports:
 * rows committed (per-row `React.Profiler` via the required `RowShell`),
 * rows READ (POD-4557: the reads-per-change fence, `shared/src/instrument/
 * reads.ts`, through which the harness hands the arm its feed), the arm's
 * `ArmStats`, and oracle parity (`arm.snapshot()` deep-equal to the
 * caller-supplied expected `SliceSnapshot`).
 *
 * happy-dom has no paint: this module reports COMMITS, never wall time. Walls
 * (input-to-paint, long tasks, heap) come from the Chromium driver
 * (`harness/browser/run.ts`) only. Never report a number from here as timing.
 *
 * Two input shapes, one detector:
 * - ENGINE-BACKED (the legacy control now, greenfield arms in CI later):
 *   `mountArmForCounts` + `runCountScenario`. The caller boots the engine
 *   (G3 `startScenarioEngine`), mounts the arm, then `apply()` performs the
 *   scenario write and `expected()` projects the oracle over the live store
 *   (`snapshotFromStore`). No arm reads the scenario library; no scenario
 *   knows the arm.
 * - REPLAY (fixture-backed, for fast arm unit tests): `createReplaySource`
 *   feeds canned `RowSourceEvent`s; `expected()` is the fixture oracle's
 *   `expectedSnapshot`. Same counters, same assertion.
 */

import { isDeepStrictEqual } from 'node:util'
import { act, useEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import {
  CommitLogContext,
  createCommitLog,
  withCommitLog,
  withCommitLogAsync,
  type CommitLog,
} from '../../shared/src/row-shell'
import {
  createReadFence,
  DISABLED_READ_FENCE,
  type ReadFence,
  type ReadStats,
} from '../../shared/src/instrument/reads'
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../shared/src/stats'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------- mounting

export interface MountedArm {
  handle: ArmHandle
  log: CommitLog
  /** The reads fence the arm was created with. Disabled means "no reads cell". */
  reads: ReadFence
  unmount(): void
}

function MountPoint({ handle }: { handle: ArmHandle }): ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (el === null) return
    const unmount = handle.mountWeb(el)
    return unmount
  }, [el, handle])
  return <div ref={setEl} data-testid="arm-mount" />
}

/**
 * Mount any arm's web list with commit logging. Mount-phase commits are
 * excluded by the `RowShell` itself (Profiler `mount` phase) and the log and
 * stats are reset before return, so the first scenario starts from zero.
 *
 * The mount runs under `withCommitLog` because an arm's `mountWeb` renders
 * through its own root, which cannot inherit this tree's provider context
 * (see `row-shell.tsx`); context — when an arm renders inside the provider
 * tree — still takes precedence.
 *
 * The reads fence is ON by default (POD-4557): the arm receives `source`
 * through `reads.wrapSource`, so every row value it ever holds is a borrowed,
 * counted row, and it receives the fence itself to wrap its tables and
 * relations. The arm cannot opt out; only the caller can, by passing a
 * disabled fence, and then every reads cell is `null` and `assertReads`
 * throws.
 */
export function mountArmForCounts(
  arm: Arm,
  source: RowSource,
  locals: SliceLocals,
  options: { reads?: ReadFence } = {},
): MountedArm {
  const log = createCommitLog()
  const reads = options.reads ?? createReadFence({ enabled: true })
  const handle = arm.create(reads.wrapSource(source), locals, reads)
  return mountElementForCounts(handle, <MountPoint handle={handle} />, log, reads)
}

/**
 * Mount an already-created handle's element with commit logging. The web path
 * goes through `mountArmForCounts`; the native lane passes
 * `handle.mountNative()` here. Element renders (not `mountWeb` roots) inherit
 * the provider context directly; `mountWeb` roots fall back to the ambient log
 * (see `row-shell.tsx`).
 */
export function mountElementForCounts(
  handle: ArmHandle,
  element: ReactElement,
  log: CommitLog = createCommitLog(),
  reads: ReadFence = DISABLED_READ_FENCE,
): MountedArm {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // Ambient OUTSIDE act: `mountWeb` runs in effects flushed by act, after a
  // scope placed inside act would already have closed.
  withCommitLog(log, () => {
    act(() => {
      root.render(<CommitLogContext.Provider value={log}>{element}</CommitLogContext.Provider>)
    })
  })
  log.reset()
  handle.stats.reset()
  if (reads.enabled) reads.reset()
  return {
    handle,
    log,
    reads,
    unmount(): void {
      act(() => {
        root.unmount()
      })
      handle.dispose()
      container.remove()
    },
  }
}

/**
 * Mount an arm's NATIVE list with commit logging (the G4 native lane). Unlike
 * `mountWeb` roots, the element renders in this tree, so the provider context
 * reaches every `RowShell` directly. Async because arm native lists may arrive
 * through `React.lazy` (the control's does — see its `arm.ts`).
 */
export async function mountNativeForCounts(
  handle: ArmHandle,
  reads: ReadFence = DISABLED_READ_FENCE,
): Promise<MountedArm> {
  const log = createCommitLog()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CommitLogContext.Provider value={log}>{handle.mountNative()}</CommitLogContext.Provider>)
  })
  log.reset()
  handle.stats.reset()
  if (reads.enabled) reads.reset()
  return {
    handle,
    log,
    reads,
    unmount(): void {
      act(() => {
        root.unmount()
      })
      handle.dispose()
      container.remove()
    },
  }
}

// ------------------------------------------------------------ replay source

/**
 * A controllable `RowSource` for fixture-backed count runs. Seeded with full
 * rows; `push` upserts (or deletes on `value: undefined`) then notifies, so
 * arms that subscribe see exactly the scenario's events and nothing else.
 */
export interface ReplaySource {
  source: RowSource
  push(event: RowSourceEvent): void
}

export function createReplaySource(initial: {
  issues: RowRecord[]
  sessions: RowRecord[]
  worktrees: RowRecord[]
}): ReplaySource {
  const rows = new Map<string, RowRecord>()
  const seed = (list: RowRecord[]): void => {
    for (const row of list) rows.set(`${row.kind}:${row.id}`, row)
  }
  seed(initial.issues)
  seed(initial.sessions)
  seed(initial.worktrees)
  const listeners = new Set<(event: RowSourceEvent) => void>()
  const source: RowSource = {
    snapshot(kind: RowRecord['kind']): RowRecord[] {
      return [...rows.values()].filter((row) => row.kind === kind)
    },
    subscribe(listener: (event: RowSourceEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    source,
    push(event: RowSourceEvent): void {
      for (const row of event.rows) {
        const key = `${row.kind}:${row.id}`
        if (row.value === undefined) rows.delete(key)
        else rows.set(key, row)
      }
      for (const listener of [...listeners]) listener(event)
    },
  }
}

// ------------------------------------------------------------------- running

/** One counted scenario: the action plus the oracle snapshot after it. */
export interface CountInput {
  scenario: string
  /** Methodology §5.8 number, e.g. `#1`. */
  methodology: string
  /** Perform the scenario input (engine write, replay push, local change). */
  apply(): void | Promise<void>
  /** The oracle snapshot the arm must equal afterwards. */
  expected(): SliceSnapshot
}

export interface CountStats {
  rowsDerived: number
  rollupsDerived: number
  indexUpdates: number
  notifications: number
}

export interface CountResult {
  scenario: string
  methodology: string
  rowsCommitted: number
  /**
   * Distinct entity rows the arm read to handle this change (POD-4557), or
   * `null` when the mount's fence was disabled. Read BEFORE the harness calls
   * `snapshot()`, so the parity projection is never charged to the arm.
   */
  readsPerChange: number | null
  /** The fence's breakdown behind `readsPerChange`. */
  reads: ReadStats | null
  commitsByRow: Record<string, number>
  /** Visible rows in the arm snapshot after the scenario (the isolation denominator). */
  visibleRows: number
  stats: CountStats
  parity: boolean
  parityDiff: string | null
}

function firstDiff(actual: SliceSnapshot, expected: SliceSnapshot): string | null {
  const actualIds = Object.keys(actual.rowsById).sort()
  const expectedIds = Object.keys(expected.rowsById).sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    const missing = expectedIds.filter((id) => !actualIds.includes(id))
    const extra = actualIds.filter((id) => !expectedIds.includes(id))
    return `row set differs: missing [${missing.slice(0, 5).join(',')}] extra [${extra.slice(0, 5).join(',')}]`
  }
  for (const id of expectedIds) {
    if (JSON.stringify(actual.rowsById[id]) !== JSON.stringify(expected.rowsById[id])) {
      return (
        `row ${id} differs:\n` +
        `  actual   ${JSON.stringify(actual.rowsById[id])}\n` +
        `  expected ${JSON.stringify(expected.rowsById[id])}`
      )
    }
  }
  if (JSON.stringify(actual.order) !== JSON.stringify(expected.order)) {
    return `order differs:\n  actual   ${JSON.stringify(actual.order).slice(0, 400)}\n  expected ${JSON.stringify(expected.order).slice(0, 400)}`
  }
  return null
}

/**
 * Reset counters, run the scenario input inside `act` (flushing effects and
 * coalesced microtask publications), then read commits, stats and parity.
 */
export async function runCountScenario(
  mounted: MountedArm,
  input: CountInput,
): Promise<CountResult> {
  mounted.handle.stats.reset()
  mounted.log.reset()
  if (mounted.reads.enabled) mounted.reads.reset()
  await withCommitLogAsync(mounted.log, async () => {
    await act(async () => {
      await input.apply()
      // Flush coalesced microtask publications (the row source drains on a
      // microtask; arm subscriptions may chain one more) before reading.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  })
  // Reads first: `snapshot()` below walks the arm's whole output and must not
  // be charged to the change.
  const reads = mounted.reads.enabled ? mounted.reads.stats() : null
  const snapshot = mounted.handle.snapshot()
  const expected = input.expected()
  const parity = isDeepStrictEqual(snapshot, expected)
  const commitsByRow: Record<string, number> = {}
  for (const [id, count] of mounted.log.counts) commitsByRow[id] = count
  const stats = mounted.handle.stats
  return {
    scenario: input.scenario,
    methodology: input.methodology,
    rowsCommitted: mounted.log.total(),
    readsPerChange: reads === null ? null : reads.rows,
    reads,
    commitsByRow,
    visibleRows: Object.keys(snapshot.rowsById).length,
    stats: {
      rowsDerived: stats.rowsDerived,
      rollupsDerived: stats.rollupsDerived,
      indexUpdates: stats.indexUpdates,
      notifications: stats.notifications,
    },
    parity,
    parityDiff: parity ? null : firstDiff(snapshot, expected),
  }
}

// ----------------------------------------------------------------- assertion

export interface IsolationBudget {
  /** Max rows allowed to commit. Methodology #1 (heartbeat): 0. */
  rowsCommitted: number
}

/**
 * The isolation fence (methodology §4.2, §5.8): rows committed must not exceed
 * rows affected. Throws with the counts on failure — BY DESIGN the legacy
 * control fails this on `unrelatedHeartbeat`, which proves the detector can
 * say NO (that failure is kept as the armed control test, never weakened).
 */
export function assertIsolation(result: CountResult, budget: IsolationBudget): void {
  // Both directions are guarded in count-harness.test.ts. Keep it that way: every
  // other caller asserts this THROWS (the legacy control exists to fail), so a
  // change that made it throw unconditionally would break every arm silently.
  if (result.rowsCommitted > budget.rowsCommitted) {
    const top = Object.entries(result.commitsByRow)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => `${id}x${n}`)
      .join(' ')
    throw new Error(
      `[isolation] ${result.scenario} (${result.methodology}): ` +
        `committed ${result.rowsCommitted} rows, budget ${budget.rowsCommitted}. ` +
        `stats=${JSON.stringify(result.stats)} top=[${top}]. ` +
        `parity=${result.parity ? 'pass' : `FAIL ${result.parityDiff ?? ''}`}`,
    )
  }
}

// ------------------------------------------------------------ reads budgets

/**
 * POD-4557 — rows an arm may READ to handle one change, per scenario. Fixed
 * here, BEFORE any round-three arm is measured (pitfall g: no budget is
 * re-read on another dimension afterwards). Rationale per line in
 * `docs/plans/pod-4441-harness.md` ("Reads per change").
 */
export const READ_BUDGETS = {
  /** #1: the changed session, and at most its issue and one relation hop. */
  unrelatedHeartbeat: 3,
  /** #3: selection is a local; no table read at all. */
  selectionClick: 0,
  /** #4: the renamed issue, and at most two rows to place or label it. */
  visibleTitleRename: 3,
  /** #2: rows per level of the changed session's issue chain (see `phaseChangeReadBudget`). */
  phaseChangePerLevel: 3,
  /**
   * #5: the visible neighbourhood of a row that moves between groups — the
   * row, two neighbours at the old and at the new position (5), plus the
   * probes of a binary-search placement at 4x (~850 visible rows: log2 ≈ 10),
   * rounded up for a header lookup and the fold boundary. A re-sort that
   * re-reads every visible row fails.
   */
  stageMoveNeighbourhood: 24,
} as const

/**
 * #2 budget: `phaseChangePerLevel × levels`, where `levels` is the changed
 * session's issue plus every ancestor above it (chain depth + 1). A roll-up
 * that re-reads a level's siblings is proportional to the family size, not
 * the chain, and fails.
 */
export function phaseChangeReadBudget(ancestors: number): number {
  return READ_BUDGETS.phaseChangePerLevel * (ancestors + 1)
}

/**
 * Number of ancestors above `issueId` via `parentOf`. Cycle-safe: a repeated
 * id stops the walk (the corpus has none; a malformed one must not hang CI).
 */
export function ancestorCount(
  issueId: string,
  parentOf: (id: string) => string | null | undefined,
): number {
  const seen = new Set<string>([issueId])
  let count = 0
  let current = parentOf(issueId)
  while (typeof current === 'string' && current.length > 0 && !seen.has(current)) {
    seen.add(current)
    count += 1
    current = parentOf(current)
  }
  return count
}

export interface ReadsBudget {
  /** Max distinct rows the arm may read for this change. */
  readsPerChange: number
}

/**
 * The reads fence. Throws with the breakdown when the arm read more distinct
 * rows than the budget allows — and ALSO when the result has no reads cell
 * (the mount's fence was disabled): a missing cell fails, it is never a pass.
 * Both directions are guarded in `count-harness.test.ts`; the legacy control
 * must FAIL it on `unrelatedHeartbeat` (`control.test.tsx`).
 */
export function assertReads(result: CountResult, budget: ReadsBudget): void {
  if (result.readsPerChange === null || result.reads === null) {
    throw new Error(
      `[reads] ${result.scenario} (${result.methodology}): no reads cell — the mount's read fence was disabled`,
    )
  }
  if (result.readsPerChange > budget.readsPerChange) {
    throw new Error(
      `[reads] ${result.scenario} (${result.methodology}): ` +
        `read ${result.readsPerChange} rows, budget ${budget.readsPerChange}. ` +
        `byEntity=${JSON.stringify(result.reads.byEntity)} ` +
        `accesses=${JSON.stringify(result.reads.accesses)} ` +
        `first=[${result.reads.sample.join(' ')}] rowsCommitted=${result.rowsCommitted}`,
    )
  }
}
