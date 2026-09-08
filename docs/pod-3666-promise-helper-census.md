# Promise-returning helper census

Snapshot: `2e0d2c95e`. Compiler: TypeScript 6.0.3.

The type-derived set contains **249 named helpers that return a promise without being declared `async`**. Those are the sites a declaration-based census cannot see. **0** of them still carry the await-before-dispatch order defect that timed out eleven boundary tests. The two original helpers remain in the set; their callers now arm the capture, dispatch, then await.

Unknown/generic return types are **not** folded into that 249. They are a separate bucket of **317**.

## Derivation

Run from a checkout of this tip:

```sh
NODE_OPTIONS='--max-old-space-size=8192' node scripts/typed-helpers-census.mjs \
  --root "$PWD" --out /tmp/typed-helpers.json
```

The script is POD-3662 artifact 4, previously syntax-checked only. The graph had never been executed. Two things were required for it to finish against this tip:

1. **Heap.** Default Node (~2 GB) aborted with `FATAL ERROR: Ineffective mark-compacts near heap limit` after ~120s. 8 GB is enough; the successful run took 99s and wrote 168 MB of raw JSON.
2. **Constructor text.** `new Foo()` has no nested `.expression.expression`. The artifact crashed there. The instrument now records `child.expression.getText()`.

No function-name list or `async` grep determines the candidates. Roots are the 125 boundary-shard files from `apps/server/test-shards.json`. The program is that set plus non-declaration repository source in their TypeScript import closure (1020 files). Anonymous callbacks are counted separately from named helpers. No emit or semantic diagnostics are requested.

## Derived set

| Bucket | Count |
| --- | ---: |
| Promise-returning functions including callbacks | 7122 |
| Named promise helpers | 4029 |
| Named **async** promise returns | 3780 |
| Named **non-async** promise returns | **249** |
| Anonymous async promise returns | 2946 |
| Anonymous non-async promise returns | 147 |
| Unknown/any/generic return types (kept separate) | **317** |
| Missing signatures | 0 |
| Awaited call expressions | 18542 |
| Unresolved await calls | 41 |
| Constructor-reachable await review sites | 475 |

Named non-async promise helpers by surface: 221 reachable-source, 28 boundary-test.

Named non-async by package:

| Package | Count |
| --- | ---: |
| apps/server | 219 |
| packages/runtime | 11 |
| packages/sync | 9 |
| apps/daemon | 3 |
| packages/harness | 2 |
| packages/logger | 2 |
| packages/transcript | 2 |
| packages/janitor | 1 |

The 249 is the answer to “how many promise-returning helpers exist that a declaration-based census could not see?” Most of them forward an already-async callee, return `Promise.resolve`, or wrap a Node/browser callback. 39 of the 249 construct a `Promise` in their own body.

## Await-before-dispatch

The defect is: an await on a capture that is only satisfied by a dispatch occurring later in the **same** function. The two worked examples from POD-3662 were `captureReply` (non-async, returns `Promise<agentRelayResult>`) and the two `relay` wrappers that used to `await captureReply(...)` before `routeDaemonFrame`.

A non-async function cannot contain `await`, so the order check is at **call sites** of the 249, plus a body review of the 39 constructors.

`await captureReply` does not appear anywhere in the repository. All 25 call sites in `apps/server/src/relay-agent-relay.test.ts` bind the promise, dispatch `agentRelayRequest`, then await the binding. The two `relay` wrappers at `relay-agent-relay.test.ts:713` and `:853` are now declared `async` and do the same: capture, dispatch, return the pending promise.

Constructor helpers in the same class that dispatch **inside** the `new Promise` executor (so an immediate `await helper()` is safe):

- `apps/daemon/src/agent-relay.ts:54` `relay` — records the waiter, then `send({ type: 'agentRelayRequest', ... })`.
- `apps/server/src/modules/sessions/oracle-support.ts:315` `relay` — pushes a waiter, then `routeDaemonFrame` of the request.

The other constructors are timers (`sleep`/`settle`/`tick`/`macrotask`), Node callbacks (`gzip`, `scrypt`, `spawn`, `server.close`, `listen`), IndexedDB requests, native-installer invoke (command stored before the promise is returned), and scheduler admission (released by other work finishing, not by a later statement in the same function). None is an await-on-capture-before-dispatch.

**Defects: none.** The eleven original timeouts are explained by the two already-repaired helpers. No additional file:line of this class is present in the scanned graph.

## Unknown-type bucket (separate)

317 functions have return type `any`, `unknown`, or a naked type parameter. All 317 are non-async. 239 are named, 78 anonymous. 197 are `any`, 70 `unknown`, 50 a type parameter (`T`, `S`, …). They are **not** counted as promise-returning: the checker cannot see a `then`. A large cluster is `apps/server/src/modules/sessions/session-wiring.ts` bag methods typed `any`. This is the opaque-declaration gap POD-3672's caller census also cannot close.

## What the instrument cannot see

Quoted from the tool itself, then the extra limits found by running it:

- Type-derived inventory and syntactic call edges are **review inputs, not a deadlock detector**. Zero `reviewSites` must never be reported as class closure. This run produced 475 constructor-reachable await sites; that count includes `sleep`, `gzip`, IDB, and every other `new Promise`. It is not a defect count.
- Scope is the **boundary import closure**, not the whole repository. 1020 reachable source files. Scripts, E2E, and packages never imported from those 125 tests are outside the graph. POD-3221's measured-lane census also did not cover `scripts/` integration lanes.
- Opaque ports, unresolved/generic types, callbacks, dynamic dispatch, and returned-promise aliases require review. The 317 unknown returns are that bucket, kept separate.
- Await recording is only `await CallExpression`. `const reply = captureReply(); await reply` is invisible to `awaitSites`. The captureReply call-site review used the source, not that list.
- Constructor reachability is a transitive worklist over inventory call edges. It does not prove the awaited promise is the one a later dispatch fulfills.
- The graph does not infer a promise behind `any`/`unknown`. It does not simulate external-library callbacks.

## Named non-async helpers that construct a Promise

| Location | Name | Surface |
| --- | --- | --- |
| `apps/daemon/src/agent-relay.ts:54` | `relay` | reachable-source |
| `apps/daemon/src/agent-relay.ts:237` | `close` | reachable-source |
| `apps/daemon/src/loopback-listen.ts:50` | `listenLoopback` | reachable-source |
| `apps/server/src/issues.test.ts:1140` | `settle` | boundary-test |
| `apps/server/src/migrations/snapshot-verifier.ts:99` | `spawnSnapshotVerifierChild` | reachable-source |
| `apps/server/src/modules/logs/service.test.ts:84` | `tick` | boundary-test |
| `apps/server/src/modules/memory/transcript-indexer.ts:312` | `sleep` | reachable-source |
| `apps/server/src/modules/messaging/telegram.ts:360` | `sleep` | reachable-source |
| `apps/server/src/modules/operations/engine.ts:1512` | `invokeCancelWithin` | reachable-source |
| `apps/server/src/modules/sessions/oracle-support.ts:315` | `relay` | reachable-source |
| `apps/server/src/modules/sessions/session-revival.ts:276` | `sleep` | reachable-source |
| `apps/server/src/modules/superagent/tools.ts:966` | `sleep` | reachable-source |
| `apps/server/src/modules/updates/build-scope.ts:335` | `runQuietly` | reachable-source |
| `apps/server/src/modules/updates/build-scope.ts:414` | `runReporting` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle-lock.ts:52` | `defaultSleep` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:762` | `digest` | reachable-source |
| `apps/server/src/relay-agent-relay.test.ts:24` | `captureReply` | boundary-test |
| `apps/server/src/response-compression.ts:55` | `gzipAsync` | reachable-source |
| `apps/server/src/static-web.ts:223` | `compress` | reachable-source |
| `apps/server/src/store/executor/context.ts:106` | `settled` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:174` | `defaultSleep` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:433` | `admit` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:660` | `close` | reachable-source |
| `apps/server/src/superagent-concierge.test.ts:83` | `settle` | boundary-test |
| `apps/server/src/superagent-headless.test.ts:117` | `settle` | boundary-test |
| `apps/server/src/superagent.test.ts:797` | `settle` | boundary-test |
| `apps/server/src/wsServer.client-auth.test.ts:97` | `attempt` | boundary-test |
| `apps/server/src/wsServer.client-auth.test.ts:116` | `rejectedHandshake` | boundary-test |
| `apps/server/src/wsServer.origin.test.ts:158` | `attempt` | boundary-test |
| `packages/runtime/src/auth-store.ts:7` | `scrypt` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:43` | `invoke` | reachable-source |
| `packages/runtime/src/parent-control.ts:204` | `sleepMs` | reachable-source |
| `packages/runtime/src/run-registry.ts:89` | `sleep` | reachable-source |
| `packages/runtime/src/time-budget.ts:38` | `macrotask` | reachable-source |
| `packages/sync/src/adapters/indexeddb/idb.ts:97` | `requestAsPromise` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1189` | `transactionCompletion` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1203` | `openDatabase` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1253` | `deleteDatabase` | reachable-source |
| `packages/sync/src/mirror.ts:522` | `sleep` | reachable-source |

## Appendix: every named non-async promise helper

| Location | Name | Surface |
| --- | --- | --- |
| `apps/daemon/src/agent-relay.ts:54` | `relay` | reachable-source |
| `apps/daemon/src/agent-relay.ts:237` | `close` | reachable-source |
| `apps/daemon/src/loopback-listen.ts:50` | `listenLoopback` | reachable-source |
| `apps/server/src/auth-route.test.ts:129` | `resolveUserId` | boundary-test |
| `apps/server/src/auth-route.test.ts:426` | `attempt` | boundary-test |
| `apps/server/src/auth-route.test.ts:442` | `bad` | boundary-test |
| `apps/server/src/automation-cutover.audit.test.ts:179` | `dispatch` | boundary-test |
| `apps/server/src/characterization.test.ts:578` | `outcome` | boundary-test |
| `apps/server/src/feed-visibility.ts:385` | `forBootstrap` | reachable-source |
| `apps/server/src/feed-visibility.ts:400` | `forBatch` | reachable-source |
| `apps/server/src/feed-visibility.ts:674` | `mayReadIssue` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:79` | `toSessions` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:84` | `toPresence` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:301` | `enqueueSessionWork` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:302` | `run` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:323` | `routeClientInputBytes` | reachable-source |
| `apps/server/src/gateway/client-mux.ts:342` | `routeClientFrame` | reachable-source |
| `apps/server/src/gateway/daemon-mux.ts:150` | `inventoryReport` | reachable-source |
| `apps/server/src/gateway/daemon-mux.ts:351` | `routeDaemonFrame` | reachable-source |
| `apps/server/src/gateway/feed-serving.principal-wiring.test.ts:181` | `commitIssue` | boundary-test |
| `apps/server/src/gateway/feed-serving.resume.test.ts:49` | `commit` | boundary-test |
| `apps/server/src/gateway/feed-serving.test.ts:49` | `commit` | boundary-test |
| `apps/server/src/gateway/feed-serving.ts:489` | `admit` | reachable-source |
| `apps/server/src/gateway/feed-serving.ts:935` | `flushPending` | reachable-source |
| `apps/server/src/gateway/peer-handshake.test.ts:167` | `receiveHello` | boundary-test |
| `apps/server/src/gateway/peer-handshake.ts:287` | `receiveDaemonFrame` | reachable-source |
| `apps/server/src/issue-lifecycle-authz-transports.test.ts:177` | `relay` | boundary-test |
| `apps/server/src/issues.test.ts:1140` | `settle` | boundary-test |
| `apps/server/src/migrations/snapshot-verifier.ts:99` | `spawnSnapshotVerifierChild` | reachable-source |
| `apps/server/src/migrations/snapshot-verifier.ts:599` | `close` | reachable-source |
| `apps/server/src/model-catalog.ts:117` | `refreshInBackground` | reachable-source |
| `apps/server/src/modules/fleet/handlers.ts:238` | `roleOf` | reachable-source |
| `apps/server/src/modules/issues/dispatcher.ts:140` | `call` | reachable-source |
| `apps/server/src/modules/issues/dispatcher.ts:151` | `call` | reachable-source |
| `apps/server/src/modules/issues/registry.ts:693` | `handler` | reachable-source |
| `apps/server/src/modules/issues/registry.ts:703` | `handler` | reachable-source |
| `apps/server/src/modules/issues/service/reads.ts:101` | `unreadFor` | reachable-source |
| `apps/server/src/modules/issues/service/workflow.ts:1473` | `onSessionActivity` | reachable-source |
| `apps/server/src/modules/lock/service.ts:338` | `write` | reachable-source |
| `apps/server/src/modules/lock/service.ts:408` | `write` | reachable-source |
| `apps/server/src/modules/lock/service.ts:437` | `write` | reachable-source |
| `apps/server/src/modules/lock/service.ts:509` | `write` | reachable-source |
| `apps/server/src/modules/lock/service.ts:550` | `write` | reachable-source |
| `apps/server/src/modules/logs/service.test.ts:84` | `tick` | boundary-test |
| `apps/server/src/modules/machines/rpc.ts:1545` | `serverEndpointProbe` | reachable-source |
| `apps/server/src/modules/machines/rpc.ts:1569` | `serverEndpointCommit` | reachable-source |
| `apps/server/src/modules/machines/rpc.ts:1587` | `serverEndpointResume` | reachable-source |
| `apps/server/src/modules/memory/transcript-indexer.ts:312` | `sleep` | reachable-source |
| `apps/server/src/modules/messages/cutover.test.ts:666` | `sleep` | boundary-test |
| `apps/server/src/modules/messages/handlers/context.ts:181` | `placementAtWake` | reachable-source |
| `apps/server/src/modules/messages/service.ts:570` | `listSessions` | reachable-source |
| `apps/server/src/modules/messages/service.ts:590` | `listSessions` | reachable-source |
| `apps/server/src/modules/messages/service.ts:592` | `machineName` | reachable-source |
| `apps/server/src/modules/messaging/telegram.ts:360` | `sleep` | reachable-source |
| `apps/server/src/modules/operations/engine.ts:1225` | `enqueueResult` | reachable-source |
| `apps/server/src/modules/operations/engine.ts:1239` | `enqueue` | reachable-source |
| `apps/server/src/modules/operations/engine.ts:1244` | `drive` | reachable-source |
| `apps/server/src/modules/operations/engine.ts:1512` | `invokeCancelWithin` | reachable-source |
| `apps/server/src/modules/sessions/daemon-lifecycle.ts:201` | `emitSessionExited` | reachable-source |
| `apps/server/src/modules/sessions/daemon-lifecycle.ts:209` | `terminalCandidateFacts` | reachable-source |
| `apps/server/src/modules/sessions/daemon-lifecycle.ts:218` | `clearOffer` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:380` | `prepareInboxSend` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:383` | `authorizeQueuedInputAtApply` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:434` | `onMachineAttached` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:522` | `setSnooze` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:525` | `clearSnooze` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:538` | `primeOwnerMemo` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:542` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:548` | `machineUseForClient` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:554` | `authorizeClientDrive` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:557` | `setOffer` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:560` | `clearOffer` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:563` | `dismissOffer` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:570` | `capabilityForSession` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:573` | `inboxPrincipalForCapability` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:618` | `mutateSessionMeta` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:621` | `renameSession` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:625` | `setAgentName` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:628` | `setArchived` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:631` | `parkArchivedSession` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:637` | `markSessionRead` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:640` | `markSessionUnread` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:646` | `setSessionIssueId` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:652` | `setSessionCwd` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:655` | `setWorkState` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:708` | `parkStaleSession` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:720` | `parkShellSession` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:762` | `prepareIssueSessionDelete` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:765` | `prepareIssueSessionRestore` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:791` | `onClientAttached` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:804` | `onClientDetached` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:810` | `onSessionClientFrame` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:813` | `onSessionClientInput` | reachable-source |
| `apps/server/src/modules/sessions/lifecycle.ts:831` | `flushBroadcasts` | reachable-source |
| `apps/server/src/modules/sessions/naming.ts:74` | `rename` | reachable-source |
| `apps/server/src/modules/sessions/oracle-support.ts:315` | `relay` | reachable-source |
| `apps/server/src/modules/sessions/oracle-support.ts:330` | `dispose` | reachable-source |
| `apps/server/src/modules/sessions/publication/broadcast.ts:85` | `capture` | reachable-source |
| `apps/server/src/modules/sessions/repository.ts:220` | `listSessions` | reachable-source |
| `apps/server/src/modules/sessions/session-access.ts:92` | `has` | reachable-source |
| `apps/server/src/modules/sessions/session-access.ts:93` | `ancestorIds` | reachable-source |
| `apps/server/src/modules/sessions/session-authz.ts:189` | `listSessions` | reachable-source |
| `apps/server/src/modules/sessions/session-authz.ts:190` | `sessionById` | reachable-source |
| `apps/server/src/modules/sessions/session-authz.ts:255` | `authorizeClientDrive` | reachable-source |
| `apps/server/src/modules/sessions/session-client-plane.ts:50` | `onMachineAttached` | reachable-source |
| `apps/server/src/modules/sessions/session-client-plane.ts:220` | `onClientDetached` | reachable-source |
| `apps/server/src/modules/sessions/session-client-plane.ts:279` | `onSessionClientFrame` | reachable-source |
| `apps/server/src/modules/sessions/session-client-plane.ts:287` | `onSessionClientInput` | reachable-source |
| `apps/server/src/modules/sessions/session-meta-ops.ts:272` | `setSessionCwd` | reachable-source |
| `apps/server/src/modules/sessions/session-meta-ops.ts:279` | `setWorkState` | reachable-source |
| `apps/server/src/modules/sessions/session-meta-ops.ts:293` | `setArchived` | reachable-source |
| `apps/server/src/modules/sessions/session-meta-ops.ts:299` | `tryAutoArchiveStoppedObserved` | reachable-source |
| `apps/server/src/modules/sessions/session-meta-ops.ts:366` | `write` | reachable-source |
| `apps/server/src/modules/sessions/session-revival.ts:262` | `write` | reachable-source |
| `apps/server/src/modules/sessions/session-revival.ts:276` | `sleep` | reachable-source |
| `apps/server/src/modules/sessions/session-state/registry.ts:272` | `handler` | reachable-source |
| `apps/server/src/modules/sessions/session-state/registry.ts:289` | `handler` | reachable-source |
| `apps/server/src/modules/sessions/session-state/registry.ts:295` | `handler` | reachable-source |
| `apps/server/src/modules/sessions/session-state/registry.ts:301` | `handler` | reachable-source |
| `apps/server/src/modules/sessions/session-state/service.ts:638` | `applyVersionedEdit` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:125` | `pendingForProof` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:135` | `mutate` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:178` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:186` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:243` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:324` | `defaultMachine` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:325` | `machineName` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:326` | `nativeAccountIdForMachine` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:328` | `resolveMachineForAgent` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:337` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:361` | `enqueue` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:397` | `bumpAttempts` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:398` | `resetAttempts` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:399` | `delete` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:411` | `authorizeAtDrain` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:474` | `persist` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:481` | `write` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:490` | `persistDraft` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:497` | `prepareSend` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:500` | `setSessionDraft` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:506` | `authorizeDrive` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:618` | `sessionOwner` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:619` | `machineUseFor` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:833` | `prepareSend` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:903` | `clearOffer` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:957` | `listSessions` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:997` | `listSessions` | reachable-source |
| `apps/server/src/modules/sessions/session-wiring.ts:1032` | `listSessions` | reachable-source |
| `apps/server/src/modules/superagent/tools.ts:966` | `sleep` | reachable-source |
| `apps/server/src/modules/updates/build-scope.ts:335` | `runQuietly` | reachable-source |
| `apps/server/src/modules/updates/build-scope.ts:414` | `runReporting` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle-lock.ts:52` | `defaultSleep` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:435` | `defaultReadSourceStatus` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:761` | `list` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:762` | `digest` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:774` | `readText` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:787` | `remove` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:2219` | `build` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:2288` | `buildApproved` | reachable-source |
| `apps/server/src/modules/updates/dev-bundle.ts:2600` | `requestBuild` | reachable-source |
| `apps/server/src/modules/updates/dev-publisher-wiring.ts:302` | `headSha` | reachable-source |
| `apps/server/src/modules/updates/dev-publisher-wiring.ts:311` | `headSha` | reachable-source |
| `apps/server/src/modules/updates/dev-publisher-wiring.ts:729` | `publishedArtifact` | reachable-source |
| `apps/server/src/modules/updates/operation.ts:2231` | `ensureCoordinatorReplacement` | reachable-source |
| `apps/server/src/modules/updates/reconciler.ts:316` | `onMachineConnected` | reachable-source |
| `apps/server/src/modules/updates/trpc.ts:386` | `createDatabaseSnapshot` | reachable-source |
| `apps/server/src/modules/workflows/service.ts:704` | `execute` | reachable-source |
| `apps/server/src/offer.test.ts:557` | `observe` | boundary-test |
| `apps/server/src/relay-agent-relay.test.ts:24` | `captureReply` | boundary-test |
| `apps/server/src/relay.test.ts:458` | `cwdMsg` | boundary-test |
| `apps/server/src/relay.test.ts:4001` | `unconfirmedKill` | boundary-test |
| `apps/server/src/relay.ts:615` | `principalForCapability` | reachable-source |
| `apps/server/src/relay.ts:1027` | `onVisibilityChanged` | reachable-source |
| `apps/server/src/relay.ts:1168` | `sourceSchemaVersion` | reachable-source |
| `apps/server/src/relay.ts:1274` | `sourceHealthy` | reachable-source |
| `apps/server/src/relay.ts:1275` | `checkpoint` | reachable-source |
| `apps/server/src/relay.ts:1429` | `authorizeQueuedMessage` | reachable-source |
| `apps/server/src/relay.ts:1431` | `confirmQueuedMessageApplied` | reachable-source |
| `apps/server/src/relay.ts:1433` | `noteQueuedMessageInjected` | reachable-source |
| `apps/server/src/relay.ts:1466` | `instructionsForStart` | reachable-source |
| `apps/server/src/relay.ts:1472` | `sessionRoomJoin` | reachable-source |
| `apps/server/src/relay.ts:1572` | `parkShellSession` | reachable-source |
| `apps/server/src/relay.ts:1573` | `parkStaleSession` | reachable-source |
| `apps/server/src/relay.ts:1717` | `setSessionIssueId` | reachable-source |
| `apps/server/src/relay.ts:1718` | `setSessionCwd` | reachable-source |
| `apps/server/src/relay.ts:1719` | `setSessionArchived` | reachable-source |
| `apps/server/src/relay.ts:1722` | `clearSessionOffer` | reachable-source |
| `apps/server/src/relay.ts:2495` | `notify` | reachable-source |
| `apps/server/src/relay.ts:3026` | `answer` | reachable-source |
| `apps/server/src/relay.ts:3188` | `capabilityForSession` | reachable-source |
| `apps/server/src/relay.ts:3274` | `notify` | reachable-source |
| `apps/server/src/response-compression.ts:55` | `gzipAsync` | reachable-source |
| `apps/server/src/server.setup-password.test.ts:42` | `login` | boundary-test |
| `apps/server/src/server.ts:1037` | `createDatabaseSnapshot` | reachable-source |
| `apps/server/src/server.ts:1129` | `roleOf` | reachable-source |
| `apps/server/src/server.ts:1467` | `resolveUserId` | reachable-source |
| `apps/server/src/server.ts:2035` | `refresh` | reachable-source |
| `apps/server/src/server.ts:2047` | `refresh` | reachable-source |
| `apps/server/src/server.ts:2048` | `operationActive` | reachable-source |
| `apps/server/src/server.ts:2072` | `drainStore` | reachable-source |
| `apps/server/src/static-web.ts:223` | `compress` | reachable-source |
| `apps/server/src/store/executor/context.ts:93` | `track` | reachable-source |
| `apps/server/src/store/executor/context.ts:106` | `settled` | reachable-source |
| `apps/server/src/store/executor/driver.ts:272` | `batch` | reachable-source |
| `apps/server/src/store/executor/executor.ts:529` | `atomicWrite` | reachable-source |
| `apps/server/src/store/executor/harness.ts:56` | `wait` | reachable-source |
| `apps/server/src/store/executor/harness.ts:63` | `reached` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:174` | `defaultSleep` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:433` | `admit` | reachable-source |
| `apps/server/src/store/executor/scheduler.ts:660` | `close` | reachable-source |
| `apps/server/src/store/executor/state-models.ts:134` | `run` | reachable-source |
| `apps/server/src/store/issues.ts:1038` | `legacyWorktreeSkippedQuery` | reachable-source |
| `apps/server/src/superagent-concierge.test.ts:83` | `settle` | boundary-test |
| `apps/server/src/superagent-concierge.test.ts:297` | `mcpToolSpecs` | boundary-test |
| `apps/server/src/superagent-headless.test.ts:117` | `settle` | boundary-test |
| `apps/server/src/superagent.test.ts:431` | `markPending` | boundary-test |
| `apps/server/src/superagent.test.ts:797` | `settle` | boundary-test |
| `apps/server/src/transcript-indexer.test.ts:75` | `onBytes` | boundary-test |
| `apps/server/src/transcript-indexer.test.ts:76` | `onTruncate` | boundary-test |
| `apps/server/src/wsServer.client-auth.test.ts:97` | `attempt` | boundary-test |
| `apps/server/src/wsServer.client-auth.test.ts:116` | `rejectedHandshake` | boundary-test |
| `apps/server/src/wsServer.origin.test.ts:158` | `attempt` | boundary-test |
| `packages/harness/src/agent-state/codex.ts:1849` | `cachedProcessBoundCodexRollout` | reachable-source |
| `packages/harness/src/discovery/providers/codex-state.ts:270` | `read` | reachable-source |
| `packages/janitor/src/worker-client.ts:304` | `close` | reachable-source |
| `packages/logger/src/node/file-sink.ts:201` | `flush` | reachable-source |
| `packages/logger/src/node/file-sink.ts:206` | `close` | reachable-source |
| `packages/runtime/src/auth-store.ts:7` | `scrypt` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:43` | `invoke` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:122` | `prepare` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:123` | `activate` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:124` | `restart` | reachable-source |
| `packages/runtime/src/machine-update-native.ts:125` | `discard` | reachable-source |
| `packages/runtime/src/machine-update.ts:348` | `run` | reachable-source |
| `packages/runtime/src/parent-control.ts:204` | `sleepMs` | reachable-source |
| `packages/runtime/src/release-build-timing.ts:185` | `timeReleaseBuildTask` | reachable-source |
| `packages/runtime/src/run-registry.ts:89` | `sleep` | reachable-source |
| `packages/runtime/src/time-budget.ts:38` | `macrotask` | reachable-source |
| `packages/sync/src/adapters/indexeddb/idb.ts:97` | `requestAsPromise` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:501` | `autocommit` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:552` | `enqueueCommit` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1189` | `transactionCompletion` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1203` | `openDatabase` | reachable-source |
| `packages/sync/src/adapters/indexeddb/store.ts:1253` | `deleteDatabase` | reachable-source |
| `packages/sync/src/conformance/harness.ts:139` | `retire` | reachable-source |
| `packages/sync/src/mirror.ts:522` | `sleep` | reachable-source |
| `packages/sync/src/replica/replica.ts:533` | `commitRegions` | reachable-source |
| `packages/transcript/src/source.ts:53` | `readSlice` | reachable-source |
| `packages/transcript/src/tailer.ts:375` | `pacedSeed` | reachable-source |
