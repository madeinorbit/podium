-- PERSONAL PREFERENCES MOVE TO PER-USER STORAGE (POD-1213; POD-352 AC3,
-- ADR 9 D3 rule 4, ADR 4 Amendment 1 D10).
--
-- POD-418 split the settings SHAPES, POD-419 moved the SECRETS, POD-420
-- contracted the WRITES. This moves the twenty-four `preferences-personal`
-- leaves off the instance-wide `meta['settings']` blob and into
-- `user_preferences`, keyed `(user_id, key)` — the per-user state family's
-- shape, `session_user_state` / `issue_user_state` conventions verbatim.
--
-- WHAT WAS ACTUALLY WRONG, not just untidy: the whole blob is served to every
-- authenticated client, so one person's role/model choices, sidebar order,
-- autoContinue dismissal, ntfy topic and Telegram chat id were readable by
-- every other person on the instance. That is a live cross-user leak against
-- ADR 9 D3's per-user-state class and POD-352's "no cross-user leakage" exit
-- item (POD-421 audits it).
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot (`backup.ts`).
--
-- ---------------------------------------------------------------------------
-- 1. HAND-EDITED, AND THE EDIT IS THE POINT
-- ---------------------------------------------------------------------------
-- `drizzle-kit generate` emits the CREATE TABLE and nothing else — the same
-- shape POD-1076 and POD-419 both recorded: a new table beside a later removal
-- with no backfill between them, which applies cleanly and loses everything.
-- So the COPY IS BEFORE THE CLEAR, textually and in execution order, and the
-- statement order is load-bearing rather than stylistic. Deleting the
-- INSERT..SELECT and keeping the DDL would leave one correctly-shaped EMPTY
-- table, no error, and every configured preference on the instance reset to its
-- default. `personal-preference-store.test.ts` mutation-verifies exactly that,
-- and a second mutant swaps two same-typed keys inside the copy — most of these
-- leaves are strings out of one blob, so a mis-keyed lift is invisible to every
-- schema, count and NOT NULL check there is.
--
-- ---------------------------------------------------------------------------
-- 2. THE KEYS ARE THE DOTTED PATHS, SPELLED OUT
-- ---------------------------------------------------------------------------
-- They are POD-418's `settingsPathsInTier('personal-preference')` — the paths
-- the values occupied in the blob — spelled out rather than derived, because a
-- migration is FROZEN HISTORY: if the vocabulary is later renamed, the rows this
-- statement wrote keep the keys they were actually written with, and the rename
-- carries its own migration. `personal-preference-store.test.ts` asserts these
-- literals equal the shipped classification, which is where the two are tied
-- together — importing them would make this file follow a rename instead of
-- catching one, and would make a leaf ADDED to `PersonalPreferences` silently
-- migration-less.
--
-- ---------------------------------------------------------------------------
-- 3. THE OWNER OF EVERY BACKFILLED ROW
-- ---------------------------------------------------------------------------
-- `'user:sole'` — POD-1075's first admin, the id POD-380 and POD-1076 already
-- wrote into every pin, snooze, tab order and read marker. Podium has
-- authenticated exactly one identity, so every configured preference has an
-- unambiguous owner and is BACKFILLED rather than dropped. Spelled out rather
-- than imported from `FIRST_ADMIN_USER_ID`, for the reason in §2.
--
-- ---------------------------------------------------------------------------
-- 4. VALUES ARE CARRIED AS JSON, NOT AS TEXT
-- ---------------------------------------------------------------------------
-- `->` (not `->>`) is deliberate: it yields the JSON *representation*, so
-- `autoContinue.enabled` arrives as `true` rather than as the integer 1, and
-- `sidebar.repoOrder` arrives as `["a","b"]` rather than as an unparseable
-- flattening. `->>` would coerce every leaf to a SQL scalar and silently turn
-- three booleans into integers and one array into text — a type change no
-- count, schema or NOT NULL assertion can see. The reader (`UserPreferences`
-- repository) does `JSON.parse` on this column and nothing else.
--
-- A path the blob does not hold is SQL NULL and becomes no row, which is the
-- right answer: an absent row means "this person has never set it" and resolves
-- to the blob/default fallback. `''` is NOT filtered here (unlike POD-419's
-- secrets): an empty ntfy topic is a real preference value meaning "off", not
-- an unconfigured credential.

CREATE TABLE `user_preferences` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `user_preferences_pk` PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
-- THE COPY. Before the clear. `json_valid` guards a corrupt blob (which
-- `SettingsRepository.getSettings` already reads as defaults) — without it the
-- JSON operator would abort the migration and wedge boot on a row the running
-- server tolerates. `updated_at` is the LIFT time: the blob never recorded when
-- a preference was last changed, so this is the only honest non-null answer —
-- it is when this row came into being. ISO-8601 via strftime, matching every
-- other timestamp column; `datetime('now')` writes the space-separated form
-- that string comparisons then sort wrongly.
INSERT OR IGNORE INTO `user_preferences` (`user_id`, `key`, `value`, `updated_at`)
SELECT 'user:sole', `key`, `value`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
	SELECT 'roles.coding.accountId' AS `key`, `value` -> '$.roles.coding.accountId' AS `value` FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.model', `value` -> '$.roles.coding.model' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.effort', `value` -> '$.roles.coding.effort' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.harness', `value` -> '$.roles.coding.harness' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.subagentModel', `value` -> '$.roles.coding.subagentModel' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.subagentStrategy', `value` -> '$.roles.coding.subagentStrategy' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.startScreen', `value` -> '$.roles.coding.startScreen' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.coding.seedCliTheme', `value` -> '$.roles.coding.seedCliTheme' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.superagent.accountId', `value` -> '$.roles.superagent.accountId' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.superagent.model', `value` -> '$.roles.superagent.model' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.superagent.effort', `value` -> '$.roles.superagent.effort' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.superagent.harness', `value` -> '$.roles.superagent.harness' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.background.accountId', `value` -> '$.roles.background.accountId' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.background.model', `value` -> '$.roles.background.model' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.background.effort', `value` -> '$.roles.background.effort' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'roles.background.harness', `value` -> '$.roles.background.harness' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'sidebar.repoSort', `value` -> '$.sidebar.repoSort' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'sidebar.repoOrder', `value` -> '$.sidebar.repoOrder' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'sidebar.groupByRepo', `value` -> '$.sidebar.groupByRepo' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'autoContinue.enabled', `value` -> '$.autoContinue.enabled' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'autoContinue.promptDismissed', `value` -> '$.autoContinue.promptDismissed' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'notifications.web', `value` -> '$.notifications.web' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'notifications.ntfyTopic', `value` -> '$.notifications.ntfyTopic' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
	UNION ALL
	SELECT 'notifications.telegramChatId', `value` -> '$.notifications.telegramChatId' FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
)
WHERE `value` IS NOT NULL;
--> statement-breakpoint
-- THE CLEAR, and only now. `json_remove` deletes the MEMBER rather than blanking
-- it — a blanked key is indistinguishable from one nobody ever set, and leaves
-- an address for a later write to fill, while a removed one leaves the blob with
-- no per-user value in it at all. That is what makes the cross-user leak gone AT
-- REST rather than merely filtered on the way out. `normalizeSettings` fills the
-- defaults back in on read, so a scrubbed blob still parses and instance-tier
-- keys are untouched; a path whose parent is absent is a no-op in SQLite, so a
-- partial blob is safe.
UPDATE `meta` SET `value` = json_remove(
	`value`,
	'$.roles.coding.accountId',
	'$.roles.coding.model',
	'$.roles.coding.effort',
	'$.roles.coding.harness',
	'$.roles.coding.subagentModel',
	'$.roles.coding.subagentStrategy',
	'$.roles.coding.startScreen',
	'$.roles.coding.seedCliTheme',
	'$.roles.superagent.accountId',
	'$.roles.superagent.model',
	'$.roles.superagent.effort',
	'$.roles.superagent.harness',
	'$.roles.background.accountId',
	'$.roles.background.model',
	'$.roles.background.effort',
	'$.roles.background.harness',
	'$.sidebar.repoSort',
	'$.sidebar.repoOrder',
	'$.sidebar.groupByRepo',
	'$.autoContinue.enabled',
	'$.autoContinue.promptDismissed',
	'$.notifications.web',
	'$.notifications.ntfyTopic',
	'$.notifications.telegramChatId'
) WHERE `key` = 'settings' AND json_valid(`value`);
