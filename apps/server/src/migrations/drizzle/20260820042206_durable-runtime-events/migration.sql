CREATE TABLE `runtime_event_checkpoints` (
	`session_id` text PRIMARY KEY,
	`observer_generation` integer NOT NULL,
	`cursor_json` text NOT NULL,
	`turn_epoch` integer NOT NULL,
	`closed_turn_epoch` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runtime_event_projection_cursors` (
	`projector` text PRIMARY KEY,
	`last_event_id` integer NOT NULL,
	`updated_at` text NOT NULL
);
