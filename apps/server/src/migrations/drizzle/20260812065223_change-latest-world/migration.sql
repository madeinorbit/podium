CREATE TABLE `change_latest` (
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`seq` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `change_latest_pk` PRIMARY KEY(`entity`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `change_latest_seq` ON `change_latest` (`seq`);