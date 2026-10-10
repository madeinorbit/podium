import { MobileSearchSections, type MobileWorkSection } from '../../../../apps/mobile/src/lib/work-sections'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { reaction } from 'mobx'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createWorklistPool } from '../../shared/src/clock-fixture-pool'
import type { MobxPool } from '@podium/client-graph/pool'
import { mobileWorkView, type MobileWorkState } from '@podium/client-graph/worklist/mobile'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { MOBILE_ROW_FIELDS } from '@podium/client-graph/worklist/mobile-row'
import { tracked } from './adapters/mobx-pool'
import { openFenceFeeds, FENCE_SCENARIOS } from './fence-scenarios'
import { mobileComparable, poolMobileSnapshot } from './oracle/mobile-snapshot'
import { installMobxWarnTrap } from './mobx-trap'
import { settled, startScenarioEngine } from '../../shared/src/scenarios'
import baseline from './worklist-mobile-before.json'

// Frozen from the actual integrate/4286-pilot answers, including every row,
// band, count and native formatter field. The older
// mobile.test.ts hashes drift at newIssue on that base too (POD-5786).
installMobxWarnTrap()

function settle(pool: MobxPool, state: MobileWorkState = {}): void {
  for (let window = 0; window < 64; window += 1) {
    tracked(() => poolMobileSnapshot(pool, state))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Mobile payload did not settle its batched loads')
}

describe('shared worklist phone parity', () => {
  for (const scale of [1, 4] as const) it(`matches the base phone fixture at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale)
    vi.spyOn(Date, 'now').mockImplementation(() => ctx.engine.readLocal('coarseNow'))
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
    feeds.attachPool(handle.pool)
    const nativeState: MobileWorkState = {}
    const checks: unknown[] = []
    let previous: readonly MobileWorkSection[] | undefined
    let retained = 0
    let identityFailure: unknown
    const nativeSections = new MobileSearchSections()
    const inspectNative = (scenario: string) => {
      const native = nativeSections.update(handle.pool, mobileWorkView(handle.pool).mobileSections().sectionKeys, '')
      const before = previous
      previous = native
      if (before) for (const section of native) {
        const old = before.find(band => band.key === section.key)
        if (!old) continue
        const refs = (rows: MobileWorkSection['data']) => rows.slice()
        if (JSON.stringify(refs(old.data)) === JSON.stringify(refs(section.data))) {
          expect(section.data, `${scenario} ${section.key}: native data identity`).toBe(old.data)
          retained++
        }
        for (const lane of ['snoozedIds', 'closedIds'] as const) if (JSON.stringify(old[lane]) === JSON.stringify(section[lane])) {
          expect(section[lane], `${scenario} ${section.key}: ${lane} identity`).toBe(old[lane])
        }
        if (JSON.stringify(old) === JSON.stringify(section)) expect(section, `${scenario} ${section.key}: section identity`).toBe(old)
      }
    }
    // Evicting a rescue child can move its parent into and back out of a band
    // within one scenario. Check consecutive publications, not historical
    // versions of a lane whose membership really changed in between.
    const stop = reaction(() => {
      const snapshot = poolMobileSnapshot(handle.pool, nativeState)
      try { inspectNative('observed publication') }
      catch (cause) { identityFailure ??= cause }
      return snapshot
    }, () => {}, { fireImmediately: true })
    const check = async (scenario: string) => {
      feeds.flush(); settle(handle.pool)
      if (scenario === 'selectionClick') {
        // At 4x, navigation activity can need a cold subtree. Its completed
        // loads trigger the eager mark-read after the selection write settled.
        await settled(ctx)
        feeds.flush(); settle(handle.pool)
        expect(tracked(() => worklistView(handle.pool).knownRow(ctx.targets.visibleRootId)?.emphasizeUnread)).toBe(false)
      }
      if (identityFailure) throw identityFailure
      tracked(() => inspectNative(scenario))
      for (const searching of [false, true]) {
        const state = { searching, collapsed: Object.fromEntries(['pinned', 'needs-you', ...tracked(() => mobileWorkView(handle.pool).mobileSections().orderingSectionKeys)]
          .map(key => [`podium:sidebar:work-group-fold:${key}`, true])) }
        const result = tracked(() => poolMobileSnapshot(handle.pool, state))
        expect(result.pending, `${scenario}, searching=${searching}`).toBe(0)
        expect(createHash('sha256').update(JSON.stringify(tracked(() => poolMobileSnapshot(handle.pool, state)))).digest('hex')).toBe(baseline.answers[`${scale}-${scenario}-${searching}` as keyof typeof baseline.answers])
        checks.push({ scenario, searching, sections: result.sections.length, pending: result.pending })
      }
      const first = tracked(() => mobileWorkView(handle.pool).mobileSections().orderingSectionKeys.flatMap(key => mobileWorkView(handle.pool).mobileSections().section(key).allIds)[0]!)
      const value = tracked(() => mobileWorkView(handle.pool).mobileRow({ id: first, kind: handle.pool.tables.worktree.has(first) ? 'worktree' : 'issue' }))
      expect(value).not.toBe(LOADING)
      expect(Object.keys(tracked(() => mobileComparable(value as Exclude<typeof value, typeof LOADING | undefined>))).sort()).toEqual([...MOBILE_ROW_FIELDS].sort())
    }
    try {
      await check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); await check(scenario.scenario) }
      expect(retained).toBeGreaterThan(0)
      expect(checks).toHaveLength(baseline.outputsPerScale)
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.dispose() }
  }, 600_000)

})
