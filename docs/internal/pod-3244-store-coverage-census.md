# POD-3244 — store coverage census

One-time measured coverage of every public method on every repository class under the store, so each Phase A conversion brief can carry its repository's unguarded methods. Measured, not grepped: the "named in a test file" column is kept beside the measurement so the two can be compared.

## What was measured, and how

- **Files.** 38 repository files: `apps/server/src/store/*.ts` (excluding `helpers.ts`, `types.ts` and `issue-storage.ts`, which hold free functions and Zod schemas rather than a repository class), `apps/server/src/store/conversations/*.ts`, `apps/server/src/modules/operations/store.ts`, and `packages/sync/src/adapters/sqlite/sync-repository.ts`.
- **Methods.** 500 public members that carry a function body, taken from the TypeScript AST (methods, accessors and arrow-function properties on exported classes; constructors, `private`/`protected` and `#private` members excluded).
- **Lanes.** All five `@podium/server` shards (`store`, `services`, `boundary`, `contracts`, `normalized-wire`) plus the `@podium/sync` package lane, each run once with coverage. Service and boundary tests are in scope deliberately: they are what actually exercise several repositories (locks through `LockService`), which is the whole reason the naming heuristic overstates thinness.
- **Provider: istanbul, not v8.** These lanes run under Bun (`bun --bun .../vitest.mjs`), and Bun has no inspector coverage API — `@vitest/coverage-v8` dies with `Coverage APIs are not supported` before a single test runs. `@vitest/coverage-istanbul` instruments at transform time and works unchanged in the lane's normal runner.
- **Attribution.** A method is mapped to its istanbul `fnMap` entry by declaration line. As a check on that mapping, function-hit and statement-hit were computed independently for all 500 methods and agree on every one (0 disagreements).

## Reproducing it

The census is not in CI and is not a gate. To re-run it, install the provider (it is deliberately not a repository dependency — see the handoff) and run each lane once:

```
cd apps/server && bun ../../scripts/validation-admission.ts focused --label census:<lane> -- \
  bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.<lane>.config.ts \
  --coverage.enabled --coverage.provider=istanbul --coverage.all=true --coverage.reportOnFailure=true \
  --coverage.include=apps/server/src/store/** \
  --coverage.include=apps/server/src/modules/operations/store.ts \
  --coverage.include=packages/sync/src/adapters/sqlite/sync-repository.ts \
  --coverage.reporter=json --coverage.reportsDirectory=<dir>
```

`--coverage.reportOnFailure=true` is not optional here: Vitest writes no coverage report at all when a lane ends red, and these lanes do end red (below).

`PODIUM_TEST_WORKERS=1` was set in the session that produced these numbers, and the host was under heavy concurrent load from the other epic worktrees. Neither changes which methods execute.

## The lanes were red, and what that does to the numbers

35 test files failed across the lanes on the integration branch as it stood: `server:store` 1, `server:services` 10, `server:boundary` 20, `server:contracts` 4, `@podium/sync` 1 (`server:normalized-wire` was green).

Every one of those files was then re-run WITHOUT coverage, same lane, same commit, and 34 of the 35 fail identically — they are the branch, not the instrumentation:

| Lane | Failing files with coverage | Failing files without coverage |
| --- | ---: | ---: |
| `server:store` | 1 | 1 |
| `server:services` | 10 | 10 |
| `server:boundary` | 20 | 20 |
| `server:contracts` | 4 | 3 |
| `@podium/sync` | 1 | 1 |

The one file that differs is instructive rather than alarming. `apps/server/src/modules/operations/store.test.ts` runs in the `contracts` shard's *reused* project, and that project asserts after every file that nothing was left on `globalThis` — because a reused runner is handed to the next file. Istanbul's counters live exactly there, so the guard reports `globalThis.__VITEST_COVERAGE__ was added` and fails the file. Its 16 tests all ran and passed; only the after-file guard threw, so its coverage still counts. Anyone re-running this census on the `contracts` or any other reuse-splitting shard should expect that one failure and read it as the guard doing its job, not as a red test.

The direction matters and it is the safe one: a test that fails runs *less* code than a test that passes, never more. So a red lane can only make the never-executed list LONGER than the truth — every method listed as covered really was executed. As a check on the other side, none of the 14 never-executed methods is named in any of the 35 failing files (`upsert` matches by name only, on unrelated objects).

## Headline

| | Methods | Share |
| --- | ---: | ---: |
| Never executed by any test in any lane | **14** | 2.8% |
| Executed, but never named in any test file | 163 | 32.6% |
| Executed and named in at least one test file | 323 | 64.6% |
| **Total public repository methods** | **500** | |

The brief's starting estimate — "about 131 of roughly 455 public repository methods are never named in any test file" — was right about the direction and wrong about the consequence. Counting the same way but with the store-accessor spelling (`store.<accessor>.<method>(`) or a direct `new <Class>(` construction in the same file, **177** of 500 methods are never named in a test file. Measured coverage says only **14** are never *executed*. The gap of 163 is the "locks via LockService" effect at scale: most repository methods reach a test through a service, a router or a fixture, not through a test that spells them.

So for a conversion brief there are two different lists, and they mean different things:

- **Never executed (14)** — a conversion here is completely unguarded. A golden test against the synchronous code comes first (method section 3, checklist item 10).
- **Executed but never named (163)** — a conversion here is guarded only indirectly. The test that would go red does not mention the method, so a reviewer reading the diff cannot see which test protects it. These are the methods where an incidental behaviour change (row order, `undefined` vs `null`, a silently dropped column) can pass.

## Never executed — the whole list

| Repository file | Class | Method | Line | Named in a test file |
| --- | --- | --- | ---: | --- |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSubjectSinceWithPrior` | 367 | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `purgeIssueUserState` | 1165 | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSenders` | 337 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `listForChat` | 21 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByIssue` | 31 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByThreadRef` | 41 | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `upsert` | 51 | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `getRecapWatermark` | 15 | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `setRecapWatermark` | 22 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdForOrder` | 535 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdsForOrders` | 542 | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `isolateTrainFailure` | 1327 | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `archiveSuperagentThread` | 203 | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `costedSessionIds` | 186 | — |

### Four of the fourteen have no production caller either

These are not thin tests, they are unused code. Nothing outside the repository file calls them anywhere in `apps`, `packages`, `scripts`, `tests` or `services`:

| Method | Only other reference |
| --- | --- |
| `TranscriptCostsRepository.costedSessionIds` | none — the declaration is the only occurrence in the tree |
| `IssuesRepository.purgeIssueUserState` | none — the declaration is the only occurrence in the tree |
| `MessagesRepository.listPendingSenders` | none; the used method is the sibling `listPendingSendersForSession` |
| `MessagingTopicsRepository.listForChat` | declared on the `MessagingService` deps interface and stubbed in `modules/messaging/service.test.ts`, never called |

Converting them would be work spent on code with no caller and no test. They are worth deleting before the wave that owns their file rather than porting; filed separately so the epic does not have to decide it inline.

## Per repository

| Repository file | Public methods | Never executed | Executed, never named |
| --- | ---: | ---: | ---: |
| `apps/server/src/store/shipping.ts` | 50 | 3 | 16 |
| `apps/server/src/store/issues.ts` | 43 | 1 | 11 |
| `apps/server/src/store/sessions.ts` | 39 | 0 | 7 |
| `apps/server/src/store/messages.ts` | 39 | 1 | 20 |
| `apps/server/src/store/events.ts` | 27 | 1 | 5 |
| `apps/server/src/store/workflows.ts` | 26 | 0 | 19 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | 21 | 0 | 1 |
| `apps/server/src/store/repos.ts` | 18 | 0 | 7 |
| `apps/server/src/store/superagent.ts` | 17 | 1 | 6 |
| `apps/server/src/store/notification-facts.ts` | 14 | 0 | 9 |
| `apps/server/src/store/automations.ts` | 13 | 0 | 7 |
| `apps/server/src/store/observation-checkpoints.ts` | 12 | 0 | 5 |
| `apps/server/src/store/locks.ts` | 12 | 0 | 11 |
| `apps/server/src/store/machines.ts` | 12 | 0 | 0 |
| `apps/server/src/store/interactions.ts` | 12 | 0 | 4 |
| `apps/server/src/store/auth.ts` | 12 | 0 | 1 |
| `apps/server/src/store/conversations/registry.ts` | 11 | 0 | 6 |
| `apps/server/src/store/server-secrets.ts` | 10 | 0 | 1 |
| `apps/server/src/store/conversations/mirror.ts` | 10 | 0 | 0 |
| `apps/server/src/store/conversations/transcript-index.ts` | 10 | 0 | 5 |
| `apps/server/src/store/settings.ts` | 8 | 0 | 0 |
| `apps/server/src/store/grants.ts` | 8 | 0 | 2 |
| `apps/server/src/store/conversations/index.ts` | 8 | 0 | 3 |
| `apps/server/src/modules/operations/store.ts` | 8 | 0 | 1 |
| `apps/server/src/store/user-layout.ts` | 7 | 0 | 1 |
| `apps/server/src/store/users.ts` | 7 | 0 | 2 |
| `apps/server/src/store/transcript-costs.ts` | 6 | 1 | 3 |
| `apps/server/src/store/user-preferences.ts` | 5 | 0 | 3 |
| `apps/server/src/store/approvals.ts` | 5 | 0 | 3 |
| `apps/server/src/store/quota-history.ts` | 5 | 0 | 0 |
| `apps/server/src/store/maintenance.ts` | 5 | 0 | 3 |
| `apps/server/src/store/accounts.ts` | 4 | 0 | 0 |
| `apps/server/src/store/telegram-bindings.ts` | 4 | 0 | 0 |
| `apps/server/src/store/messaging-topics.ts` | 4 | 4 | 0 |
| `apps/server/src/store/user-read-position.ts` | 3 | 0 | 0 |
| `apps/server/src/store/read-watermarks.ts` | 2 | 2 | 0 |
| `apps/server/src/store/settings-audit.ts` | 2 | 0 | 0 |
| `apps/server/src/store/conversations.ts` | 1 | 0 | 1 |

### Repositories no test file mentions at all

Every method in these files is reached only through a caller. There is no test that names the repository, so nothing in the test tree describes what these methods are supposed to return — the conversion has to read the SQL and the caller to know what it may not change:

- `apps/server/src/store/messaging-topics.ts` — 4 methods, 4 of them never executed
- `apps/server/src/store/read-watermarks.ts` — 2 methods, 2 of them never executed
- `apps/server/src/store/conversations.ts` — 1 method, 0 of them never executed

### The five large repositories

**`apps/server/src/store/shipping.ts`** — 50 public methods; 3 never executed; 16 executed but never named.

- Never executed: `issueIdForOrder`, `issueIdsForOrders`, `isolateTrainFailure`
- Executed, never named: `shippingEvidence`, `shippingEvidenceForSource`, `recordShippingEvidence`, `createOrReturnActiveOrder`, `activeTrainsForLane`, `releaseTrain`, `recordNativeStackEdge`, `hasNativeStackEdge`, `hasAttemptCustody`, `assertEffectDispatchCustody`, `commitEffectResult`, `commitCancellationHold`, `commitCustodyHold`, `cancelAttemptAndOrder`, `stepById`, `completeVerifiedTrain`

**`apps/server/src/store/workflows.ts`** — 26 public methods; 0 never executed; 19 executed but never named.

- Never executed: *none*
- Executed, never named: `ownerOf`, `listWorkflows`, `getWorkflow`, `insertWorkflow`, `insertRevision`, `publishRevision`, `setBinding`, `listProfiles`, `getProfile`, `upsertProfile`, `listRunEvents`, `findLiveRun`, `findLiveRunForSession`, `insertRun`, `updateRunStatus`, `updateStep`, `assignStep`, `resetStep`, `appendEvent`

**`apps/server/src/store/messages.ts`** — 39 public methods; 1 never executed; 20 executed but never named.

- Never executed: `listPendingSenders`
- Executed, never named: `queuedPositionForSession`, `pendingForPage`, `pendingHighWater`, `latestPendingOperatorForSession`, `pendingSummary`, `countQueued`, `selfSentIds`, `pendingSummaryForSession`, `alreadyCommunicated`, `retractOptimisticDelivery`, `markSendRefused`, `markCancelled`, `markDeliveredByPull`, `markRead`, `markDeadLetter`, `clearInjected`, `recordWakeCooldown`, `listDeliveredUnacked`, `listSettleNotifiable`, `markReminded`

**`apps/server/src/store/issues.ts`** — 43 public methods; 1 never executed; 11 executed but never named.

- Never executed: `purgeIssueUserState`
- Executed, never named: `listIssueCwdRows`, `listIssueParentEdges`, `assignRepoIdToIssuesUnder`, `migrateLegacyIssueRepoIds`, `issuesMissingRepoId`, `listIssueLabelsByIssue`, `listAllIssueDeps`, `countIssueComments`, `countIssueCommentsByIssue`, `searchIssueComments`, `deleteIssueMessagesForIssue`

**`apps/server/src/store/sessions.ts`** — 39 public methods; 0 never executed; 7 executed but never named.

- Never executed: *none*
- Executed, never named: `getSessions`, `findSessionsByResumeValues`, `listSessionsByResumeValues`, `findSessionsByIssueIds`, `clearAllReadAt`, `hasAnySnooze`, `clearAllSnoozes`

## Full table

`Covered` is measured. `Covering test file(s) / lane(s)` names exact test files where a separate per-test-file coverage run was made — 28 files of the `server:store` shard, run one at a time. For everything else the column names the lane: per-test-file attribution across `services`, `boundary` and `contracts` would have meant 338 further instrumented runs on a shared host, and the census does not need it to answer what it was asked. A method whose row names a lane rather than a file is still measured as executed; only the pointer to the exact test is coarser.

| Repository file | Class | Method | Line | Covered | Covering test file(s) / lane(s) | Named in a test file |
| --- | --- | --- | ---: | :-: | --- | --- |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `insert` | 93 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `update` | 109 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/store.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `markTerminal` | 131 | yes | server:contracts | — |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `get` | 137 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +1 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `activeByGroup` | 152 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `active` | 167 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/trpc.test.ts` +2 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `history` | 175 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/engine.test.ts`, `apps/server/src/modules/operations/store.test.ts` +3 |
| `apps/server/src/modules/operations/store.ts` | OperationStore | `sweepRetention` | 192 | yes | server:boundary, server:contracts, server:services | `apps/server/src/modules/operations/store.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `list` | 50 | yes | `apps/server/src/store/accounts.test.ts` — also server:boundary | `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `get` | 55 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:services | `apps/server/src/store/accounts.test.ts`, `scripts/managed-account-spawn.integration.test.ts` |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `upsert` | 60 | yes | `apps/server/src/modules/sessions/account-env.test.ts`, `apps/server/src/store/accounts.test.ts` — also server:boundary, server:services | `apps/server/src/accounts.test.ts`, `apps/server/src/modules/sessions/account-env.test.ts` +3 |
| `apps/server/src/store/accounts.ts` | AccountsRepository | `remove` | 69 | yes | `apps/server/src/store/accounts.test.ts` | `apps/server/src/accounts.test.ts`, `apps/server/src/store/accounts.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `insert` | 37 | yes | `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `get` | 53 | yes | `apps/server/src/modules/approvals/service.test.ts` | `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listPending` | 60 | yes | `apps/server/src/modules/approvals/service.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/approvals/service.test.ts` |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `listExecuting` | 72 | yes | `apps/server/src/modules/approvals/service.test.ts` — also server:boundary | — |
| `apps/server/src/store/approvals.ts` | ApprovalsRepository | `transition` | 82 | yes | `apps/server/src/modules/approvals/service.test.ts` | — |
| `apps/server/src/store/auth.ts` | AuthRepository | `createClientSession` | 61 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `listClientSessions` | 90 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSessionsByLabel` | 125 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `getClientSession` | 130 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `extendClientSession` | 165 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `touchClientSession` | 171 | yes | `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `listMobileClientSessions` | 177 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/mobile-pairing-route.test.ts` +1 |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteOwnedMobileClientSession` | 183 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` | `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `isClientSessionValid` | 195 | yes | `apps/server/src/mobile-pairing-route.test.ts`, `apps/server/src/store/auth.test.ts` — also server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/store/auth.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteClientSession` | 200 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteAllClientSessions` | 205 | yes | server:boundary | `apps/server/src/auth-route.test.ts` |
| `apps/server/src/store/auth.ts` | AuthRepository | `deleteExpiredClientSessions` | 210 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `list` | 77 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/automation-removal-scoping.test.ts` +3 |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `get` | 84 | yes | server:boundary, server:services | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `ownerOf` | 106 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `runOwnerOf` | 115 | yes | server:boundary | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `insert` | 126 | yes | server:boundary, server:services | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `update` | 159 | yes | server:boundary, server:services | `apps/server/src/modules/automations/scheduler.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `remove` | 201 | yes | server:boundary, server:services | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/router.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `addRun` | 220 | yes | server:boundary, server:services | `apps/server/src/automation-removal-scoping.test.ts`, `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `getRun` | 238 | yes | server:boundary, server:services | `apps/server/src/modules/automations/scheduler.test.ts` |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `updateRun` | 247 | yes | server:boundary, server:services | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listRuns` | 261 | yes | server:boundary, server:services | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `listAllRuns` | 273 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/automations.ts` | AutomationsRepository | `lastSpawnedSessions` | 287 | yes | server:boundary, server:services | — |
| `apps/server/src/store/conversations.ts` | ConversationsRepository | `ensureFts` | 37 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `enableFts` | 21 | yes | server:boundary, server:services | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `disableFts` | 56 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `upsert` | 77 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/search.test.ts` +4 |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `delete` | 122 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `curatedMeta` | 130 | yes | server:boundary | — |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `setMeta` | 147 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `searchCandidates` | 167 | yes | server:boundary | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/index.ts` | ConversationIndexRepository | `search` | 214 | yes | server:boundary | `apps/server/src/conversations.ledger.test.ts`, `apps/server/src/machine-identity.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirror` | 16 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `segmentsToMirrorDirty` | 23 | yes | server:boundary, server:services | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setReportedBytes` | 43 | yes | server:boundary, server:services | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` +1 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `reportedBytes` | 51 | yes | server:boundary | `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `mirrorCursor` | 60 | yes | server:boundary, server:services | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `setMirrorCursor` | 69 | yes | server:boundary, server:services | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/relay.lake-read.test.ts` +2 |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `activeIncarnation` | 77 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `startIncarnation` | 91 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `rotateIncarnation` | 115 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/mirror.ts` | TranscriptMirrorRepository | `incarnations` | 152 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.mirror.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `repairSubagentSegmentPaths` | 9 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumId` | 15 | yes | server:boundary, server:services | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/cost/service.test.ts` +1 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentsByPaths` | 30 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `parentPodiumIds` | 78 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `nativeIdsByPodiumIds` | 96 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `pathsByNativeIds` | 125 | yes | server:services | — |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `segmentPath` | 143 | yes | server:boundary, server:services | `apps/server/src/store.conversation-idle-writes.test.ts`, `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `ensure` | 150 | yes | server:boundary, server:services | `apps/server/src/modules/cost/service.test.ts`, `apps/server/src/modules/memory/lake.test.ts` +6 |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `linkSegment` | 214 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `podiumIds` | 248 | yes | server:boundary | `apps/server/src/store.conversation-registry.test.ts` |
| `apps/server/src/store/conversations/registry.ts` | ConversationRegistryRepository | `siblingSegments` | 260 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `enableFts` | 26 | yes | server:boundary, server:services | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `disableFts` | 44 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `isAvailable` | 48 | yes | server:boundary, server:services | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `segmentsToIndex` | 52 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `indexedCursor` | 66 | yes | server:boundary, server:services | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/transcript-indexer.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `append` | 73 | yes | server:boundary, server:services | `apps/server/src/search.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `resetMissingLake` | 102 | yes | server:boundary | — |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `rows` | 127 | yes | server:boundary | `apps/server/src/relay.lake-read.test.ts`, `apps/server/src/store.search-index.test.ts` +1 |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `searchCandidates` | 144 | yes | server:boundary, server:services | `apps/server/src/modules/memory/lake.test.ts`, `apps/server/src/store.search-index.test.ts` |
| `apps/server/src/store/conversations/transcript-index.ts` | TranscriptIndexRepository | `drop` | 174 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `onAppend` | 93 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventCheckpoint` | 99 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventCheckpoint` | 121 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEvents` | 136 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/daemon/src/runtime-event-reconnect.integration.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeTranscriptEvents` | 156 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `hasCausalTurnFailure` | 203 | yes | `apps/server/src/store/runtime-events.test.ts` | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listRuntimeEventsAfter` | 218 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/events.ts` | EventsRepository | `runtimeEventProjectionCursor` | 233 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `saveRuntimeEventProjectionCursor` | 240 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `appendEvent` | 250 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +2 |
| `apps/server/src/store/events.ts` | EventsRepository | `announceEvent` | 284 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/events.ts` | EventsRepository | `listEventsSince` | 310 | yes | server:boundary, server:services | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/characterization.test.ts` +17 |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSinceWithPrior` | 342 | yes | server:boundary | `apps/server/src/event-log.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listKindSubjectSinceWithPrior` | 367 | **no** | — | — |
| `apps/server/src/store/events.ts` | EventsRepository | `maxEventId` | 388 | yes | server:boundary | `apps/server/src/event-log.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `planEventPrune` | 408 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/event-log.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +1 |
| `apps/server/src/store/events.ts` | EventsRepository | `pruneEventBatch` | 425 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/event-log.test.ts`, `apps/server/src/store/runtime-events.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getStewardState` | 452 | yes | server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setStewardState` | 459 | yes | server:boundary | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `activateJanitorSteward` | 478 | yes | server:boundary | — |
| `apps/server/src/store/events.ts` | EventsRepository | `addSubscription` | 494 | yes | server:boundary | `apps/server/src/steward.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `removeSubscription` | 517 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listSubscriptions` | 521 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `setSubscriptionEnabled` | 534 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `getSubscription` | 541 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `listEnabledSubscriptions` | 548 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/events.ts` | EventsRepository | `markDelivered` | 558 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityRevision` | 98 | yes | `apps/server/src/store/grants.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `visibilityAudienceFor` | 102 | yes | server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResource` | 115 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForResources` | 149 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/grants.ts` | GrantsRepository | `listForKind` | 179 | yes | `apps/server/src/store/grants.test.ts` | `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `upsert` | 195 | yes | `apps/server/src/store/grants.test.ts` — also server:boundary, server:services | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +6 |
| `apps/server/src/store/grants.ts` | GrantsRepository | `remove` | 221 | yes | `apps/server/src/store/grants.test.ts` — also server:services | `apps/server/src/modules/fleet/authz.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/grants.ts` | GrantsRepository | `removeAllForResource` | 245 | yes | `apps/server/src/store/grants.test.ts` — also server:boundary, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store/grants.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `insert` | 120 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `get` | 152 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `openByFingerprint` | 159 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listOpen` | 170 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `listForSession` | 186 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `answer` | 203 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts`, `apps/server/src/modules/interactions/structured.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `recordDelivery` | 232 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `reopen` | 273 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `retireClaimed` | 298 | yes | server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `close` | 324 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `closeSession` | 335 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/interactions.ts` | InteractionsRepository | `pruneResolvedBefore` | 350 | yes | server:services | `apps/server/src/modules/interactions/service.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `upsertIssue` | 99 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +12 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `transitionShippingStage` | 267 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssue` | 392 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/event-log.test.ts` +15 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueCwdRows` | 423 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `closedIssueIds` | 471 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssues` | 502 | yes | server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues-frame-cache.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueParentEdges` | 559 | yes | server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueRows` | 572 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/search.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssue` | 613 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:services | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/relay.draft-reap.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `pruneOrphanRefLetters` | 637 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `nextIssueSeq` | 649 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `renumberCollidingIssueSeqs` | 669 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `assignRepoIdToIssuesUnder` | 726 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `allocateSessionLetter` | 771 | yes | server:boundary, server:normalized-wire, server:services | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `migrateLegacyIssueRepoIds` | 796 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `issuesMissingRepoId` | 807 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueLabels` | 817 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:services | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueLabels` | 828 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.ledger.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueLabelsByIssue` | 838 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllLabels` | 851 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueDep` | 861 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `removeIssueDep` | 867 | yes | server:boundary, server:services | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueDeps` | 880 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listAllIssueDeps` | 894 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listDependents` | 908 | yes | server:boundary, server:normalized-wire, server:services | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueComment` | 920 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueComments` | 928 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/issues.test.ts` +5 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueComments` | 945 | yes | server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countIssueCommentsByIssue` | 956 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `searchIssueComments` | 965 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `addIssueMessage` | 1001 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/migrations/integrity.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueMessage` | 1011 | yes | server:boundary, server:services | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessages` | 1018 | yes | `apps/server/src/migrations/integrity.test.ts` — also server:boundary, server:services | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/modules/messages/multi-user.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `countUnreadIssueMessages` | 1038 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.test.ts` +2 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `markIssueMessagesRead` | 1056 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueMessageReadAt` | 1073 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `listIssueUserState` | 1093 | yes | server:boundary, server:normalized-wire, server:services | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `getIssueUserState` | 1112 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `setIssueUserState` | 1132 | yes | server:boundary | `apps/server/src/issues.test.ts`, `apps/server/src/store.issues.test.ts` +1 |
| `apps/server/src/store/issues.ts` | IssuesRepository | `purgeIssueUserState` | 1165 | **no** | — | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `claimIssueMessage` | 1171 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueMessagesForIssue` | 1181 | yes | server:boundary | — |
| `apps/server/src/store/issues.ts` | IssuesRepository | `deleteIssueChildRows` | 1185 | yes | server:boundary | `apps/server/src/store.issues.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `getLock` | 96 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocks` | 103 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listExpiredLocks` | 111 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listLocksHeldBySession` | 119 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `upsertLock` | 127 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `renewLock` | 155 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `deleteLock` | 170 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaiters` | 175 | yes | server:services | `apps/server/src/modules/lock/service.test.ts` |
| `apps/server/src/store/locks.ts` | LocksRepository | `enqueueWaiter` | 185 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiter` | 198 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `removeWaiterBySession` | 202 | yes | server:services | — |
| `apps/server/src/store/locks.ts` | LocksRepository | `listWaitsBySession` | 209 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/machines.ts` | MachinesRepository | `upsertMachine` | 117 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/browser-open.test.ts`, `apps/server/src/enrollment-durability.test.ts` +28 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `listMachines` | 141 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/daemon/test/build-report-compiled.bun.test.ts` +18 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachine` | 151 | yes | `apps/server/src/store/grants.test.ts`, `apps/server/src/store/machines.build.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/gateway/peer-handshake.build.test.ts` +8 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `addMachineComponent` | 177 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/modules/sessions/stop.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineInventory` | 192 | yes | server:boundary, server:services | `apps/server/src/browser-open.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +6 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineBuild` | 197 | yes | `apps/server/src/store/machines.build.test.ts` — also server:boundary, server:services | `apps/server/src/modules/machines/version-state.test.ts`, `apps/server/src/router.updates.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `getMachineByToken` | 217 | yes | server:boundary, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setUpdateChannel` | 229 | yes | server:boundary | `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/server/src/router.updates.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `renameMachine` | 233 | yes | server:boundary, server:services | `apps/server/src/relay.bind-storm.test.ts`, `apps/server/src/sessions.ledger.test.ts` +1 |
| `apps/server/src/store/machines.ts` | MachinesRepository | `setMachineOwner` | 243 | yes | server:boundary, server:services | `apps/server/src/modules/machines/service.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `deleteMachine` | 247 | yes | server:boundary | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/machines.ts` | MachinesRepository | `touchMachine` | 251 | yes | server:boundary, server:services | `apps/server/src/modules/machines/service.test.ts`, `apps/server/src/store.machines.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getLease` | 30 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `putLease` | 37 | yes | server:services | — |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `getCommand` | 62 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `recordCommand` | 70 | yes | server:services | `apps/server/src/modules/maintenance/service.test.ts` |
| `apps/server/src/store/maintenance.ts` | MaintenanceRepository | `pruneCommandsBatch` | 84 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `addMessage` | 122 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/issues/service/mail-pending.test.ts` +10 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getMessage` | 172 | yes | server:boundary, server:services | `apps/daemon/src/queue-drain-reconnect.integration.test.ts`, `apps/server/src/issues.test.ts` +8 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listMessagesFor` | 180 | yes | server:boundary, server:services | `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts`, `apps/server/src/modules/messages/service.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForSessionProof` | 205 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listLedger` | 225 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-ask-upload.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `queuedPositionForSession` | 258 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingForPage` | 278 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingHighWater` | 307 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `latestPendingOperatorForSession` | 324 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSenders` | 337 | **no** | — | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummary` | 361 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countQueued` | 371 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPending` | 378 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` +2 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordRead` | 398 | yes | server:boundary, server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `readReceipts` | 408 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/characterization.delivery.refusals.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `selfSentIds` | 421 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `pendingSummaryForSession` | 456 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `countPendingForSession` | 494 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listPendingSendersForSession` | 504 | yes | server:services | `apps/server/src/modules/issues/service/mail-pending.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `alreadyCommunicated` | 529 | yes | server:boundary | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markInjected` | 547 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveryAbandoned` | 575 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `retractOptimisticDelivery` | 619 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markSendRefused` | 679 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDelivered` | 700 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markCancelled` | 716 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeliveredByPull` | 731 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markRead` | 747 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markDeadLetter` | 772 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `clearInjected` | 790 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueued` | 798 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/queue-drain-abandonment.test.ts` +1 |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listQueuedPage` | 803 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `recordWakeCooldown` | 821 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `getWakeCooldown` | 830 | yes | server:boundary, server:services | `apps/server/src/modules/messages/authz.test.ts`, `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `expireObserved` | 840 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markAcked` | 857 | yes | server:services | `apps/server/src/modules/messages/service.test.ts` |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listDeliveredUnacked` | 871 | yes | server:boundary, server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `listSettleNotifiable` | 895 | yes | server:services | — |
| `apps/server/src/store/messages.ts` | MessagesRepository | `markReminded` | 913 | yes | server:services | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `listForChat` | 21 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByIssue` | 31 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `getByThreadRef` | 41 | **no** | — | — |
| `apps/server/src/store/messaging-topics.ts` | MessagingTopicsRepository | `upsert` | 51 | **no** | — | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `claim` | 23 | yes | server:boundary, server:services | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `hasActive` | 44 | yes | server:boundary | `apps/server/src/restart-notification-storm.integration.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retire` | 56 | yes | server:boundary, server:services | `apps/server/src/modules/messages/gate-agent.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKey` | 67 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireFactKeyPrefix` | 81 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireByIssue` | 91 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationFactsRepository | `retireExpired` | 95 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `claim` | 113 | yes | server:boundary, server:services | `apps/server/src/modules/messages/service.test.ts`, `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `isClaimed` | 130 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retire` | 134 | yes | server:boundary, server:services | `apps/server/src/steward.test.ts` |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKey` | 139 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireFactKeyPrefix` | 144 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireByIssue` | 148 | yes | server:boundary | — |
| `apps/server/src/store/notification-facts.ts` | NotificationArbiter | `retireExpired` | 152 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `loadAll` | 137 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `get` | 150 | yes | `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +5 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `advanceGeneration` | 158 | yes | `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/causal-observation-gate.test.ts`, `apps/server/src/store/observation-checkpoints.test.ts` +1 |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `rebindExact` | 206 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `save` | 326 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/store/observation-checkpoints.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `getTerminalCandidate` | 354 | yes | `apps/server/src/store/observation-checkpoints.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/restart-notification-storm.integration.test.ts`, `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `recordTerminalCandidate` | 380 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `confirmTerminalCandidate` | 439 | yes | server:boundary | `apps/server/src/terminal-hibernation-proof.test.ts` |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `renewTerminalCandidate` | 488 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `consumeTerminalCandidate` | 533 | yes | server:boundary | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `cancelTerminalCandidate` | 559 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/observation-checkpoints.ts` | ObservationCheckpointsRepository | `purge` | 563 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `record` | 133 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `list` | 248 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `trail` | 260 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `prune` | 278 | yes | `apps/server/src/store/quota-history.test.ts` — also server:boundary, server:services | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/quota-history.ts` | QuotaHistoryRepository | `countAll` | 283 | yes | `apps/server/src/store/quota-history.test.ts` | `apps/server/src/store/quota-history.test.ts` |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `getRecapWatermark` | 15 | **no** | — | — |
| `apps/server/src/store/read-watermarks.ts` | ReadWatermarksRepository | `setRecapWatermark` | 22 | **no** | — | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `invalidate` | 118 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepoPaths` | 123 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/machine-capability-guard.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts` +4 |
| `apps/server/src/store/repos.ts` | ReposRepository | `listRepos` | 152 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` +1 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/find-repo-on-machine.test.ts` +9 |
| `apps/server/src/store/repos.ts` | ReposRepository | `isPrefixTaken` | 191 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `derivePrefixFor` | 196 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForRepoId` | 201 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store.repo-id.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `prefixForPath` | 210 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/store.refs.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `repoForPrefix` | 215 | yes | server:boundary | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `ensurePrefixForRepoId` | 229 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `setRepoPrefix` | 245 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.refs.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `nextDraftSeq` | 271 | yes | server:boundary, server:services | `apps/server/src/store.refs.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `addRepo` | 291 | yes | `apps/server/src/migrations/pre-migrated-fixture.test.ts`, `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.test.ts` +19 |
| `apps/server/src/store/repos.ts` | ReposRepository | `updateRepoOrigin` | 325 | yes | server:boundary | `apps/server/src/store.repo-id.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/repos.ts` | ReposRepository | `resolveRepoIdForPath` | 388 | yes | `apps/server/src/migrations/integrity.test.ts`, `apps/server/src/store/repos-read-cost.test.ts`, `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues.test.ts`, `apps/server/src/store.repo-id.test.ts` +2 |
| `apps/server/src/store/repos.ts` | ReposRepository | `removeRepo` | 403 | yes | `apps/server/src/store/repos-read-cost.test.ts` — also server:boundary | `apps/server/src/store.machines.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/repos.ts` | ReposRepository | `migrateLegacyRepoRows` | 434 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `legacyRepoResidue` | 488 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/repos.ts` | ReposRepository | `importReposJson` | 509 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `putNativeLoginTransfer` | 68 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getNativeLoginTransfer` | 78 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/modules/machines/login-propagation.test.ts`, `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clearNativeLoginTransfer` | 94 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/store/server-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `get` | 118 | yes | server:boundary, server:services, server:store | `apps/server/src/migrations/server-secret-store.test.ts`, `scripts/audit-client-secrets.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `getOrEmpty` | 128 | yes | server:boundary, server:services, server:store | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/settings/wiring.test.ts` +1 |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `set` | 140 | yes | server:boundary, server:services, server:store | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/relay.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `apiKeyFor` | 162 | yes | server:boundary | — |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `clear` | 168 | yes | server:services, server:store | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `updatedAt` | 173 | yes | server:store | `apps/server/src/migrations/server-secret-store.test.ts` |
| `apps/server/src/store/server-secrets.ts` | ServerSecretsRepository | `presence` | 189 | yes | `apps/server/src/store/server-secrets.test.ts` — also server:services | `apps/server/src/migrations/server-secret-store.test.ts`, `apps/server/src/modules/machines/login-propagation.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadSessions` | 44 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +24 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSession` | 49 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-oom-death.test.ts` +1 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/machine-identity.test.ts`, `apps/server/src/modules/sessions/session-requested-model-reload.test.ts` +7 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionByResumeValue` | 69 | yes | `apps/server/src/store/session-by-resume-value.test.ts` — also server:boundary | `apps/server/src/store/session-by-resume-value.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getSessions` | 79 | yes | server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByResumeValues` | 98 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSessionsByResumeValues` | 129 | yes | server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `findSessionsByIssueIds` | 156 | yes | server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessions` | 173 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-attribution.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDeletedSessionsForIssue` | 178 | yes | server:boundary | `apps/server/src/relay.issue-session-delete.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `upsertSession` | 323 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/session-attribution.test.ts`, `apps/server/src/store/session-by-resume-value.test.ts` +2 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/issues.attach.test.ts`, `apps/server/src/issues.normalized-wire.bench.test.ts` +17 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteSessions` | 488 | yes | `apps/server/src/store/session-by-resume-value.test.ts` — also server:boundary, server:services | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `softDeleteForIssue` | 502 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `restoreDeletedForIssue` | 507 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachTombstonesFromIssue` | 543 | yes | server:boundary, server:services | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `detachDanglingIssueReferences` | 562 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/relay.draft-reap.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `purgeSession` | 581 | yes | `apps/server/src/store/observation-checkpoints.test.ts` — also server:boundary | `apps/server/src/relay.draft-reap.test.ts`, `apps/server/src/sessions.refs.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listPins` | 601 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-session-state.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setPin` | 617 | yes | server:boundary, server:services | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listReadAt` | 642 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/modules/sessions/oracle-commands.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `getReadAt` | 652 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/session-cutover.audit.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionRead` | 660 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/archive-park.test.ts`, `apps/server/src/modules/sessions/auto-archive-observed.test.ts` +4 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `markSessionUnread` | 675 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/auto-archive-observed.test.ts`, `apps/server/src/relay.test.ts` +1 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllReadAt` | 691 | yes | server:boundary, server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listSnoozes` | 699 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +6 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setSnooze` | 725 | yes | server:boundary, server:services | `apps/server/src/relay.outbox.test.ts`, `apps/server/src/relay.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearSnooze` | 738 | yes | server:boundary, server:services | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `hasAnySnooze` | 744 | yes | server:boundary, server:services | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearAllSnoozes` | 753 | yes | server:boundary | — |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listOffers` | 760 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setOffer` | 799 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-idempotency.test.ts`, `apps/server/src/offer.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `offerCreatedAt` | 823 | yes | server:boundary, server:services | `apps/server/src/offer.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `clearOffer` | 831 | yes | server:boundary, server:services | `apps/server/src/offer.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `listTabOrders` | 837 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-decomposition.test.ts`, `apps/server/src/modules/sessions/oracle-errors.test.ts` +3 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setTabOrder` | 856 | yes | server:boundary, server:services | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDrafts` | 912 | yes | server:boundary, server:services | `apps/server/src/modules/sessions/oracle-session-state.test.ts`, `apps/server/src/modules/sessions/session-start.test.ts` +2 |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftTimes` | 925 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraft` | 938 | yes | server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `loadDraftDocs` | 991 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/relay.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/sessions.ts` | SessionsRepository | `setDraftDoc` | 1020 | yes | server:boundary, server:services | `apps/server/src/store.test.ts` |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `append` | 127 | yes | server:boundary, server:services | `apps/server/src/modules/settings/wiring.test.ts` |
| `apps/server/src/store/settings-audit.ts` | SettingsAuditRepository | `list` | 160 | yes | server:services | `apps/server/src/modules/settings/wiring.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettings` | 58 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +9 more — also server:boundary, server:normalized-wire, server:services | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/sessions/session-state/registry.test.ts` +9 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettings` | 70 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | `apps/server/src/modules/sessions/session-state/registry.test.ts`, `apps/server/src/modules/sessions/spawn-account-env.test.ts` +5 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getSettingsFor` | 93 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | `apps/server/src/modules/settings/service.commands.test.ts`, `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setSettingsFor` | 119 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | `apps/server/src/approvals-relay-e2e.test.ts`, `apps/server/src/modules/settings/service.commands.test.ts` +4 |
| `apps/server/src/store/settings.ts` | SettingsRepository | `applyPreferencePatch` | 150 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `preferenceFor` | 172 | yes | `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `getModelCatalog` | 183 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:services | `apps/server/src/relay.model-catalog.test.ts` |
| `apps/server/src/store/settings.ts` | SettingsRepository | `setModelCatalog` | 215 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/sessions/model-validation-wiring.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidence` | 355 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `shippingEvidenceForSource` | 366 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordShippingEvidence` | 380 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `repairCandidatesForAttempt` | 416 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `rootIntegrationReceipt` | 476 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordRootIntegrationReceipt` | 496 | yes | server:boundary, server:services | `apps/server/src/issues.test.ts`, `apps/server/src/modules/shipping/service.test.ts` +1 |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getOrder` | 517 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeOrderForIssue` | 522 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listOrders` | 529 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdForOrder` | 535 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `issueIdsForOrders` | 542 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrder` | 559 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createOrReturnActiveOrder` | 653 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `transitionOrder` | 673 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `getAttempt` | 712 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `createAttempt` | 717 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestAttemptForOrder` | 767 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listAttempts` | 774 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimTrain` | 780 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `trainManifestForAttempt` | 1116 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainForOrder` | 1229 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `activeTrainsForLane` | 1272 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `releaseTrain` | 1295 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `isolateTrainFailure` | 1327 | **no** | — | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordNativeStackEdge` | 1472 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasNativeStackEdge` | 1540 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `claimAttempt` | 1557 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasAttemptCustody` | 1609 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `assertEffectDispatchCustody` | 1629 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitEffectResult` | 1666 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCancellationHold` | 1778 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `commitCustodyHold` | 1833 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `finishAttempt` | 1866 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `cancelAttemptAndOrder` | 1924 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `requestCancellation` | 2011 | yes | server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `hasCancellationIntent` | 2037 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `appendStep` | 2042 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepById` | 2112 | yes | server:boundary, server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `stepsForAttempt` | 2117 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `latestStepForEffect` | 2125 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `openHoldForOrder` | 2141 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listHolds` | 2148 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `raiseHold` | 2154 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `resolveHold` | 2247 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `receiptForOrder` | 2307 | yes | server:boundary, server:services | `apps/server/src/modules/shipping/service.test.ts`, `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `listReceipts` | 2314 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `recordEffectEnvelope` | 2320 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeCoveredOrder` | 2400 | yes | server:boundary | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedTrain` | 2543 | yes | server:services | — |
| `apps/server/src/store/shipping.ts` | ShippingRepository | `completeVerifiedOrder` | 2573 | yes | server:boundary, server:services | `apps/server/src/store-issues.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `seedGlobalThread` | 29 | yes | `apps/server/src/migrations/change-provenance-upgrade.test.ts`, `apps/server/src/migrations/convergence.test.ts`, `apps/server/src/migrations/integrity.test.ts` +8 more — also server:boundary, server:normalized-wire, server:services | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `loadSuperagentMessages` | 39 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `appendSuperagentMessage` | 61 | yes | server:boundary | `apps/server/src/search.test.ts`, `apps/server/src/store.test.ts` +1 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `clearSuperagentMessages` | 90 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listSuperagentThreads` | 94 | yes | server:boundary | `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `getSuperagentThread` | 103 | yes | server:boundary | `apps/server/src/store.test.ts`, `apps/server/src/superagent-headless.test.ts` +1 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `upsertSuperagentThread` | 114 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/search.test.ts` +2 |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `setThreadWatermark` | 143 | yes | server:boundary | `apps/server/src/router.test.ts`, `apps/server/src/store.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `updateSuperagentThreadBinding` | 152 | yes | server:boundary | `apps/server/src/superagent.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `archiveSuperagentThread` | 203 | **no** | — | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putQueuedInput` | 207 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listQueuedInputs` | 231 | yes | server:boundary, server:services | `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deleteQueuedInput` | 262 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `putPendingTurn` | 266 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `promoteQueuedInput` | 286 | yes | server:boundary | — |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `listPendingTurns` | 297 | yes | server:boundary, server:services | `apps/server/src/superagent-headless.test.ts` |
| `apps/server/src/store/superagent.ts` | SuperagentRepository | `deletePendingTurn` | 321 | yes | server:boundary | — |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `list` | 88 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `listForUser` | 100 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `upsert` | 111 | yes | `apps/server/src/store/telegram-bindings.test.ts` — also server:boundary | `apps/server/src/relay.test.ts`, `apps/server/src/restart-notification-storm.integration.test.ts` +1 |
| `apps/server/src/store/telegram-bindings.ts` | TelegramBindingsRepository | `remove` | 132 | yes | `apps/server/src/store/telegram-bindings.test.ts` | `apps/server/src/store/telegram-bindings.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `record` | 110 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `forIssues` | 168 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `allAttributed` | 178 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `costedSessionIds` | 186 | **no** | — | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `latestWindowSinceMs` | 204 | yes | server:services | — |
| `apps/server/src/store/transcript-costs.ts` | TranscriptCostsRepository | `countAll` | 211 | yes | server:services | `apps/server/src/modules/cost/service.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `getSnapshot` | 41 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `get` | 57 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `set` | 73 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/authz.test.ts`, `apps/server/src/modules/layout/service.test.ts` +1 |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `setMany` | 87 | yes | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` — also server:services | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clear` | 106 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/modules/layout/service.test.ts`, `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `clearMany` | 110 | yes | `apps/server/src/modules/layout/service.test.ts` | — |
| `apps/server/src/store/user-layout.ts` | UserLayoutRepository | `keysFor` | 117 | yes | `apps/server/src/store/user-layout.test.ts` | `apps/server/src/store/user-layout.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `getFor` | 80 | yes | `apps/server/src/store/runtime-events.test.ts`, `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | — |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `get` | 98 | yes | `apps/server/src/migrations/personal-preference-store.test.ts`, `apps/server/src/store/user-preferences.test.ts` | `apps/server/src/migrations/personal-preference-store.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `set` | 119 | yes | `apps/server/src/store/user-preferences.test.ts` — also server:boundary, server:services | `apps/server/src/store/user-preferences.test.ts` |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `clear` | 135 | yes | `apps/server/src/store/user-preferences.test.ts` | — |
| `apps/server/src/store/user-preferences.ts` | UserPreferencesRepository | `keysFor` | 141 | yes | `apps/server/src/store/user-preferences.test.ts` | — |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `getSnapshot` | 53 | yes | server:services, server:store | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `get` | 68 | yes | server:services, server:store | `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/user-read-position.ts` | UserReadPositionRepository | `advance` | 87 | yes | server:services, server:store | `apps/server/src/modules/read-position/authz.test.ts`, `apps/server/src/store/user-read-position.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `get` | 89 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/sessions/oracle-decomposition.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `roleOf` | 119 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store-users-frame-cache.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `list` | 123 | yes | server:boundary, server:services | — |
| `apps/server/src/store/users.ts` | UsersRepository | `credentialFor` | 133 | yes | server:boundary | `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/users.ts` | UsersRepository | `hasPerUserCredentials` | 152 | yes | server:boundary | — |
| `apps/server/src/store/users.ts` | UsersRepository | `create` | 161 | yes | server:boundary, server:services | `apps/server/src/enrollment-durability.test.ts`, `apps/server/src/modules/fleet/authz.test.ts` +1 |
| `apps/server/src/store/users.ts` | UsersRepository | `setPasswordHash` | 186 | yes | server:boundary | `apps/server/src/auth-route.test.ts`, `apps/server/src/router.setup.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `ownerOf` | 166 | yes | server:boundary | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listWorkflows` | 198 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getWorkflow` | 225 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertWorkflow` | 236 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRevisions` | 266 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRevision` | 274 | yes | server:boundary, server:services | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRevision` | 281 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `publishRevision` | 318 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getBinding` | 326 | yes | server:boundary, server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listBindings` | 333 | yes | server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `setBinding` | 341 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listProfiles` | 375 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getProfile` | 383 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `upsertProfile` | 390 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRuns` | 433 | yes | server:boundary, server:services | `apps/server/src/modules/workflows/engine.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRun` | 445 | yes | server:boundary, server:services | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/service.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `getRunSteps` | 452 | yes | server:boundary, server:services | `apps/server/src/modules/workflows/engine.test.ts`, `apps/server/src/modules/workflows/multi-user.test.ts` |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `listRunEvents` | 470 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRun` | 489 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `findLiveRunForSession` | 500 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `insertRun` | 513 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateRunStatus` | 558 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `updateStep` | 564 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `assignStep` | 597 | yes | server:boundary, server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `resetStep` | 605 | yes | server:services | — |
| `apps/server/src/store/workflows.ts` | WorkflowsRepository | `appendEvent` | 625 | yes | server:boundary, server:services | — |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `appendChanges` | 50 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStatesGeneration` | 125 | yes | server:boundary | `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `maxChangeSeq` | 130 | yes | server:boundary, server:normalized-wire, server:services, server:store, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/feed-bootstrap-scaling.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `minChangeSeq` | 138 | yes | server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/store.changes.test.ts`, `packages/sync/src/ledger.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `changesSince` | 150 | yes | server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/migrations/restore.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `planChangePrune` | 169 | yes | server:boundary, server:services, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/maintenance/service.test.ts` +2 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneChangeBatch` | 186 | yes | server:boundary, server:services, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` +1 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `latestChangeStates` | 220 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/characterization.test.ts`, `apps/server/src/store.changes.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `getAppliedMutation` | 237 | yes | server:boundary, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-idempotency.test.ts` +3 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `recordAppliedMutation` | 244 | yes | server:boundary, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `pruneAppliedMutations` | 257 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `enqueueMessage` | 265 | yes | server:boundary, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listQueuedMessages` | 305 | yes | server:boundary, server:services | `apps/server/src/characterization.test.ts`, `apps/server/src/modules/sessions/oracle-commands.test.ts` +5 |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `queuedMessageCounts` | 342 | yes | `apps/server/src/store/runtime-events.test.ts` — also server:boundary, server:normalized-wire, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessage` | 350 | yes | server:boundary, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `bumpQueuedAttempts` | 354 | yes | server:boundary, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `resetQueuedAttempts` | 360 | yes | server:boundary, server:services | — |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `deleteQueuedMessagesForSession` | 365 | yes | server:boundary, server:services | `apps/server/src/store.outbox.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `listParkedUpstreamMutations` | 382 | yes | server:boundary, @podium/sync | `packages/sync/src/adapters/sqlite/parked-upstream.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `readFeedIdentity` | 407 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts` — also server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` |
| `packages/sync/src/adapters/sqlite/sync-repository.ts` | SyncRepository | `writeFeedIdentity` | 420 | yes | `apps/server/src/migrations/dead-sync-feed.test.ts` — also server:boundary, server:normalized-wire, server:services, @podium/sync | `apps/server/src/migrations/restore.test.ts`, `packages/sync/src/adapters/sqlite/schema.test.ts` |

