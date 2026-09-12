CREATE TABLE `managed_credentials` (
	`owner_user_id` text NOT NULL,
	`id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`credential` text NOT NULL,
	`identity` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'role' NOT NULL,
	`created_at` integer NOT NULL,
	`provenance` text DEFAULT 'connected' NOT NULL,
	CONSTRAINT `managed_credentials_pk` PRIMARY KEY(`owner_user_id`, `id`),
	CONSTRAINT "managed_credentials_provenance" CHECK(provenance IN ('connected', 'adopted-instance-credential'))
);
