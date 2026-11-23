/**
 * ONE DEFINITION, TWO FORMS [POD-6995, POD-6958 design 2.1 step 4].
 *
 * Most query definitions are one source that builds on either engine's tables
 * (`prepared((db, t) => …)`). Where the SQL itself must differ (SQLite's
 * two-argument `MAX(a, b)` is `GREATEST(a, b)` on Postgres), a definition has two
 * forms, written side by side in the repository so a reviewer sees both:
 *
 * ```ts
 * const upsertWindow = dialectPrepared<QuotaWindowValues, void>()({
 *   sqlite: (db, t) => … set: { peak: sql`MAX(${t.w.peak}, excluded.peak)` } …,
 *   pg: (db, t) => … set: { peak: sql`GREATEST(${t.w.peak}, excluded.peak)` } …,
 * })
 * ```
 *
 * THE TYPES ARE DECLARED ONCE. The first call names the values the statement runs
 * with and the row it yields (`void` for a statement without `RETURNING`); the
 * second takes the two forms. Each form's row must equal the declared row exactly
 * ({@link Exact}: not merely assignable, so a form with an extra or a narrower
 * column fails to compile), and the repository sees one signature whose run
 * methods take the declared values. The two calls exist because TypeScript cannot
 * take some type arguments explicitly and infer the rest.
 *
 * WHICH FORM RUNS is decided once per drizzle instance, by the instance's own
 * dialect: the store's Postgres instance (`pg-drizzle.ts`) builds the `pg` form,
 * every SQLite instance (the store's, the query-plan audit's recorder) the `sqlite`
 * form. The definition registers as one ordinary workspace definition, so the
 * audits, the census and the workspace handles treat it exactly like `prepared`;
 * deleting SQLite later means deleting the `sqlite:` arms (design 2.12).
 */

import type { PreparedAccessor } from '@podium/sync/adapters/sqlite/prepared'
import { entityKind } from 'drizzle-orm'
import type { StoreDialect } from './binding'
import { prepared, type StoreDrizzle, type StoreTables } from './sync-drizzle'

/**
 * `true` when `A` and `B` are the same type, `false` otherwise. Mutual
 * assignability is not enough (`{ a: string; b: number }` is assignable to
 * `{ a: string }`), so this compares the two as the checker's identity relation
 * does.
 */
export type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * The row a prepared statement yields: one element of what its `all` resolves to,
 * or `void` for a statement that returns no rows (an insert, update or delete
 * without `RETURNING`, whose `all` drizzle types as an error).
 */
export type RowOf<P> = P extends { all(...args: never[]): Promise<infer Out> }
  ? Out extends readonly (infer Row)[]
    ? Row
    : // biome-ignore lint/suspicious/noConfusingVoidType: `void` is how a definition declares that it yields no rows (design 2.1 step 4).
      void
  : never

type RunMethod = 'get' | 'all' | 'run' | 'values' | 'execute'

/**
 * A form's statement with its run methods typed to take `Values`. Optional when
 * `Values` has no required key, as for a statement with no placeholders.
 */
export type DialectStatement<Values, P> = {
  readonly [K in RunMethod & keyof P]: P[K] extends (...args: never[]) => infer Out
    ? Partial<Values> extends Values
      ? (values?: Values) => Out
      : (values: Values) => Out
    : never
}

/** One form: built on the instance's drizzle and the tables bound to it. */
export type DialectForm<P> = (db: StoreDrizzle, t: StoreTables) => P

/** The two forms of a definition. */
export interface DialectForms<S, G> {
  readonly sqlite: DialectForm<S>
  readonly pg: DialectForm<G>
}

/** The declared row and the row a form builds, as a mismatch's compile error names them. */
export interface RowMismatch<Declared, Built> {
  readonly declared: Declared
  readonly built: Built
}

/**
 * The bound on a form's statement type: anything when it builds exactly the declared
 * row; otherwise {@link RowMismatch}, which no statement is, so a form that builds
 * another row fails to compile on its body, with both rows in the message.
 *
 * A bound on the type parameter, not a check in the parameter list: a conditional
 * type over a form's type in any parameter (an intersection on the forms, a rest
 * tuple after them) fixes the forms' type arguments to `unknown` before their arrow
 * bodies are inferred. A bound is checked after inference.
 */
export type RowIs<Row, P> = Exact<RowOf<P>, Row> extends true ? unknown : RowMismatch<Row, RowOf<P>>

/**
 * A definition with a SQLite form and a Postgres form, declared as running with
 * `Values` and yielding `Row`. See the module comment.
 */
export function dialectPrepared<Values, Row>() {
  return <S extends RowIs<Row, S>, G extends RowIs<Row, G>>(
    forms: DialectForms<S, G>,
  ): PreparedAccessor<StoreDrizzle, DialectStatement<Values, S>> =>
    prepared((db, t) =>
      dialectOf(db) === 'pg' ? forms.pg(db, t) : forms.sqlite(db, t),
    ) as unknown as PreparedAccessor<StoreDrizzle, DialectStatement<Values, S>>
}

/**
 * The engine a drizzle instance builds SQL for, read off its dialect's drizzle
 * entity kind (subclasses included) rather than by `instanceof`, so a SQLite store
 * never loads drizzle's Postgres modules.
 */
export function dialectOf(db: StoreDrizzle): StoreDialect {
  const dialect = (db as unknown as { readonly dialect?: object }).dialect
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
