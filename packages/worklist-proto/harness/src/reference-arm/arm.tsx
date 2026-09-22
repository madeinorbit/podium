/**
 * POD-4563 (L6a) — the REFERENCE arm: the fence suite's "can say YES" arm.
 *
 * It is the oracle drawn through the round-three row contract. On every engine
 * publication it recomputes every row view with `rowViewsFromStore` (the same
 * function the fence compares against), keeps the previous view object when
 * the new one is deep-equal, and renders one flat keyed list of memoised
 * `RowShell` rows. So it redraws exactly the rows whose view changed — if, and
 * only if, the harness mechanics are right: commits counted per row, mounts
 * not counted, a moved row not remounted, the before/after oracle taken at the
 * right instants. `fences.test.tsx` requires it to pass `assertCommits` on
 * every scenario; the legacy control is the arm that must fail.
 *
 * NOT A CANDIDATE. It reads the engine store, not the feed, and does
 * whole-world work per change; it is exempt from the reads fence and the copy
 * sweep, and it never appears in the round-three roster (`roster.ts`).
 */

import { isDeepStrictEqual } from 'node:util'
import { createElement, memo, type ReactElement, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { Arm, ArmHandle } from '../../../shared/src/arm'
import {
  CommitLogContext,
  currentCommitLog,
  type RowProps,
  RowShell,
} from '../../../shared/src/row-shell'
import type { RowView } from '../../../shared/src/row-view'
import type { SliceLocals, SliceOrder, SliceSnapshot } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import type { LegacyControlEngine } from '../legacy-control/arm'
import { type RowViews, rowViewsFromStore, snapshotFromStore } from '../oracle/index'

/**
 * PLANTED MISTAKES (`fences.planted.test.tsx`): each turns this arm into one
 * that parity still passes and the exact-commit fence must fail. Absent in
 * the real reference arm.
 * - `unmemoised`: the row slot is not memoised, so every list render redraws
 *   every row (over-commit).
 * - `stale`: the view of row `id` is never refreshed after mount, so a change
 *   to it never redraws (under-commit).
 * - `remount`: rows are keyed by a render counter, so every list render
 *   REMOUNTS every row and commits none (round two's isolation fence, which
 *   counts commits only, passes it).
 */
export type ReferencePlant =
  | { kind: 'unmemoised' }
  | { kind: 'stale'; id: string }
  | { kind: 'remount' }

interface ReferenceState {
  order: SliceOrder
  views: RowViews
}

function localsOf(engine: LegacyControlEngine): SliceLocals {
  const store = engine.getSnapshot()
  return { selectedIssueId: store.selectedIssueId ?? null, coarseNow: store.coarseNow }
}

function stateOf(
  engine: LegacyControlEngine,
  previous: ReferenceState | null,
  plant: ReferencePlant | null,
): ReferenceState {
  const store = engine.getSnapshot()
  const locals = localsOf(engine)
  const fresh = rowViewsFromStore(store, locals)
  const views: RowViews = {}
  for (const [id, view] of Object.entries(fresh)) {
    const prior = previous?.views[id]
    const stale = plant?.kind === 'stale' && plant.id === id
    views[id] = prior !== undefined && (stale || isDeepStrictEqual(prior, view)) ? prior : view
  }
  return { order: snapshotFromStore(store, locals).order, views }
}

const ReferenceRow = memo(function ReferenceRow({ row }: RowProps): ReactElement {
  return (
    <div data-issue-row={row.id} data-selected={row.selected ? 'true' : 'false'}>
      {row.displayRef} {row.title} [{row.phase}
      {row.working ? '*' : ''}
      {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
      {row.originTick !== null ? ` ⤷${row.originTick.ref}` : ''}
    </div>
  )
})

function Slot({ view }: { view: RowView }): ReactElement {
  return <RowShell row={view} component={ReferenceRow} />
}

const ReferenceSlot = memo(Slot)

function ReferenceList({
  subscribe,
  read,
}: {
  subscribe: (listener: () => void) => () => void
  read: () => ReferenceState
}): ReactElement {
  const state = useSyncExternalStore(subscribe, read)
  return (
    <div data-reference-list>
      {listedIds(state).map((id) => {
        const view = state.views[id]
        return view === undefined ? null : <ReferenceSlot key={id} view={view} />
      })}
    </div>
  )
}

/** The planted lists: the same list, with one mistake each. */
function PlantedList({
  subscribe,
  read,
  plant,
}: {
  subscribe: (listener: () => void) => () => void
  read: () => ReferenceState
  plant: ReferencePlant
}): ReactElement {
  const state = useSyncExternalStore(subscribe, read)
  const renders = useRef(0)
  renders.current += 1
  const SlotType = plant.kind === 'unmemoised' ? Slot : ReferenceSlot
  return (
    <div data-reference-list>
      {listedIds(state).map((id) => {
        const view = state.views[id]
        const key = plant.kind === 'remount' ? `${id}:${renders.current}` : id
        return view === undefined ? null : <SlotType key={key} view={view} />
      })}
    </div>
  )
}

function listedIds(state: ReferenceState): string[] {
  return [
    ...state.order.pinnedIds,
    ...state.order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
}

function zeroStats(): ArmStats {
  const stats: ArmStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset(): void {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
    },
  }
  return stats
}

export function referenceArmFor(
  engine: LegacyControlEngine,
  plant: ReferencePlant | null = null,
): Arm {
  return {
    create(): ArmHandle {
      const stats = zeroStats()
      let state = stateOf(engine, null, plant)
      const listeners = new Set<() => void>()
      const off = engine.subscribe(() => {
        stats.notifications += 1
        state = stateOf(engine, state, plant)
        for (const listener of [...listeners]) listener()
      })
      const subscribe = (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      const read = (): ReferenceState => state
      let webRoot: { unmount(): void } | null = null
      return {
        snapshot(): SliceSnapshot {
          return snapshotFromStore(engine.getSnapshot(), {
            ...localsOf(engine),
            selectedIssueId: null,
          })
        },
        stats,
        dispose(): void {
          off()
          webRoot?.unmount()
          webRoot = null
        },
        mountWeb(el: Element): () => void {
          webRoot?.unmount()
          const root = createRoot(el)
          webRoot = root
          const log = currentCommitLog()
          root.render(
            <CommitLogContext.Provider value={log}>
              {plant === null
                ? createElement(ReferenceList, { subscribe, read })
                : createElement(PlantedList, { subscribe, read, plant })}
            </CommitLogContext.Provider>,
          )
          return () => {
            root.unmount()
            if (webRoot === root) webRoot = null
          }
        },
        mountNative(): ReactElement {
          throw new Error('[reference] web lane only; the reference arm has no native list')
        },
      }
    },
  }
}
