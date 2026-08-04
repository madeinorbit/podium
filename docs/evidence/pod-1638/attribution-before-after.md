# POD-1638 — the three stall queries, before and after

Measured 2026-08-04 on `issue/1638-fix-the-three-queries-that-stall-the-loo`, branched
off `issue/279-integration`.

## How this was measured

The POD-1630 attribution instrument, extended two ways for this issue (both
default-off):

- **Lifetime totals.** `server.ts` resets the attribution window every 1000ms so a
  stall line reports the second that stalled. Reading that window from outside its
  reset cadence answers nothing — the first attempt here measured ~0 statements over
  20s for exactly that reason. `queryAttributionTotals()` accumulates and is never
  reset.
- **Caller stacks.** `PODIUM_LOOP_PROFILE_STACKS` samples a stack per statement
  execution and aggregates identical stacks per statement key. Gated separately from
  `PODIUM_LOOP_PROFILE` because capturing a stack is far dearer than the timing pair.

Harness: boot the real server (no daemon, no clients) against a **copy** of the live
database — `sqlite3 ~/.podium/podium.db ".backup <tmp>/podium.db"` — with
`PODIUM_STATE_DIR` in a temp dir and a non-18787 port; settle 5s; measure 30s of idle.
The live instance was never touched.

> Trap worth recording: a fresh worktree here has **no `node_modules`**, so every
> `@podium/*` import silently resolves to the MAIN checkout. The first run measured
> main, not this branch. `bun install` in the worktree, then check `require.resolve`.

Fixture: 1607 issues, 13 repos, 1199 sessions, 7592 `applied_mutations` rows.

## Result

Statement counts over one 30s idle boot (counts and rows — the count is the defect,
the duration is a symptom that moves with load):

### The numbers that ship — base `ec2cf9928`

Both arms measured on the SAME base (`issue/279-integration` @ `ec2cf9928`), one
tree, only the three behaviour files reverted for the before-arm (the instrument
changes carry no behaviour and stayed in both arms so the harness is identical):

| statement | before | after |
|---|---|---|
| `SELECT * FROM issues WHERE id = ?` | 32474x / 31836 rows | 22198x / 21763 rows |
| `SELECT * FROM grants WHERE resource_kind = ? AND resource_id = ?` | 24992x | 17040x |
| `SELECT machine_id, path, origin_url, repo_id FROM repos ORDER BY rowid ASC` | 1278x / 16614 rows | **0** |
| `SELECT repo_id, prefix FROM repo_prefixes` | 1278x / 10224 rows | **0** |
| `SELECT prefix FROM repo_prefixes WHERE repo_id = ?` | 971x | **0** |

### Correction: the 24206x/sec in the brief is no longer the base

The brief's repo-scan figure, and the 22209x I first measured, were both true —
against `9404eab40`, the base this branch was cut from. **POD-1618 landed in
`ec2cf9928` and memoized the per-session lookups**, which took the same statement
from 22209x to 1278x before this change touched anything.

So the honest claim for what ships is **1278 -> 0, not 22209 -> 0**. The scan is
eliminated either way — a repo list is read once per pass rather than per session,
and that property does not depend on which base you measure it from — but the
*credit* for the first 20931 belongs to POD-1618.

Recording this because it is the trap the number invites: a count measured on the
base you branched from stops being true the moment the base moves, and it will
still look like a clean before/after. Every count here now carries its SHA.

For the record, the original measurement against `9404eab40`:

| statement | before (`9404eab40`) | after |
|---|---|---|
| `repos ORDER BY rowid ASC` | 22209x / 288717 rows | 0 |
| `repo_prefixes` (full) | 22209x / 177672 rows | 0 |
| `repo_prefixes WHERE repo_id = ?` | 21902x | 0 |
| `issues WHERE id = ?` | 34728x | 24928x |

`DELETE FROM applied_mutations WHERE applied_at < ?`, on a copy of the live table
(7592 rows, ~21MB of `result` payload):

```
before:  QUERY PLAN `--SCAN applied_mutations
after:   QUERY PLAN `--SEARCH applied_mutations USING INDEX
                      idx_applied_mutations_applied_at (applied_at<?)
```

## The three defects were not one defect

### 1. `SELECT * FROM issues WHERE id = ?` — 37121x/sec. TWO callers, not one.

The caller stacks named both. Both call the same thing — the reader-scoped session
projection, `modules/sessions/view.ts list()` — from inside a loop:

```
getIssue <- computeDisplayRef (view.ts:118) <- stampRef (view.ts:106) <- map
         <- reapIfEmptyDraft (issues/service/attention.ts:195)
         <- reapLeakedDrafts (attention.ts:218) <- boot (service/index.ts:288)

getIssue <- sessionOwner (session-authz.ts:195) <- canReadSession (…:190) <- filter
         <- list (view.ts:39)
         <- flushDeliveryTriggers (messages/scheduler.ts:244)
         <- runReconcilePage (scheduler.ts:331)
```

`listSessions()` is not an accessor — it is a projection that runs an authorization
check and a display-ref resolution **per session**, each hitting SQLite. The boot
draft sweep rebuilt the whole thing once per draft, so it cost drafts x sessions.

**Fixed here:** `reapLeakedDrafts` hoists the session read (and the child-count scan)
to once per pass, and batches the purges so the sweep publishes **one** full-list
reconcile instead of one per reaped draft. `reapLeakedDrafts` no longer appears in the
caller stacks at all.

**Not fixed here, deliberately:** the entire 24928 residual attributes to
`flushDeliveryTriggers`/`runReconcilePage`. That is the message-delivery reconcile
calling `view.list()` once per page, and it is POD-1639's scope by agreed split
(POD-1639 owns `view.ts`, `session-authz.ts`, `session-state/service.ts`,
`messages/scheduler.ts`; this issue touched none of them). Handed over with the
stacks above. It is the largest remaining CPU item in the stall window.

### 2. `SELECT ... FROM repos ORDER BY rowid ASC` — 24206x/sec. Independent.

Not the same defect as (1), and not fixed by fixing (1): even a **single**
`list()` over 1199 sessions full-scanned `repos` 1199 times, because
`computeDisplayRef -> prefixForPath -> resolveRepoIdForPath` re-read the whole
registry per session. A 13-row table read 22209 times for 288717 rows.

**Fixed:** `ReposRepository` holds the registry read (rows + prefix map) and serves
`listRepos`, `prefixForRepoId` and the machine-scoped variant from it.

Invalidation is **structural rather than a checklist**: the cache is dropped by a
`prepare` wrapper whenever a statement writing `repos`/`repo_prefixes` executes on
this connection, so a mutator added later cannot forget to invalidate. Paired tests
assert that a repo registered, removed, or re-prefixed after the first read is seen —
so the cache cannot pass by never reading, nor by caching forever.

### 3. `DELETE FROM applied_mutations WHERE applied_at < ?` — 1x, 1529ms, 0 rows.

Confirmed with `EXPLAIN QUERY PLAN` before and after, as the brief asked.

Worth stating precisely: the cost is **not** "7592 rows is slow". A table scan walks
the rows themselves, so it reads every row's `result` payload — ~21MB, ~5000 pages —
to delete nothing. One index turns it into a `SEARCH` over the cutoff range that
touches no rows at all in the steady state.

**Fixed:** `idx_applied_mutations_applied_at`, declared on the sync adapter's schema
(which owns the table) and shipped as migration
`20260804050000_index-applied-mutations-applied-at`.

> Migration authoring note: `drizzle-kit generate` **cannot run on this branch** —
> it aborts with "Non-commutative migrations detected — 3 conflicts across 2
> migrations" (`sort_key` on issues, `maintenance_commands`,
> `session_observation_checkpoints`, each created on two lineages). This reproduces
> on the clean base with no changes of mine, so it is pre-existing. The migration was
> therefore hand-authored and the manifest regenerated with
> `scripts/build-drizzle-manifest.ts`, which is what the runtime applier actually
> reads (no snapshot/journal files are committed in this repo). Verified end-to-end:
> the migration applied on boot to a copy of the live database and the plan flipped.
> The lineage repair is filed separately.

## Tests

- `apps/server/src/store/repos-read-cost.test.ts` — counts statements against a real
  migrated database; 50 resolutions must not be 50 scans, paired with four
  invalidation assertions.
- `apps/server/src/modules/issues/service/reap-drafts-cost.test.ts` — asserts the
  **scaling**: sweeping 50 drafts costs the same number of session reads as sweeping
  25. Verified to fail (102 vs 52) with the hoist reverted.
- `apps/server/src/migrations/applied-mutations-retention-index.test.ts` — asserts the
  query PLAN, not a duration, and that the delete still removes exactly the rows below
  the cutoff.
