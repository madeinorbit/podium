/**
 * ONE SYNC DEFINITION, TWO FORMS [POD-6989, POD-6958 design 2.1 step 4].
 *
 * The sync repository's definitions are one source that builds on either engine's
 * tables. Where the SQL itself must differ (SQLite's `INDEXED BY` hint, its two-argument
 * `MAX(a, b)`, its `rowid`), a definition has two forms, written side by side in the
 * repository so a reviewer sees both:
 *
 * ```ts
 * const newestAgedSeq = dialectPrepared()({
 *   sqlite: (db, t) => … .from(sql`${t.changes} indexed by …`) … .prepare(),
 *   pg: (db, t) => … .from(t.changes) … .prepare(),
 * })
 * ```
 *
 * This is the package's counterpart of the server's `dialectPrepared`
 * (`apps/server/src/store/executor/dialect-prepared.ts`), which a package may not
 * import, and it is spelled the same way so the prepared-statement census and the
 * definition census read both alike. Both forms are built on the same typed drizzle
 * instance (a Postgres store binds its instance to the SQLite types, design 2.1 step 2),
 * so they share one statement type and the repository sees one signature.
 *
 * ONE DEFINITION, PREPARED ONCE PER DRIZZLE INSTANCE. The two forms register as one
 * ordinary `prepared` definition, so its statement is built once per instance and only
 * filled and run per call (server-data rule 1, POD-6147). WHICH FORM it builds is decided
 * by the instance's own dialect, read off its drizzle entity kind rather than by
 * `instanceof`, so a SQLite store never loads drizzle's Postgres modules. The audits and
 * censuses build it like any other: the dialect census builds the `pg` form, the
 * query-plan audit the `sqlite` one. Deleting SQLite later means deleting the `sqlite:`
 * arms (design 2.12).
 */

import { entityKind } from 'drizzle-orm'
import { type PreparedAccessor, prepared } from '../sqlite/prepared'

/** The engines a sync repository can run on. */
export type SyncDialect = 'sqlite' | 'pg'

/** The engine a drizzle instance builds SQL for. */
export function dialectOf(db: object): SyncDialect {
  const dialect = (db as { readonly dialect?: object }).dialect
  for (
    let kind: unknown =
      dialect === undefined ? undefined : Object.getPrototypeOf(dialect)?.constructor;
    typeof kind === 'function';
    kind = Object.getPrototypeOf(kind)
  ) {
    const name = (kind as { readonly [entityKind]?: string })[entityKind]
    if (name === 'PgDialect') return 'pg'
    if (name === 'SQLiteDialect') return 'sqlite'
  }
  throw new Error(
    'dialectPrepared: this drizzle instance has neither a SQLite nor a Postgres dialect',
  )
}

/** The two forms of one definition. */
export interface DialectForms<D, T, P> {
  readonly sqlite: (db: D, t: T) => P
  readonly pg: (db: D, t: T) => P
}

/**
 * A definition with a SQLite form and a Postgres form; see the module comment. The first
 * call fixes the instance and table types (a repository rebinds it once with its own),
 * the second takes the two forms.
 */
export function dialectPrepared<D extends object, T>() {
  return <P>(forms: DialectForms<D, T, P>): PreparedAccessor<D, P> =>
    prepared<D, T, P>((db, t) => (dialectOf(db) === 'pg' ? forms.pg(db, t) : forms.sqlite(db, t)))
}
