# POD-3393 — Wave 2 (identity and access), per-site conversion analysis

Files: `store/users.ts`, `store/auth.ts`, `store/grants.ts`, `store/settings.ts`,
`store/approvals.ts`, `store/user-layout.ts`.

Base: integration branch at `57691d712`. Written BEFORE any conversion, against the synchronous code,
so the conversion that follows is mechanical and reviewable line by line. Every site is answered
against the execution method's Stage A checklist (§3).

## 0. Status — CONVERTED. What follows was written before the conversion and is kept as the record

All six files are converted and committed. Section 0 below is the state this document was written in
— before a line was written — and it is left standing because the two blockers it names were both
ruled on by the coordinator and both rulings changed what every wave did. Results are in §7.

## 0a. The original status — the conversion is not written, and why

Two things had to be ruled on before a line could be converted, both mailed to the coordinator.

1. **There is no synchronous seam to convert onto.** Every member of `QueryClient` returns a promise
   (`store/executor/driver.ts:246-267`, built async by `queryClientOver` at `:270`), and
   `StoreExecutor.drizzle` is that client with `transact`/`read` async too
   (`store/executor/executor.ts:67-70`). The brief requires sync forms and forbids adding `async`.
   Spec §6 rule 20's own 2026-09-03 correction states the same fact. Mailed as `msg_a54d53b1`
   (delivered), with a proposal: a transitional synchronous client owned by the coordinator, the same
   move rule 17 already made with `runSynchronousSpan` on the post-commit side.
2. **`INSERT OR REPLACE` on a two-constraint table.** Filed as POD-3403. See §3 below.

Everything in this document is independent of both answers.

## 1. Statement intent — the thing that cannot be got wrong silently

**Wave 2 has ZERO `RETURNING` writes, so it needs no `writeGet` and no `writeAll`.** Derived, not
assumed: `grep -in returning` over the six files returns two hits, both prose inside comments
(`grants.ts:61`, `grants.ts:167`). The store's only `RETURNING` write is `notification-facts.ts`,
which belongs to wave 4. So the POD-3321 defect class — a write declared as a read because drizzle
emits `RETURNING` through `all` — has no site in this wave.

Every one of the 41 statement sites is therefore `get`/`all` (read) or `run` (write), and the
classification is decided by what the statement does, never by its result shape.

| File | Read sites (`get`/`all`) | Write sites (`run`) |
| --- | ---: | ---: |
| `users.ts` | 4 | 3 |
| `auth.ts` | 3 | 8 |
| `grants.ts` | 4 | 3 |
| `settings.ts` | 2 | 2 |
| `approvals.ts` | 3 | 2 |
| `user-layout.ts` | 3 | 4 |
| **total** | **19** | **22** |

## 2. Checklist §3 Stage A, answered once where the answer is uniform

**Item 1 — §2.7 constructs.** No `PRAGMA`, no `sqlite_master`, no introspection anywhere in the six
files. Six `INSERT OR REPLACE` statements; see §3.

**Item 2 — JSON columns.** None of this wave's columns is `mode: 'json'`. `approval_requests.op_json`,
`user_layout.value` and `meta.value` are plain `text()` in `migrations/schema.ts`, parsed by hand at
the reader. So rule 4's corrupt-blob oracle does not govern them and none of them appears in its 26
cases. Their existing behaviour is preserved verbatim as a rule 6 decision:

| Column | Reader | Behaviour on a corrupt value | Conversion |
| --- | --- | --- | --- |
| `meta.value` (settings) | `getSettings` | quarantine — `catch` returns `normalizeSettings(undefined)` | keep the try/catch verbatim |
| `meta.value` (catalog) | `getModelCatalog` | quarantine — `catch` returns `null` | keep verbatim |
| `user_layout.value` | `getSnapshot` | quarantine per row — the row is skipped, the rest survive | keep verbatim |
| `user_layout.value` | `get` | quarantine — returns `undefined` | keep verbatim |
| `approval_requests.op_json` | `toRow` | **THROWS** — a bare `JSON.parse` with no guard | preserve the throw; it is behaviour, and changing it is not a conversion |

The `op_json` row is the one worth a reviewer's eye: it is the only unguarded parse in the wave, so a
corrupt op makes `get`, `listPending` and `listExecuting` all throw rather than skip. That is today's
behaviour and this wave preserves it rather than improving it.

**Item 3 — mapper lines that are decisions (rule 6), and stay.**

- `users.ts` `parseRole` — fails closed. An unknown role is UNREADABLE, not `member`. Stays, with its
  comment.
- `users.ts` `credentialFor`'s `CREDENTIAL_SOURCES` check — fails closed, and load-bearing: a leftover
  pre-POD-1554 `instance-password` row must read as no credential. Stays.
- `users.ts` `read`'s `disabledAt !== null` collapse — three states deliberately collapsed to "no
  account" so no caller can get one of them permissive. Stays.
- `grants.ts` `parseVerb` — fails closed; an unparseable edge is DROPPED so an unreadable grant denies.
  Stays, and the `flatMap` that drops it stays with it.
- `settings.ts` `getModelCatalog`'s `parsed.machineId !== machineId` refusal — an older unkeyed
  snapshot must not be served as if it applied here. Stays.
- `user-layout.ts` `set`/`setMany`'s `isLayoutKey` refusal — the closed vocabulary shared with three
  other answers. Stays, including `setMany` validating EVERY key before writing ANY.

Mapper lines that exist only because the driver returns `unknown` — the `as string` casts in
`users.read`, `grants.toRow`, `approvals.toRow`, and the ten-field hand-typed select in
`auth.listClientSessions` — go, provided the rows arrive with the schema's TypeScript names. That
proviso is the second half of the blocker in §0: a builder query issued as text through the client
returns PHYSICAL column names, and only drizzle's own execution path maps them back (spec rule 7,
and the spike says so at `store/spike/turso-append/sync-append.ts:57-68`).

**Item 4 — brands from `$type` (rule 3).** The schema already carries every brand this wave needs:
`users.id` and `userCredentials.userId` and `clientSessions.userId` are `$type<UserId>()`;
`approvalRequests` carries `MachineId`, `SessionId` and `IssueId`; `userLayout.userId` is `UserId`.
So the re-entry casts in `approvals.toRow` ("SERIALIZATION EDGE: untyped sqlite columns re-entering
their id spaces") and in `auth`'s two mappers are removable — again subject to the same proviso.
`grants.ts` is the exception and keeps its plain `string`: `grantee` and `owner` are deliberately
unbranded in the schema, because a grantee may become a group (ADR 9 D2's deferred additive change).

**Item 5 — spans.** Three, all single-repository and none nested:

- `users.create` — `transaction(this.db, …)` around two inserts, `users` then `user_credentials`.
  Boundary and ordering preserved; the immediate mode is the scheduler's job (rule 7), not this file's.
- `user-layout.setMany` — one transaction around N inserts.
- `user-layout.clearMany` — one transaction around N deletes.

All three call `transaction()` from `@podium/runtime/sqlite` on the raw handle. That import is the
third face of the §0 blocker: `StoreExecutor.transact` is async, so a synchronous repository has no
transaction seam either. Whatever answers the client question must answer this one too.

**Item 6 — non-database calls inside a span.** One, and it is not a side effect: `users.create` calls
`currentReadScope().clear(this.accountsSlot)` before the span and again in a `finally`. It is process-
local cache invalidation, not an observable effect, so rule 19's test says it stays. It is noted for
B-prep rather than fixed here. Note the `finally` is load-bearing for the ROLLBACK arm — a read taken
inside the transaction would otherwise outlive it and hold an account that does not exist.

**Item 7 — `undefined` bound parameters.** Checked at every site; none can reach the driver.
`auth.createClientSession` maps all five optional metadata fields through `?? null`;
`approvals.transition` uses `resultText ?? null`; `approvals.insert` and `grants.upsert` pass columns
that are already `T | null`. `users.setPasswordHash` and `user-layout.set` take required parameters.
No site changes behaviour here and none needs a decision.

**Item 8 — dynamic `IN` lists and the statement cache.** One site: `grants.listForResources`, which
chunks at 500 (`grants.ts:180-196`) because `SQLITE_MAX_VARIABLE_NUMBER` is 999. The chunk size bounds
the parameter count but NOT the number of distinct SQL texts — a final partial chunk of any size
between 1 and 500 produces its own statement text, so the cache can hold up to 500 variants of this
one query. That is today's behaviour and the conversion preserves it; it is recorded here because the
checklist asks and because it is a real cache fact rather than a defect this wave should fix.

**Item 9 — test setups that change.** None yet. All six repositories are constructed from a
`StoreExecutor` already, so no test constructs them from a raw handle. The one construction that WILL
need attention is not a test: see §4.

**Item 10 — the uncovered list.** **Empty for this wave.** The coverage census's never-executed table
(14 methods) names no method in any of the six files, so no golden test is owed before converting.
Nine methods are "executed but never named" and are the ones where an incidental change could pass
unnoticed: `auth.extendClientSession`, `auth.deleteClientSession`, `auth.deleteAllClientSessions`,
`auth.deleteExpiredClientSessions`, `grants.visibilityAudienceFor`,
`grants.visibilityAudienceResourceIds`, `grants.listForResources`, `user-layout.clearMany`, and
`approvals.listExecuting`. Those get the mutation checks.

## 3. `INSERT OR REPLACE` — six sites, one of which is not mechanical

drizzle-orm 1.0.0-rc.4 has no `INSERT OR REPLACE` for sqlite: its sqlite insert builder offers
`onConflictDoUpdate` and `onConflictDoNothing` only (`node_modules/drizzle-orm/sqlite-core/
query-builders/insert.d.ts:176`; no `orReplace` symbol anywhere under `sqlite-core`). Checklist item 1
already asks for "every column named on an OR REPLACE conversion", which is the `onConflictDoUpdate`
answer — and it is correct wherever the table has exactly ONE uniqueness constraint.

| Site | Table | Constraints | Verdict |
| --- | --- | --- | --- |
| `user-layout.ts:86` (`set`) | `user_layout` | pk `(user_id, key)` only | mechanical |
| `user-layout.ts:101` (`setMany`) | `user_layout` | pk `(user_id, key)` only | mechanical |
| `grants.ts:224` (`upsert`) | `grants` | pk of four columns only | mechanical |
| `settings.ts:78` (`setSettings`) | `meta` | pk `key` only | mechanical |
| `settings.ts:228` (`setModelCatalog`) | `meta` | pk `key` only | mechanical |
| `auth.ts:75` (`createClientSession`) | `client_sessions` | pk `token_hash` **and** `UNIQUE(session_id)` | **POD-3403** |

`OR REPLACE` resolves a conflict on ANY constraint; `ON CONFLICT` resolves one named target and raises
on the other. Measured on bun:sqlite with the table and index reproduced from migration
`20260813142935_mobile-session-public-id-index`: seed one mobile row, then write again with a new
`token_hash` and the same `session_id`, which is what a re-pair does.

```
INSERT OR REPLACE       -> one row, token_hash hashB, session_id sess-1   (the old row was deleted)
ON CONFLICT(token_hash) -> UNIQUE constraint failed: client_sessions.session_id
```

So the conversion the checklist implies would turn a write that silently rotates a token into one that
throws, on the auth path. That is a behaviour change, and this wave does not make it. Filed as
POD-3403 with four candidate rules; the site will carry `// DECISION POD-3403` if it has to land
before the ruling.

The check that separates the two classes is per table and cheap — look for a `uniqueIndex` on the
table as well as its primary key — and the other waves holding the remaining seven production
`OR REPLACE` statements need telling to run it. Wave 1 has five (`accounts.ts`,
`telegram-bindings.ts` twice, `user-preferences.ts`, `user-read-position.ts`); wave 6 has one
(`events.ts`). Wave 1 has been told directly.

## 4. A wave boundary that overlaps on one line

`settings.ts:53` is the ONLY production construction of `UserPreferencesRepository`:

```ts
this.userPreferences = new UserPreferencesRepository(this.db)
```

`settings.ts` is wave 2's. `user-preferences.ts` is wave 1's (POD-3392), and its constructor takes
`SqlDatabase` (`user-preferences.ts:69`), so wave 1's conversion changes that signature and the only
caller it has to fix is in wave 2's file. Neither worker may edit the other's.

The file's own comment says the composition is deliberate and that the repository "keeps the raw handle
until its own conversion [POD-3254]", which suggests wave 2 keeps one `legacyHandle` call solely to
build it. That is a guess at a sequencing the coordinator owns, so it has been asked rather than
assumed, and wave 1 has been told not to move the signature until it is answered.

## 5. Rule 18 — the grant read this wave must not touch

Wave 2 owns `grants.ts` but NOT the per-decision read rule 18 protects. That loop is
`ownershipFromMachines`, outside these files, and this wave does not go near it.

Inside `grants.ts` the relevant fact is the opposite one: `listForResources` is an ALREADY-APPROVED
batched read (POD-1653), and its header records why batching was legal there — every row is still read
from SQLite at the moment of asking, so it changes how many round trips a pass costs and not what any
decision sees. The conversion keeps that shape exactly, including the chunk loop, and adds no new
batching of its own. `listForResource` stays per resource.

## 6. Control baseline

`PODIUM_TEST_WORKERS` **was set, to 1**, for every run in this document.

| Lane | Files | Tests | Failures on the base |
| --- | ---: | ---: | --- |
| `server:store` | 68 | 888 | none |
| `server:services` | 129 | 2290 | **36, all pre-existing** |

The services lane is red on the base before this wave changes anything, which is why the delta is
measured as a failing-test-NAME SET and never as a count. All 36 are in `modules/sessions/*` — 26 in
`oracle-handoff.test.ts`, the rest spread over seven files — and none of them touches a wave 2 file.
The name set is kept as the control arm.


## 7. Results

### 7.1 What landed

All six files query through the executor's synchronous drizzle seam (`executor.syncQueries`, giving
`.db` and `.transact`). Five hold no raw handle at all, confirmed by the boundary lint rather than by
my own grep: `store-boundary-ledger` now reports `users.ts`, `auth.ts`, `grants.ts`, `approvals.ts`
and `user-layout.ts` as "listed in STAGE_A_UNCONVERTED but holds no raw handle — it is CONVERTED".
`settings.ts` is deliberately still listed; see §4.

Constructors changed, and the six `store.ts` lines that build them:

| Repository | Now takes |
| --- | --- |
| `UsersRepository` | `(db, transact)` |
| `UserLayoutRepository` | `(db, transact)` |
| `AuthRepository` | `(db)` |
| `GrantsRepository` | `(db)` |
| `ApprovalsRepository` | `(db)` |
| `SettingsRepository` | `(db, legacy)` — `legacy` only composes wave 1's `UserPreferencesRepository` |

### 7.2 The lanes, by failing-test-NAME set

`PODIUM_TEST_WORKERS` **was set, to 1**, for every run in this document.

| Lane | Control | After | New failures | Fixed |
| --- | --- | --- | --- | --- |
| `server:store` | 68 files / 888 tests, 0 failures | 68 / 888, **0 failures** | none | none |
| `server:services` | 129 / 2290, 36 failures | 129 / 2290, 36 failures | **none — name set identical** | none |
| `server:boundary` | 120 / 2367, 51 failures | 120 / 2367, 52 failures | **one, see §7.4** | none |

The services lane is the reason this is measured as a set: 36 before and 36 after is a stable count
over an identical set, and the boundary lane's 51 → 52 is the case a count would have let through as
noise.

### 7.3 Mutation checks on the conversions that were not mechanical

Two conversions changed shape rather than just spelling, so each was A/B'd against the pre-conversion
SQL on the same fixture, and then the A/B itself was mutation-checked — an oracle that agrees on the
first run has not been shown capable of disagreeing.

**`approvals.transition`** — the `COALESCE` set clause became two `sql` fragments. A/B over three
transitions (`pending→executing`, `executing→succeeded`, and a `pending→denied` that must not match)
produced identical rows and identical `changes` counts. Mutation: `decidedAt` losing its `COALESCE` wrapper →
`decidedAt: now`. Killed, and the message is the behaviour: `decided_at` reads `10:00` (the approve
instant, preserved) in the original against `11:00` (overwritten by the later transition) in the
mutant. That is the property the method's own comment names.

**`grants.upsert`** — `INSERT OR REPLACE` became `onConflictDoUpdate`. A/B on a re-share by a NEW
owner produced an identical row. Mutation: drop `owner` from the `set` list. Killed, and the message
is again the property: `owner` stays `user:alice` (the previous granter) instead of being re-stamped
to `user:carol`. That is the accountability rule the method's header states.

### 7.4 The one new failure: a probe went dark, the cache did not

`store-users-frame-cache.test.ts` fails at `expect(afterFirst).toBeGreaterThan(0)` — its read counter
observes zero reads. **Two independent causes, either alone sufficient:**

1. It counts through `probeLegacyStatements`, which observes the executor's LEGACY driver. A converted
   repository goes through drizzle's own bun-sqlite driver and never reaches it.
2. It matches the substring `FROM users WHERE id`. drizzle emits
   `select "id", "display_name", "role", "created_at", "disabled_at" from "users" where "users"."id" = ?`
   — so the match fails on case and on quoting even if the statement were observed.

**The cache still works.** Counted at drizzle's own logger over a directly-constructed
`UsersRepository`: the first `get` reads, two further calls in the same frame read zero more, and a
call after a microtask turn reads again. POD-1931's behaviour is unchanged.

No assertion was edited. This is the guard-going-dark class the coordinator asked every wave to report,
and it is the good version of it: the test's own `toBeGreaterThan(0)` — added by POD-3281 precisely so
"the probe cannot be dead" — turned a silent vacuous pass into a loud red. Without that line the probe
would have returned 0 and the two cache assertions would have compared 0 to 0 and passed.

### 7.5 Source-text scanners over wave 2 files: none

Checked rather than assumed. The two source-reading guards in the tree pin their target with a literal
path constant — `store-issues-row-cache-writers.test.ts` reads `store/issues.ts`,
`store-repos-registry-cache-writers.test.ts` reads `store/repos.ts`. Neither scans a wave 2 file, so
neither can go dark because of this conversion. Wave 6's finding has no wave 2 equivalent.

### 7.6 A gate that cannot be green as things stand

The boundary lint's `store-boundary-ledger` instructs: "Delete the line from
scripts/check-boundaries.ts in the same commit as the conversion." The coordinator has ruled the
opposite — it edits `STAGE_A_UNCONVERTED`, no wave does. Both cannot hold, and the lint is therefore
red for every wave from the moment it converts until the coordinator removes its lines. Worth
reconciling before "lint family green" is used as Phase A's exit gate.

## 8. Rule 28 (declared column modes) — wave 2's exposure is zero, derived not asserted

Rule 28 lands after this wave converted, so it was checked against the landed code rather than
assumed away.

**No column any wave 2 file reads carries a declared mode, and none is an integer.** Derived by
scanning each table's declaration in `migrations/schema.ts` rather than by recalling the earlier note:

| Table | Columns with a declared `mode` | `integer()` columns |
| --- | --- | --- |
| `users` | none | none |
| `user_credentials` | none | none |
| `client_sessions` | none | none |
| `grants` | none | none |
| `approval_requests` | none | none |
| `user_layout` | none | none |
| `meta` | none | none |

Every column in all seven is `text()`. So there is no `mode: 'boolean'` column to write a true-case
golden test for, and no mapper in this wave can compare a boolean against a number.

**The converse check, because the table above only proves the trigger is absent.** Searching the six
converted files for the hazard's shape — `=== 1`, `!== 0`, `=== 0`, `!== 1`, `Number(` — finds six
sites, and five are not database values at all: `settings.ts:132` and `:171` measure JavaScript
collection sizes, and `auth.ts:124` and `grants.ts:286` wrap a driver `changes` count, which is
`number | bigint` across the two drivers and has nothing to do with a column mode.

The sixth is the only place this wave compares a value the database returned against a number:
`users.ts:167`, `return row?.present === 1`, where `present` is the SQL literal `1` from
`select 1 ... limit 1` — a literal, not a column, so no declared mode can reach it.

It was exercised anyway, on both arms, because rule 28's point is that the default value proves
nothing:

```
empty table                              -> false   (want false)
per-user-scrypt WITH hash  [TRUE ARM]    -> true    (want true)
per-user-scrypt with NULL hash           -> false   (want false)
another source WITH hash                 -> false   (want false)
mixed rows, one qualifying [TRUE ARM]    -> true    (want true)
```

Both true arms fire, and both near-miss rows — the right source with no hash, the wrong source with a
hash — correctly answer false. That is the fail-closed behaviour `credentialFor`'s header describes,
holding after the conversion.

**The other two rulings in the same message are also no-ops here.** `INSERT OR IGNORE`: zero
occurrences in the six files. `markDelivered`: not a wave 2 method. Both checked by search, not by
recollection.

## 9. Rebase onto the moving tip, and the four rules that landed after this wave converted

Rebased from `57691d712` onto `f97080fa9` (rules 29–40). The rebase was clean: no conflict in any
file, and `git log f97080fa9..HEAD` is this wave's commits and nothing else, which is the check rule 40
now asks for.

### 9.1 Rule 34a — the shape every repository was renamed to

Wave 2 converted while the capability was still SPLIT across constructor arguments: `(db)` for
`auth` / `grants` / `approvals`, `(db, transact)` for `users` / `user-layout`, `(db, legacy)` for
`settings`. Rules 34 and 34a landed afterwards and rule 34a is the operative one — `db` must be a
GETTER, because a field assigned in the constructor freezes the ROOT drizzle instance and rule 35's
ambient routing can then never resolve the enclosing transaction through it.

All six now read:

```ts
constructor(private readonly queries: SyncQueries) {}
protected get db(): SyncDrizzle { return this.queries.db }
protected transact = <T>(fn: () => T): T => this.queries.transact(fn)
```

No method body changed. The six `store.ts` construction lines pass `this.queries` — the one
capability object — under rule 29's narrow exemption; they are lines 323, 333, 338, 339, 345 and 346,
and nothing else in that file was touched. Nine test constructions were re-pointed the same way, all
of them setup, no assertion edited; they are listed in the commit.

### 9.2 Rule 39 — no projection in this wave widened, derived by PRINTING every statement

Rule 39 is the one that could not be answered by reading, so it was answered by printing. A temporary
probe wrapped the store's `SqlDatabase` in a recording proxy — which is the exact object
`clientOverWrapper` prepares against, so what it records is what drizzle actually emitted — and drove
every read and every write in the six files. Every statement is reproduced in §9.5.

The comparison, against `PRAGMA table_info` on the MIGRATED database rather than against
`schema.ts`:

| Site | Original named | Emitted | Table has | Verdict |
| --- | --- | --- | --- | --- |
| `users.get` | `SELECT *` | 5 | 5 | exact, 5/5 |
| `users.credentialFor` | `SELECT *` | 4 | 4 | exact, 4/4 |
| `grants.listForResource` / `listForResources` / `listForKind` | `SELECT *` | 10 | 10 | exact, 10/10 |
| `approvals.get` / `listPending` / `listExecuting` | `SELECT *` | 11 | 11 | exact, 11/11 |
| `auth.listClientSessions` | 10 named | 10 | 10 | exact, same set |
| `auth.getClientSession` | 8 named | 8 | 10 | exact, same 8 |
| `auth.deleteOwnedMobileClientSession` | `token_hash` | 1 | 10 | exact |
| `users.list` | `id` | 1 | 5 | exact |
| `users.hasPerUserCredentials` | `1 AS present` | `select 1` | — | exact |
| `layout.getSnapshot` / `get` / `keysFor` | 2 / 1 / 1 | 2 / 1 / 1 | 4 | exact |
| `settings.getSettings` / `getModelCatalog` | `value` | 1 | 2 | exact |

**No wave 2 select spreads `getTableColumns`,** so rule 39's stated failure mode has no site here; the
`SELECT *` sites convert to a bare `.select()`, and for each of those four tables the schema declares
exactly the columns the shipped table has, so the emitted list is the same set `*` expanded to. Zero
extra columns and zero missing ones.

### 9.3 Rule 36 — the qualifier bug has no site in this wave

Two `sql` fragments appear in a SELECT LIST — `users.hasPerUserCredentials`'s `sql<number>\`1\`` and
`grants.remove`'s `count()`. Neither names a COLUMN, so the trigger rule 36 measured (a bare
identifier in a select-list fragment resolving against the wrong table) cannot fire. Confirmed in the
printed SQL: `select 1 from "user_credentials" …` and `select count(*) from "grants" …`. The one
fragment that does name columns — `approvals.transition`'s two `COALESCE` set clauses — is in an
UPDATE's SET clause and emits fully qualified: `COALESCE("approval_requests"."decided_at", ?)`.

### 9.4 Rule 31a — the constraint census, and why POD-3403's marker stays

Derived from the migrated database (`PRAGMA index_list`, `PRAGMA foreign_key_list`, and a scan of
every table's `foreign_key_list` for INBOUND edges), not from `schema.ts`:

| Table | Uniqueness constraints | Inbound FKs | CHECK | Converted form |
| --- | --- | --- | --- | --- |
| `users` | 1 (pk) | none | no | plain insert |
| `user_credentials` | 1 (pk) | none | no | `onConflictDoUpdate` |
| `user_layout` | 1 (pk) | none | no | `onConflictDoUpdate` |
| `meta` | 1 (pk) | none | no | `onConflictDoUpdate` |
| `grants` | 1 (pk) | none | no | `onConflictDoUpdate` |
| `approval_requests` | 1 (pk) + 1 NON-unique index | none | **yes** | plain insert |
| `client_sessions` | **2** — pk on `token_hash` AND `idx_client_sessions_session_id` | none | no | **NOT converted, POD-3403** |

Four `INSERT OR REPLACE` sites converted; each is on a single-uniqueness-constraint table with no
inbound foreign key, so neither of OR REPLACE's two divergences from DO UPDATE can reach them — the
untargeted-conflict throw (rule 31a) or the delete-and-reinsert cascade. Each also names EVERY column
of its table in the insert, checked in the printed SQL, so the column-reversion difference is a no-op
as well.

**THE `NOT NULL` LEG, which rule 31a's OR REPLACE row does not spell out and which does divide the two
forms.** `INSERT OR REPLACE` resolves a NOT NULL violation by substituting the column's DEFAULT, and
ABORTS only when the column has no default; `onConflictDoUpdate` throws either way. So the two forms
diverge at a site where a NOT NULL column both can receive a null AND has a default. Checked against
the shipped DDL for the four converted sites:

| Table | NOT NULL columns with a DEFAULT | Can a null reach one? |
| --- | --- | --- |
| `grants` | none (`migration.sql` 20260730173834: eight NOT NULL, no DEFAULT clause) | n/a |
| `user_credentials` | none (same migration) | n/a |
| `user_layout` | none (20260802095200) | n/a |
| `meta` | none (`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`) | n/a |

Zero of the four has a default on a NOT NULL column, so OR REPLACE's substitution branch is
unreachable at every converted site and both forms abort identically. Worth recording that
`client_sessions` DOES have one — `label text DEFAULT 'login' NOT NULL` (20260802111446) — so the
site that stayed raw is also the only one where this second divergence is live. That belongs in
POD-3403 alongside the two-constraint argument.

`client_sessions` is the one table with two uniqueness constraints, which is exactly rule 31a's
"real defect" row, so the marker on `auth.createClientSession` is a genuinely open question and stays.
`approval_requests` carries a CHECK constraint, but its insert is a plain one — no `OR IGNORE` and no
`OR REPLACE` — so rule 31's CHECK test does not govern it. Wave 2 has zero `INSERT OR IGNORE` sites.

### 9.5 Every statement the six files emit

```
users.get
    select "id", "display_name", "role", "created_at", "disabled_at" from "users" where "users"."id" = ?
users.list
    select "id" from "users" order by "users"."created_at" asc
users.credentialFor
    select "user_id", "source", "password_hash", "updated_at" from "user_credentials" where "user_credentials"."user_id" = ?
users.hasPerUserCredentials
    select 1 from "user_credentials" where (("user_credentials"."source" = ?) and (("user_credentials"."password_hash" is not null))) limit ?
users.create
    insert into "users" ("id", "display_name", "role", "created_at", "disabled_at") values (?, ?, ?, ?, ?)
users.create
    insert into "user_credentials" ("user_id", "source", "password_hash", "updated_at") values (?, ?, ?, ?)
users.setPasswordHash
    select "id", "display_name", "role", "created_at", "disabled_at" from "users" where "users"."id" = ?
users.setPasswordHash
    insert into "user_credentials" ("user_id", "source", "password_hash", "updated_at") values (?, ?, ?, ?) on conflict ("user_credentials"."user_id") do update set "source" = ?, "password_hash" = ?, "updated_at" = ?
auth.createClientSession
    INSERT OR REPLACE INTO client_sessions
            (token_hash, user_id, created_at, expires_at, label, session_id, device_id, device_name, platform, last_seen_at)
          VALUES (?, ?, ?, ?, ?,
                  ?, ?, ?,
                  ?, ?)
auth.createClientSession
    INSERT OR REPLACE INTO client_sessions
            (token_hash, user_id, created_at, expires_at, label, session_id, device_id, device_name, platform, last_seen_at)
          VALUES (?, ?, ?, ?, ?,
                  ?, ?, ?,
                  ?, ?)
auth.listClientSessions
    select "token_hash", "user_id", "created_at", "expires_at", "label", "session_id", "device_id", "device_name", "platform", "last_seen_at" from "client_sessions" order by "client_sessions"."created_at" desc
auth.getClientSession
    select "user_id", "expires_at", "label", "session_id", "device_id", "device_name", "platform", "last_seen_at" from "client_sessions" where "client_sessions"."token_hash" = ?
auth.isClientSessionValid
    select "user_id", "expires_at", "label", "session_id", "device_id", "device_name", "platform", "last_seen_at" from "client_sessions" where "client_sessions"."token_hash" = ?
auth.deleteOwnedMobileClientSession
    select "token_hash" from "client_sessions" where (("client_sessions"."session_id" = ?) and ("client_sessions"."user_id" = ?) and ("client_sessions"."label" = ?))
auth.extendClientSession
    update "client_sessions" set "expires_at" = ? where "client_sessions"."token_hash" = ?
auth.touchClientSession
    update "client_sessions" set "last_seen_at" = ? where "client_sessions"."token_hash" = ?
auth.deleteClientSessionsByLabel
    delete from "client_sessions" where "client_sessions"."label" = ?
auth.deleteClientSession
    delete from "client_sessions" where "client_sessions"."token_hash" = ?
auth.deleteExpiredClientSessions
    delete from "client_sessions" where "client_sessions"."expires_at" <= ?
auth.deleteAllClientSessions
    delete from "client_sessions"
grants.upsert
    insert into "grants" ("resource_kind", "resource_id", "grantee", "verb", "owner", "visibility", "created_at", "actor_kind", "actor_id", "on_behalf_of") values (?, ?, ?, ?, ?, null, ?, null, null, null) on conflict ("grants"."resource_kind", "grants"."resource_id", "grants"."grantee", "grants"."verb") do update set "owner" = ?, "created_at" = ?
grants.listForResource
    select "resource_kind", "resource_id", "grantee", "verb", "owner", "visibility", "created_at", "actor_kind", "actor_id", "on_behalf_of" from "grants" where (("grants"."resource_kind" = ?) and ("grants"."resource_id" = ?)) order by "grants"."created_at" asc
grants.listForResources
    select "resource_kind", "resource_id", "grantee", "verb", "owner", "visibility", "created_at", "actor_kind", "actor_id", "on_behalf_of" from "grants" where (("grants"."resource_kind" = ?) and ("grants"."resource_id" in (?, ?))) order by "grants"."created_at" asc
grants.listForKind
    select "resource_kind", "resource_id", "grantee", "verb", "owner", "visibility", "created_at", "actor_kind", "actor_id", "on_behalf_of" from "grants" where "grants"."resource_kind" = ? order by "grants"."created_at" asc
grants.remove
    select count(*) from "grants" where (("grants"."resource_kind" = ?) and ("grants"."resource_id" = ?) and ("grants"."grantee" = ?) and ("grants"."verb" = ?))
grants.remove
    delete from "grants" where (("grants"."resource_kind" = ?) and ("grants"."resource_id" = ?) and ("grants"."grantee" = ?) and ("grants"."verb" = ?))
grants.removeAllForResource
    delete from "grants" where (("grants"."resource_kind" = ?) and ("grants"."resource_id" = ?))
approvals.insert
    insert into "approval_requests" ("id", "machine_id", "session_id", "issue_id", "op_json", "status", "created_at", "actor", "on_behalf_of", "decided_at", "result_text") values (?, ?, ?, ?, ?, ?, ?, null, null, null, null)
approvals.get
    select "id", "machine_id", "session_id", "issue_id", "op_json", "status", "created_at", "actor", "on_behalf_of", "decided_at", "result_text" from "approval_requests" where "approval_requests"."id" = ?
approvals.listPending
    select "id", "machine_id", "session_id", "issue_id", "op_json", "status", "created_at", "actor", "on_behalf_of", "decided_at", "result_text" from "approval_requests" where "approval_requests"."status" = ? order by "approval_requests"."created_at" asc
approvals.listExecuting
    select "id", "machine_id", "session_id", "issue_id", "op_json", "status", "created_at", "actor", "on_behalf_of", "decided_at", "result_text" from "approval_requests" where "approval_requests"."status" = ? order by "approval_requests"."decided_at" asc
approvals.transition
    update "approval_requests" set "status" = ?, "decided_at" = COALESCE("approval_requests"."decided_at", ?), "result_text" = COALESCE(?, "approval_requests"."result_text") where (("approval_requests"."id" = ?) and ("approval_requests"."status" = ?))
layout.set
    insert into "user_layout" ("user_id", "key", "value", "updated_at") values (?, ?, ?, ?) on conflict ("user_layout"."user_id", "user_layout"."key") do update set "value" = ?, "updated_at" = ?
layout.setMany
    insert into "user_layout" ("user_id", "key", "value", "updated_at") values (?, ?, ?, ?) on conflict ("user_layout"."user_id", "user_layout"."key") do update set "value" = ?, "updated_at" = ?
layout.getSnapshot
    select "key", "value" from "user_layout" where "user_layout"."user_id" = ?
layout.get
    select "value" from "user_layout" where (("user_layout"."user_id" = ?) and ("user_layout"."key" = ?))
layout.keysFor
    select "key" from "user_layout" where "user_layout"."user_id" = ? order by "user_layout"."key" asc
layout.clear
    delete from "user_layout" where (("user_layout"."user_id" = ?) and ("user_layout"."key" = ?))
layout.clearMany
    delete from "user_layout" where (("user_layout"."user_id" = ?) and ("user_layout"."key" = ?))
settings.getSettings
    select "value" from "meta" where "meta"."key" = ?
settings.setSettings
    select "value" from "meta" where "meta"."key" = ?
settings.setSettings
    insert into "meta" ("key", "value") values (?, ?) on conflict ("meta"."key") do update set "value" = ?
settings.getModelCatalog
    select "value" from "meta" where "meta"."key" = ?
settings.setModelCatalog
    insert into "meta" ("key", "value") values (?, ?) on conflict ("meta"."key") do update set "value" = ?
```

`grants.upsert` threw on the probe's own fixture, not on the code: the probe passed a partial
`GrantRow` with no `visibility` and no `actor_kind`, and both are `NOT NULL` on the shipped table. The
statement is emitted before the driver rejects it, which is what this section records.

### 9.6 A gap in the DECISION-marker mechanism, found while re-checking POD-3403's site

The boundary lint now matches the raw-statement ban over the WHOLE source and reports the line where
the CALL STARTS (`scripts/check-boundaries.ts:1458-1471`), while `decisionMarkedLines` exempts by
LINE. For a statement that does not fit on one line — POD-3403's is ten lines of SQL — those two are
never the same line, and they cannot be made the same line: biome moves a trailing `// DECISION` off
`this.db.run(` onto the next line, measured with `biome format`:

```
-    this.db.run( // DECISION POD-3403
+    this.db.run(
+      // DECISION POD-3403
```

**It bites nobody today and it will bite exactly once.** `auth.ts` is still listed in
`STAGE_A_UNCONVERTED`, and a listed file's raw-handle violations are not raised at all
(`check-boundaries.ts:1664`), so the marker is inert either way. The moment the coordinator prunes
that entry, the site reports a `store-raw-handle` violation that no marker can exempt.

Not fixed here: `check-boundaries.ts` is not a wave's file, and the two candidate fixes are judgements
about the rule, not about this site — accept a marker in the comment block immediately preceding the
call, or report the line the `sql` template starts on rather than the line the call starts on. Mailed
to the coordinator. The workaround that must NOT be taken is hoisting the statement into a variable so
`.run(statement)` stops matching the regex: that silences the ban AND makes the ledger report `auth.ts`
as converted when it is not.

## 10. Second rebase, onto `d1e86d0e8` — wave 6 landed, and rules 34b, 36a, 39a arrived

Rebased again, clean, no conflict; `git log d1e86d0e8..HEAD` is this wave's five commits and nothing
else. The three new rules are each a CHECK on work already done rather than a change to it, and each
is answered below with its denominator, which is what rules 36a and 39a ask for.

### 10.1 Rule 34b — every `this.db` chains a query immediately: 38 of 38

The getter is worth having only if nothing binds it to a local, because a bound local resolves once
and every use after it — especially across an `await` that left the span — serves a stale instance.

Checked by PARSING rather than grepping, and specifically by looking at what FOLLOWS each occurrence
rather than what precedes it, which is the trap rule 34b names: `const row = this.db` is not a capture,
it is the first line of a chain whose variable holds the RESULT. Comments and block comments were
stripped first so that prose mentioning `this.db` cannot count.

| File | `this.db` occurrences | Captures |
| --- | --- | --- |
| `users.ts` | 7 | 0 |
| `auth.ts` | 11 | 0 |
| `grants.ts` | 7 | 0 |
| `settings.ts` | 3 | 0 |
| `approvals.ts` | 5 | 0 |
| `user-layout.ts` | 5 | 0 |
| **total** | **38** | **0** |

Rule 34b's own limit applies here and is worth repeating rather than eliding: no test in the tree can
tell the getter from an assigned field today, because ambient routing does not exist yet. This is
verified as NOT-A-REGRESSION, not as a fix.

### 10.2 Rule 36a — the site list is DERIVED, and the denominator is 2 of 19

Not "I reviewed my fragments". The six files hold **37 terminal statements** (38 counting
`auth.createClientSession`'s raw one) and **19 `.select(...)` projections**. Scanning every projection
body for a `sql` fragment returns exactly **two**:

    users.ts:173     { present: sql<number>`1` }
    grants.ts:276    { n: count() }

Both printed, and neither names a COLUMN, so buildSelection's rewrite has nothing to strip a qualifier
from: `select 1 from "user_credentials" where …` and `select count(*) from "grants" where …`. Rule
36a's latent-harm case — a bare identifier that binds correctly today and inherits the defect when
someone adds a join — cannot arise from a literal or from `count(*)`.

The third fragment in the wave names columns and is NOT in a select list: `approvals.transition`'s two
`COALESCE` clauses, in an UPDATE's SET, which emit fully qualified.

### 10.3 Rule 39a — the complete answer, with its denominator

Wave 2 spreads `getTableColumns` nowhere, so rule 39's literal trigger has no site. The real question
— does any converted read return more columns than the statement it replaced — is answered for all 37
statements in §9.2 and §9.5: **10 bare `.select()` sites** each replacing an original `SELECT *`, exact
against `PRAGMA table_info` on the migrated database (5/5, 4/4, 10/10 ×3, 11/11 ×3, and the two
`user_credentials` reads), and **9 explicit projections** all n/n, widest 10/10
(`auth.listClientSessions`). No mismatch to resolve, so rule 39a's false-positive class did not arise;
the counts came from printed SQL compared against the shipped table, never from pairing a projection
with the first SELECT in its method.

## 11. Both arms on `d1e86d0e8`, and the rule 32 patch, verified

### 11.1 The delta, as a NAME SET

Control restored with `git restore --source=d1e86d0e8` over the sixteen source files (copied out
first, no stash), and `git diff --stat` against the base printed EMPTY — the control arm is
byte-identical to the tip, which is the property that makes the comparison mean anything.
`PODIUM_TEST_WORKERS=1` on all six runs.

| Lane | Control | Treatment | New failures | Fixed |
| --- | --- | --- | --- | --- |
| `server:store` | 70 files / 943 tests / 0 | 70 / 943 / **0** | none | none |
| `server:services` | 129 / 2290 / 37 | 129 / 2290 / 37 | **none — name set identical** | none |
| `server:boundary` | 120 / 2367 / 51 | 120 / 2367 / 53 | **two, both below** | none |

    + account frame read cache reads the account once per frame and re-reads on the next turn
    + account frame read cache caches "no account" as an answer, because that is the verdict callers act on

Both are the probe going dark, §7.4's finding, and nothing else in 5,600 tests moved. The services
lane is why this is measured as a set and not a count: 37 and 37 over an identical set, on a box that
was at load 20 with three other waves' lanes running through it.

**The two failures are now down to ONE cause, not the two §7.4 recorded.** Cause 1 — the probe sitting
on a feed that a converted repository never reaches — was FIXED at this tip by the coordinator's
`clientOverWrapper` (POD-3395), which routes the seam's drizzle through the instrumented handle
instead of past it. What remains is only the SQL-text matcher.

### 11.2 The patch, and its mutation check

The widening is a one-line change plus its comment, and it is NOT landed here: rule 32 makes an
instrument the coordinator's to repair. The patch is `pod-3393-frame-cache-matcher.patch`, attached to
this issue.

    -    if (observation.sql.includes('FROM users WHERE id')) reads += 1
    +    if (READS_ONE_ACCOUNT.test(observation.sql)) reads += 1

    const READS_ONE_ACCOUNT = /from\s+"?users"?\s+where\s+(?:"users"\.)?"?id"?\s*=/i

It accepts BOTH spellings rather than replacing one with the other, because unconverted repositories
keep emitting the hand-written form until the ledger empties. Applied locally, all four tests pass.

Then mutation-checked against the REAL file rather than a fixture — the check is that removing the
behaviour the instrument guards still reddens it AFTER the widening, with an ISOLATING reason code.
Three removals, three different and correct codes:

| Mutation | Reddens | The message, which is the behaviour |
| --- | --- | --- |
| the frame cache never HITS (`if (cache.has(userId))` → `if (false)`) | 2 tests | `expected 3 to be 1` — three reads where the pass should have taken one |
| the frame cache never EXPIRES (read-scope slot → a permanent Map) | 2 tests | `expected 1 to be greater than 1` — no re-read on the next turn; and `expected undefined to be 'Minted'`, a mint inside the frame gone invisible |
| the widening REVERTED, code untouched | 2 tests | `expected 0 to be greater than 0` — the probe observing nothing, which is the defect the patch fixes |

The third row is the one that matters for rule 32: it is the same red the lane shows today, and it
proves the widening is load-bearing rather than cosmetic. Every mutation was reverted by copying the
file back and verifying with `diff` against a `git show HEAD:` copy, never by re-applying a pattern.

### 11.3 Rule 42 — the control arm was really applied, checked three ways

Rule 42 landed after this comparison ran: `git checkout <base> -- <paths>` aborts the whole checkout
when any ONE path is absent from the base, so an arm can silently never be applied and the A/B then
compares a tree with itself. Re-verified rather than assumed:

1. **The abort case had nothing to fire on.** All 16 arm paths exist in `d1e86d0e8`, checked with
   `git cat-file -e` per path. The only file this branch ADDS that the base lacks is this document,
   and the arm excludes `docs/` by construction.
2. **The diff check was run at the moment rule 42 names** — `git diff --stat d1e86d0e8` over the arm
   paths, printed EMPTY, before the first control lane started. (`git restore --source` was used
   rather than `git checkout`, but that is not the reason it worked: every path existed.)
3. **The arms did not agree, which is the functional proof.** The boundary lane went 51 → 53, and the
   two extra failures are the frame-cache tests, which fail precisely BECAUSE `users.ts` is converted.
   A control that was secretly the treatment could not have passed them. The base content is the
   unconverted code — `constructor(executor: StoreExecutor<QueryClient>)`,
   `this.db.prepare('SELECT * FROM users WHERE id = ?')`, and `store.ts` building all six
   repositories from `this.executor`. The store and services lanes' agreement rides on the SAME single
   restore, so it is a real negative and not a tree compared with itself.

`git status --porcelain` is empty, not merely the diff, so rule 42's second half — files the base has
and this branch does not, stranded as untracked leftovers for a later `git add -A` to sweep in — did
not arise either.

**One addition worth making to the rule.** The diff check proves the arm equals the BASE, and it stays
empty in the case where nothing was restored AND the paths happened to be unmodified. The cheap
complement is a POSITIVE marker: grep the built arm for one token that exists only in the treatment
and require it ABSENT. Here that token is `SyncQueries` in `users.ts`. Same cost, and it fails loudly
in the case where the arm was never applied at all.

## 12. Rule 43 — explicit null versus omission. A CHECKED NEGATIVE for wave 2

A drizzle insert names every column the schema knows and binds `null` for the ones the caller did not
supply. An explicit null is not an omission: it defeats the DEFAULT clause. On a NOT NULL column with
a default the write throws; on a NULLABLE column with a default it silently stores null where the
original stored the default — no error, wrong value, no test to show it.

### 12.1 The defaults, from the shipped tables

`PRAGMA table_info` on the migrated database, not `schema.ts`. Seven tables, **two** defaulted columns
in total:

| Table | Columns | With a DEFAULT |
| --- | --- | --- |
| `users` | 5 | none |
| `user_credentials` | 4 | none |
| `grants` | 10 | none |
| `user_layout` | 4 | none |
| `meta` | 2 | none |
| `approval_requests` | 11 | `status DEFAULT 'pending' NOT NULL` |
| `client_sessions` | 10 | `label DEFAULT 'login' NOT NULL` |

### 12.2 Both instances, resolved

**`approval_requests.status`** — the ORIGINAL did not rely on the default either. It named the column
with a literal: `INSERT INTO approval_requests (id, machine_id, session_id, issue_id, op_json,
status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`. The conversion passes `status: 'pending'`.
The DEFAULT clause plays no part on either arm, so there is nothing for an explicit null to defeat.

**`client_sessions.label`** — on the statement that did NOT convert (`auth.createClientSession`,
`// DECISION POD-3403`). It is still the hand-written `INSERT OR REPLACE` naming all ten columns, and
the method defaults the parameter in TypeScript (`label = 'login'`), so a null cannot reach the
column. Unchanged by this wave in either direction. This is the same column §9.4 found from the other
direction, when checking how OR REPLACE and DO UPDATE differ on a NOT NULL violation.

### 12.3 The stronger property: no original omitted anything

Rule 43's hazard needs a column the original OMITTED and the conversion now names. Wave 2 has none —
every hand-written insert in the six files named every column of its target table, checked against
the base:

    users              (id, display_name, role, created_at, disabled_at)   5 of 5, disabled_at a literal NULL
    user_credentials   (user_id, source, password_hash, updated_at)        4 of 4, twice
    grants             all 10                                             10 of 10
    approval_requests  (id, machine_id, session_id, issue_id, op_json, status, created_at)  7 named
    user_layout        (user_id, key, value, updated_at)                   4 of 4, twice
    meta               (key, value)                                        2 of 2, twice

So the conversion adds a named column in exactly one place — `approval_requests`, where drizzle also
names `actor`, `on_behalf_of`, `decided_at` and `result_text` as explicit nulls. All four are NULLABLE
with **no default**, so an explicit null stores precisely what omission would have stored. That is the
benign half of rule 43 and it is the only place the mechanism fires here.

`users.create` keeps the original's hardcoded `NULL` for `disabled_at` (`disabledAt: null`, not
`account.disabledAt`) — worth stating because the caller's row carries a `disabledAt` field that the
original deliberately ignored, and passing it through would have been the natural-looking mistake.

### 12.4 A note on reading §9.5's printed SQL

The printed `grants.upsert` and `approvals.insert` statements show `null` literals in their VALUES
lists. Those come from the PROBE's partial fixture, not from the code: `grants.upsert` supplies all
ten columns from its `GrantRow` and `approvals.insert` supplies its seven. Checked by reading both
method bodies against the base rather than by re-reading the printed statement.
