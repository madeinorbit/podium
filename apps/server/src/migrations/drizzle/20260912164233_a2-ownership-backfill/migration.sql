-- A2 · RETIRING THE SECOND OWNER COLUMN (spec: multi-user epic A2, ADR 9
-- Amendment 1 D1/D2/D10)
--
-- `issues` carried TWO answers to "who is accountable for this task":
-- `owner_user_id`, added by the POD-1075 phase-3 ownership migration, and
-- `assignee`, which predates it. Nothing kept them in step, and two live writers
-- actively pushed them apart:
--
--   * `IssueService.claim` wrote `{ assignee, stage }` in one update, so an AGENT
--     saying "I am working on this" reassigned the accountable HUMAN as a side
--     effect — the act D2 forbids outright ("agents never reassign humans");
--   * `IssueService.start` wrote the literal `agent:<kind>` into `assignee`
--     through a named cast, putting an agent LABEL in a column typed as a person.
--
-- This migration decides every existing row, records the decision where it can be
-- read back, and hands the next migration a table whose second owner column has
-- nothing left in it. THE DROP ITSELF IS THE NEXT MIGRATION
-- (`a2-retire-issue-assignee`), and the split is deliberate: this file must be
-- able to READ `assignee` to adjudicate it, and a single migration that both read
-- and dropped it would leave no state in which the evidence and the source value
-- both existed.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE, like every migration here: there are no
-- down migrations, and rollback is the pre-migration backup the runner takes at
-- boot.
--
-- ---------------------------------------------------------------------------
-- 1. WHY THE ASSIGNEE WINS WHEN IT NAMES A REAL PERSON
-- ---------------------------------------------------------------------------
-- It is the only column on this table that a human has ever set. `owner_user_id`
-- is server-derived at create (the creating principal's on-behalf-of human), and
-- on an instance upgraded through POD-1075 it was DEFAULTED to `'user:sole'` on
-- every row and then re-keyed to the one minted `mem_` id by
-- `20260911082826_retire-the-solo-user` — so on an upgraded instance it says
-- "whoever installed this" for every task ever created. `assignee` is the field
-- the tracker UI exposed and a person chose.
--
-- Keeping the owner would therefore reassign the whole instance to its installer
-- and call that "preserving ownership". Adopting the assignee preserves the
-- intent that was actually expressed. Deterministic: the rule is a function of
-- the two stored values and the `users` table, with no clock, no ordering and no
-- host input, so two runs over the same database produce the same result — and
-- re-running finds nothing, because the predicates all require `assignee` to
-- still differ from `owner_user_id`.
--
-- ---------------------------------------------------------------------------
-- 2. AND THE TWO CASES WHERE IT MUST NOT
-- ---------------------------------------------------------------------------
-- AGENT LABELS. `agent:<kind>` is not a person and never was. The acceptance
-- criterion is explicit — agent labels never become human owners — so these rows
-- keep their owner and the label is recorded as retired.
--
-- UNRESOLVABLE IDS. An assignee matching no row in `users` cannot be adopted: an
-- owner nobody can resolve still READS as a valid principal, so every check
-- refuses it and the failure mode is "a task nobody can see" rather than an
-- error. Default-closed (ADR 9 D4) — keep the owner that resolves.
--
-- Note the ORDER the three predicates are written in. The agent-label test comes
-- first and is by PREFIX, not by membership in `users`: if an installation ever
-- minted an account whose id begins `agent:`, membership would adopt it as a
-- person. The prefix test refuses it either way.
--
-- ---------------------------------------------------------------------------
-- 3. THE EVIDENCE IS WRITTEN BEFORE THE VALUE MOVES
-- ---------------------------------------------------------------------------
-- Every statement that changes an owner is preceded by the INSERT that records
-- what was there. `ownership_migration_dispositions` is append-only, keyed
-- `(migration, entity_kind, entity_id)`, and holds both values verbatim, so an
-- operator who finds a task assigned to the wrong person after the upgrade can
-- see exactly what was read and which rule applied. The charter asks for "an
-- explicit migration disposition for ambiguous legacy owners/assignees"; a log
-- line would not survive the upgrade, and a count would not name the rows.
--
-- UNAMBIGUOUS ROWS GET NO DISPOSITION, and that is not laziness: a disposition
-- table in which the overwhelming majority of rows say "the two agreed" is one
-- nobody reads. Ambiguity is `assignee` being present, non-empty and different
-- from `owner_user_id`. Everything else needs no decision.
--
-- `decided_at` is `datetime('now')` — the moment the upgrade ran, which is the
-- only honest stamp available: the migration cannot know when the divergence
-- happened, and inventing a plausible-looking historical time would be worse than
-- recording when it was noticed.

-- 3a. AGENT LABELS — record, do not adopt.
INSERT OR IGNORE INTO ownership_migration_dispositions
  (migration, entity_kind, entity_id, resolved_owner, retired_assignee, disposition, decided_at)
SELECT
  '20260912164233_a2-ownership-backfill',
  'issue',
  id,
  owner_user_id,
  assignee,
  'kept-owner-assignee-was-agent-label',
  datetime('now')
FROM issues
WHERE assignee IS NOT NULL
  AND assignee <> ''
  AND assignee <> owner_user_id
  AND assignee LIKE 'agent:%';
--> statement-breakpoint

-- 3b. IDS THAT RESOLVE TO NO ACCOUNT — record, do not adopt.
INSERT OR IGNORE INTO ownership_migration_dispositions
  (migration, entity_kind, entity_id, resolved_owner, retired_assignee, disposition, decided_at)
SELECT
  '20260912164233_a2-ownership-backfill',
  'issue',
  id,
  owner_user_id,
  assignee,
  'kept-owner-assignee-unknown-account',
  datetime('now')
FROM issues
WHERE assignee IS NOT NULL
  AND assignee <> ''
  AND assignee <> owner_user_id
  AND assignee NOT LIKE 'agent:%'
  AND assignee NOT IN (SELECT id FROM users);
--> statement-breakpoint

-- 3c. A REAL PERSON — record, then adopt. The INSERT is first so the retired
--     value is durable before the UPDATE overwrites the thing it disagreed with.
INSERT OR IGNORE INTO ownership_migration_dispositions
  (migration, entity_kind, entity_id, resolved_owner, retired_assignee, disposition, decided_at)
SELECT
  '20260912164233_a2-ownership-backfill',
  'issue',
  id,
  assignee,
  assignee,
  'adopted-assignee-as-owner',
  datetime('now')
FROM issues
WHERE assignee IS NOT NULL
  AND assignee <> ''
  AND assignee <> owner_user_id
  AND assignee NOT LIKE 'agent:%'
  AND assignee IN (SELECT id FROM users);
--> statement-breakpoint

UPDATE issues
SET owner_user_id = assignee
WHERE assignee IS NOT NULL
  AND assignee <> ''
  AND assignee <> owner_user_id
  AND assignee NOT LIKE 'agent:%'
  AND assignee IN (SELECT id FROM users);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. THE TWO WATERMARKS, SEEDED CONSERVATIVELY
-- ---------------------------------------------------------------------------
-- `assignment_revision` and `input_revision` (added by the previous migration)
-- have no history to recover: nothing recorded WHEN a task's owner or brief last
-- moved, and inventing an earlier value would be a claim the data cannot support.
--
-- So both are seeded to the row's CURRENT `revision`, which reads as "as far as
-- this instance knows, both last moved at the row's latest write". That fails
-- CLOSED: a worker holding a revision it read before the upgrade compares as
-- STALE and re-reads, which is the safe direction. Seeding `1` would fail open —
-- every pre-upgrade worker would compare as current against work whose owner may
-- well have changed while it was running, which is the failure these columns
-- exist to prevent.
--
-- `WHERE ... IS NULL` so this is idempotent and so a row written between the two
-- migrations keeps the value its writer chose.
UPDATE issues SET assignment_revision = revision WHERE assignment_revision IS NULL;
--> statement-breakpoint
UPDATE issues SET input_revision = revision WHERE input_revision IS NULL;
