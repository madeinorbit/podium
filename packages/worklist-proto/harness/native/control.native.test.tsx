// @vitest-environment happy-dom
/**
 * POD-4445 — the native lane: the legacy control mounted in the React Native
 * unit renderer, running the count harness over scenarios #1–#3.
 *
 * `react-native` resolves to `react-native-web` under the worklist-proto
 * package config (the same mapping `expo export -p web` builds against and
 * `apps/mobile/vitest.config.ts` uses) — real RN primitives (`View`/`Text`/
 * `ScrollView`), same `RowShell` profilers, same `runCountScenario` and
 * `assertIsolation` as the web lane. This file is excluded from the root
 * node/unit lanes (`nodeTestExclude`, the POD-1220 hazard) and runs under the
 * package config.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import {
  assertIsolation,
  mountNativeForCounts,
  runCountScenario,
} from '../src/count-harness'
import { legacyControlArmFor, preloadControlNative } from '../src/legacy-control/arm'
import { snapshotFromStore } from '../src/oracle/index'
import {
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
} from '../../shared/src/scenarios'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

describe('legacy control on the native renderer', () => {
  it('runs count scenarios #1-#3 with parity; #1 fails isolation', async () => {
    await preloadControlNative()
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.access.coarseNow,
    }
    const handle = legacyControlArmFor(ctx.engine).create(source.source, fixedLocals(locals).source)
    const mounted = await mountNativeForCounts(handle)
    try {
      // The render guard: snapshot parity below cannot tell an empty native
      // list from a full one, so assert the RN tree actually mounted first.
      const list = document.querySelector('[data-testid="control-list"]')
      console.info(`[control-native] mounted rows: ${list?.querySelectorAll('[data-testid^="row-"]').length ?? 'NO-LIST'}`)
      expect(list).not.toBeNull()
      const heartbeat = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      expect(heartbeat.visibleRows).toBeGreaterThan(0)
      expect(heartbeat.parityDiff).toBeNull()
      expect(heartbeat.parity).toBe(true)
      console.info(
        `[control-native] heartbeat committed ${heartbeat.rowsCommitted}/${heartbeat.visibleRows}; ` +
          `stats=${JSON.stringify(heartbeat.stats)}`,
      )
      // Same armed shape as the web lane: the control fails #1.
      expect(heartbeat.rowsCommitted).toBeGreaterThan(0)
      expect(() => assertIsolation(heartbeat, { rowsCommitted: 0 })).toThrow(
        /committed \d+ rows, budget 0/,
      )

      const phase = await runCountScenario(mounted, {
        scenario: 'visibleSessionPhaseChange',
        methodology: '#2',
        apply: async () => {
          await writePhaseChange(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      expect(phase.parity).toBe(true)
      console.info(
        `[control-native] phase change committed ${phase.rowsCommitted}/${phase.visibleRows}; ` +
          `stats=${JSON.stringify(phase.stats)}`,
      )

      const click = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: async () => {
          await writeSelectionClick(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      expect(click.parity).toBe(true)
      console.info(
        `[control-native] selection committed ${click.rowsCommitted}/${click.visibleRows}; ` +
          `stats=${JSON.stringify(click.stats)}`,
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
