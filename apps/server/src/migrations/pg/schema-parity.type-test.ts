/**
 * EVERY POSTGRES TWIN HAS ITS SQLITE TABLE'S ROW TYPES [POD-6978, POD-6958 design 2.1 step 2, 2.2].
 *
 * The binding's one cast (`store/executor/binding.ts`) types the Postgres tables as the
 * SQLite ones, so every query definition is written and typechecked once. This file,
 * checked by `bun run typecheck`, is the compile-time half of what makes that safe; the
 * structural half is `schema-parity.test.ts`. For every table of the server schema and
 * the sync tables:
 *
 *  - the SQLite schema's export has a Postgres export of the same name, so a table added
 *    on SQLite alone stops the typecheck;
 *  - its `$inferSelect` and its `$inferInsert` equal the SQLite table's exactly
 *    ({@link Exact}, not mere assignability): same keys, same nullability, the same
 *    columns optional on insert, the same value types.
 *
 * The twins take each column's value type from SQLite by reference
 * (`$type<SqliteRow<'t'>['c']>()`), so what this catches in practice is a column added,
 * dropped or renamed on one side, a nullability or default that differs, or a twin column
 * written by hand without that reference.
 *
 * The identity tables are excluded: the identity package owns both of their schemas,
 * which differ by design (the cloud's library tables), and proves them with its own
 * suite on both engines.
 *
 * Nothing here runs, and no test imports it.
 */

import type * as pgSync from '../../../../../packages/sync/src/adapters/pg/schema'
import type * as sqliteSync from '../../../../../packages/sync/src/adapters/sqlite/schema'
import type { Exact } from '../../store/executor/dialect-prepared'
import type * as sqliteServer from '../schema'
import type * as pgServer from './schema'

/** Compiles only when `T` is `true`. */
function assertTrue<T extends true>(): T | undefined {
  return undefined
}

/** Compiles only when `T` is `never`; otherwise the error names what `T` holds. */
function assertNone<T extends never>(): T | undefined {
  return undefined
}

/** The export names of a module that are drizzle tables. */
type TableKeys<M> = {
  [K in keyof M]: M[K] extends { readonly $inferSelect: unknown } ? K : never
}[keyof M]

/** The SQLite schema's identity tables, which the identity package twins itself. */
type IdentityKeys = Extract<TableKeys<typeof sqliteServer>, `identity${string}`>

/** Export names of `S`'s tables that `P` has no export for. */
type Missing<S, P> = Exclude<TableKeys<S>, keyof P>

/** Export names whose twin's row type differs, on select or insert. */
type Mismatched<S, P, Skip extends PropertyKey = never> = {
  [K in Exclude<TableKeys<S>, Skip> & keyof P]: S[K] extends {
    readonly $inferSelect: infer SS
    readonly $inferInsert: infer SI
  }
    ? P[K] extends { readonly $inferSelect: infer PS; readonly $inferInsert: infer PI }
      ? Exact<SS, PS> extends true
        ? Exact<SI, PI> extends true
          ? never
          : K
        : K
      : K
    : K
}[Exclude<TableKeys<S>, Skip> & keyof P]

type Server = typeof sqliteServer
type ServerPg = typeof pgServer
type Sync = typeof sqliteSync
type SyncPg = typeof pgSync

// Every SQLite table has a twin. A failure names the missing export names.
assertNone<Missing<Server, ServerPg>>()
assertNone<Missing<Sync, SyncPg>>()

// Every twin has its SQLite table's row types. A failure names the tables that differ.
assertNone<Mismatched<Server, ServerPg, IdentityKeys>>()
assertNone<Mismatched<Sync, SyncPg>>()

// The check is not vacuous: two different tables are found to differ, and so is a
// module that lacks a table.
assertTrue<
  // @ts-expect-error a watermark row is not a quota window row
  Exact<
    Mismatched<{ readonly t: Server['recapWatermarks'] }, { readonly t: ServerPg['quotaWindows'] }>,
    never
  >
>()
assertTrue<
  // @ts-expect-error a module with no `recapWatermarks` export is missing that twin
  Exact<Missing<{ readonly recapWatermarks: Server['recapWatermarks'] }, object>, never>
>()
