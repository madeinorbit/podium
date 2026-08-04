/**
 * THE RETENTION SWEEP SEARCHES, IT DOES NOT SCAN (POD-1638).
 *
 * `pruneAppliedMutations` deletes by `applied_at < cutoff`. Without an index on
 * that column SQLite walks the whole table — and a table walk reads the ROWS, so
 * the cost is the `result` payloads (~21MB on the live database), not the row
 * count. Live attribution caught ONE such call burning 1529ms and deleting
 * NOTHING, blocking the server's single event loop for a second and a half.
 *
 * WHAT IS ASSERTED IS THE QUERY PLAN, not a duration and not the mere presence
 * of an index. An index that exists but that the planner declines to use for
 * this predicate would fix nothing, and a timing assertion on a small fixture
 * passes either way — the plan is the thing that decides.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

let db: ReturnType<typeof openDatabase>

const planFor = (sql: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ')

beforeEach(() => {
  db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  const insert = db.prepare(
    'INSERT INTO applied_mutations (mutation_id, proc, result, applied_at) VALUES (?, ?, ?, ?)',
  )
  for (let i = 0; i < 500; i++) insert.run(`m-${i}`, 'issues.update', '{"ok":true}', 1000 + i)
})

describe('applied_mutations retention', () => {
  it('uses an index for the applied_at cutoff instead of scanning the table', () => {
    const plan = planFor('DELETE FROM applied_mutations WHERE applied_at < 1200')

    expect(plan).toContain('idx_applied_mutations_applied_at')
    // The paired denial: naming the index is not enough if the planner still
    // scans. `SEARCH` vs `SCAN` is the whole difference this migration buys.
    expect(plan).toContain('SEARCH')
    expect(plan).not.toContain('SCAN applied_mutations')
  })

  it('still deletes exactly the rows below the cutoff', () => {
    db.prepare('DELETE FROM applied_mutations WHERE applied_at < ?').run(1200)

    const left = db.prepare('SELECT COUNT(*) AS n FROM applied_mutations').get() as { n: number }
    const min = db.prepare('SELECT MIN(applied_at) AS m FROM applied_mutations').get() as {
      m: number
    }
    // 1000..1499 inserted, everything under 1200 removed.
    expect(left.n).toBe(300)
    expect(min.m).toBe(1200)
  })
})
