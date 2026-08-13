CREATE TABLE `delivery_receipts` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`approved_base_sha` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`tested_integration_sha` text NOT NULL,
	`landed_ref_sha` text NOT NULL,
	`destination_sha` text NOT NULL,
	`validation_profile_id` text NOT NULL,
	`validation_result` text NOT NULL,
	`destination` text NOT NULL,
	`completed_at` text NOT NULL,
	CONSTRAINT `fk_delivery_receipts_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "delivery_receipts_validation_result_check" CHECK(validation_result = 'passed')
);
--> statement-breakpoint
CREATE TABLE `ship_attempts` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`expected_source_base_sha` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`expected_target_sha` text NOT NULL,
	`machine_id` text NOT NULL,
	`lease_generation` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text,
	`submitted_head_sha` text NOT NULL,
	`tested_integration_sha` text,
	`landed_ref_sha` text,
	`destination_sha` text,
	`validation_profile_id` text,
	`validation_result` text,
	CONSTRAINT `fk_ship_attempts_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_attempts_generation_check" CHECK(lease_generation >= 0),
	CONSTRAINT "ship_attempts_terminal_pair_check" CHECK((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL)),
	CONSTRAINT "ship_attempts_outcome_check" CHECK(outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ship_attempts_validation_pair_check" CHECK((validation_profile_id IS NULL AND validation_result IS NULL) OR (validation_profile_id IS NOT NULL AND validation_result IS NOT NULL)),
	CONSTRAINT "ship_attempts_validation_result_check" CHECK(validation_result IS NULL OR validation_result IN ('passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `ship_holds` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`generation` integer NOT NULL,
	`reason_code` text NOT NULL,
	`headline` text NOT NULL,
	`detail` text NOT NULL,
	`evidence_refs` text DEFAULT '[]' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`raised_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	CONSTRAINT `fk_ship_holds_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_holds_generation_check" CHECK(generation > 0),
	CONSTRAINT "ship_holds_resolution_pair_check" CHECK((resolved_at IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `ship_orders` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`target_branch` text NOT NULL,
	`destination` text NOT NULL,
	`approved_base_sha` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`descendant_manifest` text DEFAULT '[]' NOT NULL,
	`delivery_depends_on` text DEFAULT '[]' NOT NULL,
	`provider_ref` text,
	`requested_by_actor_kind` text NOT NULL,
	`requested_by_actor_id` text NOT NULL,
	`requested_by_on_behalf_of` text,
	`requested_at` text NOT NULL,
	`policy_id` text NOT NULL,
	`close_mode` text NOT NULL,
	`state` text NOT NULL,
	`state_changed_at` text NOT NULL,
	`hold_code` text,
	CONSTRAINT `fk_ship_orders_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_orders_state_check" CHECK(state IN ('queued', 'preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying', 'shipped', 'held', 'cancelled')),
	CONSTRAINT "ship_orders_close_mode_check" CHECK(close_mode IN ('after-destination', 'leave-open')),
	CONSTRAINT "ship_orders_hold_code_check" CHECK((state = 'held' AND hold_code IS NOT NULL) OR (state <> 'held' AND hold_code IS NULL)),
	CONSTRAINT "ship_orders_requested_by_actor_kind_check" CHECK(requested_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "ship_orders_requested_by_system_has_no_human_check" CHECK(requested_by_actor_kind <> 'system' OR requested_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE TABLE `ship_steps` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`effect_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`generation` integer NOT NULL,
	`input_fence` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	`summary` text NOT NULL,
	`artifact_ref` text,
	`recorded_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `fk_ship_steps_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_steps_attempt_id_ship_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `ship_attempts`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_steps_generation_check" CHECK(generation >= 0),
	CONSTRAINT "ship_steps_state_check" CHECK(state IN ('planned', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ship_steps_lifecycle_check" CHECK((state = 'planned' AND started_at IS NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state IN ('succeeded', 'failed', 'cancelled') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND outcome IS NOT NULL))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
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
	`started_by_session` text,
	CONSTRAINT `fk_issues_parent_id_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_superseded_by_issues_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_duplicate_of_issues_id_fk` FOREIGN KEY (`duplicate_of`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT "issues_check_1" CHECK(stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK(priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK(type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`(`id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session`) SELECT `id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session` FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_issues_deleted_at` ON `issues` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_issues_closed_projection` ON `issues` (`id`,`stage`,`closed_reason`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issues_repo_id_seq` ON `issues` (`repo_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_issues_parent` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_repo` ON `issues` (`repo_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delivery_receipts_order` ON `delivery_receipts` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_ship_attempts_order` ON `ship_attempts` (`order_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_holds_order_generation` ON `ship_holds` (`order_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_holds_one_open_order` ON `ship_holds` (`order_id`) WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ship_orders_issue` ON `ship_orders` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_ship_orders_lane` ON `ship_orders` (`repo_id`,`destination`,`requested_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_orders_one_active_issue` ON `ship_orders` (`issue_id`) WHERE state NOT IN ('shipped', 'cancelled');--> statement-breakpoint
CREATE INDEX `idx_ship_steps_order` ON `ship_steps` (`order_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_ship_steps_effect` ON `ship_steps` (`attempt_id`,`effect_key`,`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_steps_attempt_idempotency` ON `ship_steps` (`attempt_id`,`idempotency_key`);--> statement-breakpoint
CREATE TRIGGER `ship_orders_frozen_fields` BEFORE UPDATE OF
  `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`,
  `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`, `provider_ref`,
  `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`,
  `requested_at`, `policy_id`, `close_mode`
ON `ship_orders`
BEGIN
  SELECT RAISE(ABORT, 'ship order approval is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_orders_terminal_immutable` BEFORE UPDATE ON `ship_orders`
WHEN OLD.`state` IN ('shipped', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal ship order is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_orders_delete_immutable` BEFORE DELETE ON `ship_orders`
BEGIN
  SELECT RAISE(ABORT, 'ship order history is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_attempts_terminal_immutable` BEFORE UPDATE ON `ship_attempts`
WHEN OLD.`finished_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'terminal ship attempt is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_attempts_delete_immutable` BEFORE DELETE ON `ship_attempts`
BEGIN
  SELECT RAISE(ABORT, 'ship attempt history is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_steps_update_immutable` BEFORE UPDATE ON `ship_steps`
BEGIN
  SELECT RAISE(ABORT, 'ship steps are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ship_steps_delete_immutable` BEFORE DELETE ON `ship_steps`
BEGIN
  SELECT RAISE(ABORT, 'ship steps are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ship_holds_resolved_immutable` BEFORE UPDATE ON `ship_holds`
WHEN OLD.`resolved_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'resolved ship hold is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_holds_delete_immutable` BEFORE DELETE ON `ship_holds`
BEGIN
  SELECT RAISE(ABORT, 'ship hold history is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `delivery_receipts_update_immutable` BEFORE UPDATE ON `delivery_receipts`
BEGIN
  SELECT RAISE(ABORT, 'delivery receipt is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `delivery_receipts_delete_immutable` BEFORE DELETE ON `delivery_receipts`
BEGIN
  SELECT RAISE(ABORT, 'delivery receipt is immutable');
END;
