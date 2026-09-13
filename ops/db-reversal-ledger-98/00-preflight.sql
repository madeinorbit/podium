--
-- REVERSE MIGRATION TO LEDGER 98 -- PREFLIGHT ASSERTIONS
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- EVERY ASSERTION BELOW ABORTS THE WHOLE TRANSACTION IF IT FAILS. They are the
-- reason this script can be trusted on a 926 MB production database: it refuses
-- to start against anything but the exact state it was written for.

-- 1. The ledger must be at 107, with rows 99..107 being exactly the nine
--    migrations from the unreleased epic branch.
CREATE TEMP TABLE "_assert_1" (x, CONSTRAINT "preflight: ledger is not at 107" CHECK(0));
INSERT INTO "_assert_1"(x) SELECT 1
 WHERE (SELECT count(*) FROM __drizzle_migrations) <> 107;

CREATE TEMP TABLE "_assert_2" (x, CONSTRAINT "preflight: ledger rows 99..107 are not the nine epic migrations" CHECK(0));
INSERT INTO "_assert_2"(x) SELECT 1
 WHERE (SELECT count(*) FROM __drizzle_migrations WHERE id BETWEEN 99 AND 107 AND name IN (
    '20260911082826_retire-the-solo-user',
    '20260911120440_member-login-email',
    '20260911124346_member-invites',
    '20260911133929_member-avatar',
    '20260912164222_a2-ownership-schema',
    '20260912164233_a2-ownership-backfill',
    '20260912164255_a2-retire-issue-assignee',
    '20260912231430_managed-credential-owner',
    '20260912231438_managed-credential-adoption')) <> 9;

CREATE TEMP TABLE "_assert_3" (x, CONSTRAINT "preflight: ledger row 98 is not supervisor-machine-presence" CHECK(0));
INSERT INTO "_assert_3"(x) SELECT 1
 WHERE (SELECT name FROM __drizzle_migrations WHERE id = 98)
        <> '20260826195939_supervisor-machine-presence';

-- 2. The four tables the epic added must all be present (so we are reversing the
--    state we think we are), and only ownership_migration_dispositions may hold
--    rows. A non-empty issue_participants / member_invites / managed_credentials
--    would mean somebody USED the new features, and dropping those tables would
--    destroy real data rather than an empty shell -- stop and re-plan.
CREATE TEMP TABLE "_assert_4" (x, CONSTRAINT "preflight: an epic table is missing" CHECK(0));
INSERT INTO "_assert_4"(x) SELECT 1
 WHERE (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN (
    'issue_participants','member_invites','managed_credentials',
    'ownership_migration_dispositions')) <> 4;

CREATE TEMP TABLE "_assert_5" (x, CONSTRAINT "preflight: issue_participants is not empty -- real data would be destroyed" CHECK(0));
INSERT INTO "_assert_5"(x) SELECT 1
 WHERE (SELECT count(*) FROM issue_participants) <> 0;
CREATE TEMP TABLE "_assert_6" (x, CONSTRAINT "preflight: member_invites is not empty -- real data would be destroyed" CHECK(0));
INSERT INTO "_assert_6"(x) SELECT 1
 WHERE (SELECT count(*) FROM member_invites) <> 0;
CREATE TEMP TABLE "_assert_7" (x, CONSTRAINT "preflight: managed_credentials is not empty -- real data would be destroyed" CHECK(0));
INSERT INTO "_assert_7"(x) SELECT 1
 WHERE (SELECT count(*) FROM managed_credentials) <> 0;

-- 3. The epic's member-login columns must be unused. `users.email`,
--    `users.account_id` and `users.avatar` are dropped by 40-*.sql; a value in
--    any of them is a login credential or an avatar somebody set, and losing it
--    silently is not acceptable.
CREATE TEMP TABLE "_assert_8" (x, CONSTRAINT "preflight: users.email / account_id / avatar hold values -- they would be lost" CHECK(0));
INSERT INTO "_assert_8"(x) SELECT 1
 WHERE (SELECT count(*) FROM users
          WHERE email IS NOT NULL OR account_id IS NOT NULL OR avatar IS NOT NULL) <> 0;

-- 4. The ownership backfill (104) must not have MOVED any owner. It is allowed
--    to have moved them -- prior_owner records where they came from and 20-*.sql
--    puts them back -- but on this database the count is zero and a non-zero
--    count means the reversal is restoring owners rather than confirming them.
--    Not an abort: a count>0 is handled correctly. Recorded here so the operator
--    sees it in the log.
SELECT 'backfill rows that MOVED an owner (restored from prior_owner): ' ||
       (SELECT count(*) FROM ownership_migration_dispositions
         WHERE disposition = 'adopted-assignee-as-owner') AS note;

-- 5. `issues.assignee` reconstruction rests on this identity: at ledger 98 every
--    issue's assignee was either NULL, or a value the backfill recorded in
--    `retired_assignee`, or equal to `owner_user_id`. The disposition table must
--    therefore cover every issue whose assignee was NOT null-or-owner. We cannot
--    check that from this database (the column is gone), so we check the two
--    facts we CAN: the disposition rows are all for issues that still exist, and
--    the row count matches what was measured against the ledger-98 backup.
CREATE TEMP TABLE "_assert_9" (x, CONSTRAINT "preflight: a disposition names an issue that no longer exists" CHECK(0));
INSERT INTO "_assert_9"(x) SELECT 1
 WHERE EXISTS (SELECT 1 FROM ownership_migration_dispositions d
                 WHERE d.entity_kind='issue'
                   AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = d.entity_id));

CREATE TEMP TABLE "_assert_10" (x, CONSTRAINT "preflight: disposition count is not the 1808 measured against the ledger-98 backup" CHECK(0));
INSERT INTO "_assert_10"(x) SELECT 1
 WHERE (SELECT count(*) FROM ownership_migration_dispositions) <> 1808;

-- 6. The minted member id must be the one this script was written against. The
--    id is minted per-apply ({{mint:mem_}} in migration 99), so a different
--    database has a different id and every rekey below would be wrong.
CREATE TEMP TABLE "_assert_11" (x, CONSTRAINT "preflight: the minted member id is not the expected one" CHECK(0));
INSERT INTO "_assert_11"(x) SELECT 1
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8');

CREATE TEMP TABLE "_assert_12" (x, CONSTRAINT "preflight: more than one user exists -- this reversal assumes the solo installation" CHECK(0));
INSERT INTO "_assert_12"(x) SELECT 1
 WHERE (SELECT count(*) FROM users) <> 1;
