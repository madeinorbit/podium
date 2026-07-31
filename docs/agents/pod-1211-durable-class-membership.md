# POD-1211 — the fourteen, classified, and the membership gate

Companion to [`pod-385-matrix-coverage-sweep.md`](./pod-385-matrix-coverage-sweep.md), which is
the evidence. This file is the **adjudication and the gate**: what each class was classified as,
why, what was deliberately *not* decided, and how the gate was proved able to say NO.

## What changed under the sweep before it was worked

**Thirteen, not fourteen.** POD-1076 landed `recap_watermarks` as a per-user-state row on this
integration branch. Its commit also records two explicit DECLINES — `notification_facts` and
`message_wake_cooldowns` — for the reason adjudicated again independently here: the per-user
family requires `writers: ['operator']` and `systemWriter: 'never-writes'`, and both tables are
written by the server as `system`. Adopting them into that family would have been a false
declaration.

**And the sweep's own count was low, because its method could not see three populations.** Limit 2
said so; this is what it cost:

| Missed | Why the method could not see it |
|---|---|
| `feed_identity` | Declared in `packages/sync/src/adapters/sqlite/schema.ts` — the SECOND drizzle schema file. `drizzle.config.ts` unions both into one journal; the sweep enumerated one. |
| `issue_ref_letters` | Named inside another row's `sites` prose, so it read as covered. It is an allocation counter with its own columns, not part of the row that mentions it. |
| `<stateDir>/discovery.db` (+ `conversation_cache`, `meta`) | A SECOND SQLite database, created at runtime with `CREATE TABLE IF NOT EXISTS`. Drizzle does not manage it and no schema mentions it. |
| `<stateDir>/uploads`, `<stateDir>/headless-turns`, `<stateDir>/hooks` | Files. Same shape as pspec, which is the whole point of Limit 2. |

Run against the pre-POD-1211 matrix, the gate reports **21** durable stores with no row.

## The classifications

### The contested call, made with no human available

Six of the coordination-shaped classes look like `deployment-substrate` — `advisory-locks` and
`applied-mutations` are their nearest neighbours and both are substrate. **They are not classified
as substrate here.** ADR 1 Amendment 1 D9.3 makes the ratchet one-way: moving a class *toward*
privacy is per-feature policy, moving anything INTO `deployment-substrate` requires an ADR 1
amendment, because substrate means TENANT-VISIBLE and widening is always reviewed (ADR 9 D4 rule
4). This issue is chartered to classify classes that had no row. It is not chartered to widen the
tenant-visible floor, and there was no human available to take that decision.

So each is `visibility: 'personal'` with `owner: { kind: 'none', reason: 'substrate' }`, and the
row says on its face that substrate is its plausible eventual home.

Nothing is lost by waiting. None of these rows reaches a client at all (`replication: 'none'`), so
`personal` and `deployment-substrate` are indistinguishable at every surface that exists today.
What IS gained is that the class is now *declared*: before this, an unclassified class and a
deliberately-private one returned the same value from `visibilityClassOf` and both read green.
`matrix.test.ts`'s exhaustive tenant-visible floor is unchanged, which is the mechanical form of
the same statement — this change widens nothing.

The shared shape is `serverBookkeeping` in `matrix.ts`, declared once so the reasoning cannot
drift between rows.

| Class | Row | Visibility |
|---|---|---|
| `maintenance_leases` | `maintenance-lease` | personal / no owner |
| `maintenance_commands` | `maintenance-command-receipts` | personal / no owner |
| `steward_state` | `steward-state` | personal / no owner |
| `notification_facts` | `notification-facts` | personal / no owner, **O1** |
| `message_wake_cooldowns` | `message-wake-cooldowns` | personal / no owner |
| `repo_draft_seq`, `issue_ref_letters` | `id-allocation-counters` | personal / no owner |
| `subscription_deliveries` | `subscription-deliveries` | personal / no owner |
| `feed_identity` | `feed-identity` | personal / no owner |

Two rows for the janitor rather than one, on POD-731's test: the LEASE is a lease machine (`cmd`)
and the RECEIPTS are dedupe bookkeeping (`single-writer`). One row cannot carry two conflict
rules, and a note is not a column a totality test can check.

`notification_facts` carries an **O1** note: the claim set discloses who was notified about which
issue. It reaches no surface today; any future one (a "why didn't I get pinged" diagnostic is the
obvious candidate) must decide that per O1 rather than inheriting this row's silence.

### The client-facing ones

| Class | Row | Visibility | Owner |
|---|---|---|---|
| `podium_events` | `activity-events` | personal | derived — follows its SUBJECT, like `blobs` |
| `subscriptions` | `event-subscriptions` | personal | the subscriber's human |
| `offers` | `agent-offers` | personal | inherits its session |

`activity-events` carries the sharpest Phase 2 note in this batch: `issues.events` is a **cursor
read over every subject in the instance with no per-principal filter**. The scoped feed must
filter it the way it filters the change log — and a filter without a watermark here is a silently
short page rather than a protocol break, which makes it easier to get wrong and harder to notice.
Its attribution cell records an inventory gap rather than fixing it: the table has no actor
columns at all.

### The rest

| Class | Row | Visibility |
|---|---|---|
| `session_observation_checkpoints` / `_rebinds` / `session_terminal_candidates` | `session-observation-bookkeeping` | personal, inherits session |
| `<stateDir>/uploads/<sessionId>/` | `session-uploads` | personal, inherits session |
| `<stateDir>/headless-turns/<hash>/` | `headless-turn-spool` | personal, inherits session |
| `<stateDir>/discovery.db` | `harness-discovery-cache` | owned-compute, inherits machine |
| `<stateDir>/hooks/` | `harness-hook-settings` | owned-compute, inherits machine |

The three observation tables are ONE row because nothing disagrees: same key, same writer, same
conflict rule, same tombstone, same replication. That is the same test that split the workflow
surface into five.

`headless-turn-spool` is `secret-presence` and is the one worth reading twice: `input.txt` is the
prompt, `stdout.jsonl` is the agent's whole output, and `mcp.json` is a harness config that can
name credentials — conversation content and configuration on a plain filesystem path, with no row
in any schema to make anyone look.

### Rows that already existed and now name what they classify

The six POD-385 listed (`approval_requests`, `automation_runs`, `conversation_identities`,
`conversation_segments`, `issue_comments`, `messaging_issue_topics`), plus seven that landed
since (`users`, `user_credentials`, `server_secrets`, `telegram_chat_bindings`, and POD-1076's
`session_user_state` / `issue_user_state` / `issue_message_user_state`), plus the state-dir paths
behind `artifacts`, `blobs`, `handoff-bundle` and `instance-id`.

The per-user rows' `sites` also stopped saying "a singleton today" about tables POD-1076 has
already re-keyed. `snooze` is now explicitly labelled as **the one member still keyed on the
entity alone**.

## The gate

`scripts/audit-durable-classes.ts`, run by `scripts/audit-durable-classes.test.ts` — in the unit
lane, because CI runs `bun run test` and an auditor in a mode nobody invokes proves nothing.

Four checks over three populations, because no single population sees the others:

1. **Drizzle tables** — *both* schema files.
2. **Runtime-created tables** — executed `CREATE TABLE`, in databases drizzle does not manage.
   Reads the `${CONST}` form, because the mobile replica names all four of its tables that way and
   a literal-only scanner would report that file clean.
3. **Durable write sites** — every module that writes to the filesystem or opens a database. This
   is the population that contains pspec. A module cannot store durable state without writing it,
   whatever the state is called and wherever it lives.
4. **Membership** — every declared store names a row that EXISTS in `OWNERSHIP_MATRIX_INDEX`, or
   carries a written reason it is not an entity class. It never calls `visibilityClassOf`, which
   is total and answers `personal` both for a row that was never written and for one that was
   merely misspelled.

Check 3 is at FILE granularity, not path granularity, deliberately: a path scanner has to
understand how each module composes its paths and goes quietly blind the moment one stops using
the shape it knows.

### Proof it can say NO

Nine planted-fixture probes run before the gate, always, each asserting both halves — the check
finds its violation, and stays quiet on the clean counterfactual. On top of that, four mutations
against the real repo:

| Mutation | Reported |
|---|---|
| Mistyped one live row id (`notification-facts` → `notification-factz`) | `store-names-a-row-that-does-not-exist` |
| Added a table to `schema.ts` | `drizzle-table-undeclared` |
| Added a module calling `writeFileSync` | `write-site-unaccounted` |
| Added a module executing `CREATE TABLE IF NOT EXISTS shadow_index` | `runtime-table-undeclared` |

And the historical one: against the pre-POD-1211 matrix, 21 findings.

### What the gate still cannot see

Stated, because an instrument's reach is part of its result.

- **It does not check that a classification is RIGHT** — POD-385's Limit 3, unchanged. A store
  mapped to a plausible-but-wrong row passes.
- **The migration ledger is excluded by path** from check 2. It embeds every historical
  `CREATE TABLE` as text, including tables dropped long ago. Safe, because those statements are
  generated from the schemas check 1 enumerates.
- **`*-spec.ts` conformance modules are excluded** from the source scan (today: the two SQLite
  driver specs, imported only by tests, writing to the OS temp dir).
- **A store written by a module the write-site scan already accounts for** can be added without a
  new finding — e.g. a second directory created by `durable-headless.ts`. The check catches new
  WRITERS, not new paths from old writers.
