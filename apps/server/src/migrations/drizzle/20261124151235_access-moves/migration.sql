CREATE TABLE `sync_access_moves` (
	`workspace_id` text NOT NULL,
	`human_id` text NOT NULL,
	`seq` integer NOT NULL,
	CONSTRAINT `sync_access_moves_pk` PRIMARY KEY(`workspace_id`, `human_id`)
);
--> statement-breakpoint
-- POD-7552: recording starts at each feed's head. A cursor below it predates the table, and
-- the server cannot tell what moved before it: such a refused resume is answered as a rescope.
INSERT INTO `sync_access_moves` (`workspace_id`, `human_id`, `seq`)
SELECT `workspace_id`, '', `head_seq` FROM `sync_feed`;
