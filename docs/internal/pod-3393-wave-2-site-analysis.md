# POD-3393 — Wave 2 (identity and access), per-site conversion analysis

Files: `store/users.ts`, `store/auth.ts`, `store/grants.ts`, `store/settings.ts`,
`store/approvals.ts`, `store/user-layout.ts`.

Base: integration branch at `57691d712`. Written BEFORE any conversion, against the synchronous code,
so the conversion that follows is mechanical and reviewable line by line. Every site is answered
against the execution method's Stage A checklist (§3).

## 0. Status — the conversion is not written, and why

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
