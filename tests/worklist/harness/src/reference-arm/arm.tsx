import { watchReference } from '@podium/client-graph/diagnostics/reference-state'
import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
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
 * LOCALS THROUGH THE CHANNEL (POD-4608). Selection and the clock come from the
 * `LocalsSource` it is created with, never from the engine store: it
 * recomputes on every engine publication (rows) AND on every locals
 * notification. On the fence's engine-backed source a click or a tick is
 * published to the channel one drain AFTER the engine publication, so the
 * row recompute still sees the old locals and only the channel brings the
 * selection and the clock in. The `deaf` plant shows what that costs.
 *
 * NOT A CANDIDATE. It reads the engine store, not the feed, and does
 * whole-world work per change; it is exempt from the reads fence and the copy
 * sweep, and it never appears in the round-three roster (`roster.ts`).
 */

import { isDeepStrictEqual } from 'node:util'
import { createElement, memo, type ReactElement, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { CheckableArm, CheckableArmHandle, LocalsSource } from '../../../shared/src/arm'
import {
  CommitLogContext,
  currentCommitLog,
  type RowProps,
  RowShell,
} from '../../../shared/src/row-shell'
import type { RowView } from '@podium/client-graph/shared/row-view'
import type { SliceLocals, SliceOrder, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import type { ClientRuntime } from '@podium/client-core/engine'
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
 * - `deaf`: the locals are read ONCE, at creation, and the channel is never
 *   subscribed — the round-two contract. A click (#3) never selects a row and
 *   a tick (#8b) never folds one (under-commit).
 * - `bareRef` (POD-4624): every row's `displayRef` loses its repo prefix
 *   (`POD-12` → `#12`), as an arm reading an empty `repos` kind would. The
 *   one plant PARITY must fail — and could not while the scenario seeder left
 *   `repos` empty, because the oracle's refs were bare too.
 */
export type ReferencePlant =
  | { kind: 'unmemoised' }
  | { kind: 'stale'; id: string }
  | { kind: 'remount' }
  | { kind: 'deaf' }
  | { kind: 'bareRef' }

/** `POD-12` → `#12`; a ref with no prefix is already bare. */
function bareRef(ref: string): string {
  return ref.replace(/^.+-(\d+)$/, '#$1')
}

interface ReferenceState {
  order: SliceOrder
  views: RowViews
}

function stateOf(
  engine: ClientRuntime,
  locals: SliceLocals,
  previous: ReferenceState | null,
  plant: ReferencePlant | null,
): ReferenceState {
  const store = referenceState(engine)
  const fresh = rowViewsFromStore(store, locals)
  const views: RowViews = {}
  for (const [id, drawn] of Object.entries(fresh)) {
    const view =
      plant?.kind === 'bareRef' ? { ...drawn, displayRef: bareRef(drawn.displayRef) } : drawn
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
  engine: ClientRuntime,
  plant: ReferencePlant | null = null,
): CheckableArm {
  return {
    create(_source, channel: LocalsSource): CheckableArmHandle {
      const stats = zeroStats()
      const deafTo = plant?.kind === 'deaf' ? channel.get() : null
      const localsNow = (): SliceLocals => deafTo ?? channel.get()
      let state = stateOf(engine, localsNow(), null, plant)
      const listeners = new Set<() => void>()
      const refresh = (): void => {
        stats.notifications += 1
        state = stateOf(engine, localsNow(), state, plant)
        for (const listener of [...listeners]) listener()
      }
      const offRows = watchReference(engine, refresh)
      const offLocals = deafTo === null ? channel.subscribe(refresh) : () => {}
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
          const snapshot = snapshotFromStore(referenceState(engine), {
            ...localsNow(),
            selectedIssueId: null,
          })
          if (plant?.kind === 'bareRef')
            for (const row of Object.values(snapshot.rowsById))
              row.displayRef = bareRef(row.displayRef)
          return snapshot
        },
        rebuildFromScratch(): SliceSnapshot {
          return snapshotFromStore(referenceState(engine), { ...localsNow(), selectedIssueId: null })
        },
        stats,
        dispose(): void {
          offRows()
          offLocals()
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
