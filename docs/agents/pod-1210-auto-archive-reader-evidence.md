# POD-1210 — auto-archive over per-user read state: the decision, and the evidence

Branch: `issue/1210-bug-janitor-archives-on-a-dropped-column`, off `issue/279-integration` at
`dfd39e81`. No merge of `main` or of the base into this branch.

## 1. The break

POD-1077's migration `20260730201523_per-user-state-family` re-keyed read state to
`(user_id, entity_id)` and dropped `issues.read_at`, `sessions.read_at` and
`issue_messages.read_at`. The janitor still selected the first two, so **both** auto-archive
jobs threw `SQLiteError: no such column: read_at` on every tick — the live instance, not only
the test lane. Auto-archive had silently stopped happening.

Two sites, not the one the stack trace named:

- `IssueAutoArchiveReader` (`apps/janitor/src/janitor.ts`) — `issues.read_at`, plus a
  `(read_at, id)` keyset cursor.
- `SessionAutoArchiveReader` — `sessions.read_at`, in a query the trace never reached because
  the issue job threw first.

A full sweep of the three dropped columns (`read_at`, `tucked_at`, `pinned`) across the repo,
excluding `apps/server`, found no other consumer: `apps/janitor` was the whole blast radius, and
`tucked_at` / `pinned` have no janitor reader at all. The only surviving `read_at` outside the
server is `messages.read_at` — a different table, never dropped.

## 2. The judgement: WHOSE "read"?

`read_at` was an instance-wide singleton when auto-archive was written, so "has it been read"
had one answer. It is now per user. Three readings were available:

| Reading | Verdict |
| --- | --- |
| **read by ANY user** — `EXISTS`/`MIN(read_at)` over the family table | **Rejected.** Cheapest to write, and wrong. `issues.archived` / `sessions.archived` are still SHARED columns: archiving is a fact about the instance, not about a viewer. Under ANY, one person opening a done issue and letting it age out removes it from everyone's board, including people who have never seen it. Read-gating exists precisely to stop work vanishing before its reader saw it; ANY inverts that on a multi-user instance. |
| **read by ALL users** | **Rejected.** Never fires. An absent row means "never read", there is no per-issue membership roster to bound "all" against, and one dormant account freezes archival instance-wide. It is also not a question a durable snapshot can ask — the janitor would have to enumerate the user table and assert a negative. |
| **read by the viewer the shared flag speaks for** | **Chosen.** |

The third is not a free choice; the **authority already made it**, and the janitor only proposes.
`IssueAttention.tryAutoArchiveObserved` and `SessionService.tryAutoArchiveStoppedObserved`
revalidate every proposal against `issueOverlay(...)` / `viewerOverlay(...).readAt`, i.e.
`broadcastViewer()` = `FIRST_ADMIN_USER_ID`, and reject on
`viewerReadAt !== observed.readAt` with `precondition`. A janitor that observed any other reader
would emit proposals the server throws away — auto-archive dead a **second** time, silently, and
this time with a green integration test. The janitor observes, the server decides, and both have
to ask the same person.

So the multi-user answer is: the shared `archived` flag speaks for one viewer, so it is gated on
that viewer's read. When POD-1077 makes fan-out per-principal, `archived` itself has to become
per-user, and the reader follows the same seam — which is why the reader is a **constructor
argument** defaulting to `ARCHIVE_VIEWER`, not an inlined constant: that day is one edit at the
composition root, and the tests can prove the scoping today by handing in a different user.

### The cursor

`(read_at, id)` became `(ius.read_at, i.id)` — the key moves with the timestamp it orders. It
stays a **total** order: the reader is pinned to ONE user, so at most one `issue_user_state` row
survives the join per issue, and the `issues` primary key breaks every `read_at` tie uniquely.
That is exactly the guarantee the singleton column gave. Under ANY-user semantics it would NOT
have been total — an issue read by three people would appear three times at three timestamps,
and the cursor would revisit or skip rows.

## 3. Evidence

### The named test, isolated

`bun --bun vitest run -c vitest.integration.config.ts scripts/janitor-recovery.integration.test.ts`
→ **1 passed** (it failed with `no such column: read_at` before the fix).

> First it failed for an unrelated reason: this worktree had **no `node_modules`**, so
> `@podium/issue-client` resolved by walking up into the MAIN checkout while `@podium/model` was
> aliased to the worktree — two copies of model, and a `TypeError: undefined is not an object
> (evaluating 'IssueColor.optional')` that looks nothing like the real bug. `bun install` in the
> worktree first. Siblings on this fan-out will hit the same thing.

### The new test, and proof it can say NO

`scripts/janitor-auto-archive.integration.test.ts` (7 tests) builds the database the way the
server does — real migrations via `SessionStore` — and writes read state through the server's own
writers (`setIssueUserState`, `markSessionRead`). The janitor's own unit lane could not have
caught POD-1077, because it hand-rolls its tables and would have happily kept a column the
product no longer has.

It says YES first (a viewer-read, closed, top-level issue IS proposed, carrying exactly the
`readAt` the server will compare against), so the "does not propose" assertions are not vacuous.

Five mutants, applied one at a time to a committed tree, each verified to match exactly once and
to change the file hash, each reverted and the tree confirmed clean:

| Mutant | Result |
| --- | --- |
| M1 — issue: archive regardless of read state (`LEFT JOIN` + null-tolerant cutoff) | **KILLED** — 3 tests fail |
| M2 — issue: "read by ANY user" (`OR 1 = 1` on the user predicate) | **KILLED** — 1 test fails |
| M3 — issue: cursor loses the `id` tiebreaker (`(read_at, '')`) | **KILLED** — 1 test fails (60 tied rows → 25 returned) |
| M4 — session: archive regardless of read state | **KILLED** — 2 tests fail |
| M5 — session: "read by ANY user" | **KILLED** — 1 test fails |

**`scripts/janitor-recovery.integration.test.ts` — the test the stack trace named — passed under
ALL FIVE mutants.** It only proves the query does not throw; its candidate set is empty. That is
the defect class this run's ledger keeps finding, and it is why the new file exists.

### Lanes

- `apps/janitor` unit lane — 12 passed.
- All three janitor integration files — 12 passed.
- `apps/server/src/modules/maintenance` + `.../issues` — 106 passed.
- `bun run typecheck` — 23/23 packages green. `scripts/` is in no typecheck lane, so the new
  test was additionally checked by temporarily including it in `@podium/server`'s project
  (clean; the tsconfig was restored and is unmodified in the diff).
- `bun run lint:boundaries` — `56 allowlisted, 0 new`. Biome clean on both changed files (3
  pre-existing `any` warnings in the row mappers, untouched).
