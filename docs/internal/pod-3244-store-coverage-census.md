# POD-3244 — store coverage census

Measured coverage of every public method on every repository class under the store, so each Stage A conversion brief can carry its repository's unguarded methods. Measured, not grepped: the "named in a test file" column is kept beside the measurement so the two can be compared.

**It is regenerated, not maintained.** The first edition of this document was measured once and edited by hand, and by the time POD-3292 recounted it, seven current members had no row at all (POD-3360) — never classified as executed, indirectly guarded or unguarded, so a brief generated from it would have skipped them and nothing would have said so. The inventory, the naming column and every table below are now derived by `scripts/store-coverage-census.ts`, and `bun run audit:store-census` fails when the committed document stops describing the tree.

## What was measured, and how

- **Files.** 41 repository files, 40 of which declare a public member: `apps/server/src/store/*.ts` (excluding `helpers.ts`, `types.ts` and `issue-storage.ts`, which hold free functions and Zod schemas rather than a repository class), `apps/server/src/store/conversations/*.ts`, `apps/server/src/modules/operations/store.ts`, and `packages/sync/src/adapters/sqlite/sync-repository.ts`. `store/issue-revision.ts` is the forty-first: an exported error class whose only member is its constructor.
- **Methods.** 532 public members that carry a function body, taken from the TypeScript AST (methods, accessors and arrow-function properties on exported classes; constructors, `private`/`protected` and `#private` members excluded). 502 of them carry a verdict from the last six-lane measurement. The other 30 landed after it and are inventoried unmeasured — see below, because the number is now large enough to change how the full table reads.
- **Lanes.** All five `@podium/server` shards (`store`, `services`, `boundary`, `contracts`, `normalized-wire`) plus the `@podium/sync` package lane, each run once with coverage. Service and boundary tests are in scope deliberately: they are what actually exercise several repositories (locks through `LockService`), which is the whole reason the naming heuristic overstates thinness.
- **Provider: istanbul, not v8.** These lanes run under Bun (`bun --bun .../vitest.mjs`), and Bun has no inspector coverage API — `@vitest/coverage-v8` dies with `Coverage APIs are not supported` before a single test runs. `@vitest/coverage-istanbul` instruments at transform time and works unchanged in the lane's normal runner.
- **Attribution.** A method is mapped to its istanbul `fnMap` entry by declaration line. As a check on that mapping, function-hit and statement-hit are computed independently for all 503 methods and agree on every one (0 disagreements). A member no lane instrumented at all is refused rather than recorded: it would otherwise read as "never executed", which is the most consequential verdict here.

## Reproducing it

Re-running the census is two things: a measurement, which needs the lanes, and a derivation, which does not.

**The derivation, and the gate.** `bun run audit:store-census` re-derives the inventory and the naming column from the tree and reports what the committed document no longer describes. It fails on membership — a member with no row, a row with no member — and on a member that has LOST its last naming test. It does not fail on a line number that moved (`bun scripts/store-coverage-census.ts sync-lines` rewrites those) or on a member that has GAINED a naming test, because that direction only makes this document pessimistic. The same check runs as a test in the `scripts` lane, so CI executes it.

**The measurement.** Install `@vitest/coverage-istanbul` (deliberately not a repository dependency — install it into `node_modules` and remove it afterwards so `package.json` and `bun.lock` stay untouched) and run each lane once:

```
cd apps/server && bun ../../scripts/validation-admission.ts focused --label census:<lane> -- \
  bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.<lane>.config.ts \
  --coverage.enabled --coverage.provider=istanbul --coverage.all=true --coverage.reportOnFailure=true \
  --coverage.include=apps/server/src/store/** \
  --coverage.include=apps/server/src/modules/operations/store.ts \
  --coverage.include=packages/sync/src/adapters/sqlite/sync-repository.ts \
  --coverage.reporter=json --coverage.reportsDirectory=<dir>/<lane>
```

Then `bun scripts/store-coverage-census.ts generate <dir>` rewrites every table below from those reports. The per-test-file column comes from the same command run once per file of the `server:store` shard, into `<dir>/per-file/<slug>/` beside a `test-file.txt` naming the file.

`--coverage.reportOnFailure=true` is not optional here: Vitest writes no coverage report at all when a lane ends red, and some of these lanes do end red (below).

`PODIUM_TEST_WORKERS=1` was set in the session that produced these numbers, and the host was under heavy concurrent load from the other epic worktrees (load average around 18 on 8 cores). Neither changes which methods execute.

## A row with no measured verdict is not a row that says "unguarded"

30 of the 532 rows below have never been through a six-lane `generate`: they are members that landed after the last measurement. The gate is deliberately blind to this — `censusDrift` compares files, classes, members and the naming column and never reads the Covered column at all — so an unmeasured member is caught the moment it has no ROW, and never again once it has one.

That matters because `**no**` in the full table now means two different things:

- **Measured, and never executed by any test in any lane** — the 14 rows in the never-executed list above. This is the consequential verdict: a conversion here is unguarded.
- **Not measured at all** — the 30 rows whose Covering cell reads *not measured — landed after the last six-lane generate*. This says nothing about whether a test executes them. Several plainly are executed; `UsersRepository.removeMember` is named in five test files.

Read the Covering cell, not the Covered cell, before treating a `**no**` as unguarded. The pessimism is the safe direction — it can only make the unguarded list look longer than it is — but it is pessimism, not measurement, and at 30 rows it is no longer a rounding error.

**The six generated blocks above describe the last six-lane run, not this tree.** The headline, the never-executed list, the no-caller table, the per-repository table and the two repository sections are rewritten only by `generate`, which needs the lanes; the full table below is the live inventory the gate checks. So the headline totals 503 members where the tree has 532. Do not hand-patch a generated block to close that gap — a hand-written number there is indistinguishable from a measured one, which is the failure this document exists to prevent. One had already crept in: the row for `UsersRepository.earliestAdmin` was hand-added with `yes` and two named lanes, which no `generate` produced, and it is now marked unmeasured with the rest [PDM-323].

## Some lanes are red, and what that does to the numbers

34 test files failed across the lanes at this edition's commit: `server:services` 10, `server:boundary` 21, `server:contracts` 3. `server:store`, `server:normalized-wire` and `@podium/sync` were green.

Every one of those files was re-run WITHOUT coverage, same lane, same commit, and all 34 fail identically — they are the branch, not the instrumentation:

| Lane | Failing files with coverage | Failing files without coverage |
| --- | ---: | ---: |
| `server:store` | 0 | 0 |
| `server:services` | 10 | 10 |
| `server:boundary` | 21 | 21 |
| `server:contracts` | 3 | 3 |
| `server:normalized-wire` | 0 | 0 |
| `@podium/sync` | 0 | 0 |

The first edition saw one extra failure that this one does not, and it is worth keeping written down because it will come back. A shard that splits into a *reused* project asserts after every file that nothing was left on `globalThis`, because the runner is handed to the next file; istanbul's counters live exactly there, so the guard reports `globalThis.__VITEST_COVERAGE__ was added` and fails the file while all its tests pass. Read that one as the guard doing its job, not as a red test — its coverage still counts.

The direction matters and it is the safe one: a test that fails runs *less* code than a test that passes, never more. So a red lane can only make the never-executed list LONGER than the truth — every method listed as covered really was executed. As a check on the other side, none of the 14 never-executed methods is named in any of the 34 failing files (`upsert` matches five of them by name only, on unrelated objects).

## Headline

<!-- census:headline -->
| | Methods | Share |
| --- | ---: | ---: |
| Never executed by any test in any lane | **14** | 2.8% |
| Executed, but never named in any test file | 154 | 30.6% |
| Executed and named in at least one test file | 335 | 66.6% |
| **Total public repository methods** | **503** | |
<!-- /census:headline -->

The brief's starting estimate — "about 131 of roughly 455 public repository methods are never named in any test file" — was right about the direction and wrong about the consequence. Counting the same way but with the store-accessor spelling (`.<accessor>.<method>(`) or a direct `new <Class>(` construction in the same file, **168** of 503 methods are never named in a test file. Measured coverage says only **14** are never *executed*. The gap of 154 is the "locks via LockService" effect at scale: most repository methods reach a test through a service, a router or a fixture, not through a test that spells them.

So for a conversion brief there are two different lists, and they mean different things:

- **Never executed (14)** — a conversion here is completely unguarded. A golden test against the synchronous code comes first (method section 3, checklist item 10).
- **Executed but never named (154)** — a conversion here is guarded only indirectly. The test that would go red does not mention the method, so a reviewer reading the diff cannot see which test protects it. These are the methods where an incidental behaviour change (row order, `undefined` vs `null`, a silently dropped column) can pass.

## Never executed — the whole list

<!-- census:never-executed -->
| Repository file | Class | Method | Line | Named in a test file |
| --- | --- | --- | ---: | --- |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSubjectSinceWithPrior` | 386 | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `purgeIssueUserState` | 1181 | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSenders` | 342 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `listForChat` | 26 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByIssue` | 36 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByThreadRef` | 46 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `upsert` | 56 | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `getRecapWatermark` | 20 | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `setRecapWatermark` | 27 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdForOrder` | 540 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdsForOrders` | 547 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `isolateTrainFailure` | 1332 | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `archiveSuperagentThread` | 208 | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `costedSessionIds` | 191 | — |
<!-- /census:never-executed -->

### Do the never-executed methods have a caller at all?

<!-- census:no-caller -->
3 of the 14 are not thin tests, they are unused code — nothing outside the repository file names them anywhere in `apps`, `packages`, `scripts`, `tests` or `services`:

| Method | Named outside its own file |
| --- | --- |
| `EventsRepository.listKindSubjectSinceWithPrior` | `apps/server/src/modules/sessions/activity-history.test.ts`, `apps/server/src/modules/sessions/activity-history.ts` |
| `IssuesRepository.purgeIssueUserState` | **none** — the declaration is the only occurrence in the tree |
| `MessagesRepository.listPendingSenders` | **none** — the declaration is the only occurrence in the tree |
| `MessagingTopicsRepository.listForChat` | `apps/server/src/modules/messaging/service.test.ts`, `apps/server/src/modules/messaging/service.ts` |
| `MessagingTopicsRepository.getByIssue` | `apps/server/src/modules/messaging/service.test.ts`, `apps/server/src/modules/messaging/service.ts` |
| `MessagingTopicsRepository.getByThreadRef` | `apps/server/src/modules/messaging/service.test.ts`, `apps/server/src/modules/messaging/service.ts` |
| `MessagingTopicsRepository.upsert` | unanswerable by name — another repository declares a member with this name |
| `ReadWatermarksRepository.getRecapWatermark` | `apps/server/src/modules/sessions/deterministic-status.test.ts`, `apps/server/src/modules/sessions/read-toolkit.test.ts` +1 |
| `ReadWatermarksRepository.setRecapWatermark` | `apps/server/src/modules/sessions/deterministic-status.test.ts`, `apps/server/src/modules/sessions/read-toolkit.test.ts` +1 |
| `ShippingRepository.issueIdForOrder` | `apps/server/src/feed-visibility.ts` |
| `ShippingRepository.issueIdsForOrders` | `apps/server/src/feed-visibility.ts` |
| `ShippingRepository.isolateTrainFailure` | `apps/server/src/modules/shipping/service.ts` |
| `SuperagentRepository.archiveSuperagentThread` | `apps/server/src/modules/superagent/service.ts` |
| `TranscriptCostsRepository.costedSessionIds` | **none** — the declaration is the only occurrence in the tree |
<!-- /census:no-caller -->

Named is weaker than called, and the table says only what a name scan can say. `MessagingTopicsRepository.listForChat` is named by `modules/messaging/service.ts` because the deps interface declares it and `service.test.ts` stubs it — nothing calls it. `MessagesRepository.listPendingSenders` has no occurrence outside its own declaration at all; the method the code uses is the sibling `listPendingSendersForSession`.

Converting a member with no caller and no test would be work spent on nothing. Those are worth deleting before the wave that owns their file rather than porting; filed separately so the epic does not have to decide it inline.

## Per repository

<!-- census:per-repository -->
| Repository file | Public methods | Never executed | Executed, never named |
| --- | ---: | ---: | ---: |
| `apps/server/src/store/shipping.ts` | 50 | 3 | 15 |
| `apps/server/src/store/issues.ts` | 42 | 1 | 10 |
| `apps/server/src/store/messages.ts` | 40 | 1 | 21 |
| `apps/server/src/store/sessions.ts` | 39 | 0 | 8 |
| `apps/server/src/store/events.ts` | 27 | 1 | 5 |
| `apps/server/src/store/workflows.ts` | 26 | 0 | 15 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | 21 | 0 | 1 |
| `apps/server/src/store/repos.ts` | 17 | 0 | 6 |
| `apps/server/src/store/superagent.ts` | 17 | 1 | 3 |
| `apps/server/src/store/notification-facts.ts` | 14 | 0 | 9 |
| `apps/server/src/store/automations.ts` | 13 | 0 | 7 |
| `apps/server/src/store/machines.ts` | 13 | 0 | 0 |
| `apps/server/src/store/auth.ts` | 12 | 0 | 1 |
| `apps/server/src/store/interactions.ts` | 12 | 0 | 4 |
| `apps/server/src/store/locks.ts` | 12 | 0 | 11 |
| `apps/server/src/store/observation-checkpoints.ts` | 12 | 0 | 4 |
| `apps/server/src/store/conversations/registry.ts` | 11 | 0 | 6 |
| `apps/server/src/store/conversations/mirror.ts` | 10 | 0 | 0 |
| `apps/server/src/store/conversations/transcript-index.ts` | 10 | 0 | 5 |
| `apps/server/src/store/server-secrets.ts` | 10 | 0 | 1 |
| `apps/server/src/store/grants.ts` | 9 | 0 | 3 |
| `apps/server/src/modules/operations/store.ts` | 8 | 0 | 1 |
| `apps/server/src/store/conversations/index.ts` | 8 | 0 | 3 |
| `apps/server/src/store/settings.ts` | 8 | 0 | 0 |
| `apps/server/src/store/user-layout.ts` | 7 | 0 | 1 |
| `apps/server/src/store/users.ts` | 8 | 0 | 2 |
| `apps/server/src/store/transcript-costs.ts` | 6 | 1 | 3 |
| `apps/server/src/store/approvals.ts` | 5 | 0 | 3 |
| `apps/server/src/store/maintenance.ts` | 5 | 0 | 3 |
| `apps/server/src/store/quota-history.ts` | 5 | 0 | 0 |
| `apps/server/src/store/user-preferences.ts` | 5 | 0 | 1 |
| `apps/server/src/store/accounts.ts` | 4 | 0 | 0 |
| `apps/server/src/store/messaging-topics.ts` | 4 | 4 | 0 |
| `apps/server/src/store/telegram-bindings.ts` | 4 | 0 | 0 |
| `apps/server/src/store/user-read-position.ts` | 3 | 0 | 0 |
| `apps/server/src/store/read-watermarks.ts` | 2 | 2 | 0 |
| `apps/server/src/store/settings-audit.ts` | 2 | 0 | 0 |
| `apps/server/src/store/table-writes.ts` | 2 | 0 | 1 |
| `apps/server/src/store/conversations.ts` | 1 | 0 | 1 |
<!-- /census:per-repository -->

### Repositories no test file mentions at all

Every method in these files is reached only through a caller. There is no test that names the repository, so nothing in the test tree describes what these methods are supposed to return — the conversion has to read the SQL and the caller to know what it may not change:

<!-- census:unnamed-repositories -->
- `apps/server/src/store/conversations.ts` — 1 method, 0 of them never executed
- `apps/server/src/store/messaging-topics.ts` — 4 methods, 4 of them never executed
- `apps/server/src/store/read-watermarks.ts` — 2 methods, 2 of them never executed
<!-- /census:unnamed-repositories -->

### The five large repositories

<!-- census:largest-repositories -->
**`apps/server/src/store/shipping.ts`** — 50 public methods; 3 never executed; 15 executed but never named.

- Never executed: `issueIdForOrder`, `issueIdsForOrders`, `isolateTrainFailure`
- Executed, never named: `shippingEvidence`, `shippingEvidenceForSource`, `recordShippingEvidence`, `createOrReturnActiveOrder`, `activeTrainsForLane`, `releaseTrain`, `recordNativeStackEdge`, `hasNativeStackEdge`, `hasAttemptCustody`, `assertEffectDispatchCustody`, `commitEffectResult`, `commitCancellationHold`, `commitCustodyHold`, `cancelAttemptAndOrder`, `completeVerifiedTrain`

**`apps/server/src/store/issues.ts`** — 42 public methods; 1 never executed; 10 executed but never named.

- Never executed: `purgeIssueUserState`
- Executed, never named: `listIssueCwdRows`, `listIssueParentEdges`, `assignRepoIdToIssuesUnder`, `issuesMissingRepoId`, `listIssueLabelsByIssue`, `listAllIssueDeps`, `countIssueComments`, `countIssueCommentsByIssue`, `searchIssueComments`, `deleteIssueMessagesForIssue`

**`apps/server/src/store/messages.ts`** — 40 public methods; 1 never executed; 21 executed but never named.

- Never executed: `listPendingSenders`
- Executed, never named: `queuedPositionForSession`, `pendingForPage`, `pendingHighWater`, `latestPendingOperatorForSession`, `pendingSummary`, `countQueued`, `existingMessageIds`, `selfSentIds`, `pendingSummaryForSession`, `alreadyCommunicated`, `retractOptimisticDelivery`, `markSendRefused`, `markCancelled`, `markDeliveredByPull`, `markRead`, `markDeadLetter`, `clearInjected`, `recordWakeCooldown`, `listDeliveredUnacked`, `listSettleNotifiable`, `markReminded`

**`apps/server/src/store/sessions.ts`** — 39 public methods; 0 never executed; 8 executed but never named.

- Never executed: *none*
- Executed, never named: `getSessions`, `findSessionsByResumeValues`, `listSessionsByResumeValues`, `findSessionsByIssueIds`, `clearAllReadAt`, `hasAnySnooze`, `clearAllSnoozes`, `setDraftDoc`

**`apps/server/src/store/events.ts`** — 27 public methods; 1 never executed; 5 executed but never named.

- Never executed: `listKindSubjectSinceWithPrior`
- Executed, never named: `saveRuntimeEventCheckpoint`, `listRuntimeEventsAfter`, `saveRuntimeEventProjectionCursor`, `announceEvent`, `activateJanitorSteward`
<!-- /census:largest-repositories -->

## Full table

`Covered` is measured. `Covering test file(s) / lane(s)` names exact test files where a separate per-test-file coverage run was made — all 68 files of the `server:store` shard, run one at a time. For everything else the column names the lane: per-test-file attribution across `services`, `boundary` and `contracts` would have meant 342 further instrumented runs on a shared host, and the census does not need it to answer what it was asked. A method whose row names a lane rather than a file is still measured as executed; only the pointer to the exact test is coarser.

<!-- census:full-table -->
| Repository file | Class | Method | Line | Covered | Covering test file(s) / lane(s) | Named in a test file |
| --- | --- | --- | ---: | :-: | --- | --- |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `insert` | 147 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `update` | 220 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/store.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `markTerminal` | 245 | yes | `apps/server/src/modules/operations/engine.test.ts` | — |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `get` | 256 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `activeByGroup` | 269 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `claimGroup` | 164 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `active` | 287 | yes | `apps/server/src/modules/operations/engine.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +2 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `history` | 314 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +3 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `sweepRetention` | 356 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `pendingCleanup` | 293 | **no** |  *not measured — landed after the last six-lane generate*  | — |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `approvedTarget` | 332 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `list` | 89 | yes | `apps/server/src/store/accounts.test.ts` — also server:boundary | `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `get` | 100 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:services | `apps/server/src/store/accounts.test.ts`, `scripts/managed-account-spawn.integration.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `upsert` | 136 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:services, server:boundary | `apps/server/src/accounts.test.ts`, `apps/server/src/modules/sessions/account-env.test.ts` +3 |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `remove` | 167 | yes | `apps/server/src/store/accounts.test.ts` | `apps/server/src/accounts.test.ts`, `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `insert` | 56 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `get` | 78 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listPending` | 83 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listExecuting` | 97 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `transition` | 109 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/auth.ts` | AuthRepository | `createClientSession` | 84 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `listClientSessions` | 109 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSessionsByLabel` | 142 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `getClientSession` | 149 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `extendClientSession` | 181 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `touchClientSession` | 189 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `listMobileClientSessions` | 197 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteOwnedMobileClientSession` | 203 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `isClientSessionValid` | 221 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSession` | 226 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteAllClientSessions` | 231 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteExpiredClientSessions` | 236 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `list` | 118 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/automation-removal-scoping.test.ts` +3 |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `get` | 128 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `ownerOf` | 156 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `runOwnerOf` | 166 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `insert` | 175 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `update` | 203 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `remove` | 242 | yes | server:services, server:boundary | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `addRun` | 268 | yes | server:services, server:boundary | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `getRun` | 284 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `updateRun` | 295 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listRuns` | 307 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listAllRuns` | 323 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `lastSpawnedSessions` | 338 | yes | server:services, server:boundary | — |
| `apps/server/src/store/committed-rows.ts` | CommittedRows | `write` | 30 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/committed-rows.ts` | CommittedRows | `subscribe` | 23 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/modules/world-index/index.test.ts` |
| `apps/server/src/store/conversations.ts` | ConversationsRepository | `ensureFts` | 41 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `enableFts` | 100 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `disableFts` | 139 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `upsert` | 160 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/search.test.ts` +4 |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `delete` | 182 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `curatedMeta` | 189 | yes | server:boundary | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `setMeta` | 206 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `searchCandidates` | 259 | yes | server:boundary | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirror` | 36 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirrorDirty` | 42 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setReportedBytes` | 84 | yes | server:services, server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `reportedBytes` | 92 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `mirrorCursor` | 101 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setMirrorCursor` | 110 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `activeIncarnation` | 118 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `startIncarnation` | 141 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `rotateIncarnation` | 170 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `incarnations` | 214 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `repairSubagentSegmentPaths` | 31 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumId` | 47 | yes | server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/cost/service.test.ts` +1 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentsByPaths` | 64 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `parentPodiumIds` | 113 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `nativeIdsByPodiumIds` | 138 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `pathsByNativeIds` | 166 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentPath` | 185 | yes | server:services, server:boundary | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `ensure` | 194 | yes | server:services, server:boundary | `apps/server/src/modules/cost/service.test.ts`, `apps/server/src/modules/memory/lake.test.ts` +6 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `linkSegment` | 265 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumIds` | 300 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `siblingSegments` | 317 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `enableFts` | 46 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `disableFts` | 64 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `isAvailable` | 68 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `segmentsToIndex` | 72 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `indexedCursor` | 91 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `append` | 100 | yes | server:services, server:boundary | `apps/server/src/search.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `resetMissingLake` | 132 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `rows` | 160 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `searchCandidates` | 177 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `drop` | 209 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `onAppend` | 152 | yes | `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventCheckpoint` | 158 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventCheckpoint` | 190 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEvents` | 214 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/daemon/src/runtime-event-reconnect.integration.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeTranscriptEvents` | 234 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `hasCausalTurnFailure` | 289 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEventsAfter` | 308 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventProjectionCursor` | 329 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventProjectionCursor` | 338 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `appendEvent` | 358 | yes | `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +4 |
| `apps/server/src/store/events.ts` | EventsRepository | `announceEvent` | 410 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listEventsSince` | 441 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/characterization.test.ts` +18 |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSinceWithPrior` | 466 | yes | server:boundary | `apps/server/src/event-log.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSubjectSinceWithPrior` | 489 | **no** | — | — |
| `apps/server/src/store/events.ts` | EventsRepository | `maxEventId` | 520 | yes | `apps/server/src/store/executor/span-side-effects.test.ts` — also server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/steward.test.ts` +1 |
| `apps/server/src/store/events.ts` | EventsRepository | `planEventPrune` | 541 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +1 |
| `apps/server/src/store/events.ts` | EventsRepository | `pruneEventBatch` | 562 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getStewardState` | 595 | yes | server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setStewardState` | 604 | yes | server:boundary | `apps/server/src/steward.single-flight.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `activateJanitorSteward` | 630 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `addSubscription` | 648 | yes | server:boundary | `apps/server/src/steward.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `removeSubscription` | 667 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listSubscriptions` | 671 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setSubscriptionEnabled` | 682 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getSubscription` | 687 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listEnabledSubscriptions` | 692 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `markDelivered` | 705 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityRevision` | 85 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityAudienceFor` | 89 | yes | server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityAudienceResourceIds` | 104 | yes | server:boundary | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResource` | 142 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResources` | 172 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForKind` | 201 | yes | `apps/server/src/store/grants.test.ts` | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `loadWorldGrants` | 215 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `upsert` | 226 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +6 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `remove` | 262 | yes | `apps/server/src/store/grants.test.ts` — also server:services | `apps/server/src/modules/fleet/authz.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `removeAllForResource` | 284 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `insert` | 159 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `get` | 191 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `openByFingerprint` | 196 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listOpen` | 214 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listForSession` | 229 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `answer` | 246 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `recordDelivery` | 279 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `reopen` | 319 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `retireClaimed` | 356 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `close` | 387 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `closeSession` | 397 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `pruneResolvedBefore` | 413 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `upsertIssue` | 168 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +13 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `transitionShippingStage` | 443 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssue` | 478 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/characterization.test.ts`, `apps/server/src/event-log.test.ts` +15 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueCwdRows` | 511 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `closedIssueIds` | 567 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssues` | 604 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues-frame-cache.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueParentEdges` | 663 | yes | server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueRows` | 675 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/search.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `loadWorldIssuePaths` | 721 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssue` | 728 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/relay.draft-reap.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `pruneOrphanRefLetters` | 757 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `nextIssueSeq` | 770 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `renumberCollidingIssueSeqs` | 792 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `assignRepoIdToIssuesUnder` | 854 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `allocateSessionLetter` | 912 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `issuesMissingRepoId` | 935 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueLabels` | 1050 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueLabels` | 1066 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueLabelsByIssue` | 1079 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllLabels` | 1094 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueDep` | 1106 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `removeIssueDep` | 1115 | yes | server:services, server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueDeps` | 1134 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllIssueDeps` | 1147 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listDependents` | 1155 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueComment` | 1166 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueComments` | 1181 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/issues.test.ts` +5 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueComments` | 1191 | yes | server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueCommentsByIssue` | 1204 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `searchIssueComments` | 1215 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `backfillLegacyWorktreeMachineIds` | 977 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/store.legacy-worktree-machine.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueMessage` | 1267 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueMessage` | 1283 | yes | server:services, server:boundary | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessages` | 1288 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `legacyWorktreeContradictionSql` | 1044 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/store.legacy-worktree-machine.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countUnreadIssueMessages` | 1305 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `markIssueMessagesRead` | 1325 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessageReadAt` | 1358 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueUserState` | 1383 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueUserState` | 1410 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueUserState` | 1445 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `purgeIssueUserState` | 1492 | **no** | — | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `claimIssueMessage` | 1498 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueMessagesForIssue` | 1507 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueChildRows` | 1511 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `getLock` | 106 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocks` | 116 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listExpiredLocks` | 126 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocksHeldBySession` | 136 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `upsertLock` | 148 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `renewLock` | 178 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `deleteLock` | 203 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaiters` | 211 | yes | server:services | `apps/server/src/modules/lock/service.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `enqueueWaiter` | 223 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiter` | 246 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiterBySession` | 250 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaitsBySession` | 264 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/machines.ts` | MachinesRepository | `legacyMachineSentinelSites` | 271 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `upsertMachine` | 305 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +28 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `listMachines` | 345 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/daemon/test/build-report-compiled.bun.test.ts` +18 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachine` | 354 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/gateway/peer-handshake.build.test.ts` +8 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `addMachineComponent` | 380 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/stop.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineInventory` | 398 | yes | server:services, server:boundary | `apps/server/src/browser-open.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +6 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineBuild` | 406 | yes | `apps/server/src/store/machines.build.test.ts` — also server:services, server:boundary | `apps/server/src/modules/machines/version-state.test.ts`, `apps/server/src/router.updates.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachineByToken` | 466 | yes | server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setUpdateChannel` | 480 | yes | server:boundary | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/server/src/router.updates.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `renameMachine` | 487 | yes | server:services, server:boundary | `apps/server/src/relay.bind-storm.test.ts`, `apps/server/src/sessions.ledger.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineOwner` | 500 | yes | server:services, server:boundary | `apps/server/src/modules/machines/service.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `deleteMachine` | 507 | yes | server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `touchMachine` | 513 | yes | server:services, server:boundary | `apps/server/src/modules/machines/service.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setSupervisorPresence` | 429 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/store/machines.build.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setServiceAssignment` | 451 | **no** |  *not measured — landed after the last six-lane generate*  | — |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setPresenceSource` | 458 | **no** |  *not measured — landed after the last six-lane generate*  | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getLease` | 39 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `putLease` | 46 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getCommand` | 64 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `recordCommand` | 77 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `pruneCommandsBatch` | 99 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `addMessage` | 201 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/issues/service/mail-pending.test.ts` +10 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `loadWorldPending` | 246 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getMessage` | 255 | yes | server:services, server:boundary | `apps/daemon/src/queue-drain-reconnect.integration.test.ts`, `apps/server/src/issues.test.ts` +8 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listMessagesFor` | 261 | yes | server:services, server:boundary | `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts`, `apps/server/src/modules/messages/service.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForSessionProof` | 278 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listLedger` | 308 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-ask-upload.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `queuedPositionForSession` | 345 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForPage` | 378 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingHighWater` | 396 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `latestPendingOperatorForSession` | 410 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSenders` | 429 | **no** | — | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummary` | 434 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countQueued` | 440 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPending` | 449 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` +2 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordRead` | 467 | yes | server:services, server:boundary | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `existingMessageIds` | 487 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `readReceipts` | 505 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `selfSentIds` | 519 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummaryForSession` | 572 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPendingForSession` | 626 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSendersForSession` | 635 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `alreadyCommunicated` | 645 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markInjected` | 669 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveryAbandoned` | 695 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `retractOptimisticDelivery` | 740 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markSendRefused` | 772 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDelivered` | 794 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markCancelled` | 811 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveredByPull` | 827 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markRead` | 844 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeadLetter` | 871 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `clearInjected` | 894 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueued` | 903 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/queue-drain-abandonment.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueuedPage` | 908 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordWakeCooldown` | 922 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getWakeCooldown` | 930 | yes | server:services, server:boundary | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `expireObserved` | 942 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markAcked` | 969 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listDeliveredUnacked` | 984 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listSettleNotifiable` | 1018 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markReminded` | 1040 | yes | server:services | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `listForChat` | 40 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByIssue` | 48 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByThreadRef` | 58 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `upsert` | 68 | **no** | — | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `claim` | 43 | yes | server:services, server:boundary | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `hasActive` | 84 | yes | server:boundary | `apps/server/src/restart-notification-storm.integration.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retire` | 100 | yes | server:services, server:boundary | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKey` | 116 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKeyPrefix` | 129 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireByIssue` | 140 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireExpired` | 144 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `claim` | 163 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `isClaimed` | 180 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retire` | 184 | yes | server:services, server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKey` | 189 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKeyPrefix` | 194 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireByIssue` | 198 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireExpired` | 202 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `loadAll` | 187 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `get` | 198 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +6 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `advanceGeneration` | 206 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +2 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `rebindExact` | 281 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `save` | 396 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `getTerminalCandidate` | 425 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/restart-notification-storm.integration.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +1 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `recordTerminalCandidate` | 456 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `confirmTerminalCandidate` | 516 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `renewTerminalCandidate` | 573 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `consumeTerminalCandidate` | 625 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `cancelTerminalCandidate` | 656 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `purge` | 663 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `record` | 136 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `list` | 263 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `trail` | 278 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `prune` | 301 | yes | `apps/server/src/store/quota-history.test.ts` — also server:services, server:boundary | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `countAll` | 306 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `getRecapWatermark` | 32 | **no** | — | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `setRecapWatermark` | 51 | **no** | — | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `invalidateRegistry` | 136 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepoPaths` | 141 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-capability-guard.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts` +3 |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepos` | 178 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +2 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/find-repo-on-machine.test.ts` +9 |
| `apps/server/src/store/repos.ts` | ReposRepository | `isPrefixTaken` | 213 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `derivePrefixFor` | 218 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForRepoId` | 224 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForPath` | 233 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/store.refs.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixResolver` | 238 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `repoForPrefix` | 245 | yes | server:boundary | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `ensurePrefixForRepoId` | 263 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `setRepoPrefix` | 287 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.refs.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `nextDraftSeq` | 315 | yes | server:services, server:boundary | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `addRepo` | 336 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.test.ts` +20 |
| `apps/server/src/store/repos.ts` | ReposRepository | `updateRepoOrigin` | 390 | yes | server:boundary | `apps/server/src/store.repo-id.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `resolveRepoIdForPath` | 468 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` +1 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts`, `apps/server/src/store.repo-id.test.ts` +2 |
| `apps/server/src/store/repos.ts` | ReposRepository | `repoIdResolver` | 496 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` +1 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `removeRepo` | 512 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.machines.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `legacyRepoResidue` | 540 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `putNativeLoginTransfer` | 81 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getNativeLoginTransfer` | 91 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/modules/machines/login-propagation.test.ts`, `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clearNativeLoginTransfer` | 109 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `get` | 136 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `scripts/audit-client-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getOrEmpty` | 148 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/settings/wiring.test.ts` +1 |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `set` | 160 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `apiKeyFor` | 181 | yes | server:boundary | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clear` | 187 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `updatedAt` | 192 | yes | `apps/server/src/migrations/server-secret-store.test.ts` | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `presence` | 210 | yes | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `bindingOwnersForMachine` | 82 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadSessions` | 91 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +24 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSession` | 122 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-oom-death.test.ts` +1 more — also server:services, server:boundary | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/session-requested-model-reload.test.ts` +7 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionByResumeValue` | 143 | yes | `apps/server/src/store/session-by-resume-value.test.ts` | `apps/server/src/store/session-by-resume-value.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSessions` | 155 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByResumeValues` | 171 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSessionsByResumeValues` | 196 | yes | server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByIssueIds` | 222 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessions` | 235 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-attribution.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessionsForIssue` | 240 | yes | server:boundary | `apps/server/src/relay.issue-session-delete.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `upsertSession` | 265 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` +2 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +17 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteSessions` | 425 | yes | `apps/server/src/store/session-by-resume-value.test.ts` — also server:services, server:boundary | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteForIssue` | 441 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `restoreDeletedForIssue` | 446 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachTombstonesFromIssue` | 491 | yes | server:services, server:boundary | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachDanglingIssueReferences` | 515 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `purgeSession` | 535 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/sessions.refs.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listPins` | 558 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-session-state.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setPin` | 574 | yes | server:services, server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listReadAt` | 621 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/oracle-commands.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getReadAt` | 633 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/session-cutover.audit.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionRead` | 648 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/archive-park.test.ts`, `apps/server/src/modules/sessions/auto-archive-observed.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionUnread` | 665 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/auto-archive-observed.test.ts`, `apps/server/src/relay.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllReadAt` | 687 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSnoozes` | 698 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +6 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setSnooze` | 726 | yes | server:services, server:boundary | `apps/server/src/relay.outbox.test.ts`, `apps/server/src/relay.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearSnooze` | 746 | yes | server:services, server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `hasAnySnooze` | 758 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllSnoozes` | 770 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listOffers` | 780 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setOffer` | 811 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-idempotency.test.ts`, `apps/server/src/offer.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `offerCreatedAt` | 840 | yes | server:services, server:boundary | `apps/server/src/offer.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearOffer` | 850 | yes | server:services, server:boundary | `apps/server/src/offer.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listTabOrders` | 859 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setTabOrder` | 877 | yes | server:services, server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDrafts` | 943 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/modules/sessions/session-start.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftTimes` | 956 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraft` | 969 | yes | server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftDocs` | 1008 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraftDoc` | 1025 | yes | server:services, server:boundary | — |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `append` | 142 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/settings/wiring.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `list` | 172 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services | `apps/server/src/modules/settings/wiring.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettings` | 83 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +12 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/sessions/session-state/registry.test.ts` +9 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettings` | 97 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/modules/sessions/session-state/registry.test.ts`, `apps/server/src/modules/sessions/spawn-account-env.test.ts` +5 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettingsFor` | 134 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/modules/settings/service.commands.test.ts`, `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettingsFor` | 160 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/settings/service.commands.test.ts` +4 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `applyPreferencePatch` | 191 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `preferenceFor` | 213 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getModelCatalog` | 224 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/relay.model-catalog.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setModelCatalog` | 258 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/sessions/model-validation-wiring.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidence` | 563 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidenceForSource` | 568 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordShippingEvidence` | 583 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `repairCandidatesForAttempt` | 616 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `rootIntegrationReceipt` | 667 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordRootIntegrationReceipt` | 689 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/shipping/service.test.ts` +2 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getOrder` | 713 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeOrderForIssue` | 725 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listOrders` | 739 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdForOrder` | 748 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdsForOrders` | 757 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrder` | 776 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrReturnActiveOrder` | 865 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `transitionOrder` | 885 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getAttempt` | 931 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createAttempt` | 940 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestAttemptForOrder` | 986 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listAttempts` | 997 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimTrain` | 1006 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `trainManifestForAttempt` | 1355 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainForOrder` | 1453 | yes | server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainsForLane` | 1501 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `releaseTrain` | 1526 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `isolateTrainFailure` | 1562 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordNativeStackEdge` | 1707 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasNativeStackEdge` | 1773 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimAttempt` | 1794 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasAttemptCustody` | 1846 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `assertEffectDispatchCustody` | 1866 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitEffectResult` | 1903 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCancellationHold` | 2015 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCustodyHold` | 2070 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `finishAttempt` | 2103 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `cancelAttemptAndOrder` | 2165 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `requestCancellation` | 2247 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasCancellationIntent` | 2273 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `appendStep` | 2278 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepById` | 2353 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepsForAttempt` | 2362 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestStepForEffect` | 2372 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `openHoldForOrder` | 2401 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listHolds` | 2410 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `raiseHold` | 2419 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `resolveHold` | 2506 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `receiptForOrder` | 2580 | yes | server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listReceipts` | 2589 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordEffectEnvelope` | 2598 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeCoveredOrder` | 2676 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedTrain` | 2800 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedOrder` | 2830 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `seedGlobalThread` | 60 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `loadSuperagentMessages` | 90 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `appendSuperagentMessage` | 124 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/search.test.ts`, `apps/server/src/store.test.ts` +2 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `clearSuperagentMessages` | 152 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listSuperagentThreads` | 159 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `getSuperagentThread` | 171 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store.test.ts`, `apps/server/src/superagent-headless.test.ts` +1 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `upsertSuperagentThread` | 190 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/search.test.ts` +2 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `setThreadWatermark` | 226 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `updateSuperagentThreadBinding` | 237 | yes | server:boundary | `apps/server/src/superagent.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `archiveSuperagentThread` | 274 | **no** | — | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putQueuedInput` | 282 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listQueuedInputs` | 305 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deleteQueuedInput` | 327 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putPendingTurn` | 334 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `promoteQueuedInput` | 353 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listPendingTurns` | 364 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deletePendingTurn` | 390 | yes | server:boundary | — |
| `apps/server/src/store/table-writes.ts` | TableWrites | `subscribe` | 69 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +12 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/table-writes.ts` | TableWrites | `wrote` | 76 | yes | `apps/server/src/store/repos-read-cost.test.ts` | `apps/server/src/store/repos-read-cost.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `list` | 115 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `listForUser` | 129 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `upsert` | 148 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/restart-notification-storm.integration.test.ts` +1 |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `remove` | 168 | yes | `apps/server/src/store/telegram-bindings.test.ts` | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `record` | 121 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `forIssues` | 179 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `allAttributed` | 190 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `costedSessionIds` | 200 | **no** | — | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `latestWindowSinceMs` | 217 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `countAll` | 225 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `getSnapshot` | 54 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `get` | 72 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `set` | 90 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `setMany` | 100 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clear` | 135 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clearMany` | 142 | yes | `apps/server/src/modules/layout/service.test.ts` | — |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `keysFor` | 148 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `getFor` | 90 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `get` | 110 | yes | `apps/server/src/migrations/personal-preference-store.test.ts`, `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/migrations/personal-preference-store.test.ts`, `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `set` | 133 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `clear` | 162 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `keysFor` | 171 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `getSnapshot` | 62 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `get` | 83 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `advance` | 103 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `get` | 120 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `roleOf` | 154 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-users-frame-cache.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `earliestAdmin` | 181 | **no** |  *not measured — landed after the last six-lane generate*  | `apps/server/src/store/users-earliest-admin.test.ts`, `apps/server/src/server.open-mode.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `setEmail` | 203 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/users-email.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `byEmail` | 192 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/member-routes.test.ts`, `apps/server/src/store/users-email.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `list` | 213 | yes | server:services, server:boundary | — |
| `apps/server/src/store/users.ts` | UsersRepository | `disable` | 229 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/world-index/index.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `loadWorldUsers` | 224 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `credentialFor` | 235 | yes | server:boundary | `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `hasPerUserCredentials` | 256 | yes | server:boundary | — |
| `apps/server/src/store/users.ts` | UsersRepository | `create` | 268 | yes | server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `setPasswordHash` | 308 | yes | server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `deleteInvite` | 418 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `inviteByHash` | 414 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `pendingInvites` | 410 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/store/member-invites.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `insertInvite` | 406 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `removeMember` | 389 | **no** | *not measured — landed after the last six-lane generate* | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store/member-invites.test.ts` +3 |
| `apps/server/src/store/users.ts` | UsersRepository | `attachAccount` | 379 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `writeProfile` | 366 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `findMemberByAccount` | 357 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `createUnclaimed` | 342 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/users.ts` | UsersRepository | `claimTransaction` | 333 | **no** | *not measured — landed after the last six-lane generate* | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `ownerOf` | 231 | yes | server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listWorkflows` | 275 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getWorkflow` | 297 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertWorkflow` | 306 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRevisions` | 333 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRevision` | 343 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` +1 |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRevision` | 348 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `publishRevision` | 386 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getBinding` | 396 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listBindings` | 407 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `setBinding` | 416 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listProfiles` | 453 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getProfile` | 462 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `upsertProfile` | 467 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRuns` | 513 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRun` | 523 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRunSteps` | 528 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/multi-user.test.ts` +1 |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRunEvents` | 552 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRun` | 576 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRunForSession` | 593 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRun` | 613 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateRunStatus` | 657 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateStep` | 661 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `assignStep` | 691 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `resetStep` | 699 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `appendEvent` | 727 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `appendChanges` | 212 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStatesGeneration` | 304 | yes | server:boundary | `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `maxChangeSeq` | 309 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `minChangeSeq` | 322 | yes | server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/store.changes.test.ts`, `packages/sync/src/ledger.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `changesSince` | 338 | yes | server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/migrations/restore.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `planChangePrune` | 368 | yes | server:services, server:boundary, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneChangeBatch` | 392 | yes | server:services, server:boundary, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` +1 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStates` | 432 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `getAppliedMutation` | 458 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-idempotency.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `recordAppliedMutation` | 467 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneAppliedMutations` | 487 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `enqueueMessage` | 496 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listQueuedMessages` | 547 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +5 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `queuedMessageCounts` | 598 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessage` | 611 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `bumpQueuedAttempts` | 615 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `resetQueuedAttempts` | 625 | yes | server:services, server:boundary | — |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessagesForSession` | 634 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listParkedUpstreamMutations` | 651 | yes | server:boundary, @podium/sync | `packages/sync/src/adapters/sqlite/parked-upstream.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `readFeedIdentity` | 683 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts`, `apps/server/src/migrations/restore.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `writeFeedIdentity` | 698 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts`, `apps/server/src/migrations/restore.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` +1 |
<!-- /census:full-table -->
