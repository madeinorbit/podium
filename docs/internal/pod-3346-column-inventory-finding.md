# POD-3346 — the stale sessions column inventory

## What was wrong

`apps/server/src/migrations/per-user-state-family.test.ts`, the test
`"the shared entity rows keep everything else and lose exactly the five columns"`,
compares the `sessions` column set after the FULL migration chain against
`before.session` (read from the pre-migration DB with `PRAGMA table_info`) plus a
HAND-WRITTEN list of the additions every LATER migration in the chain makes.

`20260830003000_session-requested-driver` added `sessions.requested_driver_id` on
30 August. The list was not updated, so the test has failed since:

```
AssertionError: expected [ 'account_id', …(55) ] to deeply equal [ 'account_id', …(54) ]
+   "requested_driver_id",
```

## Was the addition legitimate? Yes.

Commit `574e26660`, "Expose experimental session drivers" (POD-3102, 2026-08-30).
It is a complete, coherent feature change across 17 files: the drizzle schema
(`schema.ts`), the migration, `SessionRow`, the sessions store and repository,
session start/revival/client-plane, the daemon inventory, the `NewPanelMenu` UI
with its own tests, and a new `runtime-drivers` edge-visibility feature flag in
`packages/protocol/src/features.ts`.

The column's purpose is a genuine distinction, not a duplicate of what was there:
`selected_driver_id` records the driver a launch RESOLVED to (possibly a
fallback); `requested_driver_id` preserves what the start actually ASKED for,
independently of that fallback. That is a fact you cannot reconstruct from the
resolved value, so it needs its own column.

So this is case one — the schema changed as intended and nobody updated the list.
The fix is the test. Applied: `requested_driver_id` added to the additions list
with a comment in the file's existing style saying which migration added it and
why it is an ADDITION rather than a column the migration under test lost.

## Not shared with POD-3336

POD-3336 is diagnosing the services and contracts lanes. This failure's cause is
one `ALTER TABLE sessions ADD requested_driver_id` meeting one stale literal in
one migration test; the whole `apps/server/src/migrations/` suite is green with
that literal corrected (22 files / 174 tests). No other test file in the repo
mentions `requested_driver_id`/`selected_driver_id` in an inventory assertion, so
POD-3102 has no second stale-list victim for POD-3336 to be seeing. Nothing to
collapse; no mail sent on that ground.

## The design question: should this stay a hand-written list?

**Recommendation: keep it hand-written, but change its SUBJECT — and then the
hand-written part disappears on its own.**

The framing "derived list cannot drift but cannot catch an accident" is right in
general, and a derived list is the wrong answer here specifically: derive the
expectation from `schema.ts` and an accidental column in `schema.ts` appears on
both sides of the assertion, which guts the guard. That is not a trade to make.

But this assertion is not really a hand-written inventory. Its base
(`before.session`) is already DERIVED, by PRAGMA, from the pre-migration
database. Only the ADDITIONS list is hand-written — and those additions are made
by migrations that run AFTER the one under test. They are not this test's
subject. The test owns one property: *this* migration drops exactly five columns
and loses nothing else. It inherited the additions list purely because it runs
`runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)` — the whole chain — instead of
stopping at the migration it is about.

Stop at the cut and the hand-written list is not replaced by a derived one, it is
simply unnecessary:

```ts
runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex() + 1))
expect(sorted(columns(db, 'sessions'))).toEqual(sorted(before.session))
```

`cutIndex()` and the partial-chain application already exist in this file —
`preMigrationDb()` uses `slice(0, cutIndex())`. The change is one slice and the
deletion of three literal lists.

What this buys, and what it costs:

- The accident guard gets STRONGER, not weaker. Today an unintended column added
  by a later migration is indistinguishable from a legitimate one — both are
  "add a line to the list", and the author does so with no context about the
  migration under test. Cut at the migration and the expected set is pinned
  exactly, derived entirely from the observed pre-state.
- The drift disappears at the source. Every additive migration to `sessions`,
  `issues` or `issue_messages` currently breaks a test belonging to an unrelated
  migration, and the author who adds the column gets no signal that this file
  exists. That is exactly how this sat red for four days.
- What is given up: nothing this test was the sole owner of. "A later migration
  did not accidentally drop a column" is a property of THAT migration and belongs
  to its own test; the file's own `'a FRESH database boots straight into the new
  shape'` case still exercises the full chain end to end.

Not sufficient on its own, but worth recording: `bun run audit:migration-drift`
(the POD-3341 gate — which was itself motivated by this very migration) already
pins head-snapshot-vs-`schema.ts`. It does not catch a `schema.ts` mistake, so it
does not subsume this test; it does mean the chain has an independent
"schema is what we think it is" check, and this test does not need to be a second
one.

Filed as a sub-issue under POD-3221 rather than done here: it changes an
assertion, spec rule 21 governs who may do that, and the scope of this issue is
one edit.
