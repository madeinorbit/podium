--
-- REVERSE MIGRATION TO LEDGER 98 -- 103, THE A2 OWNERSHIP SCHEMA
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- 103 `a2-ownership-schema` created two tables, added two columns to
-- `issue_user_state`, added two to `issues` (undone in 20-*.sql), and created
-- one index.
--
-- `ownership_migration_dispositions` is dropped LAST of the three files that
-- read it: 20-*.sql has already taken `retired_assignee` and `prior_owner` back
-- into `issues`. After this statement those 1808 rows exist only in the
-- ledger-98 backup and in `issues.assignee` itself.

DROP TABLE "issue_participants";

DROP TABLE "ownership_migration_dispositions";

-- `issue_user_state` needs the two columns 103 added taken off, and it is also
-- the ONE table where reversing 99's identity rekey collides: two issues carry a
-- row under BOTH ids -- the pre-incident row under the minted member id, and a
-- row the still-running ledger-98 binary wrote under 'user:sole' after the
-- accident. A straight UPDATE of user_id would violate the (user_id, issue_id)
-- primary key.
--
-- So the rekey happens HERE, inside the rebuild, as a GROUP BY that merges the
-- pair. `max()` over each timestamp keeps whichever side actually has the
-- marker: the old row's `pinned_at`, the new row's later `read_at`. Nothing is
-- dropped in favour of "the newer row", which would have discarded a pin.
--
-- 50-*.sql therefore does NOT touch this table.


CREATE TABLE "__rev_stash_issue_user_state" AS SELECT * FROM "issue_user_state";

DROP TABLE "issue_user_state";

CREATE TABLE `issue_user_state` (
	`user_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`read_at` text,
	`tucked_at` text,
	`pinned_at` text,
	CONSTRAINT `issue_user_state_pk` PRIMARY KEY(`user_id`, `issue_id`)
);

INSERT INTO "issue_user_state" ("user_id", "issue_id", "read_at", "tucked_at", "pinned_at")
SELECT replace(s."user_id", 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8', 'user:sole'), "issue_id", max(s."read_at"), max(s."tucked_at"), max(s."pinned_at")
FROM "__rev_stash_issue_user_state" AS s
GROUP BY 1, 2;

DROP TABLE "__rev_stash_issue_user_state";
