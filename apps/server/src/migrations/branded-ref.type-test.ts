/**
 * THE NEGATIVE FIXTURE FOR {@link brandedRef} — POD-1958.
 *
 * This file exists to FAIL. Each `@ts-expect-error` below plants a foreign key
 * whose brand disagrees with the column it references; the directive passes only
 * while tsc still rejects the line under it. If a drizzle upgrade, a change to
 * {@link brandedRef}, or a stray `any` ever makes a mismatch assignable again,
 * the directive goes unused and TS2578 ("Unused '@ts-expect-error' directive")
 * fails `bun run typecheck` — the ordinary gate, no separate lane.
 *
 * That inversion is the point. A fixture that asserted "this compiles" would go
 * on passing after the guarantee it tests had evaporated; this one cannot pass
 * by not matching. The positive cases below are here for the other half — a
 * `brandedRef` that rejected EVERYTHING would satisfy every `@ts-expect-error`
 * on its own, so the shapes that must keep compiling are declared too.
 *
 * The brands are the real ones from `@podium/model`, imported as types only for
 * the reason `schema.ts` documents at length: drizzle-kit's loader cannot
 * resolve `@podium/model` as a value. This file is not part of the drizzle-kit
 * schema graph, but keeping the same discipline means a future move of these
 * declarations into `schema.ts` cannot break it.
 */

import type { AutomationId, IssueId, SessionId } from '@podium/model'
import { type AnySQLiteColumn, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { brandedRef } from './branded-ref'

const parents = sqliteTable('type_test_parents', {
  id: text().$type<AutomationId>().primaryKey(),
})

const unbrandedParents = sqliteTable('type_test_unbranded_parents', {
  id: text().primaryKey(),
})

// ---------------------------------------------------------------------------
// REJECTED — each of these is a defect the plain `.references()` accepted
// ---------------------------------------------------------------------------

/**
 * The mutation POD-1938's check planted: a `SessionId` foreign key pointing at
 * an `AutomationId` primary key. This is the exact shape that left the apps/server
 * typecheck at exit 0 before `brandedRef` existed.
 */
export const wrongBrand = sqliteTable('type_test_wrong_brand', {
  automationId: brandedRef(
    text('automation_id').$type<SessionId>(),
    // @ts-expect-error a SessionId column may not reference an AutomationId key
    () => parents.id,
    { onDelete: 'cascade' },
  ).notNull(),
})

/**
 * A foreign key that forgot its brand. Rejected only because the check is
 * two-directional: `SQLiteColumn` is covariant in its config, so `AutomationId`
 * IS assignable to `string` and a one-way constraint would wave this through —
 * while "someone forgot the `$type`" is the likeliest way a brand goes missing.
 */
export const unbrandedColumn = sqliteTable('type_test_unbranded_column', {
  automationId: brandedRef(
    text('automation_id'),
    // @ts-expect-error an unbranded column may not reference an AutomationId key
    () => parents.id,
    { onDelete: 'cascade' },
  ).notNull(),
})

/**
 * A branded foreign key pointing at an unbranded primary key — `automations.id`
 * as it stood before POD-1958. There was no brand on the far side to disagree
 * with, which is why the planted mutation had nothing to fail against.
 */
export const unbrandedTarget = sqliteTable('type_test_unbranded_target', {
  automationId: brandedRef(
    text('automation_id').$type<AutomationId>(),
    // @ts-expect-error an AutomationId column may not reference an unbranded key
    () => unbrandedParents.id,
    { onDelete: 'cascade' },
  ).notNull(),
})

/**
 * A self-reference whose annotation names the wrong brand. Self-referential
 * columns are the one place the guarantee rests on a hand-written annotation
 * (the inference cycle forces one), so the annotation is checked like any other
 * target rather than trusted.
 */
export const wrongSelfBrand = sqliteTable('type_test_wrong_self_brand', {
  id: text().$type<IssueId>().primaryKey(),
  parentId: brandedRef(
    text('parent_id').$type<IssueId>(),
    // @ts-expect-error the annotation claims SessionId where the key is IssueId
    (): AnySQLiteColumn<{ data: SessionId }> => wrongSelfBrand.id,
    { onDelete: 'set null' },
  ),
})

// ---------------------------------------------------------------------------
// ACCEPTED — the shapes `schema.ts` actually uses must keep compiling
// ---------------------------------------------------------------------------

/** Equal brands on both sides: the ordinary case. */
export const matchingBrand = sqliteTable('type_test_matching_brand', {
  automationId: brandedRef(text('automation_id').$type<AutomationId>(), () => parents.id, {
    onDelete: 'cascade',
  }).notNull(),
})

/**
 * Neither side branded. `workflows`, `workflow_revisions` and `workflow_runs`
 * name entities with no brand in `packages/model` to adopt, so `string`/`string`
 * is exact and passes — `brandedRef` is not the instrument that mints a brand.
 */
export const unbrandedPair = sqliteTable('type_test_unbranded_pair', {
  workflowId: brandedRef(text('workflow_id'), () => unbrandedParents.id, {
    onDelete: 'cascade',
  }).notNull(),
})

/** A self-reference whose annotation names the right brand. */
export const matchingSelfBrand = sqliteTable('type_test_matching_self_brand', {
  id: text().$type<IssueId>().primaryKey(),
  parentId: brandedRef(
    text('parent_id').$type<IssueId>(),
    (): AnySQLiteColumn<{ data: IssueId }> => matchingSelfBrand.id,
    { onDelete: 'set null' },
  ),
})

/** The builder is returned unchanged, so the usual chain continues off it. */
export const chainsThrough = sqliteTable('type_test_chains_through', {
  automationId: brandedRef(text('automation_id').$type<AutomationId>(), () => parents.id, {
    onDelete: 'cascade',
  }).primaryKey(),
})
