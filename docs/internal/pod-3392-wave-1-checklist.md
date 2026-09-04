# POD-3392 — wave 1, the Stage A checklist answered per file

Eight repositories: `accounts.ts`, `telegram-bindings.ts`, `user-read-position.ts`,
`user-preferences.ts`, `read-watermarks.ts`, `settings-audit.ts`, `quota-history.ts`,
`server-secrets.ts`.

Written against the branch tip `57691d712`. Everything numeric here is derived from the artefacts —
the migrated database, the coverage census, the boundary lint's own ledger — rather than read off
the source by eye, and the derivation is named at each point so it can be re-run.

## Status: the conversion is BLOCKED, and the blocker is not in these files

No repository is converted in this commit. **POD-3400** asks the question that has to be answered
before the first method can move, and it blocks all seven waves rather than this one:

> Every member of the executor's `QueryClient` returns a promise — `run`, `get`, `all`, `writeGet`,
> `writeAll`, `batch` (`store/executor/driver.ts:246-266`, built by `queryClientOver` at `:270`),
> and the bun driver is no exception because `createBunSqliteDriver` builds its client with the same
> `queryClientOver`. drizzle ships no synchronous proxy driver: `sqlite-proxy` is async only, and the
> one synchronous driver, `bun-sqlite`, needs the raw handle rule 13 bans and the exit gate deletes.
> So a method that reaches the database through the executor's client returns a promise, and one that
> stays synchronous is still on the raw handle. The wave briefs say sync forms only; spec rule 11 says
> signatures are async. Both cannot hold in one commit.

Wave 2 (POD-3393) hit the identical wall independently and mailed the coordinator the same finding.
Two of the four workers reaching the same conclusion separately is the evidence that it is the
mechanism and not a local misreading.

What this commit does contain is everything that does not depend on the answer: the golden tests the
brief requires to be written FIRST, and the checklist below.

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
