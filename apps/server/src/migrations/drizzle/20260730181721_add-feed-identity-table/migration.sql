CREATE TABLE `feed_identity` (
	`singleton` integer PRIMARY KEY,
	`feed_id` text NOT NULL,
	`epoch` text NOT NULL,
	`minted_at` integer NOT NULL
);
