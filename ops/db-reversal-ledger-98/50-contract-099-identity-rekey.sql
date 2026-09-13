--
-- REVERSE MIGRATION TO LEDGER 98 -- 99, THE IDENTITY REKEY
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- 99 `retire-the-solo-user` replaced the constant id 'user:sole' with a freshly
-- minted `mem_` id in every column that names a principal, in the JSON payloads
-- of `changes` and `change_latest`, and rotated `feed_identity.epoch` to force
-- clients to resync. This file puts the constant back.
--
-- THE DATABASE IS CURRENTLY SPLIT-BRAINED, and that is the strongest argument
-- for doing this rather than restoring the backup. The binary that is still
-- running predates 99 and writes the literal 'user:sole'. Since 04:46 it has
-- written 'user:sole' into a database whose `users` table says
-- 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8' -- one session, four messages,
-- twelve issue_message_user_state rows, two issue_user_state rows and ~900
-- change payloads now name an owner that resolves to no user row at all.
-- Reversing the rekey does not merely undo migration 99; it re-unifies rows the
-- accident split.
--
-- THE SUBSTITUTION IS EXACT, NOT A PREFIX MATCH. The minted id is a KSUID with
-- no substructure, it appears nowhere in this database except as a principal id,
-- and the postcondition in 90-*.sql scans EVERY column of EVERY table for a
-- surviving occurrence. The list below was not transcribed from migration 99 --
-- it is the union of that migration's own UPDATE list with the result of that
-- same exhaustive scan, so it also covers the three places migration 99 itself
-- MISSED (`changes.entity_id`, `change_latest.entity_id`, and a
-- `superagent_threads.id` written after the fact).
--
-- `issue_user_state` is absent on purpose: its rekey has a primary-key collision
-- and is handled by the merge in 30-*.sql.

UPDATE "machines" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issue_comments" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issue_comments" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "messages" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "messages" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "snoozes" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "tab_order" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "pins" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "users" SET "id" = 'user:sole' WHERE "id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "user_credentials" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "client_sessions" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "session_user_state" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issue_message_user_state" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "settings_audit_events" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "settings_audit_events" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "user_preferences" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "queued_messages" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "queued_messages" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "user_layout" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "user_read_position" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "automation_runs" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "automation_runs" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "automations" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "automations" SET "created_by_actor" = 'user:sole' WHERE "created_by_actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "automations" SET "created_by_on_behalf_of" = 'user:sole' WHERE "created_by_on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "assignee" = 'user:sole' WHERE "assignee" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "created_by_actor" = 'user:sole' WHERE "created_by_actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issues" SET "created_by_on_behalf_of" = 'user:sole' WHERE "created_by_on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "sessions" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "sessions" SET "created_by_actor_id" = 'user:sole' WHERE "created_by_actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "sessions" SET "created_by_on_behalf_of" = 'user:sole' WHERE "created_by_on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_messages" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_threads" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_pending_turns" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_pending_turns" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_pending_turns" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_queued_inputs" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_queued_inputs" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "superagent_queued_inputs" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_bindings" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_bindings" SET "updated_by_id" = 'user:sole' WHERE "updated_by_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_runs" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflows" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflows" SET "created_by_id" = 'user:sole' WHERE "created_by_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_events" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_events" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "workflow_revisions" SET "created_by_id" = 'user:sole' WHERE "created_by_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "execution_profiles" SET "owner_user_id" = 'user:sole' WHERE "owner_user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "execution_profiles" SET "created_by_id" = 'user:sole' WHERE "created_by_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "approval_requests" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "approval_requests" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "grants" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "grants" SET "grantee" = 'user:sole' WHERE "grantee" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "grants" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "grants" SET "owner" = 'user:sole' WHERE "owner" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issue_messages" SET "actor" = 'user:sole' WHERE "actor" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "issue_messages" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "telegram_chat_bindings" SET "actor_id" = 'user:sole' WHERE "actor_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "telegram_chat_bindings" SET "on_behalf_of" = 'user:sole' WHERE "on_behalf_of" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';
UPDATE "telegram_chat_bindings" SET "user_id" = 'user:sole' WHERE "user_id" = 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8';

-- The feed. `changes.payload` and `change_latest.payload` are JSON documents
-- that quote the principal id; migration 99 rewrote them with the same
-- quote-delimited replace, and this is its inverse.
UPDATE "changes"
   SET "payload" = replace("payload", '"mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8"', '"user:sole"')
 WHERE "payload" LIKE '%"mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8"%';

UPDATE "change_latest"
   SET "payload" = replace("payload", '"mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8"', '"user:sole"')
 WHERE "payload" LIKE '%"mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8"%';

-- `entity_id` -- WHICH MIGRATION 99 DID NOT REWRITE, so the live feed index
-- carries both spellings of the same entity. `changes` is keyed by an
-- autoincrementing seq and cannot collide. `change_latest` is keyed
-- (entity, entity_id) and DOES: three entities have a row under each spelling.
-- The later `seq` is the current state of that entity, so the earlier row of
-- each colliding pair is deleted before the survivors are rekeyed.
DELETE FROM "change_latest" WHERE rowid IN (
  SELECT CASE WHEN a."seq" >= b."seq" THEN b.rowid ELSE a.rowid END
    FROM "change_latest" a
    JOIN "change_latest" b
      ON b."entity" = a."entity"
     AND b."entity_id" = replace(a."entity_id", 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8', 'user:sole')
   WHERE a."entity_id" LIKE '%mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8%'
);

UPDATE "change_latest"
   SET "entity_id" = replace("entity_id", 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8', 'user:sole')
 WHERE "entity_id" LIKE '%mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8%';

UPDATE "changes"
   SET "entity_id" = replace("entity_id", 'mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8', 'user:sole')
 WHERE "entity_id" LIKE '%mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8%';

-- One `superagent_threads` row was created AFTER the accident with the minted id
-- baked into its primary key ('global:mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8').
-- Its owner column is rekeyed by the list above; the id is left alone. Rewriting
-- a primary key to a spelling the ledger-98 code never mints would invent a row
-- rather than restore one, and the existing 'global' thread -- the one the
-- shipping binary uses -- is untouched and still there.

-- THE FEED EPOCH IS ROTATED, NOT RESTORED, and this is the one value that will
-- not match the ledger-98 backup. Restoring the original epoch would tell every
-- client "nothing has changed since you last synced", which is false twice over:
-- the payloads were rewritten at 04:46 and are being rewritten again now. A
-- client that synced during the window holds mem_-flavoured rows and must be
-- made to discard them. A fresh epoch is what says so.
UPDATE "feed_identity"
   SET "epoch" = 'ledger-98-revert-' || lower(hex(randomblob(16)))
 WHERE "singleton" = 1;
