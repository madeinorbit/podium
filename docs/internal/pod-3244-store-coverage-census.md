# POD-3244 — store coverage census

Measured coverage of every public method on every repository class under the store, so each Stage A conversion brief can carry its repository's unguarded methods. Measured, not grepped: the "named in a test file" column is kept beside the measurement so the two can be compared.

**It is regenerated, not maintained.** The first edition of this document was measured once and edited by hand, and by the time POD-3292 recounted it, seven current members had no row at all (POD-3360) — never classified as executed, indirectly guarded or unguarded, so a brief generated from it would have skipped them and nothing would have said so. The inventory, the naming column and every table below are now derived by `scripts/store-coverage-census.ts`, and `bun run audit:store-census` fails when the committed document stops describing the tree.

## What was measured, and how

- **Files.** 40 repository files, 39 of which declare a public member: `apps/server/src/store/*.ts` (excluding `helpers.ts`, `types.ts` and `issue-storage.ts`, which hold free functions and Zod schemas rather than a repository class), `apps/server/src/store/conversations/*.ts`, `apps/server/src/modules/operations/store.ts`, and `packages/sync/src/adapters/sqlite/sync-repository.ts`. `store/issue-revision.ts` is the fortieth: an exported error class whose only member is its constructor.
- **Methods.** 503 public members that carry a function body, taken from the TypeScript AST (methods, accessors and arrow-function properties on exported classes; constructors, `private`/`protected` and `#private` members excluded).
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
| `apps/server/src/store/users.ts` | 7 | 0 | 2 |
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
| `apps/server/src/modules/operations/store.ts` | OperationStore | `insert` | 98 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `update` | 114 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/store.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `markTerminal` | 136 | yes | `apps/server/src/modules/operations/engine.test.ts` | — |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `get` | 142 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `activeByGroup` | 157 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `active` | 172 | yes | `apps/server/src/modules/operations/engine.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +2 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `history` | 180 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +3 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `sweepRetention` | 197 | yes | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` — also server:services, server:boundary | `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `list` | 55 | yes | `apps/server/src/store/accounts.test.ts` — also server:boundary | `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `get` | 60 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:services | `apps/server/src/store/accounts.test.ts`, `scripts/managed-account-spawn.integration.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `upsert` | 65 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:services, server:boundary | `apps/server/src/accounts.test.ts`, `apps/server/src/modules/sessions/account-env.test.ts` +3 |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `remove` | 74 | yes | `apps/server/src/store/accounts.test.ts` | `apps/server/src/accounts.test.ts`, `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `insert` | 42 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `get` | 58 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listPending` | 65 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listExecuting` | 77 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `transition` | 87 | yes | `apps/server/src/modules/approvals/service.single-flight.test.ts`, `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/auth.ts` | AuthRepository | `createClientSession` | 66 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `listClientSessions` | 95 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSessionsByLabel` | 130 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `getClientSession` | 135 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `extendClientSession` | 170 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `touchClientSession` | 176 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `listMobileClientSessions` | 182 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteOwnedMobileClientSession` | 188 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `isClientSessionValid` | 200 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSession` | 205 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteAllClientSessions` | 210 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteExpiredClientSessions` | 215 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `list` | 82 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/automation-removal-scoping.test.ts` +3 |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `get` | 89 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `ownerOf` | 111 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `runOwnerOf` | 120 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `insert` | 131 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `update` | 164 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `remove` | 206 | yes | server:services, server:boundary | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `addRun` | 225 | yes | server:services, server:boundary | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `getRun` | 243 | yes | server:services, server:boundary | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `updateRun` | 252 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listRuns` | 266 | yes | server:services, server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listAllRuns` | 278 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `lastSpawnedSessions` | 292 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations.ts` | ConversationsRepository | `ensureFts` | 42 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `enableFts` | 21 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `disableFts` | 56 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `upsert` | 77 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/search.test.ts` +4 |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `delete` | 122 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `curatedMeta` | 130 | yes | server:boundary | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `setMeta` | 147 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `searchCandidates` | 167 | yes | server:boundary | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `search` | 214 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirror` | 16 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirrorDirty` | 23 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setReportedBytes` | 43 | yes | server:services, server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `reportedBytes` | 51 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `mirrorCursor` | 60 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setMirrorCursor` | 69 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `activeIncarnation` | 77 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `startIncarnation` | 91 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `rotateIncarnation` | 115 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `incarnations` | 152 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `repairSubagentSegmentPaths` | 9 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumId` | 15 | yes | server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/cost/service.test.ts` +1 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentsByPaths` | 30 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `parentPodiumIds` | 78 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `nativeIdsByPodiumIds` | 96 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `pathsByNativeIds` | 125 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentPath` | 143 | yes | server:services, server:boundary | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `ensure` | 150 | yes | server:services, server:boundary | `apps/server/src/modules/cost/service.test.ts`, `apps/server/src/modules/memory/lake.test.ts` +6 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `linkSegment` | 214 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumIds` | 248 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `siblingSegments` | 260 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `enableFts` | 26 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `disableFts` | 44 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `isAvailable` | 48 | yes | server:services, server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `segmentsToIndex` | 52 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `indexedCursor` | 66 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `append` | 73 | yes | server:services, server:boundary | `apps/server/src/search.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `resetMissingLake` | 102 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `rows` | 127 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `searchCandidates` | 144 | yes | server:services, server:boundary | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `drop` | 174 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `onAppend` | 99 | yes | `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventCheckpoint` | 105 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventCheckpoint` | 127 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEvents` | 142 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/daemon/src/runtime-event-reconnect.integration.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeTranscriptEvents` | 162 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `hasCausalTurnFailure` | 209 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEventsAfter` | 224 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventProjectionCursor` | 239 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventProjectionCursor` | 246 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `appendEvent` | 256 | yes | `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +4 |
| `apps/server/src/store/events.ts` | EventsRepository | `announceEvent` | 303 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listEventsSince` | 329 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/characterization.test.ts` +18 |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSinceWithPrior` | 361 | yes | server:boundary | `apps/server/src/event-log.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSubjectSinceWithPrior` | 386 | **no** | — | — |
| `apps/server/src/store/events.ts` | EventsRepository | `maxEventId` | 407 | yes | `apps/server/src/store/executor/span-side-effects.test.ts` — also server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/steward.test.ts` +1 |
| `apps/server/src/store/events.ts` | EventsRepository | `planEventPrune` | 427 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +1 |
| `apps/server/src/store/events.ts` | EventsRepository | `pruneEventBatch` | 444 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getStewardState` | 471 | yes | server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setStewardState` | 478 | yes | server:boundary | `apps/server/src/steward.single-flight.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `activateJanitorSteward` | 497 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `addSubscription` | 513 | yes | server:boundary | `apps/server/src/steward.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `removeSubscription` | 536 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listSubscriptions` | 540 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setSubscriptionEnabled` | 553 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getSubscription` | 560 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listEnabledSubscriptions` | 567 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `markDelivered` | 577 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityRevision` | 99 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityAudienceFor` | 103 | yes | server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityAudienceResourceIds` | 118 | yes | server:boundary | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResource` | 140 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResources` | 174 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForKind` | 204 | yes | `apps/server/src/store/grants.test.ts` | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `upsert` | 220 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +6 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `remove` | 246 | yes | `apps/server/src/store/grants.test.ts` — also server:services | `apps/server/src/modules/fleet/authz.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `removeAllForResource` | 270 | yes | `apps/server/src/store/grants.test.ts` — also server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `insert` | 125 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `get` | 157 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `openByFingerprint` | 164 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listOpen` | 175 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listForSession` | 191 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `answer` | 208 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `recordDelivery` | 237 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `reopen` | 278 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `retireClaimed` | 303 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `close` | 329 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `closeSession` | 340 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `pruneResolvedBefore` | 355 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `upsertIssue` | 104 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +13 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `transitionShippingStage` | 300 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssue` | 425 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/characterization.test.ts`, `apps/server/src/event-log.test.ts` +15 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueCwdRows` | 456 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `closedIssueIds` | 504 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssues` | 535 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues-frame-cache.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueParentEdges` | 592 | yes | server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueRows` | 605 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/search.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssue` | 646 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/relay.draft-reap.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `pruneOrphanRefLetters` | 670 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `nextIssueSeq` | 682 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `renumberCollidingIssueSeqs` | 702 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `assignRepoIdToIssuesUnder` | 759 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `allocateSessionLetter` | 804 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `issuesMissingRepoId` | 823 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueLabels` | 833 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueLabels` | 844 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueLabelsByIssue` | 854 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllLabels` | 867 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueDep` | 877 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `removeIssueDep` | 883 | yes | server:services, server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueDeps` | 896 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllIssueDeps` | 910 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listDependents` | 924 | yes | server:services, server:boundary, server:normalized-wire | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueComment` | 936 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueComments` | 944 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/issues.test.ts` +5 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueComments` | 961 | yes | server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueCommentsByIssue` | 972 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `searchIssueComments` | 981 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueMessage` | 1017 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueMessage` | 1027 | yes | server:services, server:boundary | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessages` | 1034 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countUnreadIssueMessages` | 1054 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `markIssueMessagesRead` | 1072 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessageReadAt` | 1089 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueUserState` | 1109 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueUserState` | 1128 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueUserState` | 1148 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `purgeIssueUserState` | 1181 | **no** | — | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `claimIssueMessage` | 1187 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueMessagesForIssue` | 1197 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueChildRows` | 1201 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `getLock` | 101 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocks` | 108 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listExpiredLocks` | 116 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocksHeldBySession` | 124 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `upsertLock` | 132 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `renewLock` | 160 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `deleteLock` | 175 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaiters` | 180 | yes | server:services | `apps/server/src/modules/lock/service.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `enqueueWaiter` | 190 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiter` | 203 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiterBySession` | 207 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaitsBySession` | 214 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/machines.ts` | MachinesRepository | `legacyMachineSentinelSites` | 168 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `upsertMachine` | 194 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +28 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `listMachines` | 218 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/daemon/test/build-report-compiled.bun.test.ts` +18 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachine` | 228 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/gateway/peer-handshake.build.test.ts` +8 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `addMachineComponent` | 254 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/stop.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineInventory` | 269 | yes | server:services, server:boundary | `apps/server/src/browser-open.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +6 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineBuild` | 274 | yes | `apps/server/src/store/machines.build.test.ts` — also server:services, server:boundary | `apps/server/src/modules/machines/version-state.test.ts`, `apps/server/src/router.updates.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachineByToken` | 294 | yes | server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setUpdateChannel` | 306 | yes | server:boundary | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/server/src/router.updates.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `renameMachine` | 310 | yes | server:services, server:boundary | `apps/server/src/relay.bind-storm.test.ts`, `apps/server/src/sessions.ledger.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineOwner` | 320 | yes | server:services, server:boundary | `apps/server/src/modules/machines/service.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `deleteMachine` | 324 | yes | server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `touchMachine` | 328 | yes | server:services, server:boundary | `apps/server/src/modules/machines/service.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getLease` | 35 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `putLease` | 42 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getCommand` | 67 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `recordCommand` | 75 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `pruneCommandsBatch` | 89 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `addMessage` | 127 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/issues/service/mail-pending.test.ts` +10 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getMessage` | 177 | yes | server:services, server:boundary | `apps/daemon/src/queue-drain-reconnect.integration.test.ts`, `apps/server/src/issues.test.ts` +8 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listMessagesFor` | 185 | yes | server:services, server:boundary | `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts`, `apps/server/src/modules/messages/service.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForSessionProof` | 210 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listLedger` | 230 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-ask-upload.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `queuedPositionForSession` | 263 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForPage` | 283 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingHighWater` | 312 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `latestPendingOperatorForSession` | 329 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSenders` | 342 | **no** | — | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummary` | 366 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countQueued` | 376 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPending` | 383 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` +2 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordRead` | 403 | yes | server:services, server:boundary | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `existingMessageIds` | 423 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `readReceipts` | 438 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `selfSentIds` | 451 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummaryForSession` | 486 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPendingForSession` | 524 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSendersForSession` | 534 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `alreadyCommunicated` | 559 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markInjected` | 577 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveryAbandoned` | 605 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `retractOptimisticDelivery` | 649 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markSendRefused` | 709 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDelivered` | 730 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markCancelled` | 746 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveredByPull` | 761 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markRead` | 777 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeadLetter` | 802 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `clearInjected` | 820 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueued` | 828 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/queue-drain-abandonment.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueuedPage` | 833 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordWakeCooldown` | 851 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getWakeCooldown` | 860 | yes | server:services, server:boundary | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `expireObserved` | 870 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markAcked` | 887 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listDeliveredUnacked` | 901 | yes | server:services, server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listSettleNotifiable` | 925 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markReminded` | 943 | yes | server:services | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `listForChat` | 26 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByIssue` | 36 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByThreadRef` | 46 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `upsert` | 56 | **no** | — | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `claim` | 28 | yes | server:services, server:boundary | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `hasActive` | 49 | yes | server:boundary | `apps/server/src/restart-notification-storm.integration.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retire` | 61 | yes | server:services, server:boundary | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKey` | 72 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKeyPrefix` | 86 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireByIssue` | 96 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireExpired` | 100 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `claim` | 118 | yes | server:services, server:boundary | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `isClaimed` | 135 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retire` | 139 | yes | server:services, server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKey` | 144 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKeyPrefix` | 149 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireByIssue` | 153 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireExpired` | 157 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `loadAll` | 142 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `get` | 155 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +6 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `advanceGeneration` | 163 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +2 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `rebindExact` | 211 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `save` | 331 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `getTerminalCandidate` | 359 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/restart-notification-storm.integration.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +1 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `recordTerminalCandidate` | 385 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `confirmTerminalCandidate` | 444 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `renewTerminalCandidate` | 493 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `consumeTerminalCandidate` | 538 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `cancelTerminalCandidate` | 564 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `purge` | 568 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `record` | 138 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `list` | 253 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `trail` | 265 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `prune` | 283 | yes | `apps/server/src/store/quota-history.test.ts` — also server:services, server:boundary | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `countAll` | 288 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `getRecapWatermark` | 20 | **no** | — | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `setRecapWatermark` | 27 | **no** | — | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `invalidateRegistry` | 93 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepoPaths` | 98 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-capability-guard.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts` +3 |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepos` | 127 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` +2 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/find-repo-on-machine.test.ts` +9 |
| `apps/server/src/store/repos.ts` | ReposRepository | `isPrefixTaken` | 166 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `derivePrefixFor` | 171 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForRepoId` | 176 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/machine-identity.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForPath` | 185 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.test.ts`, `apps/server/src/store.refs.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `repoForPrefix` | 190 | yes | server:boundary | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `ensurePrefixForRepoId` | 204 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `setRepoPrefix` | 221 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.refs.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `nextDraftSeq` | 248 | yes | server:services, server:boundary | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `addRepo` | 268 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.test.ts` +20 |
| `apps/server/src/store/repos.ts` | ReposRepository | `updateRepoOrigin` | 304 | yes | server:boundary | `apps/server/src/store.repo-id.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `resolveRepoIdForPath` | 376 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` +1 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts`, `apps/server/src/store.repo-id.test.ts` +2 |
| `apps/server/src/store/repos.ts` | ReposRepository | `repoIdResolver` | 404 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` +1 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `removeRepo` | 420 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.machines.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `legacyRepoResidue` | 445 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `putNativeLoginTransfer` | 73 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getNativeLoginTransfer` | 83 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/modules/machines/login-propagation.test.ts`, `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clearNativeLoginTransfer` | 99 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `get` | 123 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `scripts/audit-client-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getOrEmpty` | 133 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/settings/wiring.test.ts` +1 |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `set` | 145 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services, server:boundary | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `apiKeyFor` | 167 | yes | server:boundary | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clear` | 173 | yes | `apps/server/src/migrations/server-secret-store.test.ts` — also server:services | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `updatedAt` | 178 | yes | `apps/server/src/migrations/server-secret-store.test.ts` | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `presence` | 194 | yes | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadSessions` | 46 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +24 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSession` | 51 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-oom-death.test.ts` +1 more — also server:services, server:boundary | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/session-requested-model-reload.test.ts` +7 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionByResumeValue` | 71 | yes | `apps/server/src/store/session-by-resume-value.test.ts` | `apps/server/src/store/session-by-resume-value.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSessions` | 81 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByResumeValues` | 100 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSessionsByResumeValues` | 131 | yes | server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByIssueIds` | 158 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessions` | 175 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-attribution.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessionsForIssue` | 180 | yes | server:boundary | `apps/server/src/relay.issue-session-delete.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `upsertSession` | 325 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` +2 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +17 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteSessions` | 490 | yes | `apps/server/src/store/session-by-resume-value.test.ts` — also server:services, server:boundary | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteForIssue` | 504 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `restoreDeletedForIssue` | 509 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachTombstonesFromIssue` | 545 | yes | server:services, server:boundary | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachDanglingIssueReferences` | 564 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `purgeSession` | 583 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/sessions.refs.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listPins` | 603 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-session-state.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setPin` | 619 | yes | server:services, server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listReadAt` | 644 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/oracle-commands.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getReadAt` | 654 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/session-cutover.audit.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionRead` | 662 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/archive-park.test.ts`, `apps/server/src/modules/sessions/auto-archive-observed.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionUnread` | 677 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/auto-archive-observed.test.ts`, `apps/server/src/relay.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllReadAt` | 693 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSnoozes` | 701 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +6 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setSnooze` | 727 | yes | server:services, server:boundary | `apps/server/src/relay.outbox.test.ts`, `apps/server/src/relay.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearSnooze` | 740 | yes | server:services, server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `hasAnySnooze` | 746 | yes | server:services, server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllSnoozes` | 755 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listOffers` | 762 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setOffer` | 801 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-idempotency.test.ts`, `apps/server/src/offer.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `offerCreatedAt` | 825 | yes | server:services, server:boundary | `apps/server/src/offer.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearOffer` | 833 | yes | server:services, server:boundary | `apps/server/src/offer.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listTabOrders` | 839 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setTabOrder` | 858 | yes | server:services, server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDrafts` | 914 | yes | server:services, server:boundary | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/modules/sessions/session-start.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftTimes` | 927 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraft` | 940 | yes | server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftDocs` | 977 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/relay.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraftDoc` | 1003 | yes | server:services, server:boundary | — |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `append` | 132 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/settings/wiring.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `list` | 165 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services | `apps/server/src/modules/settings/wiring.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettings` | 64 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +12 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/sessions/session-state/registry.test.ts` +9 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettings` | 76 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/modules/sessions/session-state/registry.test.ts`, `apps/server/src/modules/sessions/spawn-account-env.test.ts` +5 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettingsFor` | 99 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/modules/settings/service.commands.test.ts`, `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettingsFor` | 125 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/settings/service.commands.test.ts` +4 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `applyPreferencePatch` | 156 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `preferenceFor` | 178 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getModelCatalog` | 189 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary | `apps/server/src/relay.model-catalog.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setModelCatalog` | 221 | yes | server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/sessions/model-validation-wiring.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidence` | 360 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidenceForSource` | 371 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordShippingEvidence` | 385 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `repairCandidatesForAttempt` | 421 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `rootIntegrationReceipt` | 481 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordRootIntegrationReceipt` | 501 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/modules/shipping/service.test.ts` +2 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getOrder` | 522 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeOrderForIssue` | 527 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listOrders` | 534 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdForOrder` | 540 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdsForOrders` | 547 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrder` | 564 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrReturnActiveOrder` | 658 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `transitionOrder` | 678 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getAttempt` | 717 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createAttempt` | 722 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestAttemptForOrder` | 772 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listAttempts` | 779 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimTrain` | 785 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `trainManifestForAttempt` | 1121 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainForOrder` | 1234 | yes | server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainsForLane` | 1277 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `releaseTrain` | 1300 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `isolateTrainFailure` | 1332 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordNativeStackEdge` | 1477 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasNativeStackEdge` | 1545 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimAttempt` | 1562 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasAttemptCustody` | 1614 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `assertEffectDispatchCustody` | 1634 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitEffectResult` | 1671 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCancellationHold` | 1783 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCustodyHold` | 1838 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `finishAttempt` | 1871 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `cancelAttemptAndOrder` | 1929 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `requestCancellation` | 2016 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasCancellationIntent` | 2042 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `appendStep` | 2047 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepById` | 2117 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepsForAttempt` | 2122 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestStepForEffect` | 2130 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `openHoldForOrder` | 2146 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listHolds` | 2153 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `raiseHold` | 2159 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store-issues.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `resolveHold` | 2252 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `receiptForOrder` | 2312 | yes | server:services, server:boundary | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listReceipts` | 2319 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordEffectEnvelope` | 2325 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeCoveredOrder` | 2405 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedTrain` | 2548 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedOrder` | 2578 | yes | server:services, server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `seedGlobalThread` | 34 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +11 more — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `loadSuperagentMessages` | 44 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store.test.ts`, `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `appendSuperagentMessage` | 66 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/search.test.ts`, `apps/server/src/store.test.ts` +2 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `clearSuperagentMessages` | 95 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listSuperagentThreads` | 99 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `getSuperagentThread` | 108 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store.test.ts`, `apps/server/src/superagent-headless.test.ts` +1 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `upsertSuperagentThread` | 119 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/search.test.ts` +2 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `setThreadWatermark` | 148 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `updateSuperagentThreadBinding` | 157 | yes | server:boundary | `apps/server/src/superagent.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `archiveSuperagentThread` | 208 | **no** | — | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putQueuedInput` | 212 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listQueuedInputs` | 236 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deleteQueuedInput` | 267 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putPendingTurn` | 271 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `promoteQueuedInput` | 291 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listPendingTurns` | 302 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts`, `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deletePendingTurn` | 326 | yes | server:boundary | — |
| `apps/server/src/store/table-writes.ts` | TableWrites | `subscribe` | 34 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +12 more — also server:services, server:boundary, server:normalized-wire | — |
| `apps/server/src/store/table-writes.ts` | TableWrites | `wrote` | 41 | yes | `apps/server/src/store/repos-read-cost.test.ts` | `apps/server/src/store/repos-read-cost.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `list` | 93 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `listForUser` | 105 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `upsert` | 116 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/restart-notification-storm.integration.test.ts` +1 |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `remove` | 137 | yes | `apps/server/src/store/telegram-bindings.test.ts` | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `record` | 115 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `forIssues` | 173 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `allAttributed` | 183 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `costedSessionIds` | 191 | **no** | — | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `latestWindowSinceMs` | 209 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `countAll` | 216 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `getSnapshot` | 46 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `get` | 62 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `set` | 78 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `setMany` | 92 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clear` | 111 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clearMany` | 115 | yes | `apps/server/src/modules/layout/service.test.ts` | — |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `keysFor` | 122 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `getFor` | 80 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | — |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `get` | 98 | yes | `apps/server/src/migrations/personal-preference-store.test.ts`, `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/migrations/personal-preference-store.test.ts`, `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `set` | 119 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:services, server:boundary | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `clear` | 135 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `keysFor` | 141 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `getSnapshot` | 58 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `get` | 73 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `advance` | 92 | yes | `apps/server/src/store/user-read-position.test.ts` — also server:services | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `get` | 99 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `roleOf` | 129 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store-users-frame-cache.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `list` | 133 | yes | server:services, server:boundary | — |
| `apps/server/src/store/users.ts` | UsersRepository | `credentialFor` | 143 | yes | server:boundary | `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `hasPerUserCredentials` | 162 | yes | server:boundary | — |
| `apps/server/src/store/users.ts` | UsersRepository | `create` | 171 | yes | server:services, server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `setPasswordHash` | 196 | yes | server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `ownerOf` | 171 | yes | server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listWorkflows` | 203 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getWorkflow` | 230 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertWorkflow` | 241 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRevisions` | 271 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRevision` | 279 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` +1 |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRevision` | 286 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `publishRevision` | 323 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getBinding` | 331 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listBindings` | 338 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `setBinding` | 346 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listProfiles` | 380 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getProfile` | 388 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `upsertProfile` | 395 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRuns` | 438 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRun` | 450 | yes | server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRunSteps` | 457 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/multi-user.test.ts` +1 |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRunEvents` | 475 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRun` | 494 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRunForSession` | 505 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRun` | 518 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateRunStatus` | 563 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateStep` | 569 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `assignStep` | 602 | yes | server:services, server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `resetStep` | 610 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `appendEvent` | 630 | yes | `apps/server/src/store/json-column-corruption-oracle.test.ts` — also server:services, server:boundary | `apps/server/src/store/json-column-corruption-oracle.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `appendChanges` | 114 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStatesGeneration` | 189 | yes | server:boundary | `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `maxChangeSeq` | 194 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `minChangeSeq` | 202 | yes | server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/store.changes.test.ts`, `packages/sync/src/ledger.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `changesSince` | 214 | yes | server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/migrations/restore.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `planChangePrune` | 233 | yes | server:services, server:boundary, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneChangeBatch` | 250 | yes | server:services, server:boundary, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` +1 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStates` | 284 | yes | `apps/server/src/migrations/restore.test.ts`, `apps/server/src/store/executor/span-side-effects.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `getAppliedMutation` | 301 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-idempotency.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `recordAppliedMutation` | 308 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneAppliedMutations` | 321 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `enqueueMessage` | 329 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listQueuedMessages` | 369 | yes | server:services, server:boundary | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +5 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `queuedMessageCounts` | 406 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:services, server:boundary, server:normalized-wire | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessage` | 416 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `bumpQueuedAttempts` | 420 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `resetQueuedAttempts` | 428 | yes | server:services, server:boundary | — |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessagesForSession` | 433 | yes | server:services, server:boundary | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listParkedUpstreamMutations` | 450 | yes | server:boundary, @podium/sync | `packages/sync/src/adapters/sqlite/parked-upstream.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `readFeedIdentity` | 476 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts`, `apps/server/src/migrations/restore.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `writeFeedIdentity` | 489 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts`, `apps/server/src/migrations/restore.test.ts` — also server:services, server:boundary, server:normalized-wire, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` +1 |
<!-- /census:full-table -->
