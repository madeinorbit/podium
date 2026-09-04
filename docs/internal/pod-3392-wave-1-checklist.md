# POD-3392 — wave 1, the Stage A checklist answered per file

Eight repositories: `accounts.ts`, `telegram-bindings.ts`, `user-read-position.ts`,
`user-preferences.ts`, `read-watermarks.ts`, `settings-audit.ts`, `quota-history.ts`,
`server-secrets.ts`. All eight are CONVERTED.

Everything numeric here is derived from the artefacts — the migrated database, the migrations
themselves, the coverage census, the boundary lint's own ledger — rather than read off the source by
eye, and the derivation is named at each point so it can be re-run.

Part one below was written against `57691d712`, when the conversion was blocked; part two is the
conversion, rebased onto `903784216`. The blocked section is KEPT rather than deleted, because the
blocker it records is the reason spec rules 27/27a/27b exist and the next reader deserves the
question as well as the answer.

## Part one — the blocker, since answered

**POD-3400** asked the question that had to be answered before the first method could move, and it
blocked all seven waves rather than this one:

> Every member of the executor's `QueryClient` returns a promise — `run`, `get`, `all`, `writeGet`,
> `writeAll`, `batch` (`store/executor/driver.ts:246-266`, built by `queryClientOver` at `:270`),
> and the bun driver is no exception because `createBunSqliteDriver` builds its client with the same
> `queryClientOver`. drizzle ships no synchronous proxy driver: `sqlite-proxy` is async only, and the
> one synchronous driver, `bun-sqlite`, needs the raw handle rule 13 bans and the exit gate deletes.
> So a method that reaches the database through the executor's client returns a promise, and one that
> stays synchronous is still on the raw handle. The wave briefs say sync forms only; spec rule 11 says
> signatures are async. Both cannot hold in one commit.

Wave 2 (POD-3393) hit the identical wall independently and mailed the coordinator the same finding.
Two workers reaching the same conclusion separately is the evidence that it was the mechanism and not
a local misreading.

ANSWERED by spec rules 27, 27a and 27b: the EXECUTOR owns a synchronous drizzle instance built over
the INSTRUMENTED wrapper, and a repository takes it in its constructor. Rules 34 and 34a then fixed
its shape — one capability object, named in the constructor and nowhere else, with `db` a getter.

## What is NOT in question — the conversion shape

`store/spike/turso-append/sync-append.ts` is already a worked example and this wave will follow it
exactly, whichever way POD-3400 is answered:

1. drizzle is a QUERY BUILDER, never an executor. Build the query, call `toSQL()`.
2. NARROW the bound parameters rather than asserting them — drizzle types them `unknown[]`, and an
   unbindable value is a defect in the query that should say which one (`toSqlParams`, `:113`).
3. Issue a `Statement` with an explicit `method` AND an explicit `intent`.
4. **Map result rows back BY PHYSICAL COLUMN NAME.** drizzle's builder emits physical names and only
   drizzle's own execution path maps them back, so a row that comes back through the port is keyed
   `entity_id`, not `entityId`. Casting instead of mapping compiles, runs, and yields `undefined` for
   every renamed column — the spike's own first version did exactly that and quietly reported `false`
   for a contract the engine was in fact keeping.

Point 4 will bite every wave and deserves a place in the spec's §6 in its own right.

## Write intent, declared per method

The brief's one-thing-you-cannot-get-wrong-silently. Wave 1 has no `RETURNING` write, so no method
here is in the trap POD-3321 found — but the declaration is still made per method rather than
inferred, and "when in doubt, declare write" is applied.

| Repository | reads (`get`/`all`) | writes (`run`) | writes returning rows |
| --- | --- | --- | --- |
| `accounts.ts` | `list`, `get` | `upsert`, `remove` | none |
| `telegram-bindings.ts` | `list`, `listForUser` | `upsert`, `remove` | none |
| `user-read-position.ts` | `getSnapshot`, `get` | `advance` | none |
| `user-preferences.ts` | `getFor`, `get`, `keysFor` | `set`, `clear` | none |
| `read-watermarks.ts` | `getRecapWatermark` | `setRecapWatermark` | none |
| `settings-audit.ts` | `list` | `append` | none |
| `quota-history.ts` | `list`, `trail`, `countAll` | `record`, `prune` | none |
| `server-secrets.ts` | `get`, `getOrEmpty`, `apiKeyFor`, `updatedAt`, `presence`, `getNativeLoginTransfer` | `set`, `clear`, `putNativeLoginTransfer`, `clearNativeLoginTransfer` | none |

`quota-history.record` is the one to watch at conversion time: it is read-decide-write (it selects the
current window, then either inserts or updates), so its two statements carry different intents inside
one logical operation, and the read must not be allowed to drift out of the unit of work.

## Checklist item 1 — §2.7 constructs, and every column on an `OR REPLACE`

**No §2.7 construct appears in any of the eight files.** Derived rather than eyeballed: no `PRAGMA`,
no `sqlite_master`, no `ATTACH`, no `sql.raw`. There is also no dynamic SQL at all — a grep for
`${` inside these files returns three hits and all three are in error-message strings or a key
literal (`user-read-position.ts:100`, `user-preferences.ts:122`, `server-secrets.ts:168`), none in a
SQL body. So checklist item 8 (does a dynamic `IN` list bound the number of distinct SQL texts) is
vacuous for this wave: there are no `IN` lists and the statement cache sees a fixed set of texts.

**The four `INSERT OR REPLACE` sites all convert cleanly.** drizzle-orm 1.0.0-rc.4 has no
`INSERT OR REPLACE` for SQLite — `onConflictDoUpdate` and `onConflictDoNothing` only — so each site
becomes an `onConflictDoUpdate` naming a conflict target. Wave 2 warned (POD-3403) that the two forms
DIVERGE where a table has more than one uniqueness constraint: `OR REPLACE` resolves a conflict on
any constraint, `ON CONFLICT` resolves one named target and RAISES on the other. That warning does not
bite here, and the check was run rather than assumed.

Derived from the migrated database (`pragma_index_list` + `pragma_index_info` over the full migration
chain, plus an `INTEGER PRIMARY KEY` scan of the DDL for the rowid case):

| Table | uniqueness constraints | columns named by the INSERT | inbound foreign keys |
| --- | --- | --- | --- |
| `accounts` | 1 — pk `(id)` | 7 of 7 | none |
| `telegram_chat_bindings` | 1 — pk `(chat_id)` | 6 of 6 | none |
| `user_preferences` | 1 — pk `(user_id, key)` | 4 of 4 | none |
| `user_read_position` | 1 — pk `(user_id, stream_id)` | 5 of 5 | none |
| `recap_watermarks` | 1 — pk `(reader, session_id)` | 4 of 4 (already `ON CONFLICT`) | none |
| `server_secrets` | 1 — pk `(key)` | 3 of 3 (already `ON CONFLICT`) | none |
| `quota_windows` | 1 — pk `(account_key, window_key, resets_at_bucket)` | already `ON CONFLICT` | none |
| `settings_audit_events` | 1 — rowid `INTEGER PRIMARY KEY` | append-only, no conflict clause | none |

One constraint each, so the target is unambiguous. Every column named, so the OTHER difference
between the forms is also neutralised: `OR REPLACE` DELETES the row and reinserts it, which reverts
any column the INSERT omits back to its default, while `DO UPDATE` preserves it — with a full column
list the two agree. And no table has an inbound foreign key, so the delete-then-insert cannot cascade
into a child table the `DO UPDATE` form would have left alone. That third check is the one a reader
would most likely skip; it is included because `OR REPLACE`'s cascade is a real behaviour change and
it is invisible in the statement itself.

A correction for wave 2's mail: `telegram-bindings.ts` has ONE `INSERT OR REPLACE` (`:120`), not two.
The other write in that file is a `DELETE` (`:138`). Four sites in this wave, not five.

## Checklist item 2 — JSON columns, quarantine or throw

Every JSON column in this wave is read through a HAND parse today, and the conversion keeps it. None
of these becomes `mode: 'json'`, and the spec settles two of them by name.

| Column | today | conversion |
| --- | --- | --- |
| `settings_audit_events.detail_json` | `parseJson` → `undefined` on corrupt | keep the hand parse — spec rule 4 names this column as one of three that pass a wrong-shape value straight through, and says tightening it is a behaviour change |
| `settings_audit_events.redacted_paths` | same, then `?? []` | keep, same rule |
| `user_preferences.value` | `JSON.parse` per row; `getFor` SKIPS an unparseable row, `get` does not | keep both, and keep them DIFFERENT — the asymmetry is deliberate and documented at the method |
| `quota_windows.trail_json` | `JSON.parse` behind a shape check | keep |
| `server_secrets.value` | `JSON.parse` then `PortableCredentialBundle.safeParse` | keep — the zod parse is the decision, not the driver working around `unknown` |

`settings-audit.ts`'s `parseJson` returns `undefined` for a corrupt value rather than `{}`, with a
comment saying why: a row whose detail cannot be parsed is a different fact from one that had no
detail, and collapsing them in an audit trail hides the only symptom a corruption would show. That is
a mapper line that is a DECISION under rule 6 and it stays with its comment.

## Checklist item 3 — mapper lines that are decisions, and item 4 — brands

The mapper lines that go are the ones that exist only because the driver returned `unknown`: the
`as Record<string, unknown>` reads and the per-field casts in `settings-audit.list`, and the `Row`
interfaces in `accounts.ts` and `telegram-bindings.ts` that restate the physical column names.

The ones that STAY, each a decision:

- `accounts.ts:39,43` — `kind === 'oauth' ? 'oauth' : 'api-key'` and `scope === 'ambient' ? 'ambient'
  : 'role'`. These are not casts; they are a closed-vocabulary refusal that fails to the safe member.
  A stored value outside the union becomes the conservative one rather than flowing through.
- `settings-audit.ts` — `parseJson`'s `undefined`, above.
- `user-preferences.ts` — `getFor` skipping an unparseable row while `get` does not.
- `server-secrets.ts` — the `PortableCredentialBundle.safeParse`, which is a boundary validation rule
  5 explicitly keeps.

Brands: `sessionId` on `recap_watermarks`, `userId`/`streamId` on `user_read_position`, `id` on
`accounts` and the rest already carry `$type<…>()` in `schema.ts`, so they flow from the schema under
rule 3 and no re-entry cast is needed. This wave adds no `as` of a branded id.

## Checklist item 5 — spans; item 6 — non-database calls inside a span; item 7 — `undefined` params

No method in these eight files opens a transaction, and none crosses repositories. `quota-history.record`
is the only read-decide-write, and it is within one table.

Nothing inside any of these methods calls something that is not the database — no logger, no event
publish, no mail. So this wave contributes NOTHING to the B-prep ledger, which is consistent with why
these eight were cut as wave 1.

No bound parameter can arrive as `undefined`: every nullable column is written as an explicit `null`
at the call site (`actorId`, `onBehalfOf`, `seenAt`), and `user-preferences.set` binds
`JSON.stringify(value ?? null)`, which is the string `"null"` and never `undefined`.

## Checklist item 9 — test setups that change

`user-preferences.ts` is the one file in this wave whose constructor does not take a `StoreExecutor`:
it takes a raw `SqlDatabase` (`:69`). Converting it therefore changes its construction sites. Three
are test setups I may edit and will list in the commit message
(`migrations/personal-preference-store.test.ts:260,309,353`).

**The fourth is a wave-boundary error and I have not touched it.** The only production construction
site is `store/settings.ts:53` — `new UserPreferencesRepository(this.db)` — and `settings.ts` belongs
to wave 2. Converting my file forces an edit to theirs, which my brief says to stop on rather than
resolve locally. Wave 2 found the same collision from its side and has asked the coordinator to rule
on the sequencing; I am confirming it from mine and have changed nothing.

## Checklist item 10 — the uncovered methods, and their golden tests

From the coverage census (POD-3244), for these eight files:

| Repository | methods | never executed | no direct test |
| --- | --- | --- | --- |
| `server-secrets.ts` | 10 | 0 | 1 (`apiKeyFor`) |
| `quota-history.ts` | 5 | 0 | 0 |
| `user-preferences.ts` | 5 | 0 | 1 |
| `accounts.ts` | 4 | 0 | 0 |
| `telegram-bindings.ts` | 4 | 0 | 0 |
| `user-read-position.ts` | 3 | 0 | 0 |
| **`read-watermarks.ts`** | **2** | **2** | **2** |
| `settings-audit.ts` | 2 | 0 | 0 |

`read-watermarks.ts` is the whole of the never-executed set: both methods, no direct test and no
indirect one. Its two production callers in `modules/sessions/read-toolkit.ts` are covered only
through a `Map`-backed fake (`read-toolkit.test.ts:65`), so nothing in the tree had ever run this SQL.
Converting an unexecuted method is a rewrite with no oracle, so its golden test lands first and in its
own right — `apps/server/src/store/read-watermarks.test.ts`, eight tests, written against the
synchronous code.

What it pins, chosen for being the ways a conversion goes wrong QUIETLY rather than loudly:

- absent is `null`, not `undefined` — the caller coerces one to the other, so a wrong return would
  behave identically until some later caller distinguishes them;
- the key is the PAIR `(reader, session_id)`, asserted with two principals in both directions;
- the second write UPDATES in place — row COUNT is asserted, because `INSERT OR REPLACE` would also
  leave one row with the new watermark and pass every round-trip assertion;
- `updated_at` is read off the TABLE, because no repository method returns it and a `DO UPDATE SET`
  that forgot it would be invisible through the repository's own surface;
- the watermark may move BACKWARDS. Unlike `user_read_position.advance` this repository has no
  monotonicity rule, and a conversion that "improved" it into a `MAX()` would be a behaviour change.

The calls are awaited though the methods are synchronous today. Awaiting a non-promise is a no-op,
and it is what lets the file survive B1 unchanged — the same form the store's existing repository
tests already use, which is worth noting for POD-3400: the direct tests are already written in the
async shape, so the cost of making repositories async lies entirely in the production callers, not in
the tests.

### The golden test is mutation-checked

A new test over never-executed code proves nothing until it has been seen to fail for the right
reason. Three mutations, applied BY LINE (a bare pattern `sed` would hit the same clause in several
arms and four reds would look stronger than the three intended), each restored by copying the file
out and back — never through the shared stash.

| # | mutation | tests killed | the message |
| --- | --- | --- | --- |
| M1 | `:24` `?? null` → `?? undefined` | 2 — "a watermark never set is null, not undefined", "a non-session reader is an ordinary key" | `expected undefined to be null` |
| M2 | `:32-33` drop `updated_at = excluded.updated_at` from the `DO UPDATE SET` | 1 — "setting the same pair twice UPDATES the one row, watermark and timestamp both" | `- "updated_at": "…T10:30…"  + "updated_at": "…T09:00…"` — the stale first timestamp, named |
| M3 | `:22-23` read keys on `session_id` alone, dropping the reader half | 2 — "two readers of one session hold independent watermarks", "a non-session reader is an ordinary key" | `expected 'evt_120' to be 'evt_7'` |

Each kill is ISOLATING — it names the assertion written for that property, and the failure message
says the thing that broke rather than merely being red. M2 is the one that matters most: it is the
only assertion in the file that reaches past the repository's own surface, and it is the only one
that catches a dropped `SET` column.

## Evidence

- `PODIUM_TEST_WORKERS` **was set, to `1`**, by the environment rather than by me. The default gate is
  red or green by environment, so this is stated rather than left to be inferred.
- Golden test, unconverted code: `bun --bun vitest run --config vitest.store.config.ts
  src/store/read-watermarks.test.ts` → **1 file passed (1), 8 tests passed (8)**. The file count is
  itself a lane check: naming one file and seeing `1 passed (1)` means it ran, not that it was
  excluded.
- The shard manifest was REGENERATED, not hand-edited — `bun scripts/server-test-shards.ts --write`,
  a 3-line diff across `test-shards.json` and `turbo.json`. The lanes read an explicit file list, so a
  new test file that is not in the manifest runs nowhere and still reports green. The `store` shard
  goes from 68 to 69 files.

---

# Part two — the conversion, after rules 27a/27b and 28

The blocker recorded above was answered by the coordinator as spec rules 27, 27a and 27b: the
EXECUTOR owns the synchronous query capability (`executor.syncQueries` — a drizzle instance and a
synchronous span, together), and a repository takes it in its CONSTRUCTOR. Rules 34 and 34a then
settled its shape. All eight files are converted against that seam, on base `903784216`.

## What each repository takes

Every one of the eight takes the SAME thing: `SyncQueries`, the one capability object
(`{ db, transact }`) the executor owns — spec rules 27b, 34 and 34a. The object is named in the
CONSTRUCTOR and nowhere else; call sites read `this.db.select(...)` and `this.transact(() => ...)`.

    constructor(private readonly queries: SyncQueries) {}

    protected get db() {
      return this.queries.db          // B1 changes THIS LINE ONLY
    }
    protected transact = <T>(fn: () => T): T => this.queries.transact(fn)

`db` is a GETTER rather than an assigned field because rule 35 makes it resolve the enclosing
transaction at B1, and a field assigned once in a constructor can never do that. `transact` is an
arrow field rather than a straight assignment so it keeps its `this` when rule 35's adapter starts
using one — POD-3396's argument, adopted as the standard in rule 34a.

| Repository | takes | uses `transact` |
| --- | --- | --- |
| `AccountsRepository` | `SyncQueries` | no |
| `TelegramBindingsRepository` | `SyncQueries` | no |
| `UserPreferencesRepository` | `SyncQueries` | no — was a raw `SqlDatabase`, not an executor |
| `ReadWatermarksRepository` | `SyncQueries` | no |
| `SettingsAuditRepository` | `SyncQueries` | no |
| `ServerSecretsRepository` | `SyncQueries` | no |
| `UserReadPositionRepository` | `SyncQueries` | yes — `advance` is read-decide-write |
| `QuotaHistoryRepository` | `SyncQueries` | yes — `record` is read-decide-write |

Constructor lines changed in `store.ts`: `readPositions`, `secrets`, `settingsAudit`, `accounts`,
`telegramBindings`, `quotaHistory`, `readWatermarks` — my own seven and nothing else in that file.

## Rule 28 — the declared modes, derived rather than assumed

Rule 28 is the one that could have bitten silently, so the column set was DERIVED from `schema.ts`
per table rather than eyeballed. Across all eight tables there is exactly **one** column with a
declared mode:

    quota_windows.partial    integer({ mode: 'boolean' })

Every other column in this wave is plain `text()`, `integer()` or `real()`. So rule 28's blast radius
here is one column — and that column was already converted the way the rule requires: `toWire` and
`toInstance` read `row.partial` as a BOOLEAN, and both write sites pass `instance.partial` straight
through. The `row.partial === 1` and `partial ? 1 : 0` conversions the raw driver needed are gone,
not rewritten.

**Nothing asserted it before.** A grep of `quota-history.test.ts` for `partial` returned only the
fixture, so the exact mistake rule 28 describes would have been invisible in this file. Two tests now
pin both arms — a window first seen long after it started (`true`) and one caught at its start
(`false`) — because a test that only ever sees `false` cannot tell a working mapper from one that
always answers `false`.

### The four `partial` sites, mutated individually

Mutated BY LINE, one at a time, each restored by copying the file back:

| line | site | mutation | result |
| --- | --- | --- | --- |
| 110 | `toWire` | `row.partial` → `row.partial === 1` | **KILLED** — "a window first seen long after it started is PARTIAL" |
| 84 | `toInstance` | same | survives |
| 206 | `insert` values | `instance.partial` → `1 : 0` | survives |
| 238 | `update` set | same | survives |

The three survivors are reported rather than papered over, and neither is a hole I can close with a
test:

- **206 and 238 are EQUIVALENT MUTANTS.** The column is an integer either way — drizzle's boolean
  mode writes `true` as `1`, and writing `1` directly produces the same byte. There is no observable
  difference to assert.
- **84 is UNOBSERVABLE BY CONSTRUCTION.** `toInstance`'s `partial` feeds `foldSample`, which
  RECOMPUTES `partial` from `isPartial(firstSeenMs, …)` (`quota-history-fold.ts:341`) and discards
  the incoming value. So no input to this repository can make that field matter. It is a pre-existing
  property of the fold, not something the conversion introduced, and I have not changed it.

The one site that IS product-visible — the `list()` read every consumer goes through — is pinned and
its mutation dies by name.

## The conflict arm that no test walked

Separately from rule 28, mutation found a live gap: replacing
`MAX(peak_percent, excluded.peak_percent)` in `insert`'s `ON CONFLICT DO UPDATE` left all 13 tests
green. `record` normally reaches `insert` with a free bucket, so the clause never executed.

It is not decoration. Two window INSTANCES can share one 60-second bucket — a pool that empties keeps
almost the same reset time, so `isSameInstance` says "new instance" while `bucketOf` says "same
bucket" — and the existing row must absorb the new one and KEEP ITS PEAK, or a reset to 5% erases a
90% week. A test now covers that arm, one assertion per `DO UPDATE SET` clause, and all three folds
die under mutation:

| mutation | message |
| --- | --- |
| `peak_percent` MAX → `excluded` | `expected 5 to be 90` |
| `sample_count + 1` → no increment | `expected 1 to be 2` |
| `last_seen_ms` MAX → keep old | `expected '…T00:00:01Z' to be '…T00:00:02Z'` |

## Rulings that do NOT reach wave 1, stated as checked negatives

- **`INSERT OR IGNORE`**: none. Grepped all eight files; zero sites. The POD-3403 `OR IGNORE` ruling
  does not apply here.
- **Multi-constraint `OR REPLACE`**: none. One uniqueness constraint per table, derived from the
  migrated database (see part one). All four `OR REPLACE` sites converted to `onConflictDoUpdate`.
- **`markDelivered`**: not in this wave.
- **Source-text scanners going dark**: none over my files. The only thing that reads them as text is
  `scripts/check-boundaries.ts` — the Stage A ledger itself, whose ratchet is DESIGNED to fire when a
  listed file becomes converted. `json-column-corruption-oracle.test.ts` does call `readFileSync`,
  but on its OWN header table, not on any repository source, so conversion cannot silence it.

## The one line I could not fix, and what it costs

`store/settings.ts:53` constructs `UserPreferencesRepository`. `settings.ts` belongs to wave 2 and the
coordinator reserved that line. So on this branch it still passes a `SqlDatabase` where the converted
constructor wants a `SyncDrizzle`.

I measured the cost rather than estimating it, with a throwaway probe that applied the one-line fix,
ran the lane, and was then reverted (`settings.ts` is byte-identical to HEAD in this commit):

| lane | this branch | with the one-line probe | control (HEAD) |
| --- | --- | --- | --- |
| store | 24 failed / 873 passed | **0 failed / 897 passed** | 0 failed / 888 passed |
| services | 408 failed / 1882 passed | **36 failed / 2254 passed** | 36 failed / 2254 passed |
| boundary | 618 failed / 1748 passed | **51 failed / 2315 passed** | 51 failed / 2315 passed |

Every failure on this branch beyond the control is that one line: 484 of the boundary failures and
263 of the services failures carry the identical message, `TypeError: this.db.select is not a
function`. With the probe applied, the failing-test-NAME SETS are IDENTICAL to control in both the
services and boundary lanes — zero regression, compared by name and not by count.

The 36 services and 51 boundary failures are PRE-EXISTING on `1b231245f` and are not mine.

## God-object line counts

Requested because wave 7 recorded a pre-existing red here.

| file | before | after | delta |
| --- | --- | --- | --- |
| `store.ts` | 579 | 579 | 0 |
| `accounts.ts` | 77 | 105 | +28 |
| `telegram-bindings.ts` | 140 | 156 | +16 |
| `user-read-position.ts` | 118 | 132 | +14 |
| `user-preferences.ts` | 147 | 167 | +20 |
| `read-watermarks.ts` | 37 | 48 | +11 |
| `settings-audit.ts` | 193 | 194 | +1 |
| `quota-history.ts` | 296 | 304 | +8 |
| `server-secrets.ts` | 209 | 217 | +8 |

`store.ts` is unchanged at 579 — the seven constructor edits are in-place. The repository growth is
almost entirely the comments recording per-site decisions; the builder bodies are shorter than the
SQL they replaced.

## Setup edits, listed in full

No existing assertion was modified. These construct a repository directly and had to follow the
constructor:

- `apps/server/src/accounts.test.ts`
- `apps/server/src/store/accounts.test.ts`
- `apps/server/src/modules/sessions/account-env.test.ts`
- `apps/server/src/store/telegram-bindings.test.ts`
- `apps/server/src/store/user-read-position.test.ts`
- `apps/server/src/modules/read-position/authz.test.ts`
- `apps/server/src/store/read-watermarks.test.ts`
- `apps/server/src/migrations/server-secret-store.test.ts` (3 sites)
- `apps/server/src/migrations/personal-preference-store.test.ts` (3 sites)

New: `apps/server/src/test-support/stage-a-seam.ts`, one `stageASeam(database)` returning the
`SyncQueries` capability and refusing a non-bun handle by name (it asks `bunSqliteClient`, because
`syncQueriesOver` builds over the SqlDatabase WRAPPER and cannot itself tell). ~40 test files across the seven waves need
this; it is written once here and the coordinator has been asked to arbitrate if another wave wrote
its own.

## Evidence

Base `cad8718b7` at hand-off. The full two-arm comparison below was measured at `72e3501e0`; the three commits between the two bases were taken by rebase and the `store` lane re-run on top of them, still **85 files, 1137 passed, 0 failed** with the probe, and `apps/server` typecheck still zero errors with it. `PODIUM_TEST_WORKERS` **was set, to `1`**, by the
environment rather than by me — the default gate is red or green by environment, so it is stated
rather than left to be inferred.

### The delta, by failing-test NAME SET

The control arm is a SEPARATE DETACHED WORKTREE at `903784216`, plus one generated-file refresh
(`bun scripts/server-test-shards.ts --write`, see below) so that the only difference between the arms
is this conversion. The branch arm carries the one-line `settings.ts` probe described below, which is
NOT in the commit. No stash was used at any point, in either arm.

| lane | control | this branch |
| --- | --- | --- |
| `store` | 1126 passed, 0 failed | 1137 passed, 0 failed |
| `services` | 39 failed / 2290 | 39 failed / 2290 |
| `boundary` | 51 failed / 2367 | 51 failed / 2367 |

**The failing-test NAME SETS are identical in all three lanes** — `diff` over the sorted `FAIL` lines
is empty for each. Counts alone would not have been enough; this epic has twice had a regression hide
inside a stable count. The 39 and 51 are pre-existing at the tip and none of them is in a wave 1 file.

The `store` lane's +11 is this wave's own new tests. Two of the 39 services failures are NEW AT THE
TIP since `d1e86d0e8` (they were 37 there) and belong to the waves that landed in between, not to
this branch: `workflows … duplicate create … refused by the unique index` and `countContextAwarePendingMail
… one grouped messages read`. Both fail on `expected 'DrizzleQueryError: Failed query: insert into
"workflows" …' to match /UNIQUE constraint failed|constraint/i` — which is spec rule 38's subject
exactly: drizzle rewraps the driver error and the message moves to `.cause`. Reported to the
coordinator rather than touched.

### Typecheck, lint and formatting

- `apps/server` `tsgo --noEmit`: **one** error, `store/settings.ts(53,58)` — the reserved line
  described above. With the one-line probe applied it is **zero**.
- `bun run typecheck --filter @podium/server` did not reach `apps/server` at an earlier tip: it
  stopped in `@podium/runtime`, whose `query-attribution.test.ts` built a fake `SqlStatement` that
  predated `values(...)` being added to the interface. Two TS2741s, neither of them any wave's code.
  Reported, and fixed by the coordinator at `c8e855c97`.
- `lint:boundaries`: red, and the difference from control is EXACTLY eight lines — one
  `store-boundary-ledger` finding per converted file, which is the signal the ledger is designed to
  emit and the coordinator removes at land. Nothing else differs, so no other boundary rule moved.
  That the lint names all eight is also the independent confirmation that all eight converted: the
  finding fires only when a listed file holds no raw handle at all.
- `biome check`, compared PER FILE (a multi-file invocation caps at 20 diagnostics and the cap alone
  produced a fake +6): every changed file is unchanged against control except three that got BETTER —
  `store.ts`, `server-secrets.ts` and `user-read-position.ts` each lose their `organizeImports`
  finding. The new `stage-a-seam.ts` is clean.

### Without the probe

`store/settings.ts:53` still passes a `SqlDatabase` into `UserPreferencesRepository`. Measured rather
than described: the `store` lane is **24 failed / 1113 passed**, and all 24 carry one of two messages,
`TypeError: undefined is not an object (evaluating 'this.db.select')` (16) and `… 'this.db.insert')`
(7). Every one of them reaches the repository through `SettingsRepository`. That is the whole of this
branch's redness and it is one line of someone else's file.

### The shard manifest

Regenerated with `bun scripts/server-test-shards.ts --write`, never hand-merged. At an earlier
tip it also picked up three of wave 7's golden test files that were absent from the manifest and so
ran NOWHERE (`vitest.shard.ts` runs an explicit file list, not a glob); that was reported and the
coordinator has since fixed it at `c8e855c97`. The control arm regenerates the manifest too, so the
name-set comparison above is about this conversion only.

### Mutation

- **The conflict arm.** The `MAX(…, excluded.peak_percent)` fold on `peakPercent` replaced by
  a bare `excluded.peak_percent` (applied by LINE, not by pattern): `× folds into the existing row and
  keeps the higher peak`, `AssertionError: expected 5 to be 90`. The isolating message, not just a red.
  Restored and checked byte-identical against `git show HEAD:` rather than by grep.
- **The span.** `protected transact = <T>(fn) => fn()` in `quota-history.ts` — the span removed
  entirely — leaves all 16 tests green. NOT a defect introduced here: the SAME mutation on the control
  (replacing `transaction(this.db, fn)` with a direct call) leaves its 13 green too. A pre-existing
  coverage gap, recorded rather than hidden; `record`'s atomicity is only observable across a crash
  between its two statements.
- Rule 28's `partial` mutations and their two surviving-but-classified sites are unchanged from the
  first conversion pass and are recorded above.

### Rules answered by derivation, not by reading

- **Rule 31a** (constraint count matters for `DO UPDATE`): `grep 'CREATE UNIQUE INDEX'` over every
  file in `migrations/drizzle/*/migration.sql` returns nothing for any of the eight tables, so each
  has exactly one uniqueness constraint — its primary key — and `onConflictDoUpdate` on that key is
  equivalent to the `OR REPLACE` it replaces. POD-3403's divergence cannot reach this wave.
- **Rule 36** (a `sql` fragment loses its qualifier): PRINTED, not eyeballed. Wave 1 has two
  fragment-bearing queries. `insert … on conflict … do update set "last_seen_ms" =
  MAX("quota_windows"."last_seen_ms", excluded.last_seen_ms), …` — qualifiers intact, because the
  rewrite lives in `buildSelection` and a `DO UPDATE SET` never goes through it. `select COUNT(*) from
  "quota_windows"` — no `Column` chunk to strip.
- **Rule 39** (a conversion may not widen a projection): every `.select()` with no argument replaces a
  literal `SELECT *` in the same method; every narrowed projection names the same columns the original
  named. Checked against `git show <base>:` for each file.
- **Write intent**: there is no `.returning()` anywhere in the eight files, so no write can be emitted
  through `all`. Every write terminates in `.run()` and every read in `.get()`/`.all()`.

### Rules that landed while this wave was in flight, answered against it

- **Rule 43** (a converted INSERT binds NULL where the original omitted, defeating a DEFAULT). Derived
  with `pragma table_info` on the migrated database, not read off the schema: of the eight tables only
  two have any defaulted column — `accounts` (`identity` `''` NOT NULL, `scope` `'role'` NOT NULL) and
  `settings_audit_events` (`detail_json` `'{}'` NOT NULL, `redacted_paths` `'[]'` NOT NULL). All four
  are supplied EXPLICITLY, with real values, by both the original and the conversion, so no default is
  reachable to defeat. The emitted SQL was then PRINTED for both inserts. `accounts` names its seven
  columns and no more. `settings_audit_events` names `"id"` and binds `null` where the original omitted
  it — which is the one shape rule 43 measures as SAFE, because that column is
  `integer PRIMARY KEY AUTOINCREMENT` and an explicit null auto-assigns exactly as an omission does.
- **Rule 34b** (a getter is worth having only if nothing routes around it). All **35** `this.db`
  occurrences across the eight files chain a query immediately; `this.queries.db` appears only inside
  the getter. Checked after STRIPPING COMMENTS, which is the hazard the rule names — several of these
  files quote the anti-pattern in prose.
- **Rule 44** (a check whose pass is silence must be shown to fail). The rule-34b check above prints
  nothing when it passes, so it was fed a canary first: a class containing `const db = this.db`, one
  properly chained `this.db`, and a comment quoting the anti-pattern. It flagged the capture, at the
  right line, and neither of the other two. Only then did its silence over the eight files mean
  anything.
- **Rule 42 / 42a** (prove the control arm was applied). The control is a SEPARATE DETACHED WORKTREE at
  the base commit, so there is no unapplied-arm failure mode to detect — but it is proved positively
  anyway, by counting treatment-only and control-only tokens across the eight files:

  | token | treatment | control |
  | --- | --- | --- |
  | `SyncQueries` | 16 | 0 |
  | `protected get db` | 8 | 0 |
  | `.prepare(` | 0 | 35 |
  | `legacyHandle` | 0 | 14 |

  Four signals, all flipping in the direction the conversion goes. Rule 42a's consistency tell also
  holds the right way round: this branch ADDS a test file to the `store` lane, and the arms' totals
  differ by exactly that file's tests rather than matching.

