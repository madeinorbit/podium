// @vitest-environment happy-dom
/**
 * POD-4445 — the ONE way every round-two arm is counted in CI.
 *
 * Mounts any `Arm` under happy-dom, replays a scenario's input, and reports:
 * rows committed (per-row `React.Profiler` via the required `RowShell`),
 * the arm's `ArmStats`, and oracle parity (`arm.snapshot()` deep-equal to the
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
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../shared/src/stats'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------- mounting

export interface MountedArm {
  handle: ArmHandle
  log: CommitLog
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
 */
export function mountArmForCounts(
  arm: Arm,
  source: RowSource,
  locals: SliceLocals,
): MountedArm {
  const log = createCommitLog()
  const handle = arm.create(source, locals)
  return mountElementForCounts(handle, <MountPoint handle={handle} />, log)
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
  return {
    handle,
    log,
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
export async function mountNativeForCounts(handle: ArmHandle): Promise<MountedArm> {
  const log = createCommitLog()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CommitLogContext.Provider value={log}>{handle.mountNative()}</CommitLogContext.Provider>)
  })
  log.reset()
  handle.stats.reset()
  return {
    handle,
    log,
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
  await withCommitLogAsync(mounted.log, async () => {
    await act(async () => {
      await input.apply()
      // Flush coalesced microtask publications (the row source drains on a
      // microtask; arm subscriptions may chain one more) before reading.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  })
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
