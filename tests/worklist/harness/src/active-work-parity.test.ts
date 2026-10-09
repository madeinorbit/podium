/**
 * POD-5593 — the active-work rule moved to `@podium/model` answers exactly as
 * the pool schema's own rule did before the move, on every fixture row at 1x
 * and 4x.
 *
 * BEFORE THE MOVE both rules existed, and this test compared them row by row
 * (the pool schema's `coldByRule` and `tableColdContext` against the model's
 * evaluator over the model's declarations); it failed when the moved rule was
 * changed (a 23 h read grace failed 4x; dropping "a shell keeps nothing"
 * failed 1x and 4x). The pinned digests below are the old rule's cold sets,
 * recorded by that comparison at the commit before the old rule was deleted.
 * Now the pool path (`tableColdContext` + `coldByRule`, as the pool, its
 * rebuild and the gate's partition apply the rule) must hash to them.
 *
 * Every clock offset crosses a decay window (read grace, unread window, idle
 * finish) or rewinds, so a change to any deadline moves some cold set.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ISSUE_ACTIVE_WORK, SESSION_ACTIVE_WORK } from '@podium/model/browser'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '@podium/client-graph/shared/schema'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { openFenceFeeds, parityLocals } from './fence-scenarios'

const KINDS = ['issue', 'session', 'worktree', 'repo'] as const
type Kind = (typeof KINDS)[number]
type Tables = Readonly<Record<Kind, ReadonlyMap<string, Readonly<Record<string, unknown>>>>>

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Clock offsets from the fixture's own clock: a rewind, now, and past each decay window. */
const OFFSETS = [-30 * DAY, -DAY, 0, HOUR, 25 * HOUR, 8 * DAY, 40 * DAY] as const

/** The old rule's cold sets over {@link OFFSETS}, per scale (recorded before the move). */
const BEFORE_THE_MOVE: Readonly<Record<1 | 4, string>> = {
  1: 'b33d1759d4e97d8bbbf125439503ccc21e428ccc6050878902db43e8a5fb1bd2',
  4: 'f01545134732b12d18db194efd16f74c9f61db995c736b45162666a357a659f9',
}

async function fixtureTables(scale: 1 | 4): Promise<{ now: number; tables: Tables }> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'pooled')
  try {
    const table = (kind: Kind) =>
      new Map(
        feeds.rows.source
          .snapshot(kind)
          .filter((record) => record.value !== undefined)
          .map((record) => [record.id, record.value as unknown as Readonly<Record<string, unknown>>]),
      )
    return {
      now: parityLocals(ctx).coarseNow,
      tables: { issue: table('issue'), session: table('session'), worktree: table('worktree'), repo: table('repo') },
    }
  } finally {
    feeds.dispose()
    ctx.dispose()
  }
}

/** Cold ids per entity by the pool path at `now`. */
function coldSets(tables: Tables, now: number): Record<Kind, string[]> {
  const ctx = tableColdContext(SCHEMA, (entity: EntityName) => tables[entity], now)
  return Object.fromEntries(
    KINDS.map((kind) => [kind, [...tables[kind]].filter(([, row]) => coldByRule(SCHEMA, kind, row, ctx)).map(([id]) => id).sort()]),
  ) as Record<Kind, string[]>
}

describe('the moved active-work rule answers as before the move (POD-5593)', () => {
  it('is the pool schema rule: one definition, no copy', () => {
    expect(SCHEMA.issue.cold).toBe(ISSUE_ACTIVE_WORK)
    expect(SCHEMA.session.cold).toBe(SESSION_ACTIVE_WORK)
  })

  it.each([1, 4] as const)('on every fixture row at %ix', async (scale) => {
    const { now, tables } = await fixtureTables(scale)
    const counts: Record<string, Record<Kind, number>> = {}
    const digest = createHash('sha256')
    for (const offset of OFFSETS) {
      const cold = coldSets(tables, now + offset)
      digest.update(JSON.stringify([offset, cold]))
      counts[`${offset / HOUR}h`] = Object.fromEntries(KINDS.map((kind) => [kind, cold[kind].length])) as Record<Kind, number>
    }
    console.info(`[active-work-parity] ${scale}x ${JSON.stringify({ rows: Object.fromEntries(KINDS.map((k) => [k, tables[k].size])), cold: counts })}`)
    expect(digest.digest('hex')).toBe(BEFORE_THE_MOVE[scale])
    // The fixture exercises the rule: some issues and sessions are history
    // at the fixture's clock, and more once every window has passed.
    expect(counts['0h']!.issue).toBeGreaterThan(0)
    expect(counts['0h']!.session).toBeGreaterThan(0)
    expect(counts[`${(40 * DAY) / HOUR}h`]!.issue).toBeGreaterThan(counts['0h']!.issue)
  }, 600_000)
})
