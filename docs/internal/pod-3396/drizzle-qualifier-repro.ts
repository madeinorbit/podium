/**
 * THE SMALLEST THING THAT EMITS A BARE IDENTIFIER [POD-3396, finding POD-3397's].
 *
 * Needs nothing from podium — drizzle-orm and two toy tables — so it runs
 * anywhere:  bun docs/internal/pod-3396/drizzle-qualifier-repro.ts
 *
 * THE TRIGGER is a `sql` fragment in the SELECT LIST of a query with NO JOINS.
 * Not the WHERE clause, and not "one FROM table" on its own. `buildSelection`
 * (sqlite-core/dialect.js:105, under `isSingleTable = !joins || joins.length === 0`
 * at :167) maps over the fragment's chunks and replaces every `Column` with a
 * BARE identifier. It is a blind map: it does not know some of those chunks sit
 * inside a nested FROM, so the OUTER query's qualifier is stripped while the name
 * sits in a subquery whose own table it now binds to first.
 *
 * THE HARM needs the correlated subquery; the TRIGGER does not. (a) is the same
 * rewrite and is harmless because there is no inner FROM to capture the name.
 *
 * AND THE PART THAT MAKES IT UNREADABLE OFF THE PAGE: `queryChunks.map` walks
 * only the TOP LEVEL, so the identical fragment is broken written inline (b) and
 * silently correct when composed from a nested fragment (f). "Does my query have
 * this bug" is therefore not answerable by reading it. Print `.toSQL().sql`.
 */

import { Database } from 'bun:sqlite'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const parent = sqliteTable('parent', { id: text('id').primaryKey() })
const child = sqliteTable('child', { parentId: text('parent_id'), n: integer('n') })
const other = sqliteTable('other', { parentId: text('parent_id') })

const db = drizzle({ client: new Database(':memory:') })
const show = (label: string, sqlText: string) => console.log(`${label}\n    ${sqlText}\n`)

show(
  '(a) projection / one table / no subquery                    harmless',
  db
    .select({ x: sql`${parent.id}` })
    .from(parent)
    .toSQL().sql,
)
show(
  '(b) projection / one table / correlated subquery            THE BUG',
  db
    .select({ n: sql`(SELECT COUNT(*) FROM ${child} c WHERE c.parent_id = ${parent.id})` })
    .from(parent)
    .toSQL().sql,
)
show(
  '(c) projection / TWO tables / correlated subquery           safe: not isSingleTable',
  db
    .select({ n: sql`(SELECT COUNT(*) FROM ${child} c WHERE c.parent_id = ${parent.id})` })
    .from(parent)
    .innerJoin(other, eq(other.parentId, parent.id))
    .toSQL().sql,
)
show(
  '(d) WHERE / one table / correlated subquery                 safe: buildSelection never sees it',
  db
    .select({ id: parent.id })
    .from(parent)
    .where(sql`(SELECT COUNT(*) FROM ${child} c WHERE c.parent_id = ${parent.id}) > 0`)
    .toSQL().sql,
)
show(
  '(e) THE FIX: sql.identifier is not a Column chunk',
  db
    .select({
      n: sql`(SELECT COUNT(*) FROM ${child} c WHERE c.parent_id = ${sql.identifier('parent')}.${sql.identifier('id')})`,
    })
    .from(parent)
    .toSQL().sql,
)
const inner = sql`c.parent_id = ${parent.id}`
show(
  '(f) THE TRAP: same Column one level deeper — silently safe',
  db
    .select({ n: sql`(SELECT COUNT(*) FROM ${child} c WHERE ${inner})` })
    .from(parent)
    .toSQL().sql,
)
