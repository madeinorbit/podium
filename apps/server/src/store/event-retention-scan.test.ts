/**
 * RETENTION READS ITS VICTIMS, NOT THE LOG (POD-7435).
 *
 * The event-log prune deletes what is over the row cap (`id <= capThroughId`) or older
 * than the age cutoff (`ts < cutoff`). Its candidate read used to test the `OR` of the
 * two along the workspace's ids: no index serves it, so every unit walked the whole log
 * to find the few dozen rows a steady-state pass deletes (about 50 MB read and 1 to 6 s
 * of frozen server on the operator's 50,000-row log, POD-7414 section 2). The janitor's
 * head and count reads tested the same `OR` on every tick.
 *
 * Ids do not follow ts: a historical transcript replay appends old timestamps under new
 * ids. So each limit is its own bounded range, the cap along `(workspace_id, id)` and the
 * age along `idx_podium_events_ts`. Asserted here on both engines:
 *   - which rows a unit takes (replayed history, both arms at once, the projector fence,
 *     the batch bound), and that the janitor's head and count agree with it;
 *   - the PLAN on a full-size log with few and with no eligible rows: every read of the
 *     log is a range bounded by the cap or the cutoff, never the workspace alone.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { type EventStoreSlice, openEventStoreSlice } from '../test-support/event-store-slice'
import { OPERATOR_PLANNER_STATISTICS } from '../test-support/operator-planner-statistics'
import { probeStatements } from './executor/statement-probe'
import { RUNTIME_EVENT_LOG_KIND } from './runtime-event-kind'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = Date.UTC(2026, 10, 23, 12)
const iso = (ms: number) => new Date(ms).toISOString()
const CUTOFF = iso(NOW_MS - 14 * DAY_MS)
const YOUNG = iso(NOW_MS - DAY_MS)
const OLD = iso(NOW_MS - 30 * DAY_MS)
const PROJECTOR = 'runtime.board.v1'
const FULL_LOG = 50_000

let open: EventStoreSlice | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

async function slice(): Promise<EventStoreSlice> {
  open = await openEventStoreSlice()
  return open
}

async function append(s: EventStoreSlice, ts: string, kind = 'issue.updated'): Promise<number> {
  return await s.events.appendEvent({ ts, kind, subject: 's1' })
}

async function remaining(s: EventStoreSlice): Promise<number[]> {
  return (await s.events.listEventsSince(0, { limit: 1_000 })).map((e) => e.id)
}

describe('event retention takes its victims through two bounded arms (POD-7435)', () => {
  it('prunes a replayed history by its age although its ids are above the cap', async () => {
    const s = await slice()
    const young = [await append(s, YOUNG), await append(s, YOUNG)]
    // A historical replay: old timestamps under the newest ids.
    const replayed = [await append(s, OLD), await append(s, OLD), await append(s, OLD)]
    const plan = { cutoff: CUTOFF, capThroughId: 0 }

    expect(await s.events.pruneEventBatch(plan, 500)).toBe(3)
    expect(await remaining(s)).toEqual(young)
    expect(replayed.every((id) => id > young[1]!)).toBe(true)
  })

  it('takes the lowest ids of both arms together, at most a batch per unit', async () => {
    const s = await slice()
    const ids: number[] = []
    for (let i = 0; i < 4; i++) ids.push(await append(s, YOUNG))
    for (let i = 0; i < 3; i++) ids.push(await append(s, OLD))
    // Cap through the second id; the three replayed rows are over age.
    const plan = { cutoff: CUTOFF, capThroughId: ids[1]! }

    expect(await s.events.pruneEventBatch(plan, 3)).toBe(3)
    expect(await remaining(s)).toEqual([ids[2], ids[3], ids[5], ids[6]])
    expect(await s.events.pruneEventBatch(plan, 3)).toBe(2)
    expect(await remaining(s)).toEqual([ids[2], ids[3]])
    expect(await s.events.pruneEventBatch(plan, 3)).toBe(0)
  })

  it('keeps unprojected runtime rows in both arms, and takes the projected ones', async () => {
    const s = await slice()
    const projectedOld = await append(s, OLD, RUNTIME_EVENT_LOG_KIND)
    const overCap = await append(s, YOUNG, RUNTIME_EVENT_LOG_KIND)
    await s.events.saveRuntimeEventProjectionCursor(PROJECTOR, overCap - 1, YOUNG)
    const unprojectedOld = await append(s, OLD, RUNTIME_EVENT_LOG_KIND)
    const plainOld = await append(s, OLD)
    const plan = { cutoff: CUTOFF, capThroughId: overCap }

    expect(await s.events.pruneEventBatch(plan, 500)).toBe(2)
    expect(await remaining(s)).toEqual([overCap, unprojectedOld])
    expect(projectedOld).toBeLessThan(plainOld)
  })
})

/**
 * The log at full size: `rows` events, the first `overCap` of them over the cap and the
 * newest `replayed` of them with an aged ts (a replay under new ids). Written with one
 * statement per engine, so 50,000 rows cost a fraction of a second.
 */
async function seedFullLog(
  s: EventStoreSlice,
  input: { rows: number; replayed: number },
): Promise<void> {
  const ws = SELF_HOSTED_WORKSPACE_ID
  const { rows, replayed } = input
  const kind = RUNTIME_EVENT_LOG_KIND
  // Five in six rows are runtime events, as on the operator's log.
  if (s.engine === 'pg') {
    await s.run(sql`INSERT INTO podium_events (ts, kind, subject, payload, workspace_id)
      SELECT CASE WHEN g > ${rows - replayed} THEN ${OLD}
          ELSE to_char(timestamp '2026-11-20 00:00:00' + g * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"') END,
        CASE WHEN g % 6 = 0 THEN 'issue.updated' ELSE ${kind} END,
        's' || (g % 50), '{"p":1}', ${ws}
      FROM generate_series(1, ${rows}) AS g`)
    await s.run(sql`ANALYZE podium_events`)
  } else {
    await s.run(sql`WITH RECURSIVE n(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM n WHERE g < ${rows})
      INSERT INTO podium_events (ts, kind, subject, payload, workspace_id)
      SELECT CASE WHEN g > ${rows - replayed} THEN ${OLD}
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 1795132800 + g, 'unixepoch') END,
        CASE WHEN g % 6 = 0 THEN 'issue.updated' ELSE ${kind} END,
        's' || (g % 50), '{"p":1}', ${ws}
      FROM n`)
    await withOperatorEventStatistics(s)
  }
  const head = await s.all<{ m: number }>(sql`SELECT MAX(id) AS m FROM podium_events`)
  await s.events.saveRuntimeEventProjectionCursor(PROJECTOR, Number(head[0]!.m), YOUNG)
}

/**
 * The operator's planner statistics for the event log (as `event-log.test.ts` applies
 * them): what SQLite plans a real log by. The new age index has none captured yet, so
 * SQLite plans it by its defaults.
 */
async function withOperatorEventStatistics(s: EventStoreSlice): Promise<void> {
  await s.run(sql`ANALYZE`)
  await s.run(sql`DELETE FROM sqlite_stat1`)
  let rows = '1'
  for (const [table, index, stat] of OPERATOR_PLANNER_STATISTICS) {
    if (table !== 'podium_events' || index === null) continue
    const [total = '1', ...perPrefix] = stat.split(' ')
    rows = total
    const line = [total, total, ...perPrefix].join(' ')
    await s.run(sql`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (${table}, ${index}, ${line})`)
  }
  await s.run(
    sql`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('podium_events', 'sqlite_autoindex_podium_events_1', ${`${rows} ${rows} 1`})`,
  )
  await s.run(sql`ANALYZE sqlite_schema`)
}

/** The statements `fn` runs on the slice, as the driver saw them. */
async function statementsOf(s: EventStoreSlice, fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const detach = probeStatements(s.probeTarget as never, (o) => seen.push(o.sql))
  try {
    await fn()
  } finally {
    detach()
  }
  return seen
}

/**
 * The plan's reads of `podium_events`, one line each. SQLite: the `EXPLAIN QUERY PLAN`
 * details. Postgres: each scan node of the custom plan for `values`, by its name, index
 * and index condition.
 */
async function eventReads(
  s: EventStoreSlice,
  statement: string,
  values: Record<string, string>,
): Promise<string[]> {
  if (s.engine !== 'pg') {
    // The slice's own SQLite handle, outside any transaction: the plan only.
    const db = s.probeTarget.db as SqlDatabase
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as { detail: string }[]
    return rows.map((r) => r.detail).filter((d) => / podium_events\b/.test(d))
  }
  const literal = withLiterals(statement, values)
  const [row] = await s.all<{ 'QUERY PLAN': unknown }>(sql.raw(`EXPLAIN (FORMAT JSON) ${literal}`))
  const raw = row!['QUERY PLAN']
  const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PgNode }[]
  const out: string[] = []
  const walk = (node: PgNode): void => {
    // The scans of the log (the Delete node names the table too, and reads nothing).
    if (node['Relation Name'] === 'podium_events' && / Scan$/.test(node['Node Type'])) {
      const cond = node['Index Cond'] ?? node['Recheck Cond'] ?? ''
      out.push(`${node['Node Type']} ${node['Index Name'] ?? ''} ${cond}`.replace(/\s+/g, ' '))
    }
    for (const child of node.Plans ?? []) walk(child)
  }
  walk(plan[0]!.Plan)
  return out
}

interface PgNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  Plans?: PgNode[]
}

/**
 * The statement with each `$n` replaced by the literal its comparison names: the
 * workspace, the cap, the cutoff, the fenced kind, the projector, or a limit (the last
 * limit is the batch, the others the arms' budget). Throws on a placeholder it cannot
 * name, so a reshaped statement fails here rather than planning the wrong values.
 */
function withLiterals(statement: string, values: Record<string, string>): string {
  const limits = [...statement.matchAll(/limit \$\d+/gi)].length
  let limitsSeen = 0
  return statement.replace(/\$(\d+)/g, (_, _n: string, offset: number) => {
    const before = statement.slice(Math.max(0, offset - 40), offset).toLowerCase()
    const named = (key: string) => {
      const value = values[key]
      if (value === undefined) throw new Error(`no value for ${key}`)
      return value
    }
    if (/limit $/.test(before)) {
      limitsSeen++
      return named(limitsSeen === limits ? 'batchSize' : 'budget')
    }
    if (/"workspace_id" = $/.test(before)) return `'${SELF_HOSTED_WORKSPACE_ID}'`
    if (/"id" <= $/.test(before) || /"id" > $/.test(before)) return named('capThroughId')
    if (/"ts" < $/.test(before)) return `'${named('cutoff')}'`
    if (/"kind" = $/.test(before)) return `'${RUNTIME_EVENT_LOG_KIND}'`
    if (/"projector" = $/.test(before)) return `'${PROJECTOR}'`
    throw new Error(`cannot name the placeholder after: ${before}`)
  })
}

/** Each read is a range bounded by the cap or the cutoff, never the workspace alone. */
function expectBoundedReads(reads: string[], engine: string, statement: string): void {
  const all = `${statement.slice(0, 60)}… reads ${reads.join(' | ')}`
  expect(reads.length, all).toBeGreaterThan(0)
  for (const read of reads) {
    if (engine === 'pg') {
      expect(read, all).toMatch(/^(Index|Index Only|Bitmap Heap) Scan /)
      expect(read, all).toMatch(/\(id <=|\(id = |ts < |\(ts <|id <= /)
    } else {
      expect(read, all).toMatch(/^SEARCH podium_events /)
      expect(read, all).not.toMatch(/\(workspace_id=\?\)$/)
    }
  }
}

describe('the retention reads plan as bounded ranges on a full-size log (POD-7435)', () => {
  for (const shape of [
    { name: 'few eligible rows', overCap: 83, replayed: 40 },
    { name: 'no eligible row', overCap: 0, replayed: 0 },
  ] as const) {
    it(`the delete unit and the janitor's head and count, with ${shape.name}`, async () => {
      const s = await slice()
      await seedFullLog(s, { rows: FULL_LOG + shape.overCap, replayed: shape.replayed })
      const plan = await s.events.planEventPrune({ maxAgeDays: 14, maxRows: FULL_LOG })
      const capThroughId = plan.capThroughId
      expect(capThroughId > 0).toBe(shape.overCap > 0)

      const janitor = s.janitorReads
      const [headSql, countSql] = await statementsOf(s, async () => {
        const head = await janitor.eventPruneHead(plan)
        const count = await janitor.eventPruneCount(plan)
        expect(count).toBe(shape.overCap + shape.replayed)
        expect(head === null).toBe(count === 0)
      })
      const [deleteSql] = (
        await statementsOf(s, async () => {
          expect(await s.events.pruneEventBatch(plan, 500)).toBe(shape.overCap + shape.replayed)
        })
      ).filter((text) => /delete from "podium_events"/i.test(text))

      const values = {
        capThroughId: String(capThroughId),
        cutoff: plan.cutoff,
        budget: '500',
        batchSize: '500',
      }
      for (const statement of [deleteSql!, headSql!, countSql!]) {
        expectBoundedReads(await eventReads(s, statement, values), s.engine, statement)
      }
      // The delete's two arms, each through its own index.
      const deleteReads = (await eventReads(s, deleteSql!, values)).join('\n')
      expect(deleteReads).toContain('idx_podium_events_ts')
    })
  }
})
