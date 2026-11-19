/**
 * POD-7148 — the sidebar's filing candidates leave what it shows unchanged.
 *
 * Before, every issue in memory that was not archived or deleted was a
 * filing candidate; now only the declared candidates are
 * (`SIDEBAR_CANDIDATES`, client-graph `worklist/visible.ts`). Over the real
 * engine's pooled feed of the base corpus cell, in the full bootstrap and in
 * the policy set a first download leaves, the sidebar draws exactly the same
 * rows, open, snoozed, closed and nested, with the old candidacy (every issue
 * tracked, `VisibleCollection.track`) as with the new.
 *
 * The check is armed: the corpus holds rows the sidebar shows that the
 * sidebar collection does not (finished rows from the recent collection,
 * closed issues a session keeps), so tracking only the sidebar collection's
 * members draws a different list.
 */

import type { MobxPool } from '@podium/client-graph/pool'
import { sidebarNested, sidebarView } from '@podium/client-graph/worklist/sidebar'
import { matchesWhere, SIDEBAR_WHERE } from '@podium/model'
import { runInAction } from 'mobx'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  collectGarbage,
  fullPool,
  openStartupFeed,
  policySetPool,
  type StartupFeed,
} from './startup-states'

/** Every row the sidebar draws, by section, nested rows under their parent. */
function drawn(pool: MobxPool): unknown {
  return sidebarView(pool)
    .sections({})
    .bands.map((band) => {
      const nested = (ids: readonly string[]) =>
        ids.map((id) => {
          const row = pool.worklistRow(id)
          return [id, row ? [...sidebarNested(row, pool)] : []]
        })
      return {
        key: band.key,
        open: nested(band.rowIds),
        snoozed: nested(band.snoozedIds),
        closed: nested(band.closedIds),
      }
    })
}

const issueIds = (pool: MobxPool) => [...pool.tables.issue.keys()]

/** The old candidacy: every issue in memory that is not archived or deleted. */
function trackAll(pool: MobxPool): void {
  runInAction(() => {
    for (const [id, row] of pool.tables.issue) {
      const value = row as unknown as Readonly<Record<string, unknown>>
      if (value['archived'] !== true && value['deletedAt'] == null) pool.worklist.track(id)
    }
  })
}

/** Only the sidebar collection's members (the brief's first reading): what the check must catch. */
function onlySidebarMembers(pool: MobxPool): void {
  runInAction(() => {
    for (const [id, row] of pool.tables.issue)
      if (
        !matchesWhere(SIDEBAR_WHERE, row as unknown as Readonly<Record<string, unknown>>, {
          now: 0,
          args: {},
        })
      )
        pool.worklist.untrack(id)
  })
}

let feed: StartupFeed

beforeAll(async () => {
  feed = await openStartupFeed({ history: 1, active: 1 })
}, 600_000)

describe.each([
  ['the full bootstrap', (f: StartupFeed) => fullPool(f)],
  ['the policy set', (f: StartupFeed) => policySetPool(f)],
])('%s', (_name, build) => {
  it('draws the same sidebar with the declared candidates as with every issue tracked', () => {
    const pool = build(feed)
    try {
      const candidates = issueIds(pool).filter((id) => pool.worklist.tracks(id)).length
      const held = issueIds(pool).length
      // The change does something: some held issues file nothing.
      expect(candidates).toBeLessThan(held)
      const now = drawn(pool)
      trackAll(pool)
      const before = issueIds(pool).filter((id) => pool.worklist.tracks(id)).length
      console.info(
        `[POD-7148] ${_name}: ${held} held, ${before} tracked before, ${candidates} after`,
      )
      expect(before).toBeGreaterThan(candidates)
      expect(drawn(pool)).toEqual(now)
      // Armed: the sidebar collection alone draws a different list.
      onlySidebarMembers(pool)
      expect(drawn(pool)).not.toEqual(now)
    } finally {
      pool.dispose()
      collectGarbage()
    }
  })
})
