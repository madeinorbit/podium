CREATE TABLE `ship_repair_candidates` (
	`order_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`round` integer NOT NULL,
	`context_digest` text NOT NULL,
	`repair_ref` text NOT NULL,
	`candidate_head_sha` text NOT NULL,
	`result_token` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `ship_repair_candidates_pk` PRIMARY KEY(`attempt_id`, `sequence`),
	CONSTRAINT `fk_ship_repair_candidates_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_repair_candidates_attempt_id_ship_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `ship_attempts`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_ship_repair_candidates_attempt_order` FOREIGN KEY (`attempt_id`,`order_id`) REFERENCES `ship_attempts`(`id`,`order_id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_repair_candidates_generation_check" CHECK(generation > 0),
	CONSTRAINT "ship_repair_candidates_sequence_check" CHECK(sequence > 0 AND round = sequence),
	CONSTRAINT "ship_repair_candidates_context_check" CHECK(length(context_digest) = 64 AND context_digest NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ship_repair_candidates_ref` ON `ship_repair_candidates` (`repair_ref`);
--> statement-breakpoint
CREATE TRIGGER `ship_repair_candidates_update_immutable`
BEFORE UPDATE ON `ship_repair_candidates`
BEGIN SELECT RAISE(ABORT, 'ship repair candidate is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `ship_repair_candidates_delete_immutable`
BEFORE DELETE ON `ship_repair_candidates`
BEGIN SELECT RAISE(ABORT, 'ship repair candidate history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `ship_train_members_insert_guard`
BEFORE INSERT ON `ship_train_members`
BEGIN
  SELECT CASE WHEN NEW.`ordinal` >= (
    SELECT `member_count` FROM `ship_train_manifests` WHERE `id` = NEW.`train_id`
  ) THEN RAISE(ABORT, 'ship train member ordinal exceeds immutable member count') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `ship_train_active_claims` WHERE `train_id` = NEW.`train_id`
  ) THEN RAISE(ABORT, 'ship train members are sealed after active claim') END;
END;
