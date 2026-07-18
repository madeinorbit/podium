CREATE TABLE `session_observation_checkpoints` (
	`session_id` text PRIMARY KEY,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`binding_version` integer DEFAULT 0 NOT NULL,
	`observation_generation` integer DEFAULT 0 NOT NULL,
	`checkpoint_json` text,
	`updated_at` text NOT NULL
);
