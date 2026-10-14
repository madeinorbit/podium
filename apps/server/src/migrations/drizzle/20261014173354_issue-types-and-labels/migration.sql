-- POD-6106 (flight deck v6, D2 + D3). Issue types narrow to task | phase | decision,
-- and labels become a vocabulary of their own instead of free text on each issue.
--
--   epic, automation           -> task
--   milestone                  -> phase   (POD-279's "Phase N" issues)
--   bug, feature, chore,
--   story, spike               -> task + a label of the same name
--   task, decision             -> unchanged
--
-- Both tables are rebuilt: SQLite can neither narrow a CHECK nor change a primary
-- key in place. Nothing is dropped that the new shape cannot hold: every old label
-- string and every retired type that names a label survives as a label link.
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`color` text,
	`description` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_labels_name_nocase` ON `labels` (lower("name"));
--> statement-breakpoint
-- Every free-text label in use becomes one label row. Names are unique ignoring
-- case, so case variants collapse onto one deterministic spelling.
INSERT INTO `labels` (`name`, `created_at`)
SELECT MIN(`label`), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `issue_labels` GROUP BY lower(`label`) ORDER BY lower(`label`);
--> statement-breakpoint
-- A retired type that becomes a label gets a label row when some issue carries it
-- and no label of that name exists yet.
INSERT INTO `labels` (`name`, `created_at`)
SELECT DISTINCT `type`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `issues`
WHERE `type` IN ('bug', 'feature', 'chore', 'story', 'spike')
  AND lower(`type`) NOT IN (SELECT lower(`name`) FROM `labels`)
ORDER BY `type`;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` integer NOT NULL,
	CONSTRAINT `issue_labels_pk` PRIMARY KEY(`issue_id`, `label_id`),
	CONSTRAINT `fk_issue_labels_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_issue_labels_label_id_labels_id_fk` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_issue_labels` (`issue_id`, `label_id`)
SELECT DISTINCT il.`issue_id`, l.`id` FROM `issue_labels` il
JOIN `labels` l ON lower(l.`name`) = lower(il.`label`);
--> statement-breakpoint
INSERT INTO `__new_issue_labels` (`issue_id`, `label_id`)
SELECT i.`id`, l.`id` FROM `issues` i
JOIN `labels` l ON lower(l.`name`) = i.`type`
WHERE i.`type` IN ('bug', 'feature', 'chore', 'story', 'spike')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE `issue_labels`;
--> statement-breakpoint
ALTER TABLE `__new_issue_labels` RENAME TO `issue_labels`;
--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`visibility` text DEFAULT 'personal' NOT NULL,
	`created_by_actor` text NOT NULL,
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
	`landed_at` text,
	`landed_sha` text,
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
	`human_question_attribution` text,
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
	`started_by_session` text,
	CONSTRAINT `fk_issues_parent_id_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_superseded_by_issues_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_duplicate_of_issues_id_fk` FOREIGN KEY (`duplicate_of`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT "issues_check_1" CHECK(stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK(priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK(type IN ('task', 'phase', 'decision'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`(`id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `landed_at`, `landed_sha`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `human_question_attribution`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session`) SELECT `id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, CASE `type` WHEN 'milestone' THEN 'phase' WHEN 'decision' THEN 'decision' ELSE 'task' END, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `landed_at`, `landed_sha`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `human_question_attribution`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session` FROM `issues`;
--> statement-breakpoint
DROP TABLE `issues`;
--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `idx_issue_labels_label_id` ON `issue_labels` (`label_id`);
--> statement-breakpoint
CREATE INDEX `idx_issues_deleted_at` ON `issues` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_issues_closed_projection` ON `issues` (`id`,`stage`,`closed_reason`,`deleted_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issues_repo_id_seq` ON `issues` (`repo_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `idx_issues_parent` ON `issues` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `idx_issues_repo` ON `issues` (`repo_path`);
--> statement-breakpoint
-- Cached issue payloads still carry the retired types. A fresh epoch makes every
-- old cursor rebootstrap from the migrated rows instead of replaying them.
UPDATE `feed_identity`
SET `epoch` = 'issue-types-and-labels-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1;
