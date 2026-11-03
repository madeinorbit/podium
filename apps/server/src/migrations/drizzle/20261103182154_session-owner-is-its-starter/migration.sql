-- A SESSION BELONGS TO WHOEVER STARTED IT (POD-6283; docs/design/multi-user-instance.md §2.3).
--
-- Until this release, a session started on a task was stored with the TASK's
-- owner as `sessions.owner_user_id` (session-start.ts and createdOwnership both
-- let the issue owner win). Only `created_by_on_behalf_of` named the person who
-- actually started it, or for whom an agent started it. Session authorization
-- now reads `owner_user_id` alone, so a row where the two differ would leave
-- Bob's agent on Alice's task in Alice's hands and refuse Bob.
--
-- The correction: set the owner to `created_by_on_behalf_of` where
--   - the instance has more than one member (a one-member instance is left
--     exactly as it was: there both columns name the same person anyway),
--   - the row records an on-behalf-of human that differs from its owner, and
--   - that human is an active member (not disabled, and still a row in
--     `users`). A row whose starter is gone or disabled keeps its owner rather
--     than being handed to nobody.
--
-- Data only, no schema change: nothing is dropped or narrowed, and the
-- pre-migration backup the runner takes at boot is the rollback. Rows written
-- before `created_by_on_behalf_of` existed have NULL there and are untouched.
UPDATE `sessions`
SET `owner_user_id` = `created_by_on_behalf_of`
WHERE `created_by_on_behalf_of` IS NOT NULL
  AND `owner_user_id` IS NOT `created_by_on_behalf_of`
  AND (SELECT COUNT(*) FROM `users`) > 1
  AND `created_by_on_behalf_of` IN (SELECT `id` FROM `users` WHERE `disabled_at` IS NULL);
