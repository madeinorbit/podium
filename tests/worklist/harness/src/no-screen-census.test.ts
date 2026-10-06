import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
/**
 * POD-5423 (review finding 8, the structural guard): work follows the screen,
 * not memory. The app's pool (`createRuntimeWorklistPool`) with no list on
 * screen keeps no per-issue filing reaction and builds no per-issue or
 * per-session computed; a list reader starts the filing, and when it goes the
 * filing stops and the lanes empty. A screen's hold (`worklist.retain`) files
 * synchronously, to the same lanes a reader gets.
 *
 * Counted from OUTSIDE the pool with the MobX census (`mobx-census.ts`): every
 * reaction and computed built while each phase runs, by debug name and owner.
 */
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { type FixtureScale, startScenarioEngine } from '../../shared/src/scenarios'
import { type CensusSnapshot, startCensus } from './mobx-census'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap()

interface Tally {
  /** Reactions still live, by debug name with digits folded. */
  live: Record<string, number>
  /** Filing reactions still live. */
  filing: number
  /** Computeds built, by owner class (per-row owners are the point). */
  computedsBy: Record<string, number>
}

function tally(snapshot: CensusSnapshot): Tally {
  const live: Record<string, number> = {}
  const computedsBy: Record<string, number> = {}
  let filing = 0
  for (const entry of snapshot.entries) {
    if (entry.kind === 'reaction' && entry.sub === 'live') {
      const name = (entry.name ?? '?').replace(/\d+/g, '#')
      if (name.startsWith('pool.file.')) filing += 1
      else live[name] = (live[name] ?? 0) + 1
    }
    if (entry.kind === 'computed') {
      const owner = entry.owner?.cls ?? 'standalone'
      computedsBy[owner] = (computedsBy[owner] ?? 0) + 1
    }
  }
  return { live, filing, computedsBy }
}

const PER_ROW = ['IssueModel', 'SessionModel', 'WorktreeModel', 'GroupNode'] as const
const perRow = (t: Tally) => PER_ROW.reduce((sum, owner) => sum + (t.computedsBy[owner] ?? 0), 0)

async function phases(scale: FixtureScale) {
  let census = startCensus()
  const ctx = await startScenarioEngine(scale, { ownRows: true })
  const handle = createRuntimeWorklistPool(ctx.engine)
  const pool = handle.pool
  try {
    while (pool.hydrate() > 0) {}
    const idle = tally(census.snapshot())
    census.stop()
    const candidates = runInAction(() => pool.tables.issue.size)

    census = startCensus()
    let sections: unknown
    const stop = autorun(() => {
      sections = sidebarView(pool).sections()
    })
    while (pool.hydrate() > 0) {}
    const mounted = tally(census.snapshot())
    const read = runInAction(() => worklistGroups(pool).layout)
    stop()
    const unmounted = tally(census.snapshot())
    census.stop()
    const emptied = runInAction(() => worklistGroups(pool).layout)

    const release = pool.worklist.retain()
    const held = runInAction(() => worklistGroups(pool).layout)
    release()
    const released = runInAction(() => worklistGroups(pool).layout)
    return { idle, mounted, unmounted, candidates, sections, read, emptied, held, released }
  } finally {
    census.stop()
    handle.dispose()
    ctx.dispose()
  }
}

describe('no screen mounted', () => {
  for (const scale of [1, 4] as const) {
    it(`keeps no filing reaction or per-row computed at ${scale}x, and files only while a list is read or held`, async () => {
      const run = await phases(scale)
      console.info(
        `[no-screen ${scale}x] idle`,
        JSON.stringify(run.idle),
        'mounted filing',
        run.mounted.filing,
        'per-row',
        perRow(run.mounted),
      )
      // Idle: not one per-issue reaction or per-row computed (before POD-5423:
      // one filing reaction per issue in memory, and its visibility graph).
      expect(run.idle.filing).toBe(0)
      expect(perRow(run.idle)).toBe(0)
      // Near zero, and not growing with the corpus.
      expect(Object.values(run.idle.live).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8)
      // A mounted list reader starts every candidate's filing.
      expect(run.mounted.filing).toBe(run.candidates)
      expect(perRow(run.mounted)).toBeGreaterThan(0)
      expect((run.sections as { bands: unknown[] }).bands.length).toBeGreaterThan(0)
      expect(run.read.groups.length).toBeGreaterThan(0)
      // Unmounted: every filing reaction stops and the lanes empty.
      expect(run.unmounted.filing).toBe(0)
      expect(run.emptied).toEqual({ pinnedIds: [], groups: [] })
      // A hold files synchronously, to the lanes the reader got.
      expect(run.held).toEqual(run.read)
      expect(run.released).toEqual({ pinnedIds: [], groups: [] })
    }, 600_000)
  }
})
