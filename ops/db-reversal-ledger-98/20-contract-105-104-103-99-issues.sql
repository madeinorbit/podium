--
-- REVERSE MIGRATION TO LEDGER 98 -- 105 + 104 + 103 + 99, THE ISSUES TABLE
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- 105 `a2-retire-issue-assignee` DROPped `issues.assignee`.
-- 104 `a2-ownership-backfill` overwrote `issues.owner_user_id` on rows it judged
--     'adopted-assignee-as-owner' (zero such rows here) and seeded
--     `assignment_revision` / `input_revision`.
-- 103 `a2-ownership-schema` ADDed those two columns.
--  99 `retire-the-solo-user` rebuilt this table to strip the
--     `DEFAULT 'user:sole'` from `owner_user_id` and `created_by_actor`, which
--     also MOVED `landed_at` / `landed_sha` from the end of the row into the
--     middle.
--
-- All four are undone by one rebuild, because all four are the shape of this one
-- table. The DDL below is the exact `sqlite_master.sql` text from the ledger-98
-- backup, so the rebuilt table is byte-identical to what the shipping binary
-- expects -- column order included.
--
-- WHERE `assignee` COMES BACK FROM. Two sources, and neither is a guess:
--
--   * 1808 rows: `ownership_migration_dispositions.retired_assignee`. The
--     backfill wrote the value it read BEFORE 105 dropped the column, precisely
--     so this question could be answered later. Its own header argues for
--     `prior_owner` on the same grounds.
--   * 1 row, iss_4e01441e-9e58-44ea-b4eb-e52769f52e68: its assignee EQUALLED
--     its owner, so the backfill considered it unambiguous and recorded nothing.
--     After the drop it is indistinguishable from the 2487 rows whose assignee
--     was NULL. This id is the one fact in this script that comes from the
--     ledger-98 backup rather than from the live database, and it is pinned
--     here rather than inferred because it CANNOT be inferred.
--
-- Every other row gets NULL, which is what the backup says they held: at
-- ledger 98 the assignee column was NULL on 2487 issues, empty-string on none,
-- equal-to-owner on that one, and one of the 1808 recorded values otherwise.
-- 2487 + 1 + 1808 = 4296 = every issue.


CREATE TABLE "__rev_stash_issues" AS SELECT * FROM "issues";

DROP TABLE "issues";

CREATE TABLE "issues" (
	`id` text PRIMARY KEY,
	`owner_user_id` text DEFAULT 'user:sole' NOT NULL,
	`visibility` text DEFAULT 'personal' NOT NULL,
	`created_by_actor` text DEFAULT 'user:sole' NOT NULL,
	`created_by_on_behalf_of` text,
	`repo_path` text NOT NULL,
	`repo_id` text,
	`seq` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`brief` text,
	`stage` text NOT NULL,
	`worktree_path` text,
	`branch` text,
	`parent_branch` text DEFAULT 'main' NOT NULL,
	`default_agent` text NOT NULL,
	`default_model` text DEFAULT 'auto' NOT NULL,
	`default_effort` text DEFAULT 'auto' NOT NULL,
	`machine_id` text,
	`linear_id` text,
	`linear_identifier` text,
	`linear_url` text,
	`activity_notes` text,
	`notes_updated_at` text,
	`suggested_stage` text,
	`suggested_reason` text,
	`blocked_by` text DEFAULT '[]' NOT NULL,
	`dependency_note` text,
	`pr_url` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`assignee` text,
	`parent_id` text,
	`design` text,
	`acceptance` text,
	`notes` text,
	`due_at` text,
	`defer_until` text,
	`closed_reason` text,
	`closed_at` text,
	`superseded_by` text,
	`duplicate_of` text,
	`sort_key` text,
	`color` text,
	`estimate_min` integer,
	`needs_human` integer DEFAULT 0 NOT NULL,
	`human_question` text,
	`human_question_options` text,
	`human_question_asked_by` text,
	`human_question_asked_at` text,
	`panel` text,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text,
	`updated_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`draft` integer DEFAULT 0 NOT NULL,
	`audience` text DEFAULT 'human' NOT NULL,
	`deleted_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`coordinator_session_id` text,
	`started_by_session` text, `landed_at` text, `landed_sha` text,
	CONSTRAINT `fk_issues_parent_id_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_superseded_by_issues_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_duplicate_of_issues_id_fk` FOREIGN KEY (`duplicate_of`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT "issues_check_1" CHECK(stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK(priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK(type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation'))
);

INSERT INTO "issues" ("id", "owner_user_id", "visibility", "created_by_actor", "created_by_on_behalf_of", "repo_path", "repo_id", "seq", "title", "description", "brief", "stage", "worktree_path", "branch", "parent_branch", "default_agent", "default_model", "default_effort", "machine_id", "linear_id", "linear_identifier", "linear_url", "activity_notes", "notes_updated_at", "suggested_stage", "suggested_reason", "blocked_by", "dependency_note", "pr_url", "priority", "type", "assignee", "parent_id", "design", "acceptance", "notes", "due_at", "defer_until", "closed_reason", "closed_at", "superseded_by", "duplicate_of", "sort_key", "color", "estimate_min", "needs_human", "human_question", "human_question_options", "human_question_asked_by", "human_question_asked_at", "panel", "created_at", "actor", "on_behalf_of", "updated_at", "archived", "origin", "draft", "audience", "deleted_at", "revision", "coordinator_session_id", "started_by_session", "landed_at", "landed_sha")
SELECT "id", COALESCE((SELECT d."prior_owner" FROM "ownership_migration_dispositions" d
               WHERE d."migration" = '20260912164233_a2-ownership-backfill'
                 AND d."entity_kind" = 'issue' AND d."entity_id" = s."id"
                 AND d."disposition" = 'adopted-assignee-as-owner'), s."owner_user_id"), "visibility", "created_by_actor", "created_by_on_behalf_of", "repo_path", "repo_id", "seq", "title", "description", "brief", "stage", "worktree_path", "branch", "parent_branch", "default_agent", "default_model", "default_effort", "machine_id", "linear_id", "linear_identifier", "linear_url", "activity_notes", "notes_updated_at", "suggested_stage", "suggested_reason", "blocked_by", "dependency_note", "pr_url", "priority", "type", CASE WHEN s."id" = 'iss_4e01441e-9e58-44ea-b4eb-e52769f52e68'
         THEN s."owner_user_id"
         ELSE (SELECT d."retired_assignee" FROM "ownership_migration_dispositions" d
                WHERE d."migration" = '20260912164233_a2-ownership-backfill'
                  AND d."entity_kind" = 'issue' AND d."entity_id" = s."id")
    END, "parent_id", "design", "acceptance", "notes", "due_at", "defer_until", "closed_reason", "closed_at", "superseded_by", "duplicate_of", "sort_key", "color", "estimate_min", "needs_human", "human_question", "human_question_options", "human_question_asked_by", "human_question_asked_at", "panel", "created_at", "actor", "on_behalf_of", "updated_at", "archived", "origin", "draft", "audience", "deleted_at", "revision", "coordinator_session_id", "started_by_session", "landed_at", "landed_sha"
FROM "__rev_stash_issues" AS s;

DROP TABLE "__rev_stash_issues";

CREATE INDEX `idx_issues_closed_projection` ON `issues` (`id`,`stage`,`closed_reason`,`deleted_at`);

CREATE INDEX `idx_issues_deleted_at` ON `issues` (`deleted_at`);

CREATE INDEX `idx_issues_parent` ON `issues` (`parent_id`);

CREATE INDEX `idx_issues_repo` ON `issues` (`repo_path`);

CREATE UNIQUE INDEX `idx_issues_repo_id_seq` ON `issues` (`repo_id`,`seq`);
