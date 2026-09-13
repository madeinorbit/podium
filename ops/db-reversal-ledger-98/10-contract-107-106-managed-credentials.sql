--
-- REVERSE MIGRATION TO LEDGER 98 -- 107 + 106, MANAGED CREDENTIALS
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- 107 `managed-credential-adoption` INSERTed into `managed_credentials` from
-- `accounts`. It destroyed nothing -- its own header says so ("`accounts` still
-- holds the pre-adoption rows, unread") -- and on this database it copied
-- nothing at all, because `accounts` is empty and the EXISTS guard made the
-- whole statement a no-op. So 107 has no inverse beyond dropping the table its
-- rows live in, which is 106's inverse.
--
-- 106 `managed-credential-owner` CREATEd the table. Dropping it takes the
-- primary-key autoindex with it.

DROP TABLE "managed_credentials";
