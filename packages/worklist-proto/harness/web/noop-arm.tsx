/**
 * POD-4558 (L5b) — the no-op arm: the instrument floor.
 *
 * It takes every change and does nothing with it. It subscribes to the feed
 * and the locals (so the shared kernel write and the feed drain run exactly as
 * they do under a real arm) and ignores every notification. Its rows are drawn
 * once, at mount, from the oracle over the boot store, through the SAME
 * `RowShell` a round-three arm uses — so its commit signal comes from its own
 * shell, and the page times it on the same path as every other arm.
 *
 * What the driver measures on this page is therefore the cost of the write,
 * the feed, the harness's own settle hop and nothing else: the floor that
 * every budget is stated on (`docs/plans/pod-4441-harness.md`, "Instrument
 * floor"). It is not a candidate; the oracle import here never reaches an arm
 * page's bundle.
 *
 * PLANTS (`?plant=` on the page; the timer's can-say-NO proof, never a
 * floor run): `sync:<ms>` busy-waits that long inside every feed/locals
 * notification and commits nothing; `late:<ms>` re-renders every drawn row
 * from a timer that long after every notification, so the commit lands in a
 * later task. The timer must charge both to `actionMs`, and a `late` longer
 * than the settle must surface as `strayCommits` on the next record.
 */

import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Arm, ArmHandle } from '../../shared/src/arm'
import {
  CommitLogContext,
  currentCommitLog,
  RowActionsContext,
  RowShell,
  useRowActions,
  type RowActions,
  type RowProps,
} from '../../shared/src/row-shell'
import type { SliceSnapshot } from '../../shared/src/slice-types'
import type { ArmStats } from '../../shared/src/stats'
import type { ScenarioEngine } from '../../shared/src/scenarios'
import { oracleSnapshot, rowViewsFromStore } from '../src/oracle/index'

/** Rows drawn: about one window of the arms' lists (17 at 1600×1000), plus
 *  the library's click targets. */
const DRAWN_ROWS = 20

const NOOP_ACTIONS: RowActions = { select: () => {} }

function NoopRow({ row }: RowProps): ReactElement {
  const actions = useRowActions()
  return (
    <div data-issue-row={row.id}>
      <button type="button" data-pressable onClick={() => actions.select(row.id)}>
        {row.displayRef} {row.title}
      </button>
    </div>
  )
}

function zeroStats(): ArmStats {
  return {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset() {},
  }
}

export type NoopPlant = { kind: 'sync' | 'late'; ms: number } | null

/** `?plant=sync:<ms>` / `late:<ms>`; null when absent. */
export function readPlant(): NoopPlant {
  const raw = new URLSearchParams(window.location.search).get('plant')
  if (raw === null) return null
  const [kind, ms] = raw.split(':')
  if ((kind !== 'sync' && kind !== 'late') || !Number.isFinite(Number(ms))) {
    throw new Error(`[noop] bad plant ${raw} (want sync:<ms> or late:<ms>)`)
  }
  return { kind, ms: Number(ms) }
}

/** `mustDraw`: rows drawn even when outside the first window (the library's click targets). */
export function noopArmFor(boot: ScenarioEngine, mustDraw: readonly string[], plant: NoopPlant = null): Arm {
  return {
    create(source, locals): ArmHandle {
      let redraw = (): void => {}
      const onChange = (): void => {
        if (plant === null) return
        if (plant.kind === 'sync') {
          const until = performance.now() + plant.ms
          while (performance.now() < until) {
            // planted synchronous work
          }
        } else {
          setTimeout(() => redraw(), plant.ms)
        }
      }
      const offSource = source.subscribe(onChange)
      const offLocals = locals.subscribe(onChange)
      const store = boot.engine.getSnapshot()
      const frozen: SliceSnapshot = oracleSnapshot(store)
      const views = rowViewsFromStore(store, locals.get())
      const ordered = [...frozen.order.pinnedIds, ...frozen.order.groups.flatMap((g) => g.rowIds)]
      const drawn = new Set(ordered.slice(0, DRAWN_ROWS))
      for (const id of mustDraw) drawn.add(id)
      const rows = [...drawn].flatMap((id) => (views[id] ? [views[id]] : []))
      let root: ReturnType<typeof createRoot> | null = null
      return {
        snapshot: () => frozen,
        stats: zeroStats(),
        dispose() {
          offSource()
          offLocals()
          root?.unmount()
          root = null
        },
        mountWeb(el) {
          root?.unmount()
          const mounted = createRoot(el)
          root = mounted
          const log = currentCommitLog()
          const draw = (): void =>
            mounted.render(
              createElement(
                CommitLogContext.Provider,
                { value: log },
                createElement(
                  RowActionsContext.Provider,
                  { value: NOOP_ACTIONS },
                  rows.map((row) => createElement(RowShell, { key: row.id, row, component: NoopRow })),
                ),
              ),
            )
          draw()
          redraw = draw
          return () => {
            mounted.unmount()
            if (root === mounted) root = null
          }
        },
        mountNative(): ReactElement {
          throw new Error('[noop] the instrument floor is a web page only')
        },
      }
    },
  }
}
