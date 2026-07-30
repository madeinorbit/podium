# POD-385 — is pspec the only entity class missing from ADR 1's matrix?

**Answer: no.** 14 further durable classes have no matrix row, and 6 rows exist but do not
name the table they classify. Evidence, method and the method's limits below.

**Nothing here is adopted.** POD-385 added exactly one row (`pspec-component`), the one its own
contracts needed. A wrong classification is worse than a missing one, so the rest are NAMED for
the coordinator to file as a sweep, not classified here.

## Why this needed asking

`visibilityClassOf` is TOTAL and default-closed: an id it has never heard of resolves to
`personal`. On the safety axis that is ADR 9 D4 working exactly as designed. As a DETECTOR it
fails completely — a class nobody ever classified and a class deliberately classified `personal`
return the same value, and both read green.

POD-731 found the same shape one level down (a *mistyped* row id also resolves `personal` and
passes) and its fix is the one to generalise: **membership on the matrix is a separate obligation
from classification, and has to be asserted independently.** POD-385 is the proof that the hole
admits a whole missing CLASS and not merely a typo — pspec had no row at all, and every gate in
the repo was green about it.

## Method, and what it cannot see

1. Enumerated the 54 tables declared in `apps/server/src/migrations/schema.ts` (`sqliteTable("…")`).
2. Diffed against every table name mentioned ANYWHERE in `packages/model/src/annotations/matrix.ts`
   — not just the `sites` column.
3. Adjudicated the residue by hand against the 58 row titles.
4. Confirmed each surviving candidate is LIVE: referenced from non-migration source under
   `apps/server/src` or `packages/`.

**Limit 1 — the `sites` column is not an audit instrument.** It is free-form: some rows name
tables (`` `locks` ``, `` `lock_waiters` ``), others name modules
(`apps/server/src/modules/issues/service/crud.ts`) or prose ("the disk lake"). Matching table
names against `sites` alone reported 27 false-positive gaps. Step 2 exists because of that.

**Limit 2 — SQLite tables are not the whole population.** pspec itself is the counterexample: it
is files in a repo working tree and appears in no schema at all. A complete sweep must also cover
filesystem-backed and daemon-local durable state, which this pass did not attempt.

**Limit 3 — this is a coverage sweep, not a classification review.** A class WITH a row could
still be classified wrongly; nothing here checks that.

## Covered after all — 6 rows that do not name their table (a doc gap, not a classification gap)

| Table | Row that covers it |
|---|---|
| `approval_requests` | `approval-requests` |
| `automation_runs` | `automations-and-runs` |
| `conversation_identities` | `conversation-registry` |
| `conversation_segments` | `segments` |
| `issue_comments` | `issue-comments` |
| `messaging_issue_topics` | `messaging-issue-topics` |

These are classified. Their rows just cannot be audited mechanically, which is Limit 1 as a
concrete cost — and is why a future membership gate should key on something stronger than `sites`.

## NOT COVERED — 14 live classes with no row

Grouped by the shape they look like, with the reason each matters. **These are candidates for
adjudication, not classifications.**

### Per-user-state-shaped — the family ADR 9 D3 rule 4 says is never grantable

The dangerous group, and the one the brief's warning names: keying a per-user fact as a shared
singleton is today's bug (`pins`, `tab_order`), and D4's backstop answers `personal` for all of
them, which is the WRONG class for per-user state, not merely an undeclared one.

- `recap_watermarks` — a per-reader position marker by shape.
- `notification_facts` — the notification arbiter's once-until-ack state (POD-880).
- `message_wake_cooldowns` — per-recipient suppression.

### Coordination / substrate-shaped

`advisory-locks` is already declared `deployment-substrate` on exactly this reasoning, so these
are its neighbours and are likely substrate too — which is a TENANT-VISIBLE class, i.e. the
backstop's `personal` is wrong in the widening direction.

- `maintenance_commands`, `maintenance_leases` — janitor coordination.
- `steward_state`.

### Issue-adjacent

- `subscriptions`, `subscription_deliveries` — the issue subscription surface (25 and 2 source
  files). `subscriptionSetEnabled` is one of POD-311's nine web-UI-only issue commands, so the
  command has a contract while the state it writes has no row.
- `repo_draft_seq` — draft id allocation.
- `offers` — the `podium offer` bar (30 source files, the largest of the fourteen).

### Session observation

- `session_observation_checkpoints`, `session_observation_rebinds`, `session_terminal_candidates`
  — plausibly inside `daemon-observed-runtime`'s intent, but that row's `sites` is
  `packages/model/src/entities/session.ts` and its title enumerates session FIELDS, not these
  tables. Adjacent, not covered.

### Activity

- `podium_events` — the activity event stream (7 source files). Distinct from `change-log`, which
  is the sync kernel's `changes` table.

## Deliberately excluded

- `meta` — schema metadata, not an entity class.
- `upstream_outbox` — already in `DECLARED_OMISSIONS` with a reason (retired with POD-309). The
  mechanism for saying "deliberately not classified" exists and is used; the fourteen above are
  simply absent from it.

## What the sweep issue should probably do

1. Classify the fourteen, per-table, against ADR 9 D3 — starting with the per-user-state-shaped
   three, where the default is wrong rather than merely undeclared.
2. Give the six covered-but-unnamed rows their table names.
3. **Add the membership gate**, which is the durable fix. `matrix.test.ts` today proves the
   BACKSTOP fires for an undeclared class (`some-future-entity-nobody-classified`); it does not
   and cannot prove that no real class is undeclared. A gate that enumerates the schema's tables
   and requires each to be either a matrix row or a `DECLARED_OMISSIONS` entry would have caught
   all fourteen — and would have caught pspec only if it also covered non-table stores, which is
   Limit 2 and the harder half.
