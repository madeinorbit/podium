CREATE TABLE `conversation_segment_incarnations` (
	`machine_id` text NOT NULL,
	`native_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`device` text NOT NULL,
	`inode` text NOT NULL,
	`mirrored_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	CONSTRAINT `conversation_segment_incarnations_pk` PRIMARY KEY(`machine_id`, `native_id`, `sequence`)
);
--> statement-breakpoint
CREATE INDEX `conversation_segment_incarnations_native` ON `conversation_segment_incarnations` (`machine_id`,`native_id`,`sequence`);