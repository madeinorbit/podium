CREATE TABLE `ship_order_stack_edges` (
	`upper_order_id` text NOT NULL,
	`lower_order_id` text NOT NULL,
	`upper_approved_head_sha` text NOT NULL,
	`lower_approved_head_sha` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `ship_order_stack_edges_pk` PRIMARY KEY(`upper_order_id`, `lower_order_id`),
	CONSTRAINT `fk_ship_order_stack_edges_upper_order_id_ship_orders_id_fk` FOREIGN KEY (`upper_order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_order_stack_edges_lower_order_id_ship_orders_id_fk` FOREIGN KEY (`lower_order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_order_stack_edges_distinct_check" CHECK(upper_order_id <> lower_order_id)
);
--> statement-breakpoint
CREATE TABLE `ship_train_manifests` (
	`id` text PRIMARY KEY,
	`version` integer NOT NULL,
	`subset_id` text NOT NULL,
	`repair_round` integer NOT NULL,
	`canonical_digest` text NOT NULL,
	`canonical_json` text NOT NULL,
	`repo_id` text NOT NULL,
	`target_branch` text NOT NULL,
	`expected_target_sha` text NOT NULL,
	`destination` text NOT NULL,
	`provider_ref` text,
	`policy_id` text NOT NULL,
	`validation_profile` text NOT NULL,
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
	CONSTRAINT "ship_train_manifests_release_pair_check" CHECK((released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `ship_train_members` (
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
	CONSTRAINT `idx_ship_train_members_order` UNIQUE(`train_id`,`order_id`),
	CONSTRAINT `idx_ship_train_members_issue` UNIQUE(`train_id`,`issue_id`),
	CONSTRAINT `idx_ship_train_members_attempt` UNIQUE(`train_id`,`attempt_id`),
	CONSTRAINT `idx_ship_train_members_source` UNIQUE(`train_id`,`source_branch`),
	CONSTRAINT "ship_train_members_ordinal_check" CHECK(ordinal >= 0),
	CONSTRAINT "ship_train_members_generation_check" CHECK(generation > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_ship_order_stack_edges_lower` ON `ship_order_stack_edges` (`lower_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_manifests_subset` ON `ship_train_manifests` (`subset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_manifests_digest` ON `ship_train_manifests` (`canonical_digest`);--> statement-breakpoint
CREATE INDEX `idx_ship_train_manifests_leader` ON `ship_train_manifests` (`leader_order_id`,`leader_attempt_id`,`leader_generation`,`released_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_members_attempt_global` ON `ship_train_members` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_train_members_one_active_order` ON `ship_train_members` (`order_id`) WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ship_train_members_live_custody` ON `ship_train_members` (`order_id`,`attempt_id`,`generation`,`released_at`);
--> statement-breakpoint
CREATE TRIGGER `ship_order_stack_edges_update_immutable`
BEFORE UPDATE ON `ship_order_stack_edges`
BEGIN
  SELECT RAISE(ABORT, 'ship order stack edge is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ship_order_stack_edges_delete_immutable`
BEFORE DELETE ON `ship_order_stack_edges`
BEGIN
  SELECT RAISE(ABORT, 'ship order stack edge is immutable');
END;
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
  OR OLD.`target_branch` IS NOT NEW.`target_branch`
  OR OLD.`expected_target_sha` IS NOT NEW.`expected_target_sha`
  OR OLD.`destination` IS NOT NEW.`destination`
  OR OLD.`provider_ref` IS NOT NEW.`provider_ref`
  OR OLD.`policy_id` IS NOT NEW.`policy_id`
  OR OLD.`validation_profile` IS NOT NEW.`validation_profile`
  OR OLD.`leader_order_id` IS NOT NEW.`leader_order_id`
  OR OLD.`leader_attempt_id` IS NOT NEW.`leader_attempt_id`
  OR OLD.`leader_generation` IS NOT NEW.`leader_generation`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'ship train manifest is immutable except for one release');
END;
--> statement-breakpoint
CREATE TRIGGER `ship_train_manifests_delete_immutable`
BEFORE DELETE ON `ship_train_manifests`
BEGIN
  SELECT RAISE(ABORT, 'ship train manifest history is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ship_train_members_release_only`
BEFORE UPDATE ON `ship_train_members`
WHEN OLD.`released_at` IS NOT NULL
  OR NEW.`released_at` IS NULL
  OR OLD.`train_id` IS NOT NEW.`train_id`
  OR OLD.`ordinal` IS NOT NEW.`ordinal`
  OR OLD.`issue_id` IS NOT NEW.`issue_id`
  OR OLD.`order_id` IS NOT NEW.`order_id`
  OR OLD.`attempt_id` IS NOT NEW.`attempt_id`
  OR OLD.`generation` IS NOT NEW.`generation`
  OR OLD.`machine_id` IS NOT NEW.`machine_id`
  OR OLD.`source_branch` IS NOT NEW.`source_branch`
  OR OLD.`approved_base_sha` IS NOT NEW.`approved_base_sha`
  OR OLD.`approved_head_sha` IS NOT NEW.`approved_head_sha`
  OR OLD.`delivery_depends_on` IS NOT NEW.`delivery_depends_on`
BEGIN
  SELECT RAISE(ABORT, 'ship train member is immutable except for one release');
END;
--> statement-breakpoint
CREATE TRIGGER `ship_train_members_delete_immutable`
BEFORE DELETE ON `ship_train_members`
BEGIN
  SELECT RAISE(ABORT, 'ship train member history is immutable');
END;
