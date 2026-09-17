-- Preserve stage-1 hashes. The new column CHECK enforces both kinds without rebuilding machines.
ALTER TABLE `machines` ADD `credential_kind` text NOT NULL DEFAULT 'bearer-hash';
--> statement-breakpoint
ALTER TABLE `machines` ADD `public_key` text CONSTRAINT `machines_credential_material` CHECK (
  (`credential_kind` = 'bearer-hash' AND `token_hash` <> '' AND `public_key` IS NULL)
  OR (`credential_kind` = 'ed25519' AND `token_hash` = '' AND `public_key` IS NOT NULL
      AND length(`public_key`) = 51 AND substr(`public_key`, 1, 8) = 'ed25519:')
);
