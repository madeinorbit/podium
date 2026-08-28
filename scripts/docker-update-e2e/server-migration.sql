CREATE TABLE `update_e2e_server_probe` (
  `marker` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `update_e2e_server_probe` (`marker`, `applied_at`) VALUES ('packaged-server', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
