ALTER TABLE `issues` ADD `brief` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`id` text PRIMARY KEY,
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
	`superseded_by` text,
	`duplicate_of` text,
	`pinned` integer DEFAULT 0 NOT NULL,
	`color` text,
	`estimate_min` integer,
	`needs_human` integer DEFAULT 0 NOT NULL,
	`human_question` text,
	`human_question_options` text,
	`human_question_asked_by` text,
	`human_question_asked_at` text,
	`panel` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`draft` integer DEFAULT 0 NOT NULL,
	`read_at` text,
	`audience` text DEFAULT 'human' NOT NULL,
	`deleted_at` text,
	`coordinator_session_id` text,
	`started_by_session` text,
	CONSTRAINT `fk_issues_parent_id_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_superseded_by_issues_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_duplicate_of_issues_id_fk` FOREIGN KEY (`duplicate_of`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT "issues_check_1" CHECK(stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK(priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK(type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`(`id`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `superseded_by`, `duplicate_of`, `pinned`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `updated_at`, `archived`, `origin`, `draft`, `read_at`, `audience`, `deleted_at`, `coordinator_session_id`, `started_by_session`) SELECT `id`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `superseded_by`, `duplicate_of`, `pinned`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `updated_at`, `archived`, `origin`, `draft`, `read_at`, `audience`, `deleted_at`, `coordinator_session_id`, `started_by_session` FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_issues_deleted_at` ON `issues` (`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issues_repo_id_seq` ON `issues` (`repo_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_issues_parent` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_repo` ON `issues` (`repo_path`);
--> statement-breakpoint
-- Backfill only untouched agent discoveries [spec:SP-6144]. "Touched" means an
-- EXPLICIT operator lifecycle action still in the event log: a stage change /
-- claim (issue.stage_changed), a pin, or an answered needs-human question — all
-- with no causing session. A mere read-through (issue.read) is NOT curation and
-- must not pin an issue in backlog. Event retention (14d/50k) makes this fuzzy
-- for older touches; accepted — the sweep is one-shot and operator-reversible.
UPDATE issues
SET stage = 'proposed'
WHERE archived = 0
  AND deleted_at IS NULL
  AND closed_reason IS NULL
  AND origin = 'agent'
  AND parent_id IS NULL
  AND stage = 'backlog'
  AND NOT EXISTS (
    SELECT 1 FROM podium_events e
    WHERE e.subject = issues.id
      AND e.kind IN ('issue.stage_changed', 'issue.pinned', 'issue.needs_human_cleared')
      AND json_extract(e.payload, '$.causedBySessionId') IS NULL
  );
