/**
 * Migration 010 — drop the 'verifying' issue stage.
 *
 * 'verifying' sat between 'review' and 'done' and never earned its keep: review
 * already covers "the change is written and being checked", so the extra column
 * only split the same work across two lanes on the board.
 *
 * Existing 'verifying' rows fold back into 'review' (the stage they came from),
 * NOT 'done' — an issue mid-verification is not finished, and it should stay on
 * the board asking for eyes. Without this backfill such a row fails IssueStage
 * parsing the moment it goes on the wire. `suggested_stage` (the assistant's
 * advisory column, unconstrained free text) gets the same treatment so a stale
 * suggestion can't offer a stage the UI no longer renders.
 *
 * The 006 CHECK on issues.stage still names 'verifying' and stays that way: a
 * CHECK cannot be narrowed in place, and the rebuild that would narrow it must
 * DROP TABLE issues — which, under a SQLite build that enables foreign keys by
 * default (node:sqlite does; bun:sqlite does not), cascades through the child
 * tables' ON DELETE CASCADE and destroys every dep/label/comment/message row.
 * Not worth it. The CHECK's job is rejecting garbage, and it still does; it just
 * tolerates one dead value that nothing writes any more. IssueStage (zod) is the
 * enforcing boundary.
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  db.exec("UPDATE issues SET stage = 'review' WHERE stage = 'verifying'")
  db.exec("UPDATE issues SET suggested_stage = 'review' WHERE suggested_stage = 'verifying'")
}
