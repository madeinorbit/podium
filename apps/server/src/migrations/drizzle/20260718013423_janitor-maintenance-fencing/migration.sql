CREATE TABLE `maintenance_commands` (
	`job_kind` text NOT NULL,
	`run_key` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`result_json` text NOT NULL,
	`applied_at` text NOT NULL,
	CONSTRAINT `maintenance_commands_pk` PRIMARY KEY(`job_kind`, `run_key`)
);
--> statement-breakpoint
CREATE TABLE `maintenance_leases` (
	`name` text PRIMARY KEY,
	`generation_id` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`expires_at` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`schema_version` text NOT NULL,
	`updated_at` text NOT NULL
);
