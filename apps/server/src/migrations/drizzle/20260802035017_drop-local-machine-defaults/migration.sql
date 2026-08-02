PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY,
	`agent_kind` text NOT NULL,
	`provider_id` text NOT NULL,
	`title` text,
	`name` text,
	`summary` text,
	`project_path` text,
	`resume_kind` text,
	`resume_value` text,
	`created_at` text,
	`updated_at` text,
	`message_count` integer,
	`machine_id` text NOT NULL,
	`parent_conversation_id` text
);
--> statement-breakpoint
INSERT INTO `__new_conversations`(`id`, `agent_kind`, `provider_id`, `title`, `name`, `summary`, `project_path`, `resume_kind`, `resume_value`, `created_at`, `updated_at`, `message_count`, `machine_id`, `parent_conversation_id`) SELECT `id`, `agent_kind`, `provider_id`, `title`, `name`, `summary`, `project_path`, `resume_kind`, `resume_value`, `created_at`, `updated_at`, `message_count`, `machine_id`, `parent_conversation_id` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repos` (
	`machine_id` text NOT NULL,
	`path` text NOT NULL,
	`origin_url` text,
	`repo_name` text,
	`added_at` text NOT NULL,
	`repo_id` text,
	CONSTRAINT `repos_pk` PRIMARY KEY(`machine_id`, `path`)
);
--> statement-breakpoint
INSERT INTO `__new_repos`(`machine_id`, `path`, `origin_url`, `repo_name`, `added_at`, `repo_id`) SELECT `machine_id`, `path`, `origin_url`, `repo_name`, `added_at`, `repo_id` FROM `repos`;--> statement-breakpoint
DROP TABLE `repos`;--> statement-breakpoint
ALTER TABLE `__new_repos` RENAME TO `repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY,
	`owner_user_id` text DEFAULT 'user:sole' NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`effort` text,
	`account_id` text,
	`cwd` text NOT NULL,
	`title` text NOT NULL,
	`origin_kind` text NOT NULL,
	`conversation_id` text,
	`resume_kind` text,
	`resume_value` text,
	`status` text NOT NULL,
	`exit_code` integer,
	`spawn_failure` text,
	`durable_label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`name` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`work_state` text,
	`machine_id` text NOT NULL,
	`last_output_at` text,
	`last_input_at` text,
	`last_resumed_at` text,
	`spawned_by` text,
	`headless` integer DEFAULT 0 NOT NULL,
	`issue_id` text,
	`stopped_at` text,
	`stop_reason` text,
	`deleted_at` text,
	`deleted_by_issue_id` text,
	`deletion_source` text,
	`workflow_run_id` text,
	`workflow_step_id` text,
	`execution_profile_id` text,
	`name_source` text,
	`ref_issue_id` text,
	`ref_letter` text,
	`ref_draft` integer,
	`terminal_cols` integer DEFAULT 80 NOT NULL,
	`terminal_rows` integer DEFAULT 24 NOT NULL,
	`working_ms_total` integer,
	`input_count` integer DEFAULT 0 NOT NULL,
	`output_count` integer DEFAULT 0 NOT NULL,
	`activity_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sessions_stop_reason_check" CHECK(stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count`) SELECT `id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_conversations_project_path` ON `conversations` (`project_path`);--> statement-breakpoint
CREATE INDEX `idx_conversations_updated_at` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_by_issue` ON `sessions` (`deleted_by_issue_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_at` ON `sessions` (`deleted_at`);