CREATE TABLE `ship_recovery_revision` (
	`id` integer PRIMARY KEY,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ship_recovery_revision_singleton" CHECK(id = 1)
);

--> statement-breakpoint
INSERT INTO ship_recovery_revision (id, revision) VALUES (1, 0);
