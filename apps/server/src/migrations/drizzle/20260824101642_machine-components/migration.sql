ALTER TABLE `machines` ADD `components_json` text;--> statement-breakpoint
-- POD-2700 seed. A row that has EVER carried a daemon-reported inventory or a
-- daemon build report has PROVABLY run a daemon, so it keeps its host
-- capabilities across this upgrade instead of vanishing from every picker until
-- its daemon next connects. Rows with neither proxy stay NULL — "not recorded",
-- which refuses nothing; the boot-time server stamp and the ordinary daemon
-- handshake write the real fact from here on. The coordinator row minted by
-- `ensureHostMachine` receives neither proxy and is therefore left for that boot
-- stamp to mark `server`, which is what finally makes it honestly incapable of
-- hosting a repository.
UPDATE `machines`
   SET `components_json` = '["daemon"]'
 WHERE `components_json` IS NULL
   AND (`inventory_json` IS NOT NULL OR `build_reported_at` IS NOT NULL);
