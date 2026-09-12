-- PDM-280 · ADOPTING THE INSTANCE'S UNOWNED PROVIDER KEYS
--
-- The migration before this one created `managed_credentials`, keyed
-- (owner_user_id, id). This one decides who the rows already in `accounts`
-- belong to, and records that it decided.
--
-- ---------------------------------------------------------------------------
-- 1. WHY THE EARLIEST ADMIN, AND WHY THAT IS NOT A GUESS
-- ---------------------------------------------------------------------------
-- `accounts` has no owner column, so there is no stored intent to preserve and
-- nothing to adjudicate between — unlike A2, which had two disagreeing columns.
-- What there is instead is one fact: somebody typed these keys into an instance
-- that had exactly one administrator, and that administrator is the only party
-- a deterministic rule can name. Every other candidate (the newest admin, the
-- most active member, nobody) is either arbitrary or discards a working
-- credential.
--
-- THE RULE IS THE ONE THE PRODUCT ALREADY USES, spelled a third time:
-- `role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1`.
-- `UsersRepository.earliestAdmin()` is the builder spelling and
-- `EARLIEST_ADMIN_MEMBER_SQL` is the raw-handle spelling; a test ties those two
-- by running both against one database. This file is the third site, and
-- `managed-credential-adoption.test.ts` joins it to that tie the same way —
-- by asserting the owner this migration picked IS what `earliestAdmin()`
-- returns for the same database, rather than by comparing strings.
--
-- ---------------------------------------------------------------------------
-- 2. NO ADMIN RESOLVES — COPY NOTHING, AND SAY SO IN SQL
-- ---------------------------------------------------------------------------
-- A database from before accounts, or one whose admins are all disabled, has no
-- answer. The EXISTS guard makes that a no-op rather than an error: without it
-- the scalar subquery yields NULL and the insert dies on `owner_user_id NOT
-- NULL`, turning "nobody to adopt to" into a failed upgrade. The rows stay in
-- `accounts`, which is where they already were, and nobody can sign in to use
-- them anyway. Inventing an owner is the one thing this file must not do
-- (ADR 9 D4, default-closed).
--
-- ---------------------------------------------------------------------------
-- 3. RE-ENTRANT BY AN EXPLICIT GUARD, NOT BY `INSERT OR IGNORE`
-- ---------------------------------------------------------------------------
-- A2's reasoning applies unchanged: `OR IGNORE` would also swallow a genuine
-- constraint violation, so a row dropped for the wrong reason would look exactly
-- like a re-run. The NOT EXISTS predicate names the condition instead, and a
-- second run copies nothing because the pair is already present.
--
-- ---------------------------------------------------------------------------
-- 4. WHAT MAKES THE ADOPTION READABLE AFTERWARDS
-- ---------------------------------------------------------------------------
-- `provenance = 'adopted-instance-credential'`, against the `'connected'`
-- default every row written through `accounts.connect` carries. So a later
-- reader can tell a key this person chose from one the upgrade handed them —
-- PDM-247's requirement. The other half is that nothing was destroyed to get
-- here: `accounts` still holds the pre-adoption rows, unread, until PDM-296
-- drops it a release later.

INSERT INTO managed_credentials (
  owner_user_id, id, provider, kind, credential, identity, scope, created_at, provenance
)
SELECT
  (SELECT u.id FROM users u
    WHERE u.role = 'admin' AND u.disabled_at IS NULL
    ORDER BY u.created_at, u.id LIMIT 1),
  a.id, a.provider, a.kind, a.credential, a.identity, a.scope, a.created_at,
  'adopted-instance-credential'
FROM accounts a
WHERE EXISTS (
    SELECT 1 FROM users u WHERE u.role = 'admin' AND u.disabled_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM managed_credentials m
    WHERE m.id = a.id
      AND m.owner_user_id = (SELECT u.id FROM users u
        WHERE u.role = 'admin' AND u.disabled_at IS NULL
        ORDER BY u.created_at, u.id LIMIT 1)
  );
