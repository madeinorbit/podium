import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the round-three hand-rolled pool on the native renderer:
 * `mountNative()` through `mountNativeForCounts`, one RowShell per DRAWN
 * row. Since Hb2 (POD-4583) the native list is windowed (React Native's
 * `SectionList`: the PINNED section, then each group's open lane and closed
 * fold, `initialNumToRender` rows), so the drawn rows are the window's first
 * rows in oracle order — not the whole visible set. A heartbeat redraws no
 * row and a rename redraws the renamed row only among drawn rows. Parity
 * and the counted scenarios are the web lane's
 * (`arms/hand/pool/worklist/visible.test.tsx`,
 * `arms/hand/pool/worklist/groups.test.tsx`,
 * `arms/hand/pool/counts.test.tsx`).
 *
 * Ha2 (POD-4579): `activityAt` reads `issue.sessions`, so the heartbeat
 * moved its session's issue and the a1 list, which drew every issue,
 * redrew that hidden row. Since Ha3 (POD-4580) that closed root and its
 * session are COLD: the heartbeat relinks a registry entry and the list
 * never drew the row, so the heartbeat redraws nothing at all. The load
 * window never closes on its own here, so the mount's queued loads cannot
 * land inside the counted steps.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { harnessHandPoolArm } from '../src/adapters/hand-pool'
import {
  applyTitleRename,
  startScenarioEngine,
  writeHeartbeat,
  writeTitleRename,
} from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { openFenceFeeds, parityLocals } from '../src/fence-scenarios'
import { snapshotFromStore } from '../src/oracle/index'

describe('hand pool on the native renderer', () => {
  it('draws the window\u2019s first rows in oracle order; a heartbeat on a cold session redraws nothing, a rename redraws the renamed row only among drawn rows', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    // No load window closes on its own mid-step.
    const handle = harnessHandPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
    const mounted = await mountNativeForCounts(handle)
    try {
      // The native list is a lazy chunk (`React.lazy` in `pool/arm.ts`): it
      // commits once the import resolves, after the mount's own act.
      const list = await vi.waitFor(
        async () => {
          await act(async () => {})
          const found = document.querySelector('[data-testid="hand-pool-list"]')
          if (found === null) throw new Error('native list not mounted yet')
          return found
        },
        { timeout: 20_000, interval: 50 },
      )
      const drawnIds = [...list.querySelectorAll('[data-testid^="row-"]')].map((row) =>
        (row.getAttribute('data-testid') ?? '').slice('row-'.length),
      )
      // Windowed: a strict prefix of the visible set, in oracle grouped
      // order (pinned, then each group's open lane and closed fold).
      const oracle = snapshotFromStore(referenceState(ctx.engine), parityLocals(ctx)).order
      const oracleIds = [
        ...oracle.pinnedIds,
        ...oracle.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
      ]
      expect(drawnIds.length, 'the window draws rows').toBeGreaterThan(0)
      expect(drawnIds.length, 'the window draws a prefix, not the set').toBeLessThan(
        oracleIds.length,
      )
      expect(drawnIds, 'the window\u2019s first rows in oracle order').toEqual(
        oracleIds.slice(0, drawnIds.length),
      )
      const drawn = new Set(drawnIds)

      mounted.log.reset()
      await act(async () => {
        await writeHeartbeat(ctx)
        feeds.flush()
      })
      const heartbeatIssue = handle.pool.relations.one(
        'session',
        ctx.targets.heartbeatSessionId,
        'issue',
      )
      expect(heartbeatIssue).not.toBeNull()
      expect(handle.pool.residency?.isCold('issue', heartbeatIssue!)).toBe(true)
      expect(handle.pool.residency?.isCold('session', ctx.targets.heartbeatSessionId)).toBe(true)
      expect([...mounted.log.counts.keys()], 'a heartbeat on a cold session drew a row').toEqual([])

      await act(async () => {
        await writeTitleRename(ctx)
        feeds.flush()
      })
      // The renamed row redraws iff the window drew it; nothing else does.
      const renamed = ctx.targets.visibleRootId
      expect([...mounted.log.counts.keys()].sort()).toEqual(drawn.has(renamed) ? [renamed] : [])
      const shown = new Set(handle.pool.order())
      expect([...mounted.log.counts.keys()].filter((id) => !shown.has(id))).toEqual([])

      // The other branch: rename a drawn row itself, which must redraw
      // exactly that row (so the rename direction can fail either way).
      if (!drawn.has(renamed)) {
        const drawnId = drawnIds[0]!
        mounted.log.reset()
        await act(async () => {
          applyTitleRename(ctx, drawnId, 'Renamed drawn row')
          await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
          feeds.flush()
        })
        expect([...mounted.log.counts.keys()]).toEqual([drawnId])
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
