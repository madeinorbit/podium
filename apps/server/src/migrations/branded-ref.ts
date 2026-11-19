/**
 * BRAND-EQUAL FOREIGN KEYS FOR THE DRIZZLE SCHEMA — POD-1958.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 *
 * POD-1199 branded the schema's entity id columns with drizzle's `$type<Brand>()`
 * so that a column declaring an `AutomationId` cannot be confused with one
 * declaring a `SessionId`. A foreign key was outside that guarantee, because
 * drizzle rc.4 types `.references()` as
 *
 *     references(ref: () => SQLiteColumn, actions?: …): this
 *
 * — `SQLiteColumn` with NO type argument, so the referenced column's `data` type
 * is erased at the parameter. The builder's own brand and the target's brand
 * never meet, and every pairing typechecks. Measured while mutation-checking
 * POD-1938: flipping `automation_runs.automation_id` from `AutomationId` to
 * `SessionId` left `bun run typecheck` at exit 0. That is a branding scheme
 * whose central claim — an id of one entity cannot stand in for another — is
 * unenforced exactly where two entities meet.
 *
 * The answer to "can drizzle generics express brand equality directly?" is NO at
 * 1.0.0-rc.4: there is no generic on `references()` to constrain, and adding one
 * would mean patching drizzle. Hence this helper.
 *
 * ---------------------------------------------------------------------------
 * HOW IT ENFORCES
 * ---------------------------------------------------------------------------
 *
 * {@link brandedRef} is `.references()` with the erased parameter put back. It
 * takes the column builder as its FIRST argument, so the builder's data type is
 * in scope when the target is checked:
 *
 *     automationId: brandedRef(
 *       text('automation_id').$type<AutomationId>(),
 *       () => automations.id,
 *       { onDelete: 'cascade' },
 *     ).notNull(),
 *
 * The check is EXACT, not assignable-in-one-direction. `SQLiteColumn` is
 * declared `out T` (covariant in its config), so a plain parameter constraint
 * would accept a branded target for an UNBRANDED foreign key — `AutomationId`
 * is assignable to `string` — and the most common mistake, forgetting the brand
 * on the referencing side, would pass. {@link Exact} requires assignability BOTH
 * ways, so all three failures are rejected:
 *
 *   - wrong brand on the FK (`SessionId` → `AutomationId`),
 *   - no brand on the FK (`string` → `AutomationId`),
 *   - no brand on the referenced primary key (`AutomationId` → `string`).
 *
 * The last one is why the mutation survived even on its own terms: when it was
 * planted, `automations.id` was still `text().primaryKey()` with no `$type`, so
 * there was no brand on the far side for `SessionId` to disagree with. POD-1938
 * branded the primary keys; this makes that branding load-bearing, and a primary
 * key that loses its brand now breaks every foreign key pointed at it.
 *
 * A pair with no brand on EITHER side (`string`/`string`) is exact and passes —
 * `workflows`, `workflow_revisions` and `workflow_runs` have no brand in
 * `packages/model` to adopt yet (`scripts/entity-id-audit.ts` limit 4), and this
 * helper is not the instrument that should mint one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ERROR LANDS
 * ---------------------------------------------------------------------------
 *
 * The mismatch is spelled on the TARGET PARAMETER rather than the return type,
 * as `(() => TTarget) & Exact<…>`. Inference still comes off the function half,
 * so `TTarget` resolves normally; a mismatch fails the intersection and tsc
 * reports it at the `() => other.id` argument itself:
 *
 *     error TS2345: Argument of type '() => SQLiteColumn<…>' is not assignable
 *     to parameter of type '(() => SQLiteColumn<…>) &
 *     ForeignKeyBrandMismatch<SessionId, AutomationId>'.
 *
 * naming both brands, in FK-then-target order. Returning the error instead would
 * put it on whatever was chained next (`.notNull()` does not exist on …), or —
 * for an unchained column — inside `sqliteTable`'s overload resolution, which
 * prints the whole column-types record and buries the cause.
 *
 * ---------------------------------------------------------------------------
 * SELF-REFERENTIAL COLUMNS
 * ---------------------------------------------------------------------------
 *
 * A column that references its own table needs an explicit return annotation to
 * break the inference cycle, which is why `issues.parentId` writes
 * `(): AnySQLiteColumn => issues.id`. Bare `AnySQLiteColumn` has `data: unknown`
 * and would now be rejected (`unknown` is not assignable to `IssueId`), so those
 * sites name the brand in the annotation instead:
 *
 *     (): AnySQLiteColumn<{ data: IssueId }> => issues.id
 *
 * which is stated rather than inferred — the one place the guarantee rests on an
 * annotation being honest. `AnySQLiteColumn<TPartial>` is drizzle's own partial
 * override, so this is not a cast.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD MUST BE ABLE TO SAY NO
 * ---------------------------------------------------------------------------
 *
 * `branded-ref.type-test.ts` plants each of the three rejected shapes under a
 * `@ts-expect-error`. If a mismatch ever becomes assignable again the directive
 * goes unused and TS2578 fails the ordinary typecheck — the fixture cannot pass
 * by not matching. `branded-ref.test.ts` additionally refuses a raw
 * `.references(` anywhere in `schema.ts`, because the helper only binds the
 * sites that use it and drizzle's own method is still there to be reached for.
 */

import type { WorkspaceId } from '@podium/model'
import type { ColumnBuilderBase } from 'drizzle-orm'
import {
  foreignKey,
  type ReferenceConfig,
  type SQLiteColumn,
  type SQLiteColumnBuilder,
} from 'drizzle-orm/sqlite-core'

/**
 * The data type a column builder will produce.
 *
 * `$type<T>()` does not overwrite `_['data']` — it intersects a `_['$type']`
 * marker that `MakeColumnConfig` resolves only when the table is built. Reading
 * `_['data']` alone therefore sees `string` for every branded text column and
 * this whole check collapses to a tautology, so the marker is read first, the
 * same order drizzle itself resolves it in.
 */
type BuilderData<TBuilder extends ColumnBuilderBase> = TBuilder['_'] extends { $type: infer TType }
  ? TType
  : TBuilder['_']['data']

declare const BRAND_MISMATCH: unique symbol

/**
 * The type a mismatched target fails against. It exists to be UNSATISFIABLE and
 * to carry both brands into the diagnostic; the `unique symbol` is what stops a
 * structurally-similar value from accidentally satisfying it.
 */
export interface ForeignKeyBrandMismatch<TColumn, TTarget> {
  readonly [BRAND_MISMATCH]: [column: TColumn, target: TTarget]
}

/**
 * `TOk` when `A` and `B` are the same type, an unsatisfiable error type when not.
 *
 * Both directions are required. One direction is variance, not equality, and
 * would let an unbranded foreign key point at a branded key silently.
 * The tuple wrappers stop a union from distributing into a per-member check.
 */
type Exact<A, B, TOk> = [A] extends [B]
  ? [B] extends [A]
    ? TOk
    : ForeignKeyBrandMismatch<A, B>
  : ForeignKeyBrandMismatch<A, B>

/**
 * Declare a foreign key whose brand must equal the referenced column's brand.
 *
 * Use INSTEAD of `.references()` in `schema.ts`; `branded-ref.test.ts` enforces
 * that. Returns the builder unchanged, so the usual chain continues off it
 * (`.notNull()`, `.primaryKey()`, …) and drizzle-kit sees exactly what
 * `.references()` would have left behind — this helper emits no SQL of its own
 * and changes no migration.
 */
export function brandedRef<TBuilder extends SQLiteColumnBuilder, TTarget extends SQLiteColumn>(
  column: TBuilder,
  target: (() => TTarget) & Exact<BuilderData<TBuilder>, TTarget['_']['data'], unknown>,
  actions?: ReferenceConfig['actions'],
): TBuilder {
  return column.references(target as () => SQLiteColumn, actions)
}

/**
 * A WORKSPACE TABLE'S FOREIGN KEY (POD-6959 design 2.2, POD-7024).
 *
 * Every key of a workspace table leads with `workspace_id`, so a foreign key between two of
 * them is composite: `(workspace_id, issue_id)` references `issues (workspace_id, id)`. A
 * child row can then never point at a parent in another workspace, which is the database's own
 * guarantee of isolation (design 2.9). A single-column `.references()` cannot say that, and it
 * cannot even be declared any more: the parent's id alone is no longer unique.
 *
 * The brand check of {@link brandedRef} holds for every pair, position by position, and the
 * first pair must be the two workspace columns. Drizzle's own `foreignKey()` takes the columns
 * untyped, so the pairing is checked here and the key is built by drizzle.
 *
 * NO `set null`. SQLite sets every child column of a key to NULL, the workspace too, which its
 * NOT NULL refuses. The four references that cleared themselves when their target was deleted
 * (`issues.parent_id`, `superseded_by`, `duplicate_of`, `workflow_runs.supersedes_run_id`) keep
 * that behaviour through a trigger the keys migration writes, and their key takes no action.
 */
type DataOf<TColumn> = TColumn extends { _: { $type: infer TType } }
  ? TType
  : TColumn extends { _: { data: infer TData } }
    ? TData
    : never

type PairedWith<TColumns extends readonly unknown[], TTargets extends readonly unknown[]> = {
  readonly [K in keyof TTargets]: K extends keyof TColumns
    ? Exact<DataOf<TColumns[K]>, DataOf<TTargets[K]>, TTargets[K]>
    : TTargets[K]
}

type WorkspaceFirst<TColumns extends readonly unknown[]> = TColumns extends readonly [
  infer TFirst,
  ...unknown[],
]
  ? Exact<DataOf<TFirst>, WorkspaceId, TColumns>
  : ForeignKeyBrandMismatch<TColumns, WorkspaceId>

export function workspaceRef<
  const TColumns extends readonly [SQLiteColumn, ...SQLiteColumn[]],
  const TTargets extends readonly [SQLiteColumn, ...SQLiteColumn[]],
>(config: {
  readonly name: string
  readonly columns: TColumns & WorkspaceFirst<TColumns>
  readonly foreignColumns: TTargets & PairedWith<TColumns, TTargets>
  readonly onDelete?: 'cascade' | 'restrict'
}) {
  const { name, columns, foreignColumns, onDelete } = config
  if (columns.length !== foreignColumns.length) {
    throw new Error(
      `foreign key ${name} pairs ${columns.length} columns with ${foreignColumns.length}`,
    )
  }
  if (columns[0].name !== 'workspace_id' || foreignColumns[0].name !== 'workspace_id') {
    throw new Error(`foreign key ${name} must lead with workspace_id on both sides`)
  }
  const key = foreignKey({
    name,
    columns: [...columns] as unknown as [SQLiteColumn, ...SQLiteColumn[]],
    foreignColumns: [...foreignColumns] as unknown as [SQLiteColumn, ...SQLiteColumn[]],
  })
  return onDelete === undefined ? key : key.onDelete(onDelete)
}
