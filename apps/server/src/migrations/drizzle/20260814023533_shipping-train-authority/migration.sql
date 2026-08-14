CREATE TABLE `ship_effect_envelopes` (
	`effect_key` text PRIMARY KEY,
	`train_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_ship_effect_envelopes_train_id_ship_train_manifests_id_fk` FOREIGN KEY (`train_id`) REFERENCES `ship_train_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_effect_envelopes_attempt_id_ship_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `ship_attempts`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `ship_lane_revisions` (
	`lane_key` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ship_train_active_claims` (
	`train_id` text NOT NULL,
	`order_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`generation` integer NOT NULL,
	CONSTRAINT `ship_train_active_claims_pk` PRIMARY KEY(`train_id`, `order_id`),
	CONSTRAINT `fk_ship_train_active_claims_train_id_ship_train_manifests_id_fk` FOREIGN KEY (`train_id`) REFERENCES `ship_train_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_active_claims_member_order` FOREIGN KEY (`train_id`,`order_id`) REFERENCES `ship_train_members`(`train_id`,`order_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_active_claims_member_attempt` FOREIGN KEY (`train_id`,`attempt_id`) REFERENCES `ship_train_members`(`train_id`,`attempt_id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_train_active_claims_generation_check" CHECK(generation > 0)
);
--> statement-breakpoint
ALTER TABLE `ship_orders` ADD `validation_profile` text;--> statement-breakpoint
ALTER TABLE `ship_orders` ADD `validation_profile_digest` text;--> statement-breakpoint
ALTER TABLE `ship_train_manifests` ADD `lane_key` text;--> statement-breakpoint
ALTER TABLE `ship_train_manifests` ADD `lane_revision` integer;--> statement-breakpoint
ALTER TABLE `ship_train_manifests` ADD `member_count` integer;--> statement-breakpoint
UPDATE `ship_train_members`
   SET `released_at` = '2026-08-14T00:00:00.000Z'
 WHERE `released_at` IS NULL;--> statement-breakpoint
UPDATE `ship_train_manifests`
   SET `released_at` = '2026-08-14T00:00:00.000Z',
       `release_reason` = 'protocol-v2-upgrade'
 WHERE `released_at` IS NULL;--> statement-breakpoint
UPDATE `ship_attempts`
   SET `finished_at` = '2026-08-14T00:00:00.000Z', `outcome` = 'failed'
 WHERE `finished_at` IS NULL
   AND `id` IN (SELECT `attempt_id` FROM `ship_train_members`);--> statement-breakpoint
UPDATE `ship_orders`
   SET `state` = 'queued', `state_changed_at` = '2026-08-14T00:00:00.000Z', `hold_code` = NULL
 WHERE `state` = 'preflight'
   AND `id` IN (SELECT `order_id` FROM `ship_train_members`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ship_attempts` (
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
	CONSTRAINT `idx_ship_attempts_id_order` UNIQUE(`id`,`order_id`),
	CONSTRAINT "ship_attempts_generation_check" CHECK(lease_generation >= 0),
	CONSTRAINT "ship_attempts_terminal_pair_check" CHECK((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL)),
	CONSTRAINT "ship_attempts_outcome_check" CHECK(outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ship_attempts_validation_pair_check" CHECK((validation_profile_id IS NULL AND validation_result IS NULL) OR (validation_profile_id IS NOT NULL AND validation_result IS NOT NULL)),
	CONSTRAINT "ship_attempts_validation_result_check" CHECK(validation_result IS NULL OR validation_result IN ('passed', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_ship_attempts`(`id`, `order_id`, `expected_source_base_sha`, `approved_head_sha`, `expected_target_sha`, `machine_id`, `lease_generation`, `started_at`, `finished_at`, `outcome`, `submitted_head_sha`, `tested_integration_sha`, `landed_ref_sha`, `destination_sha`, `validation_profile_id`, `validation_result`) SELECT `id`, `order_id`, `expected_source_base_sha`, `approved_head_sha`, `expected_target_sha`, `machine_id`, `lease_generation`, `started_at`, `finished_at`, `outcome`, `submitted_head_sha`, `tested_integration_sha`, `landed_ref_sha`, `destination_sha`, `validation_profile_id`, `validation_result` FROM `ship_attempts`;--> statement-breakpoint
DROP TABLE `ship_attempts`;--> statement-breakpoint
ALTER TABLE `__new_ship_attempts` RENAME TO `ship_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ship_orders` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`target_branch` text NOT NULL,
	`destination` text NOT NULL,
	`approved_base_sha` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`descendant_manifest` text DEFAULT '[]' NOT NULL,
	`delivery_depends_on` text DEFAULT '[]' NOT NULL,
	`evidence_manifest_ref` text,
	`current_integration_receipt` text,
	`provider_ref` text,
	`requested_by_actor_kind` text NOT NULL,
	`requested_by_actor_id` text NOT NULL,
	`requested_by_on_behalf_of` text,
	`requested_at` text NOT NULL,
	`policy_id` text NOT NULL,
	`validation_profile` text,
	`validation_profile_digest` text,
	`close_mode` text NOT NULL,
	`state` text NOT NULL,
	`state_changed_at` text NOT NULL,
	`hold_code` text,
	CONSTRAINT `fk_ship_orders_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `idx_ship_orders_id_issue` UNIQUE(`id`,`issue_id`),
	CONSTRAINT "ship_orders_state_check" CHECK(state IN ('queued', 'preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying', 'shipped', 'held', 'cancelled')),
	CONSTRAINT "ship_orders_close_mode_check" CHECK(close_mode IN ('after-destination', 'leave-open')),
	CONSTRAINT "ship_orders_hold_code_check" CHECK((state = 'held' AND hold_code IS NOT NULL) OR (state <> 'held' AND hold_code IS NULL)),
	CONSTRAINT "ship_orders_requested_by_actor_kind_check" CHECK(requested_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "ship_orders_requested_by_system_has_no_human_check" CHECK(requested_by_actor_kind <> 'system' OR requested_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_ship_orders`(`id`, `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`, `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`, `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`, `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`, `requested_at`, `policy_id`, `close_mode`, `state`, `state_changed_at`, `hold_code`) SELECT `id`, `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`, `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`, `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`, `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`, `requested_at`, `policy_id`, `close_mode`, `state`, `state_changed_at`, `hold_code` FROM `ship_orders`;--> statement-breakpoint
DROP TABLE `ship_orders`;--> statement-breakpoint
ALTER TABLE `__new_ship_orders` RENAME TO `ship_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ship_train_members` (
	`train_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`issue_id` text NOT NULL,
	`order_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`generation` integer NOT NULL,
	`machine_id` text NOT NULL,
	`source_branch` text NOT NULL,
	`approved_base_sha` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`delivery_depends_on` text NOT NULL,
	`released_at` text,
	CONSTRAINT `ship_train_members_pk` PRIMARY KEY(`train_id`, `ordinal`),
	CONSTRAINT `fk_ship_train_members_train_id_ship_train_manifests_id_fk` FOREIGN KEY (`train_id`) REFERENCES `ship_train_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_members_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_members_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_members_attempt_id_ship_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `ship_attempts`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_members_attempt_order` FOREIGN KEY (`attempt_id`,`order_id`) REFERENCES `ship_attempts`(`id`,`order_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_members_order_issue` FOREIGN KEY (`order_id`,`issue_id`) REFERENCES `ship_orders`(`id`,`issue_id`) ON DELETE RESTRICT,
	CONSTRAINT `idx_ship_train_members_order` UNIQUE(`train_id`,`order_id`),
	CONSTRAINT `idx_ship_train_members_issue` UNIQUE(`train_id`,`issue_id`),
	CONSTRAINT `idx_ship_train_members_attempt` UNIQUE(`train_id`,`attempt_id`),
	CONSTRAINT `idx_ship_train_members_source` UNIQUE(`train_id`,`source_branch`),
	CONSTRAINT "ship_train_members_ordinal_check" CHECK(ordinal >= 0),
	CONSTRAINT "ship_train_members_generation_check" CHECK(generation > 0)
);
--> statement-breakpoint
INSERT INTO `__new_ship_train_members`(`train_id`, `ordinal`, `issue_id`, `order_id`, `attempt_id`, `generation`, `machine_id`, `source_branch`, `approved_base_sha`, `approved_head_sha`, `delivery_depends_on`, `released_at`) SELECT `train_id`, `ordinal`, `issue_id`, `order_id`, `attempt_id`, `generation`, `machine_id`, `source_branch`, `approved_base_sha`, `approved_head_sha`, `delivery_depends_on`, `released_at` FROM `ship_train_members`;--> statement-breakpoint
DROP TABLE `ship_train_members`;--> statement-breakpoint
ALTER TABLE `__new_ship_train_members` RENAME TO `ship_train_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_ship_attempts_order` ON `ship_attempts` (`order_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_ship_orders_issue` ON `ship_orders` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_ship_orders_lane` ON `ship_orders` (`repo_id`,`destination`,`requested_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_orders_one_active_issue` ON `ship_orders` (`issue_id`) WHERE state NOT IN ('shipped', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_members_attempt_global` ON `ship_train_members` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_members_one_active_order` ON `ship_train_members` (`order_id`) WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ship_train_members_live_custody` ON `ship_train_members` (`order_id`,`attempt_id`,`generation`,`released_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_effect_envelopes_attempt_effect` ON `ship_effect_envelopes` (`attempt_id`,`effect_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_active_claims_order` ON `ship_train_active_claims` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_active_claims_attempt` ON `ship_train_active_claims` (`attempt_id`);--> statement-breakpoint
DROP INDEX `idx_ship_train_members_one_active_order`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `ship_train_members_release_only`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `ship_train_manifests_release_only`;--> statement-breakpoint
CREATE TRIGGER `ship_orders_frozen_fields` BEFORE UPDATE OF
  `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`,
  `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`,
  `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`,
  `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`,
  `requested_at`, `policy_id`, `validation_profile`, `validation_profile_digest`, `close_mode`
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
CREATE TRIGGER `ship_train_manifests_release_only`
BEFORE UPDATE ON `ship_train_manifests`
WHEN OLD.`released_at` IS NOT NULL
  OR NEW.`released_at` IS NULL
  OR OLD.`id` IS NOT NEW.`id`
  OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`subset_id` IS NOT NEW.`subset_id`
  OR OLD.`repair_round` IS NOT NEW.`repair_round`
  OR OLD.`canonical_digest` IS NOT NEW.`canonical_digest`
  OR OLD.`canonical_json` IS NOT NEW.`canonical_json`
  OR OLD.`repo_id` IS NOT NEW.`repo_id`
  OR OLD.`repo_path` IS NOT NEW.`repo_path`
  OR OLD.`machine_id` IS NOT NEW.`machine_id`
  OR OLD.`lane_key` IS NOT NEW.`lane_key`
  OR OLD.`lane_revision` IS NOT NEW.`lane_revision`
  OR OLD.`target_branch` IS NOT NEW.`target_branch`
  OR OLD.`expected_target_sha` IS NOT NEW.`expected_target_sha`
  OR OLD.`destination` IS NOT NEW.`destination`
  OR OLD.`provider_ref` IS NOT NEW.`provider_ref`
  OR OLD.`policy_id` IS NOT NEW.`policy_id`
  OR OLD.`validation_profile` IS NOT NEW.`validation_profile`
  OR OLD.`validation_profile_digest` IS NOT NEW.`validation_profile_digest`
  OR OLD.`member_count` IS NOT NEW.`member_count`
  OR OLD.`leader_order_id` IS NOT NEW.`leader_order_id`
  OR OLD.`leader_attempt_id` IS NOT NEW.`leader_attempt_id`
  OR OLD.`leader_generation` IS NOT NEW.`leader_generation`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'ship train manifest is immutable except for one release');
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_members_update_immutable`
BEFORE UPDATE ON `ship_train_members`
BEGIN
  SELECT RAISE(ABORT, 'ship train member is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_members_delete_immutable`
BEFORE DELETE ON `ship_train_members`
BEGIN
  SELECT RAISE(ABORT, 'ship train member history is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_members_final_leader`
AFTER INSERT ON `ship_train_members`
WHEN NEW.`ordinal` + 1 = (SELECT `member_count` FROM `ship_train_manifests` WHERE `id` = NEW.`train_id`)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `ship_train_manifests` m
     WHERE m.`id` = NEW.`train_id`
       AND m.`leader_order_id` = NEW.`order_id`
       AND m.`leader_attempt_id` = NEW.`attempt_id`
       AND m.`leader_generation` = NEW.`generation`
  ) THEN RAISE(ABORT, 'ship train final member must be its leader') END;
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_active_claims_insert_guard`
BEFORE INSERT ON `ship_train_active_claims`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `ship_train_manifests` m
    JOIN `ship_train_members` tm ON tm.`train_id` = m.`id`
     WHERE m.`id` = NEW.`train_id` AND m.`released_at` IS NULL
       AND tm.`order_id` = NEW.`order_id` AND tm.`attempt_id` = NEW.`attempt_id`
       AND tm.`generation` = NEW.`generation`
  ) THEN RAISE(ABORT, 'active train claim must match an unreleased member') END;
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_active_claims_update_immutable`
BEFORE UPDATE ON `ship_train_active_claims`
BEGIN
  SELECT RAISE(ABORT, 'active train claim is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_active_claims_release_guard`
BEFORE DELETE ON `ship_train_active_claims`
WHEN EXISTS (SELECT 1 FROM `ship_train_manifests` m WHERE m.`id` = OLD.`train_id` AND m.`released_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active train claims release manifest-wide only');
END;--> statement-breakpoint
CREATE TRIGGER `ship_effect_envelopes_update_immutable`
BEFORE UPDATE ON `ship_effect_envelopes`
BEGIN
  SELECT RAISE(ABORT, 'ship effect envelope is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ship_effect_envelopes_delete_immutable`
BEFORE DELETE ON `ship_effect_envelopes`
BEGIN
  SELECT RAISE(ABORT, 'ship effect envelope is immutable');
END;
