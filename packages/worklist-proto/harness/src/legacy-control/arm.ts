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
 * 3. The derive reads the store through the reads fence when the harness
 *    passes one (POD-4557, `fenced-store.ts`): every store array and replica
 *    row collection it walks is counted, so the control reports what legacy
 *    reads per change — the whole corpus on an unrelated heartbeat.
 *
 * `ArmStats` semantics for the control (honest whole-world numbers):
 * - `rowsDerived`: visible rows re-derived per derivation (the whole list —
 *   legacy has no per-row derivation).
 * - `rollupsDerived`: derivations run (one whole-world rollup each).
 * - `indexUpdates`: 0, always. Legacy maintains no incremental per-entity
 *   index; invalidation is per collection. Zero is the finding, not a gap.
 * - `notifications`: runtime publications observed since reset.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { defineSlice, type WorklistSlice, worklistSlice } from '@podium/client-core/viewmodels'
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { CheckableArm, CheckableArmHandle, LocalsSource } from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { CommitLogContext, currentCommitLog } from '../../../shared/src/row-shell'
import type { SliceSnapshot } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import { rebuiltSnapshotFromStore, snapshotFromStore } from '../oracle/index'
import { fencedLegacyStore } from './fenced-store'
import { type ControlSliceDef, LegacyControlList } from './list'

// DYNAMIC on purpose (not a bundle nicety): `./native` imports `react-native`,
// whose Flow-typed source the root node/unit lanes cannot parse. A static
// import would put that chain in every file importing this arm and break
// `bun run test:file` and the unit lane for the whole package (the POD-1220
// hazard). The chunk loads only via `preloadControlNative()` — called by the
// native lane before mounting. Web entries never preload, so the chunk never
// loads there either. (An earlier `React.lazy` revision never resolved under
// `act` in the package lane; the explicit preload below is deterministic.)
type NativeModule = typeof import('./native')
let nativeModule: NativeModule | null = null

export function preloadControlNative(): Promise<void> {
  if (nativeModule !== null) return Promise.resolve()
  return import('./native').then((module) => {
    nativeModule = module
  })
}

function NativeHost({
  engine,
  sliceDef,
}: {
  engine: LegacyControlEngine
  sliceDef: ControlSliceDef
}): ReactElement {
  if (nativeModule === null) {
    throw new Error('[control] native list not preloaded — call preloadControlNative() first')
  }
  return createElement(nativeModule.LegacyControlNativeList, { engine, sliceDef })
}

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
export function legacyControlArmFor(engine: LegacyControlEngine): CheckableArm {
  return {
    create(
      _source,
      locals: LocalsSource,
      reads: ReadFence = DISABLED_READ_FENCE,
    ): CheckableArmHandle {
      const stats = createControlStats()
      const counted: ControlSliceDef = defineSlice({
        name: 'worklist-control',
        sourceEqual: worklistSlice.sourceEqual,
        isEqual: worklistSlice.isEqual,
        derive: (store: Store<PodiumClientApi>): WorklistSlice => {
          const slice = worklistSlice.derive(fencedLegacyStore(reads, store))
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
            coarseNow: locals.get().coarseNow,
          })
        },
        // POD-4556: the same derivation and projection with every legacy memo
        // bypassed (the per-replica view-model cache starts empty). What it
        // checks is the legacy cache plumbing, not the rules.
        rebuildFromScratch(): SliceSnapshot {
          return rebuiltSnapshotFromStore(engine.getSnapshot(), {
            selectedIssueId: null,
            coarseNow: locals.get().coarseNow,
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
          return createElement(NativeHost, { engine, sliceDef: counted })
        },
      }
    },
  }
}
