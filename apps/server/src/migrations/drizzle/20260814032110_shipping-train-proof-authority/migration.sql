PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_delivery_receipts` (
  `id` text PRIMARY KEY,
  `order_id` text NOT NULL,
  `approved_base_sha` text NOT NULL,
  `approved_head_sha` text NOT NULL,
  `result_commit_sha` text NOT NULL,
  `tested_integration_sha` text NOT NULL,
  `landed_ref_sha` text NOT NULL,
  `destination_sha` text NOT NULL,
  `validation_profile_id` text NOT NULL,
  `validation_result` text NOT NULL,
  `destination` text NOT NULL,
  `completed_at` text NOT NULL,
  CONSTRAINT `fk_delivery_receipts_order_id_ship_orders_id_fk`
    FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `delivery_receipts_validation_result_check` CHECK(validation_result = 'passed')
);--> statement-breakpoint
INSERT INTO `__new_delivery_receipts`
  (`id`, `order_id`, `approved_base_sha`, `approved_head_sha`, `result_commit_sha`,
   `tested_integration_sha`, `landed_ref_sha`, `destination_sha`,
   `validation_profile_id`, `validation_result`, `destination`, `completed_at`)
SELECT `id`, `order_id`, `approved_base_sha`, `approved_head_sha`, `landed_ref_sha`,
       `tested_integration_sha`, `landed_ref_sha`, `destination_sha`,
       `validation_profile_id`, `validation_result`, `destination`, `completed_at`
  FROM `delivery_receipts`;--> statement-breakpoint
DROP TABLE `delivery_receipts`;--> statement-breakpoint
ALTER TABLE `__new_delivery_receipts` RENAME TO `delivery_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delivery_receipts_order` ON `delivery_receipts` (`order_id`);--> statement-breakpoint
CREATE TRIGGER `delivery_receipts_update_immutable` BEFORE UPDATE ON `delivery_receipts`
BEGIN SELECT RAISE(ABORT, 'delivery receipt is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `delivery_receipts_delete_immutable` BEFORE DELETE ON `delivery_receipts`
BEGIN SELECT RAISE(ABORT, 'delivery receipt is immutable'); END;--> statement-breakpoint
ALTER TABLE `ship_orders` ADD `repo_path` text;--> statement-breakpoint
ALTER TABLE `ship_orders` ADD `machine_id` text;--> statement-breakpoint
UPDATE `ship_orders`
   SET `repo_path` = (SELECT i.`repo_path` FROM `issues` i WHERE i.`id` = `ship_orders`.`issue_id`),
       `machine_id` = (SELECT i.`machine_id` FROM `issues` i WHERE i.`id` = `ship_orders`.`issue_id`)
 WHERE `repo_path` IS NULL OR `machine_id` IS NULL;--> statement-breakpoint
UPDATE `ship_orders`
   SET `repo_path` = NULL, `machine_id` = NULL
 WHERE (`repo_path` IS NULL) <> (`machine_id` IS NULL);--> statement-breakpoint
DROP TRIGGER `ship_train_manifests_release_only`;--> statement-breakpoint
UPDATE `ship_train_manifests`
   SET `repo_path` = COALESCE(
         `repo_path`,
         (SELECT so.`repo_path` FROM `ship_orders` so WHERE so.`id` = `ship_train_manifests`.`leader_order_id`),
         '<legacy-released>'
       ),
       `machine_id` = COALESCE(
         `machine_id`,
         (SELECT so.`machine_id` FROM `ship_orders` so WHERE so.`id` = `ship_train_manifests`.`leader_order_id`),
         'machine:legacy-released'
       ),
       `lane_key` = COALESCE(`lane_key`, '0000000000000000000000000000000000000000000000000000000000000000'),
       `lane_revision` = COALESCE(`lane_revision`, 1),
       `validation_profile_digest` = COALESCE(`validation_profile_digest`, '0000000000000000000000000000000000000000000000000000000000000000'),
       `member_count` = COALESCE(`member_count`, (SELECT COUNT(*) FROM `ship_train_members` tm WHERE tm.`train_id` = `ship_train_manifests`.`id`));--> statement-breakpoint
DROP TRIGGER `ship_train_members_final_leader`;--> statement-breakpoint
DROP TRIGGER `ship_train_active_claims_insert_guard`;--> statement-breakpoint
DROP TRIGGER `ship_train_active_claims_release_guard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ship_train_manifests` (
	`id` text PRIMARY KEY,
	`version` integer NOT NULL,
	`subset_id` text NOT NULL,
	`repair_round` integer NOT NULL,
	`canonical_digest` text NOT NULL,
	`canonical_json` text NOT NULL,
	`repo_id` text NOT NULL,
	`repo_path` text NOT NULL,
	`machine_id` text NOT NULL,
	`lane_key` text NOT NULL,
	`lane_revision` integer NOT NULL,
	`target_branch` text NOT NULL,
	`expected_target_sha` text NOT NULL,
	`destination` text NOT NULL,
	`provider_ref` text,
	`policy_id` text NOT NULL,
	`validation_profile` text NOT NULL,
	`validation_profile_digest` text NOT NULL,
	`member_count` integer NOT NULL,
	`leader_order_id` text NOT NULL,
	`leader_attempt_id` text NOT NULL,
	`leader_generation` integer NOT NULL,
	`created_at` text NOT NULL,
	`released_at` text,
	`release_reason` text,
	CONSTRAINT `fk_ship_train_manifests_leader_order_id_ship_orders_id_fk` FOREIGN KEY (`leader_order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_train_manifests_leader_attempt_id_ship_attempts_id_fk` FOREIGN KEY (`leader_attempt_id`) REFERENCES `ship_attempts`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_train_manifests_version_check" CHECK(version = 1),
	CONSTRAINT "ship_train_manifests_repair_round_check" CHECK(repair_round = 0),
	CONSTRAINT "ship_train_manifests_generation_check" CHECK(leader_generation > 0),
	CONSTRAINT "ship_train_manifests_lane_revision_check" CHECK(lane_revision > 0),
	CONSTRAINT "ship_train_manifests_member_count_check" CHECK(member_count > 0),
	CONSTRAINT "ship_train_manifests_release_pair_check" CHECK((released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_ship_train_manifests`(`id`, `version`, `subset_id`, `repair_round`, `canonical_digest`, `canonical_json`, `repo_id`, `repo_path`, `machine_id`, `lane_key`, `lane_revision`, `target_branch`, `expected_target_sha`, `destination`, `provider_ref`, `policy_id`, `validation_profile`, `validation_profile_digest`, `member_count`, `leader_order_id`, `leader_attempt_id`, `leader_generation`, `created_at`, `released_at`, `release_reason`) SELECT `id`, `version`, `subset_id`, `repair_round`, `canonical_digest`, `canonical_json`, `repo_id`, `repo_path`, `machine_id`, `lane_key`, `lane_revision`, `target_branch`, `expected_target_sha`, `destination`, `provider_ref`, `policy_id`, `validation_profile`, `validation_profile_digest`, `member_count`, `leader_order_id`, `leader_attempt_id`, `leader_generation`, `created_at`, `released_at`, `release_reason` FROM `ship_train_manifests`;--> statement-breakpoint
DROP TABLE `ship_train_manifests`;--> statement-breakpoint
ALTER TABLE `__new_ship_train_manifests` RENAME TO `ship_train_manifests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_manifests_subset` ON `ship_train_manifests` (`subset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_manifests_digest` ON `ship_train_manifests` (`canonical_digest`);--> statement-breakpoint
CREATE INDEX `idx_ship_train_manifests_leader` ON `ship_train_manifests` (`leader_order_id`,`leader_attempt_id`,`leader_generation`,`released_at`);
--> statement-breakpoint
CREATE TRIGGER `ship_train_manifests_release_only`
BEFORE UPDATE ON `ship_train_manifests`
WHEN OLD.`released_at` IS NOT NULL OR NEW.`released_at` IS NULL
  OR OLD.`id` IS NOT NEW.`id` OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`subset_id` IS NOT NEW.`subset_id` OR OLD.`repair_round` IS NOT NEW.`repair_round`
  OR OLD.`canonical_digest` IS NOT NEW.`canonical_digest` OR OLD.`canonical_json` IS NOT NEW.`canonical_json`
  OR OLD.`repo_id` IS NOT NEW.`repo_id` OR OLD.`repo_path` IS NOT NEW.`repo_path`
  OR OLD.`machine_id` IS NOT NEW.`machine_id` OR OLD.`lane_key` IS NOT NEW.`lane_key`
  OR OLD.`lane_revision` IS NOT NEW.`lane_revision` OR OLD.`target_branch` IS NOT NEW.`target_branch`
  OR OLD.`expected_target_sha` IS NOT NEW.`expected_target_sha` OR OLD.`destination` IS NOT NEW.`destination`
  OR OLD.`provider_ref` IS NOT NEW.`provider_ref` OR OLD.`policy_id` IS NOT NEW.`policy_id`
  OR OLD.`validation_profile` IS NOT NEW.`validation_profile`
  OR OLD.`validation_profile_digest` IS NOT NEW.`validation_profile_digest`
  OR OLD.`member_count` IS NOT NEW.`member_count` OR OLD.`leader_order_id` IS NOT NEW.`leader_order_id`
  OR OLD.`leader_attempt_id` IS NOT NEW.`leader_attempt_id` OR OLD.`leader_generation` IS NOT NEW.`leader_generation`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN SELECT RAISE(ABORT, 'ship train manifest is immutable except for one release'); END;--> statement-breakpoint
CREATE TRIGGER `ship_train_manifests_delete_immutable`
BEFORE DELETE ON `ship_train_manifests`
BEGIN SELECT RAISE(ABORT, 'ship train manifest history is immutable'); END;--> statement-breakpoint
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
CREATE TRIGGER `ship_orders_lane_custody_insert`
BEFORE INSERT ON `ship_orders`
WHEN NEW.`repo_path` IS NULL OR NEW.`machine_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'new ship order requires frozen lane custody'); END;--> statement-breakpoint
CREATE TRIGGER `ship_orders_lane_custody_immutable`
BEFORE UPDATE OF `repo_path`, `machine_id` ON `ship_orders`
BEGIN SELECT RAISE(ABORT, 'ship order lane custody is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ship_train_active_claims_insert_guard`
BEFORE INSERT ON `ship_train_active_claims`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `ship_train_manifests` m
    JOIN `ship_train_members` tm ON tm.`train_id` = m.`id`
     WHERE m.`id` = NEW.`train_id` AND m.`released_at` IS NULL
       AND tm.`order_id` = NEW.`order_id` AND tm.`attempt_id` = NEW.`attempt_id`
       AND tm.`generation` = NEW.`generation`
       AND (SELECT COUNT(*) FROM `ship_train_members` all_members
             WHERE all_members.`train_id` = m.`id`) = m.`member_count`
       AND EXISTS (
         SELECT 1 FROM `ship_train_members` leader
          WHERE leader.`train_id` = m.`id`
            AND leader.`ordinal` = m.`member_count` - 1
            AND leader.`order_id` = m.`leader_order_id`
            AND leader.`attempt_id` = m.`leader_attempt_id`
            AND leader.`generation` = m.`leader_generation`
       )
       AND NOT EXISTS (
         SELECT 1 FROM `ship_train_members` generation_member
          WHERE generation_member.`train_id` = m.`id`
            AND generation_member.`generation` <= 0
       )
  ) THEN RAISE(ABORT, 'active train claim requires complete normalized leader authority') END;
END;--> statement-breakpoint
CREATE TRIGGER `ship_train_active_claims_release_guard`
BEFORE DELETE ON `ship_train_active_claims`
WHEN EXISTS (SELECT 1 FROM `ship_train_manifests` m WHERE m.`id` = OLD.`train_id` AND m.`released_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active train claims release manifest-wide only');
END;
