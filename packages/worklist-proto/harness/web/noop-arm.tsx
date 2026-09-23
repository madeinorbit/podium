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
 * `walk:<passes>` walks every issue and session row of the feed that many
 * times inside every notification and commits nothing: work that grows with
 * the corpus (O(N) per change), which the restated slope budget (excess over
 * the floor, 4x over 1x) must fail while `sync:<ms>` (constant) passes it.
 *
 * LIFECYCLE PLANTS (POD-4561, the lifecycle walls' and heap checks' can-say-NO
 * proof): `build:<ms>` busy-waits that long inside `create` (the arm's own
 * construction), which coldBootstrap and principalSwitch must charge to
 * `actionMs`; `leak:<mb>` holds an `mb` MB block per store and, on `dispose`
 * and on every feed `replace` (a rescope), moves the block to a page global
 * instead of dropping it (and takes a new one on replace), so a principal
 * switch retains `mb` MB more and a rescope (two replaces) `2 × mb`;
 * `retain:1` keeps the disposed store (its handle, and through it the feed
 * and the runtime it was built over) in a page global, so a principal switch
 * leaves the old principal alive and the driver's survivor check must fail.
 */

import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Arm, ArmHandle } from '../../shared/src/arm'
import {
  CommitLogContext,
  currentCommitLog,
  type RowActions,
  RowActionsContext,
  type RowProps,
  RowShell,
  useRowActions,
} from '../../shared/src/row-shell'
import type { ScenarioEngine } from '../../shared/src/scenarios'
import type { SliceSnapshot } from '../../shared/src/slice-types'
import type { ArmStats, RowSourceEvent } from '../../shared/src/stats'
import { oracleSnapshot, rowViewsFromStore } from '../src/oracle/index'

/** Rows drawn: the first window (`FIRST_WINDOW_ROWS`) plus the rows a page's
 *  stage moves pull into it (one per round), like a windowed arm's overscan. */
const DRAWN_ROWS = 108

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

export type NoopPlant = {
  kind: 'sync' | 'late' | 'walk' | 'build' | 'leak' | 'retain'
  ms: number
} | null

const PLANT_KINDS = new Set(['sync', 'late', 'walk', 'build', 'leak', 'retain'])

/** `?plant=sync:<ms>` / `late:<ms>` / `walk:<passes>` / `build:<ms>` / `leak:<mb>` / `retain:1`; null when absent. */
export function readPlant(): NoopPlant {
  const raw = new URLSearchParams(window.location.search).get('plant')
  if (raw === null) return null
  const [kind, ms] = raw.split(':')
  if (!PLANT_KINDS.has(kind ?? '') || !Number.isFinite(Number(ms))) {
    throw new Error(
      `[noop] bad plant ${raw} (want sync:<ms>, late:<ms>, walk:<passes>, build:<ms>, leak:<mb> or retain:1)`,
    )
  }
  return { kind: kind as NonNullable<NoopPlant>['kind'], ms: Number(ms) }
}

/** `leak:<mb>`: an `mb` MB block on the V8 heap (a packed array of doubles). */
function heapBlock(mb: number): number[] {
  return Array.from({ length: mb * 131_072 }, (_, i) => i + 0.5)
}

/** Where `leak:<mb>` and `retain:1` put what they should have dropped. */
const leaked: unknown[] = []

export function noopArmFor(boot: ScenarioEngine, plant: NoopPlant = null): Arm {
  return {
    create(source, locals): ArmHandle {
      if (plant?.kind === 'build') {
        const until = performance.now() + plant.ms
        while (performance.now() < until) {
          // planted construction work
        }
      }
      let block = plant?.kind === 'leak' ? heapBlock(plant.ms) : null
      let redraw = (): void => {}
      const onChange = (event?: RowSourceEvent): void => {
        if (plant === null) return
        if (plant.kind === 'build' || plant.kind === 'retain') return
        if (plant.kind === 'leak') {
          if (event?.type === 'replace' && block !== null) {
            leaked.push(block)
            block = heapBlock(plant.ms)
          }
          return
        }
        if (plant.kind === 'walk') {
          let sink = 0
          for (let pass = 0; pass < plant.ms; pass += 1) {
            for (const record of source.snapshot('issue')) sink += record.id.length
            for (const record of source.snapshot('session')) sink += record.id.length
          }
          // Observable, so the walk cannot be optimised away.
          ;(globalThis as { __noopWalked?: number }).__noopWalked = sink
        } else if (plant.kind === 'sync') {
          const until = performance.now() + plant.ms
          while (performance.now() < until) {
            // planted synchronous work
          }
        } else {
          setTimeout(() => redraw(), plant.ms)
        }
      }
      const offSource = source.subscribe(onChange)
      const offLocals = locals.subscribe(() => onChange())
      const store = boot.engine.getSnapshot()
      const frozen: SliceSnapshot = oracleSnapshot(store)
      const views = rowViewsFromStore(store, locals.get())
      const ordered = [...frozen.order.pinnedIds, ...frozen.order.groups.flatMap((g) => g.rowIds)]
      const rows = ordered.slice(0, DRAWN_ROWS).flatMap((id) => (views[id] ? [views[id]] : []))
      let root: ReturnType<typeof createRoot> | null = null
      const handle: ArmHandle = {
        snapshot: () => frozen,
        stats: zeroStats(),
        dispose() {
          if (plant?.kind === 'retain') leaked.push({ handle, source, boot })
          if (block !== null) leaked.push(block)
          block = null
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
                  rows.map((row) =>
                    createElement(RowShell, { key: row.id, row, component: NoopRow }),
                  ),
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
      return handle
    },
  }
}
