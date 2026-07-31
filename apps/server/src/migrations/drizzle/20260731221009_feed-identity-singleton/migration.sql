PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feed_identity` (
	`singleton` integer PRIMARY KEY,
	`feed_id` text NOT NULL,
	`epoch` text NOT NULL,
	`minted_at` integer NOT NULL,
	CONSTRAINT "feed_identity_singleton" CHECK("singleton" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_feed_identity`(`singleton`, `feed_id`, `epoch`, `minted_at`) SELECT `singleton`, `feed_id`, `epoch`, `minted_at` FROM `feed_identity`;--> statement-breakpoint
DROP TABLE `feed_identity`;--> statement-breakpoint
ALTER TABLE `__new_feed_identity` RENAME TO `feed_identity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;