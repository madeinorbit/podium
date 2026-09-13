--
-- REVERSE MIGRATION TO LEDGER 98 -- POSTCONDITIONS
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- Run inside the same transaction, after everything else. Any failure here rolls
-- the entire reversal back.

CREATE TEMP TABLE "_assert_29" (x, CONSTRAINT "post: an epic table survived" CHECK(0));
INSERT INTO "_assert_29"(x) SELECT 1
 WHERE (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN (
    'issue_participants','member_invites','managed_credentials',
    'ownership_migration_dispositions')) <> 0;

CREATE TEMP TABLE "_assert_30" (x, CONSTRAINT "post: issues.assignee did not come back" CHECK(0));
INSERT INTO "_assert_30"(x) SELECT 1
 WHERE (SELECT count(*) FROM pragma_table_info('issues') WHERE name='assignee') <> 1;

CREATE TEMP TABLE "_assert_31" (x, CONSTRAINT "post: an A2 column survived on issues" CHECK(0));
INSERT INTO "_assert_31"(x) SELECT 1
 WHERE (SELECT count(*) FROM pragma_table_info('issues')
          WHERE name IN ('assignment_revision','input_revision')) <> 0;

CREATE TEMP TABLE "_assert_32" (x, CONSTRAINT "post: a member column survived on users" CHECK(0));
INSERT INTO "_assert_32"(x) SELECT 1
 WHERE (SELECT count(*) FROM pragma_table_info('users')
          WHERE name IN ('email','account_id','avatar')) <> 0;

CREATE TEMP TABLE "_assert_33" (x, CONSTRAINT "post: the issue count changed" CHECK(0));
INSERT INTO "_assert_33"(x) SELECT 1
 WHERE (SELECT count(*) FROM issues) <> 4296;

CREATE TEMP TABLE "_assert_34" (x, CONSTRAINT "post: an issue has an owner other than user:sole" CHECK(0));
INSERT INTO "_assert_34"(x) SELECT 1
 WHERE EXISTS (SELECT 1 FROM issues WHERE owner_user_id <> 'user:sole');

-- The assignee census, checked against what the ledger-98 backup actually holds.
CREATE TEMP TABLE "_assert_35" (x, CONSTRAINT "post: assignee NULL count is not the 2487 the backup holds" CHECK(0));
INSERT INTO "_assert_35"(x) SELECT 1
 WHERE (SELECT count(*) FROM issues WHERE assignee IS NULL) <> 2487;

CREATE TEMP TABLE "_assert_36" (x, CONSTRAINT "post: assignee non-null count is not the 1809 the backup holds" CHECK(0));
INSERT INTO "_assert_36"(x) SELECT 1
 WHERE (SELECT count(*) FROM issues WHERE assignee IS NOT NULL) <> 1809;

CREATE TEMP TABLE "_assert_37" (x, CONSTRAINT "post: the one equal-to-owner assignee was not restored" CHECK(0));
INSERT INTO "_assert_37"(x) SELECT 1
 WHERE (SELECT assignee FROM issues WHERE id = 'iss_4e01441e-9e58-44ea-b4eb-e52769f52e68') <> 'user:sole';

CREATE TEMP TABLE "_assert_38" (x, CONSTRAINT "post: the sole user is not user:sole" CHECK(0));
INSERT INTO "_assert_38"(x) SELECT 1
 WHERE (SELECT count(*) FROM users WHERE id = 'user:sole') <> 1;

CREATE TEMP TABLE "_assert_39" (x, CONSTRAINT "post: idx_automation_runs_automation lost its DESC" CHECK(0));
INSERT INTO "_assert_39"(x) SELECT 1
 WHERE (SELECT count(*) FROM pragma_index_xinfo('idx_automation_runs_automation')
          WHERE name='fired_at' AND "desc"=1) <> 1;

-- The exhaustive scan for a surviving minted id lives in revert-to-ledger-98.sh,
-- which can enumerate every column of every table; SQL cannot do that without
-- generating itself.
