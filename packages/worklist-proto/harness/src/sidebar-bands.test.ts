/**
 * POD-5423 (review finding 10): the sidebar's sections are one view per pool
 * and layout VALUE, built from one cached band per key. Two callers holding
 * equal layouts in different objects share the view; a row moving lanes
 * inside one band (a snooze) re-runs that band and the list of band references, never
 * another band and never the band list itself. Counted with the work meter
 * at 4 and 16 bands (one repo per band).
 */
import { MobxPool } from '@podium/client-graph/pool'
import type { SidebarSections } from '@podium/client-graph/worklist/sidebar'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { startCensus } from './mobx-census'
import { installMobxWarnTrap } from './mobx-trap'
import { measureWork } from './work-meter'

installMobxWarnTrap()

const NOW = Date.parse('2026-10-03T12:00:00Z')
type Row = Record<string, unknown>

function corpus(bands: number) {
  const issues: Row[] = []
  for (let band = 0; band < bands; band += 1) {
    for (let n = 0; n < 3; n += 1) {
      issues.push({
        id: `band-${band}-issue-${n}`,
        seq: band * 10 + n + 1,
        title: `b${band}i${n}`,
        repoId: `repo-${band}`,
        repoPath: `/repo-${band}`,
        stage: 'in_progress',
        audience: 'human',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: `2026-10-0${1 + n}T00:00:00Z`,
        deps: [],
        // Each band already holds one snoozed row: a second snooze moves a lane
        // without changing the band's facts (its name and fold).
        ...(n === 0 ? { deferUntil: '2026-10-20T00:00:00Z' } : {}),
      })
    }
  }
  return issues
}

async function run(bands: number) {
  const issues = corpus(bands)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({
    type: 'replace',
    rows: issues.map((value) => ({
      kind: 'issue' as const,
      id: String(value['id']),
      value: value as never,
    })),
  })
  const census = startCensus()
  // Two callers, equal layouts, different objects (one per hook instance).
  const seen: SidebarSections[] = []
  const stops = [{ collapsed: {} }, { collapsed: {} }].map((layout, at) =>
    autorun(() => {
      seen[at] = pool.sidebar.sections(layout)
    }),
  )
  const views = census.snapshot().entries.filter((entry) => entry.kind === 'computed').length
  census.stop()
  try {
    const moved = issues[1]!
    const { work } = await measureWork(
      async () =>
        pool.apply({
          type: 'update',
          rows: [
            {
              kind: 'issue',
              id: String(moved['id']),
              value: { ...moved, deferUntil: '2026-10-20T00:00:00Z' } as never,
            },
          ],
        }),
      { pool },
    )
    const ran = (name: string) => work.derivationsBy[name] ?? 0
    return {
      shared: seen[0] === seen[1],
      sectionsViews: ran('pool.sidebar.sections'),
      bandViews: ran('pool.sidebar.band'),
      bandSpecs: ran('pool.sidebar.bandSpecs'),
      groups: ran('pool.sidebar.group'),
      bands: seen[0]!.bands.length,
      snoozed: seen[0]!.bands.find((band) => band.key === 'repo-0')?.snoozedIds,
      views,
    }
  } finally {
    for (const stop of stops) stop()
    pool.dispose()
  }
}

describe('sidebar bands', () => {
  it('share one view per layout value and re-run only the moved row’s band', async () => {
    const small = await run(4)
    const large = await run(16)
    console.info('[sidebar bands] 4', JSON.stringify(small), '16', JSON.stringify(large))
    expect(small.bands).toBe(4)
    expect(large.bands).toBe(16)
    // One view for both callers (before POD-5423: one per layout object).
    expect(small.shared).toBe(true)
    // A snooze moves the row into its band's snoozed lane: that band and the
    // reference list re-run, nothing else.
    expect(small.snoozed).toEqual(expect.arrayContaining(['band-0-issue-0', 'band-0-issue-1']))
    for (const result of [small, large]) {
      expect(result.sectionsViews).toBe(1)
      expect(result.bandViews).toBe(1)
      expect(result.bandSpecs).toBe(0)
    }
    expect(large.groups).toBe(small.groups)
  }, 120_000)
})
