CREATE TABLE `session_observation_rebinds` (
	`session_id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`from_provider_session_id` text,
	`from_binding_version` integer NOT NULL,
	`from_observation_generation` integer NOT NULL,
	`to_provider_session_id` text NOT NULL,
	`resulting_binding_version` integer NOT NULL,
	`resulting_observation_generation` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_session_observation_rebinds_session_id_session_observation_checkpoints_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_observation_checkpoints`(`session_id`) ON DELETE CASCADE
);
