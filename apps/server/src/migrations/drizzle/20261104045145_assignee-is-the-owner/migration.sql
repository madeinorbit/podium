-- ONE ACCOUNTABLE ASSIGNEE (POD-6287; docs/design/multi-user-instance.md
-- §2.2, §4.3).
--
-- A task's assignee is its owner, `owner_user_id`: the one human who answers
-- for it. Until this release `issues.assignee` was a second, free-text field
-- that anyone could write and that agent starts stamped with `agent:<kind>`;
-- the CLI's `claim --assignee me` stored the literal `me`. From now on nothing
-- writes it, and the wire's `assignee` is the owner. What the column held
-- splits two ways:
--
--   - a MEMBER ID of an active member (not disabled, still a row in `users`)
--     named the person meant to answer for the task, so that member becomes
--     the owner. The creator columns are left alone: who created a task never
--     changes.
--   - anything else (an agent label, `me`, a name, a removed or disabled
--     member's id) names nobody who can be accountable. It stays in the
--     column as a legacy display label, the wire's `legacyAssignee`, and the
--     owner is untouched.
--
-- A label that equals the owner after the first statement says nothing the
-- owner does not, and is cleared so it is not shown twice. Nothing else is
-- dropped or narrowed; the pre-migration backup the runner takes at boot is
-- the rollback. A one-member instance moves no owner: its only member already
-- owns every task.
--
-- `closed_by_user_id` is new and empty: who closed a task, so the closed-task
-- sweep stops only that person's sessions. Rows closed before it stay NULL and
-- the sweep stops the assignee's.
ALTER TABLE `issues` ADD `closed_by_user_id` text;
--> statement-breakpoint
UPDATE `issues`
SET `owner_user_id` = `assignee`
WHERE `assignee` IS NOT NULL
  AND `assignee` IS NOT `owner_user_id`
  AND `assignee` IN (SELECT `id` FROM `users` WHERE `disabled_at` IS NULL);
--> statement-breakpoint
UPDATE `issues` SET `assignee` = NULL WHERE `assignee` = `owner_user_id`;
