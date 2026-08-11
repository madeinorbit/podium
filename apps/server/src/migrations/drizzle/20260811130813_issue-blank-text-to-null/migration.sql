-- POD-820 — one spelling for absent on the issues table.
--
-- A nullable text column could hold both NULL and '' to mean "absent". The write
-- path now collapses '' to NULL (apps/server/src/modules/issues/blank-text.ts);
-- this retires the rows written before it did. Measured on a read-only copy of
-- the live database at POD-796 (793 issues): 2 rows on `assignee`, zero on every
-- other nullable text column — the sweep is written over the whole class anyway,
-- because it must also cover databases this one never saw.
--
-- The column list is the exact runtime counterpart of `BLANK_TO_NULL_COLUMNS`.
-- NOT-NULL text columns are deliberately absent: `description` holds '' on 146
-- live rows and that is its legitimate "no description" value, not a second
-- spelling of anything. `actor` / `on_behalf_of` are nullable in the table but
-- are not `IssueRow` fields, so no issue write path can produce '' on them; they
-- stay outside the correspondence this migration keeps with the normalizer.
UPDATE issues SET created_by_on_behalf_of = NULL WHERE created_by_on_behalf_of = '';--> statement-breakpoint
UPDATE issues SET repo_id = NULL WHERE repo_id = '';--> statement-breakpoint
UPDATE issues SET brief = NULL WHERE brief = '';--> statement-breakpoint
UPDATE issues SET worktree_path = NULL WHERE worktree_path = '';--> statement-breakpoint
UPDATE issues SET branch = NULL WHERE branch = '';--> statement-breakpoint
UPDATE issues SET machine_id = NULL WHERE machine_id = '';--> statement-breakpoint
UPDATE issues SET linear_id = NULL WHERE linear_id = '';--> statement-breakpoint
UPDATE issues SET linear_identifier = NULL WHERE linear_identifier = '';--> statement-breakpoint
UPDATE issues SET linear_url = NULL WHERE linear_url = '';--> statement-breakpoint
UPDATE issues SET activity_notes = NULL WHERE activity_notes = '';--> statement-breakpoint
UPDATE issues SET notes_updated_at = NULL WHERE notes_updated_at = '';--> statement-breakpoint
UPDATE issues SET suggested_stage = NULL WHERE suggested_stage = '';--> statement-breakpoint
UPDATE issues SET suggested_reason = NULL WHERE suggested_reason = '';--> statement-breakpoint
UPDATE issues SET dependency_note = NULL WHERE dependency_note = '';--> statement-breakpoint
UPDATE issues SET pr_url = NULL WHERE pr_url = '';--> statement-breakpoint
UPDATE issues SET deleted_at = NULL WHERE deleted_at = '';--> statement-breakpoint
UPDATE issues SET assignee = NULL WHERE assignee = '';--> statement-breakpoint
UPDATE issues SET parent_id = NULL WHERE parent_id = '';--> statement-breakpoint
UPDATE issues SET design = NULL WHERE design = '';--> statement-breakpoint
UPDATE issues SET acceptance = NULL WHERE acceptance = '';--> statement-breakpoint
UPDATE issues SET notes = NULL WHERE notes = '';--> statement-breakpoint
UPDATE issues SET due_at = NULL WHERE due_at = '';--> statement-breakpoint
UPDATE issues SET defer_until = NULL WHERE defer_until = '';--> statement-breakpoint
UPDATE issues SET closed_reason = NULL WHERE closed_reason = '';--> statement-breakpoint
UPDATE issues SET closed_at = NULL WHERE closed_at = '';--> statement-breakpoint
UPDATE issues SET superseded_by = NULL WHERE superseded_by = '';--> statement-breakpoint
UPDATE issues SET duplicate_of = NULL WHERE duplicate_of = '';--> statement-breakpoint
UPDATE issues SET sort_key = NULL WHERE sort_key = '';--> statement-breakpoint
UPDATE issues SET color = NULL WHERE color = '';--> statement-breakpoint
UPDATE issues SET human_question = NULL WHERE human_question = '';--> statement-breakpoint
UPDATE issues SET human_question_asked_by = NULL WHERE human_question_asked_by = '';--> statement-breakpoint
UPDATE issues SET human_question_asked_at = NULL WHERE human_question_asked_at = '';--> statement-breakpoint
UPDATE issues SET panel = NULL WHERE panel = '';--> statement-breakpoint
UPDATE issues SET coordinator_session_id = NULL WHERE coordinator_session_id = '';--> statement-breakpoint
UPDATE issues SET started_by_session = NULL WHERE started_by_session = '';
