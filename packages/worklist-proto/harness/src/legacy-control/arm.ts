/**
 * POD-4445 legacy control arm — the current store behind the `Arm` interface.
 *
 * Construction: `legacyControlArmFor(engine)` closes over a live
 * `ClientRuntime` (built the way G3 builds it — `startScenarioEngine` in tests,
 * the fixture seeder in web entries). The control reads the PUBLISHED
 * `worklistSlice` through the same `createSlicePublisher` +
 * `useSyncExternalStore` mechanism `useSlice` uses (`use-slice.ts:60-66`) —
 * one derivation per snapshot for every reader — and renders groups and rows
 * with the pre-Stage-0 whole-array-props shape (`list.tsx`).
 *
 * TWO DELIBERATE EXCEPTIONS, both documented because they are the point:
 * 1. The control IGNORES the `RowSource` deltas passed to `create()`. Legacy
 *    subscribes to the whole store, not to per-row streams; adapting it to a
 *    stream would rebuild the defect out of the measurement. The source is
 *    accepted for interface conformance only.
 * 2. The derive is counted. `countedSlice` wraps `worklistSlice.derive` with
 *    the identical `sourceEqual`/`isEqual` guards and body, adding only the
 *    `ArmStats` counters. Instrumentation, never a behavior change.
 *
 * `ArmStats` semantics for the control (honest whole-world numbers):
 * - `rowsDerived`: visible rows re-derived per derivation (the whole list —
 *   legacy has no per-row derivation).
 * - `rollupsDerived`: derivations run (one whole-world rollup each).
 * - `indexUpdates`: 0, always. Legacy maintains no incremental per-entity
 *   index; invalidation is per collection. Zero is the finding, not a gap.
 * - `notifications`: runtime publications observed since reset.
 */

import { createElement, lazy, Suspense, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import {
  defineSlice,
  worklistSlice,
  type WorklistSlice,
} from '@podium/client-core/viewmodels'
import type { Arm, ArmHandle } from '../../../shared/src/arm'
import type { SliceLocals, SliceSnapshot } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import { snapshotFromStore } from '../oracle/index'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import { LegacyControlList, type ControlSliceDef } from './list'
// LAZY on purpose (not a bundle nicety): `./native` imports `react-native`,
// whose Flow-typed source the root node/unit lanes cannot parse. A static
// import would put that chain in every file importing this arm and break
// `bun run test:file` and the unit lane for the whole package (the POD-1220
// hazard). The dynamic chunk loads only when `mountNative()` renders — under
// the package lane, where the `react-native-web` alias applies. Web entries
// never call `mountNative`, so the chunk never loads there either.
const LazyNativeList = lazy(() =>
  import('./native').then((module) => ({ default: module.LegacyControlNativeList })),
)

/** The runtime surface the control reads. Satisfied by `ClientRuntime`. */
export interface LegacyControlEngine {
  subscribe(listener: () => void): () => void
  getSnapshot(): Store<PodiumClientApi>
}

function createControlStats(): ArmStats {
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

/**
 * Close over a live engine to make an `Arm`. One factory call per principal:
 * a new principal is a new engine is a new arm (methodology lifecycle rule).
 */
export function legacyControlArmFor(engine: LegacyControlEngine): Arm {
  return {
    create(_source, locals: SliceLocals): ArmHandle {
      const stats = createControlStats()
      const counted: ControlSliceDef = defineSlice({
        name: 'worklist-control',
        sourceEqual: worklistSlice.sourceEqual,
        isEqual: worklistSlice.isEqual,
        derive: (store: Store<PodiumClientApi>): WorklistSlice => {
          const slice = worklistSlice.derive(store)
          stats.rowsDerived += slice.work.length + slice.pinned.length
          stats.rollupsDerived += 1
          return slice
        },
      })
      const off = engine.subscribe(() => {
        stats.notifications += 1
      })
      let webRoot: { unmount(): void } | null = null
      return {
        snapshot(): SliceSnapshot {
          // The oracle projection over the live store — what the current app
          // shows for the engine's present state. Unselected baseline, as the
          // fixture oracle (spec §7): selection placement is the separate
          // post-pass and never re-derives rows.
          const store = engine.getSnapshot()
          return snapshotFromStore(store, {
            selectedIssueId: null,
            coarseNow: locals.coarseNow,
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
          // Propagate the harness log across this root (Arm contract): the
          // harness sets the ambient log around the mount call; capture it
          // now so every later commit records, long after the mount scope.
          const log = currentCommitLog()
          root.render(
            createElement(
              CommitLogContext.Provider,
              { value: log },
              createElement(LegacyControlList, { engine, sliceDef: counted }),
            ),
          )
          return () => {
            root.unmount()
            if (webRoot === root) webRoot = null
          }
        },
        mountNative(): ReactElement {
          return createElement(
            Suspense,
            { fallback: null },
            createElement(LazyNativeList, { engine, sliceDef: counted }),
          )
        },
      }
    },
  }
}
