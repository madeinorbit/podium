CREATE TABLE `sync_capture` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`source` integer NOT NULL,
	`op` text NOT NULL,
	`old_key` text,
	`new_key` text,
	`undrained` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_sync_capture_undrained_sync_capture_guard_id_fk` FOREIGN KEY (`undrained`) REFERENCES `sync_capture_guard`(`id`) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE `sync_capture_guard` (
	`id` integer PRIMARY KEY
);
