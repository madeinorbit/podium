--
-- REVERSE MIGRATION TO LEDGER 98 -- THE LEDGER ITSELF
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- The last step, and the one that makes the shipping binary able to open this
-- file at all.
--
-- `runDrizzleMigrations` refuses -- by throwing, before it touches the schema --
-- when the ledger names a migration the build does not define:
--
--     database has applied migration '<name>', which this build does not
--     define. The database is newer than this build -- upgrade the Podium
--     server (downgrades are not supported).
--
-- Nine such names are in this ledger, and none of them is on origin/dev/mw. The
-- rows must go, and no drizzle migration can remove them: drizzle writes its own
-- ledger row after running a migration's SQL, so a migration that deleted 99..107
-- would still leave row 108 behind -- itself unknown to the shipping build, and
-- the same refusal. THAT is why this whole directory is a script and not a
-- migration.

DELETE FROM "__drizzle_migrations" WHERE "id" >= 99;

CREATE TEMP TABLE "_assert_25" (x, CONSTRAINT "ledger did not land on exactly 98 rows" CHECK(0));
INSERT INTO "_assert_25"(x) SELECT 1
 WHERE (SELECT count(*) FROM "__drizzle_migrations") <> 98;

-- NOT `WHERE id = 98`: the ledger's ids and its NAMES do not agree, because two
-- migrations landed out of order (row 97 is 20260831232155_transcript-costs,
-- row 98 is 20260826195939_supervisor-machine-presence). `latestAppliedMigration`
-- in the runner asks for the newest NAME, and server-transfer.ts compares that
-- string against the build's own -- so the name is what another machine sees.
-- The ledger-98 backup answers 20260831232155_transcript-costs, and so must this.
CREATE TEMP TABLE "_assert_26" (x, CONSTRAINT "the newest ledger NAME is not transcript-costs" CHECK(0));
INSERT INTO "_assert_26"(x) SELECT 1
 WHERE (SELECT name FROM "__drizzle_migrations" ORDER BY name DESC LIMIT 1)
        <> '20260831232155_transcript-costs';
