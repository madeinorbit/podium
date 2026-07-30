-- SERVER-OWNED SECRETS MOVE TO A SERVER-ONLY KEYED STORE (POD-419, 3.7b).
--
-- ADR 1 D6's `server-secrets` row says the material is server-only, never
-- replicated and never enqueued. Until this migration it lived in the
-- `meta['settings']` JSON blob — one row, three matrix rows' worth of members,
-- served whole to every client that read its preferences. This lifts the five
-- classified secrets into `server_secrets` and REMOVES them from the blob.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot.
--
-- ---------------------------------------------------------------------------
-- 1. HAND-EDITED, AND THE EDIT IS THE POINT
-- ---------------------------------------------------------------------------
-- `drizzle-kit generate` emitted the CREATE TABLE below and NOTHING ELSE. That
-- is the POD-1076 shape verbatim: a new table plus a later removal with no
-- backfill between them, which produced three correctly-shaped EMPTY tables, no
-- error and total silent loss. A generator cannot know that the rows it is
-- about to strand are the whole reason for the change.
--
-- So the COPY IS BEFORE THE CLEAR, textually and in execution order, and the
-- statement order below is load-bearing rather than stylistic. Deleting the
-- INSERT and keeping the UPDATE would destroy every configured secret on the
-- instance while every schema and count assertion stayed green.
-- `server-secret-store.test.ts` mutation-verifies exactly that, and a second
-- mutant swaps two keys in the copy — all five values are TEXT out of one blob,
-- so a mis-keyed lift is invisible to every schema, count and NOT NULL check.
--
-- ---------------------------------------------------------------------------
-- 2. THE KEYS ARE THE LEGACY DOTTED PATHS, SPELLED OUT
-- ---------------------------------------------------------------------------
-- They match POD-418's `SERVER_SECRET_KEYS`, which are the paths the material
-- occupied in the blob. They are spelled out here rather than derived because a
-- migration is FROZEN HISTORY: if the vocabulary is later renamed, the rows this
-- statement wrote keep the keys they were actually written with, and the rename
-- carries its own migration. `server-secret-store.test.ts` asserts these
-- literals equal the shipped vocabulary, which is where the two are tied
-- together — importing them would make this file follow a rename instead of
-- catching one.
--
-- ---------------------------------------------------------------------------
-- 3. AN EMPTY SECRET DOES NOT BECOME A ROW
-- ---------------------------------------------------------------------------
-- `''` is the blob's spelling of "not configured". In the keyed store absence IS
-- the row being absent — that is what lets `SecretPresenceWire.present` mean
-- something — so the copy filters empties out rather than importing five rows
-- and calling three of them blank.
--
-- ---------------------------------------------------------------------------
-- 4. `updated_at` IS THE LIFT TIME, AND SAYS SO
-- ---------------------------------------------------------------------------
-- The blob never recorded when a secret was last replaced (POD-420's recorded
-- gap), so no rotation time exists to carry across. Writing the lift time is the
-- only honest non-null answer available: it is when this row came into being.
-- ISO-8601 via strftime, matching every other timestamp column in this schema —
-- `datetime('now')` writes the space-separated form that string comparisons then
-- sort wrongly.

CREATE TABLE `server_secrets` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
-- THE COPY. Before the clear. `json_valid` guards a corrupt blob (which
-- `SettingsRepository.getSettings` already reads as defaults) — without it
-- `json_extract` would abort the migration and wedge boot on a row the running
-- server tolerates.
INSERT OR IGNORE INTO `server_secrets` (`key`, `value`, `updated_at`)
SELECT `key`, `value`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
	SELECT 'apiKeys.openrouter' AS `key`, json_extract(`value`, '$.apiKeys.openrouter') AS `value` FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'apiKeys.anthropic', json_extract(`value`, '$.apiKeys.anthropic') FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'apiKeys.openai', json_extract(`value`, '$.apiKeys.openai') FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'integrations.linearApiKey', json_extract(`value`, '$.integrations.linearApiKey') FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'notifications.telegramBotToken', json_extract(`value`, '$.notifications.telegramBotToken') FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
)
WHERE `value` IS NOT NULL AND `value` <> '';
--> statement-breakpoint
-- THE CLEAR, and only now. `json_remove` deletes the MEMBER rather than blanking
-- it: a blanked key is indistinguishable from one that never held anything and
-- leaves an address for a later write to fill, while a removed one leaves the
-- blob with no key to put material in. `normalizeSettings` fills the legacy
-- defaults back in on read, so a scrubbed blob still parses. A path whose parent
-- is absent is a no-op in SQLite, so a partial blob is safe.
UPDATE `meta` SET `value` = json_remove(
	`value`,
	'$.apiKeys.openrouter',
	'$.apiKeys.anthropic',
	'$.apiKeys.openai',
	'$.integrations.linearApiKey',
	'$.notifications.telegramBotToken'
) WHERE `key` = 'settings' AND json_valid(`value`);
