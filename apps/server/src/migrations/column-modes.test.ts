/**
 * The guard on POD-3254's column modes, epic POD-3221 step [0.12].
 *
 * The epic set `mode: 'boolean'` on every 0/1 integer column ONCE, here, so that
 * no repository conversion has to touch `schema.ts`. `mode` is type-level and the
 * drizzle snapshot does not record it, so the edit emitted no migration — the
 * full DDL `drizzle-kit generate` produces is byte-identical across the change.
 *
 * THE PART THAT IS NOT FREE, and the reason this file exists: a DEFAULT is
 * recorded. Writing the natural `.default(false)` beside the new mode makes
 * drizzle-kit emit `DEFAULT false` where every migration in the chain wrote
 * `DEFAULT 0`, which is a schema diff and, on SQLite, a table rebuild for no
 * behaviour change at all. So the defaults stay SQL literals. That is invisible
 * in review — `.default(false)` reads as the tidier line — and nothing else in
 * the tree would fail, because `drizzle-kit generate` refuses to run at all while
 * the chain carries the pre-existing non-commutative conflict (POD-3314's
 * sibling, filed outside this epic). Hence a unit assertion on the mechanism: the
 * default must not be a JS boolean.
 *
 * The column SET is written down rather than derived from the source, because
 * deriving it is the very judgement the issue made: `sessions.ref_draft` is an
 * integer column that looks like a flag and is a number, and a heuristic that
 * reads names would have converted it. The set was derived once, from the store's
 * own read and write idioms (`r.x === 1`, `Boolean(r.x)`, `x ? 1 : 0`), and this
 * is that answer pinned so a later edit has to argue with it.
 */

import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'

/** The 0/1 integer columns, `<table>.<column>`. */
const BOOLEAN_COLUMNS = [
  'automations.enabled',
  'issues.archived',
  'issues.draft',
  'issues.needs_human',
  'machines.podium_managed',
  'machines.supervised',
  'messages.expects_response',
  'quota_windows.partial',
  'sessions.archived',
  'sessions.headless',
  'subscriptions.deliver_notify',
  'subscriptions.deliver_nudge',
  'subscriptions.enabled',
  'superagent_pending_turns.first_turn',
  'superagent_threads.archived',
].sort()

interface DeclaredColumn {
  readonly key: string
  readonly columnType: string
  readonly hasDefault: boolean
  readonly defaultValue: unknown
}

function declaredColumns(): DeclaredColumn[] {
  const found: DeclaredColumn[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    for (const column of config.columns) {
      const raw = column as unknown as {
        columnType: string
        hasDefault: boolean
        default: unknown
      }
      found.push({
        key: `${config.name}.${column.name}`,
        columnType: raw.columnType,
        hasDefault: raw.hasDefault,
        defaultValue: raw.default,
      })
    }
  }
  return found
}

describe('the schema column modes', () => {
  it('carries boolean mode on exactly the 0/1 integer columns', () => {
    const declared = declaredColumns()
      .filter((column) => column.columnType === 'SQLiteBoolean')
      .map((column) => column.key)
      .sort()
    expect(declared).toEqual(BOOLEAN_COLUMNS)
  })

  it('defaults them with a SQL literal, never a JS boolean', () => {
    // `.default(false)` would serialise as `DEFAULT false` and diff against the
    // `DEFAULT 0` already in the chain. The value drizzle holds is the tell: a
    // `sql` tag is an object, a JS default is a primitive.
    const offenders = declaredColumns()
      .filter((column) => column.columnType === 'SQLiteBoolean' && column.hasDefault)
      .filter((column) => typeof column.defaultValue === 'boolean')
      .map((column) => column.key)
    expect(offenders).toEqual([])
  })
})
