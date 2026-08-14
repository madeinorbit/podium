ALTER TABLE `ship_train_manifests` ADD `repo_path` text;--> statement-breakpoint
ALTER TABLE `ship_train_manifests` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `ship_train_manifests` ADD `validation_profile_digest` text;
--> statement-breakpoint
DROP TRIGGER `ship_train_manifests_release_only`;
--> statement-breakpoint
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
  OR OLD.`target_branch` IS NOT NEW.`target_branch`
  OR OLD.`expected_target_sha` IS NOT NEW.`expected_target_sha`
  OR OLD.`destination` IS NOT NEW.`destination`
  OR OLD.`provider_ref` IS NOT NEW.`provider_ref`
  OR OLD.`policy_id` IS NOT NEW.`policy_id`
  OR OLD.`validation_profile` IS NOT NEW.`validation_profile`
  OR OLD.`validation_profile_digest` IS NOT NEW.`validation_profile_digest`
  OR OLD.`leader_order_id` IS NOT NEW.`leader_order_id`
  OR OLD.`leader_attempt_id` IS NOT NEW.`leader_attempt_id`
  OR OLD.`leader_generation` IS NOT NEW.`leader_generation`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'ship train manifest is immutable except for one release');
END;
