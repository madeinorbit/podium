# POD-1653 — the three remaining stall queries, before and after

Measured 2026-08-04 on `issue/1653-three-queries-still-stalling-the-loop`, branched
off and rebased onto `issue/279-integration` @ `6954a1c79`.

## How this was measured

The POD-1630 attribution instrument with POD-1638's two extensions (lifetime totals
and `PODIUM_LOOP_PROFILE_STACKS` caller stacks). No fourth harness was written. One
addition was needed: nothing could read the totals or the stacks out of a live
process, so `server.ts` now dumps both on **SIGUSR2**, inert unless
`PODIUM_LOOP_PROFILE` is set.

Harness: boot the real backend (`scripts/host.ts`) against a **copy** of the live
database, `PODIUM_STATE_DIR` in a temp dir, `PODIUM_INSTANCE=pod1653` so the daemon's
hook/agent-relay ports shift off the defaults, and `PODIUM_PORT=19653`. Port 18787 was
never bound; `~/.podium` was never written. Measure ~130s from boot, then SIGUSR2.

Fixture (the copy): **1622 issues, 1208 sessions, 13 repos, 5553 messages, 0 grants
rows.** Both arms measured on the same base, same fixture, a fresh copy of the
database per arm.

> The two traps POD-1638 recorded both fired again and are worth restating. A fresh
> worktree has **no `node_modules`**, so `@podium/*` resolves to the MAIN checkout —
> and a boot script placed in `/tmp` does the same thing regardless. `bun install` in
> the worktree and keep the entrypoint inside it. Bun also needs
> `--conditions=@podium/source` or every workspace import resolves to an unbuilt
> `dist`.

## Result

Statement counts over ~130s of idle boot. The count is the defect; durations move
with load and this box ran at load 17-19 throughout, so they are context, not claims.

| statement | before | after |
|---|---|---|
| `SELECT * FROM issues WHERE id = ?` | 26,838x / 26,316 rows | **658x / 451 rows** |
| `SELECT * FROM grants WHERE resource_kind = ? AND resource_id = ?` | 20,574x / **0 rows** | **0 — statement gone** |
| `SELECT * FROM issues ORDER BY repo_path ASC, seq ASC` | 1x (boot hydration) | 1x (boot hydration) |

Replacing them, both bounded by passes rather than by sessions:

| statement | after |
|---|---|
| `SELECT * FROM issues WHERE id IN (?)` | 441x / 441 rows |
| `SELECT * FROM grants WHERE resource_kind = ? AND resource_id IN (?)` | 441x / 0 rows |

Stall lines logged in the measured window fell from 25 to 4-8 across runs. That is
directional only — stall counts on a load-17 box are noisy and this harness is idle.

## The three statements were two defects and one honest non-reproduction

### 1. `SELECT * FROM issues ORDER BY repo_path ASC, seq ASC` — NOT reproduced at 9x

The brief reported 9x/487ms/14,589 rows in a single live stall window. **In this idle
harness it ran once, at boot hydration, in both arms.** The 9x needs live traffic this
harness does not generate, and it is not honest to claim a before/after on it.

What the stacks did establish is the shape of the cost, and it was worth fixing on its
own terms. `DurableIssueAccessIndex` answers three cwd questions — `worktreePaths`,
`issueForCwd`, `soleOwnerForCwd` — and each answered with `listIssueRows()`:
`SELECT *` over every issue, every row then run through `mapIssueRow`, which parses
several JSON columns. `relay.ts:1021` calls `worktreePaths().includes(cwd)` on a
**per-message path**, so a membership test cost a full scan plus ~1600 row
materializations.

**Fixed:** `listIssueCwdRows()` reads the five columns those questions actually use
(`id, repo_path, worktree_path, deleted_at, archived`) with no row mapping. Still one
live read per call — this index exists to reflect durable state without a snapshot,
and making it cheaper is not a licence to make it stale.

**Not claimed:** that this removes the live 9x. It removes the per-call payload and
the JSON parsing. Whether the 9x was these callers or a re-hydration should be
re-measured against the live host after this lands.

### 2 and 3 were ONE defect, not two

The brief asked whether the grants reads and the `issues WHERE id = ?` reads were the
same pass. **They were.** Every stack for both statements ran through the same frames:

```
listForResource / getIssue
  <- memoGrantees / memoIssueOwner   (session-authz.ts)
  <- sessionOwner                    (session-authz.ts)
  <- canReadSession                  (session-state/service.ts)
  <- filter <- project               (sessions/view.ts:169)
  <- list                            (sessions/view.ts:71)
```

`SessionView.list()` is not an accessor. It is a reader-scoped projection that runs an
authorization check **per session**, and that check costs one issue row plus one
grants read. Three separate things made it hot:

**(a) The memo was never reaching the code that reads it.** POD-1618 added a per-pass
memo, `project()` builds it, and `canReadSession` threads it down. But
`SessionStateService` was wired with `sessionOwner: (sessionId) => bag.sessionOwner(sessionId)`
— one argument. The memo died at that arity mismatch. Nothing failed; it was only
slow, which is why it survived two perf issues. Fixed by forwarding it.

**(b) A memo cannot collapse distinct keys.** A session with no issue keys its grants
on its own session id, so ~1145 of the 1208 sessions had a unique key and nothing to
coalesce — one zero-row statement each, per pass, forever, because the live `grants`
table has **0 rows**. Fixed by *batching*, explicitly not caching:
`GrantsRepository.listForResources` asks for many resources in one live read.
`grants.ts` rules a cache out by name (ADR 9 D2 rule 4 — revocation must take effect
at the next decision) and that reasoning still holds; every row here is read from
SQLite at the moment of asking. The same batching was applied to the issue rows via
`IssuesRepository.getIssues`.

**(c) A paged sweep paid a full pass per page.** `runReconcilePage` /
`flushDeliveryTriggers` walk the message backlog 100 rows at a time and each page
called `listSessions()`. With 5553 messages that is ~56 full 1208-session projections
per reconcile. POD-817 had already reduced this from once-per-row to once-per-pass;
once-per-pass is still O(pages).

Sharing a listing was the wrong axis. A delivery attempt asks only two questions —
"which session is this id" and "which sessions belong to this issue" — and **both
already had a direct answer**: `sessionById` (POD-1646) and `listSessionsForIssue`
(POD-1639). So `attemptDelivery`'s `allSessions` parameter was removed rather than
hoisted: there is no listing left to share, and no future caller can reintroduce the
cost by forgetting to pass one. `wakeKeyOfRow`, which ran a full pass **per stored
row**, was routed through `findSessionById` too.

## Tests

- `modules/sessions/session-owner-memo-cost.test.ts` (new) — three properties: the
  primed path answers **identically** to the unprimed one (graded against the
  one-at-a-time path as an oracle, over a fixture mixing issue-backed and issue-less
  sessions, a missing issue, and a verb that must not confer read); one batched read
  per kind per pass; and 10x the sessions is the same read count.
- `modules/messages/service.test.ts` — the POD-817 guard "lists sessions once per
  sweep pass" was **strengthened, not relaxed**: the assertion is now ZERO full
  passes, plus a scaling case (50 rows costs what 5 rows costs). The harness now wires
  the narrow ports production wires, counted separately so the assertion is about
  full passes rather than lookups.

Both new guards were verified to fire:

| mutant | result |
|---|---|
| primed path records only FOUND issues (drops the `?? null`) | cost test goes red |
| primed path admits every verb, not read/write/manage | equivalence test goes red |
| issue branch falls back to `listSessions()` | zero-pass test goes red |

## Gates

Scoped to the packages touched, as POD-1638 did — two full-lane vitest runs were
SIGTERMd on this box this morning and it was running at load 17-19 with ~10GB free.

- `apps/server/src/modules/{issues,sessions,messages}` + `apps/server/src/store`:
  **1282 passed, 0 failed** across 93 files.
- `bun run typecheck`: 23/23 (cached wrapper, no forced recompute).
- biome on the 13 changed files: 0 new diagnostics. The two in `store/grants.ts`
  (`useTemplate`, lines 90/94) are pre-existing and on lines this change did not
  touch.

## Follow-up: the hazard class, and what actually guards it

POD-1639 (closed) verified this arity bug against its own measurement base and
named the general hazard: *an optional trailing parameter threaded through a
function-typed port is invisible to the compiler when a call site drops it*. A
1-arg function is assignable to a 2-arg function type, so nothing can go red.

Two corrections worth recording:

- **It was one site, not six.** `session-wiring.ts` has five
  `sessionOwner: (sessionId) => bag.sessionOwner(sessionId)` closures, but only
  `SessionStatePorts` ever declared a memo parameter. The other four consumers
  (browser-open, binding-receipts, headless, client-control) declare
  `sessionOwner(sessionId)` and drop nothing.
- **Making the port take one object does NOT restore a compile error.**
  `bag.sessionOwner` is `(...args: any[]): any`, so the old shape still
  type-checks against the object port — measured, not assumed.

What the object form changes is the FAILURE MODE. Dropping the parameter now
passes the input object where a `SessionId` is expected, ownership resolves to
undefined, and **150 tests in `modules/sessions` fail**. The two-parameter form
failed silently and cost only speed, which is why it survived POD-1618, POD-1638
and POD-1639 and corrupted the per-session cost all three attributed. Loud beats
invisible.

## Known residuals

- **The `issues WHERE id = ?` residual is 658x**, not zero. Those are single-session
  callers with no pass and therefore no memo — correct, and bounded by callers rather
  than by session count.
- **The live 9x full scan is unexplained** (see 1 above). Re-measure on the live host.
- **`listForResources` returns no entry for a resource with no edges**, and
  `primeOwnerMemo` depends on reading that absence as "no grants". A future caller
  that reads a missing key as "not looked up" reintroduces the per-resource query.
  Stated at both signatures; the cost test is what catches it.
