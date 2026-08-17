CREATE TABLE `operations` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`exclusion_group` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_operations_group_state` ON `operations` (`exclusion_group`,`state`);--> statement-breakpoint
CREATE INDEX `idx_operations_kind_created` ON `operations` (`kind`,`created_at`);