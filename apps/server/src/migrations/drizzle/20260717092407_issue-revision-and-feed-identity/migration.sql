CREATE TABLE `sync_feed` (
	`id` integer PRIMARY KEY,
	`feed_id` text NOT NULL,
	`epoch` text NOT NULL,
	CONSTRAINT "sync_feed_check_1" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `issues` ADD `revision` integer DEFAULT 1 NOT NULL;