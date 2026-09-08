# Coordinator approval regression and promise caller census

Snapshot: `f7b4aa5aa` plus this issue's regression and census sources (2026-09-08). Compiler: TypeScript 6.0.3.

The type-derived set contains **145 distinct promise-producing call sites**, with **163 producer-to-sink edges**. **19 call sites are defects**; the remainder are intentional promise presence/adapter behavior or conservative type alternatives. Counts are call sites, not issue tickets or assertions.

The scan examined 4838 source files across 28 compiler runs, including all 4787 tracked TypeScript/JavaScript sources. 554 tracked sources outside the configured project closures were scanned separately; **0 tracked sources remain uncovered**. The denominator is 66098 distinct type-resolvable promise/thenable call expressions.

## Derivation

Run `bun scripts/promise-caller-census.ts > census.json`. An optional `--output-dir <directory>` retains each project's source roster and findings. No function-name list or text-search pattern determines the candidates.

1. Discover repository TypeScript configurations and create a checker with each project's own options. Scan tracked sources missing from their closures with the scripts configuration. Compiler processes run sequentially and release their memory between projects.
2. Ask the checker for every call expression's result type. Include callable structural thenables and promise alternatives in unions, regardless of the awaited value's type. Require a callable `then` as well as an awaited type: an unconstrained `T` becoming `Awaited<T>` is not evidence of a declared promise.
3. Normalize fresh object-literal properties and import aliases to checker roots while retaining generic interface instantiations, then compute a monotone may-flow closure through symbol-bound locals, assignments, named properties, object destructuring, indexed containers, transparent wrappers, local parameters/returns, and object/array containment. Direct await unwraps a promise; it does not recursively await promise-valued fields.
4. Derive sinks from AST semantics and checker-resolved parameter types: `unknown`/`any` arguments (including rest arguments and serialized containers), null/undefined existence checks, truthiness/negation/loop conditions, and equality with a non-promise value. Include short-circuit assignments, nullish fallback, and `typeof ... === 'undefined'`. Do not exclude promise caches or optional ports before review.
5. Deduplicate producer identities by source start **and end**, and edges by producer, sink, and category. Chained calls can share a start position. Review the raw set and record every disposition below.

This is a finite, context-insensitive analysis of type-resolvable call expressions. It does not infer an async implementation behind a declaration already erased to `any`/`unknown` (POD-3666), simulate external-library callback implementations, or prove arbitrary reflective JavaScript safe. Indexed container flow conservatively joins possible elements; full heap/alias analysis is outside this instrument. The raw JSON retains every sink and its expression, including intentional presence checks.

## Confirmed defects

| Issue | Call sites | Effect |
| --- | ---: | --- |
| POD-3690 | 4 | Async repository lookup is compared with a string; repository scope is refused/hidden. Production injects async, tests inject sync. |
| POD-3694 | 3 | Async user lookup is compared with undefined; the test double reports every user exists. |
| POD-3695 | 1 | The async event batch is not joined; the expected cursor stringifies a Promise. |
| POD-3697 | 4 | A runtime fixture compares unresolved operation reads or serializes an unresolved fleet read. |
| POD-3698 | 5 | The control response serializes a Promise, directly or inside its state object. |
| POD-3699 | 2 | Archived driver uses async exists() as a ternary condition; the condition always selects readlink. |

All discoveries were filed as top-level Proposed work with `discovered-from` edges, without claiming or staging them. The workflow defects affect production repository scope. Other findings in the table affect tests, harnesses, or archived evidence drivers.

## Regression and mutation evidence

**Final focused baseline: 18 passed, 0 failed** (7 coordinator cases and 11 compiler-census probes). The initial instrument probes exposed transient property-symbol aliases; normalizing fresh object-literal properties to checker roots made those probes pass. A further probe pins the separation of generic interface instantiations, so a numeric ref cannot acquire the promise stored in another ref.

**Historical mutation: 5 failed, 2 passed**, with the original service restored byte-for-byte in a `finally` block. The mutation changed only the historical guard spelling:

```diff
- async coordinatorUpdateApproved(channel: UpdateChannel, target: UpdateTarget): Promise<boolean> {
+ coordinatorUpdateApproved(channel: UpdateChannel, target: UpdateTarget): boolean {
-   const approved = await this.approvedTarget(channel)
+   const approved = this.approvedTarget(channel)
```

Three failures were explicitly checked for `AssertionError: expected false to be true`: exact asynchronous approval, active pending grant, and the first live-grant approval check. The other two were the undispatched pending grant and the issuance error `Coordinator update requires approval of the exact target.` The negative guard cases continued to pass. This was a behavioral Vitest failure, not a typecheck or import failure.

The focused command was:

```sh
PODIUM_SERVER_SHARD_REPORT_DIR="$PWD/artifacts/pod-3672-validation/server-shards" \
  bun scripts/validation-admission.ts focused --label coordinator-approval-regression -- \
  bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node \
  -t 'coordinator approval guards|promise caller census' \
  apps/server/src/modules/updates/service.test.ts scripts/promise-caller-census.test.ts
```

The mutant run selected only `coordinator approval guards` in the service test file. JSON/default reporters preserved exact case counts and failure messages. Per the POD-3221 coordinator's request, validation used a private shard-report directory, no worker override, and no broad/shard lane. The normal lean gate and full suite were not run.

The regression covers both guards directly: exact asynchronous approval, full-fingerprint mismatch at the same version, absent/wrong-channel approval, recovery-only mode, live pending grant identity, missing/changed feed target, and revocation. It also exercises the grant-issuance assertion and pending-grant dispatch when a coordinator handler registers. Recovery snapshots seed liveness independently of issuance, so a broken issuance guard cannot prevent the direct liveness test from reaching its assertion.

The census fixtures pin the original inferred-local/unknown-parameter defect, widened aliases, destructuring, local parameter and return flow, containers, indexed values, logical/nullish/typeof checks, union/structural thenables, generic false positives, and awaited negative cases.

## Fingerprint input type

A narrower public parameter is warranted. Current legitimate inputs are a URL string, `UpdateTarget`, `UpdateGrantMessage`, and `{ target: UpdateTarget; repair: boolean }`. A named union of these inputs would reject `Promise<UpdateTarget | undefined>` at compile time while preserving the canonicalization implementation. The repeated optional target lookup in `coordinatorGrantActive` should become a narrowed local at that time. This independent hardening is filed as **POD-3696**, with positive/negative type-test requirements.

## Reviewed call-site roster

Each row is one derived producer span. The attached `census.json` includes all sink expressions and category edges, the project counts, and the uncovered-source inventory. A presence check is classified as intentional only after checking what the promise represents and how its completion is handled.

| Producer | Categories | Disposition |
| --- | --- | --- |
| `.claude/skills/impeccable/scripts/live-browser.js:5128:30` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `.claude/skills/impeccable/scripts/live-browser.js:5872:30` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `.claude/skills/impeccable/scripts/live-server.mjs:84:35` | unknown/any parameter | Promise resolver intentionally assimilates the recursive port-probe promise. |
| `apps/cli/src/cli.ts:1302:11` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/cli/src/parent-boot-confirmation.ts:13:23` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/binding-store.ts:1321:19` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/binding-store.ts:1351:19` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/claude-keychain-credential-store.ts:139:20` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/claude-keychain-lock.test.ts:163:19` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/exec.ts:220:19` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/inventory.ts:127:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/inventory.ts:129:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/inventory.ts:131:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/inventory.ts:148:58` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/control/inventory.ts:151:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/discovery-loop.ts:90:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/git-capture.ts:101:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/git-capture.ts:64:18` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/host-runtime.ts:1169:26` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/quota-fetch.ts:50:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/runtime/opencode-attach.ts:856:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/runtime/version-probe.ts:53:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/worker-client.ts:116:36` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/worktree-resolve.ts:110:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/daemon/src/worktree-resolve.ts:113:15` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/mobile/src/client/MobileClientProvider.tsx:287:5` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/mobile/src/client/MobileClientProvider.tsx:512:43` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/mobile/src/components/IssueTargetSheet.test.tsx:25:8` | existence | ReactNode includes a promise alternative; this call supplies a synchronous render callback and checks for an optional node. |
| `apps/mobile/src/hooks/useVoiceInput.ios.ts:282:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/mobile/src/hooks/useVoiceInput.ios.ts:313:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/mobile/src/lib/attachment-session.ts:22:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/mobile/src/screens/capacity-refresh.ts:167:14` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/mobile/src/screens/capacity-refresh.ts:169:14` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/enrollment-durability.test.ts:117:25` | existence | **Defect — POD-3694.** Async user lookup is compared with undefined; the test double reports every user exists. |
| `apps/server/src/enrollment-durability.test.ts:189:27` | existence | **Defect — POD-3694.** Async user lookup is compared with undefined; the test double reports every user exists. |
| `apps/server/src/feed-visibility.ts:586:31` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/gateway/client-mux.ts:306:19` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/gateway/peer-handshake.test.ts:158:25` | existence | **Defect — POD-3694.** Async user lookup is compared with undefined; the test double reports every user exists. |
| `apps/server/src/migrations/snapshot-verifier.ts:410:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/migrations/snapshot-verifier.ts:605:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/model-catalog.ts:121:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/model-catalog.ts:152:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/events/retention.ts:67:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/interactions/feed.ts:74:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/interactions/service.ts:474:19` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/issue-events/feed.ts:78:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/issue-session-lifecycle.ts:94:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/messages/service.test.ts:248:16` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/messages/service.test.ts:252:16` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/messages/service.ts:1261:9` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/messaging/telegram.ts:183:19` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/operations/engine.ts:1192:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/operations/engine.ts:1227:22` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/operations/engine.ts:688:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/quota-history/service.ts:140:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/sessions/publication/broadcast.ts:102:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/sessions/runtime-event-gate.ts:282:19` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/sessions/session-revival.ts:298:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/shipping/service.test.ts:2208:27` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/superagent/service.ts:693:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/dev-bundle.ts:2322:25` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/dev-publisher-wiring.ts:302:24` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/updates/dev-publisher-wiring.ts:311:24` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/updates/head-sha-cache.ts:205:23` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/head-sha-cache.ts:245:19` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/operation.test.ts:1401:25` | existence | Optional notification promise is retained for explicit draining; the test intentionally preserves asynchronous production ordering. |
| `apps/server/src/modules/updates/operation.ts:1693:22` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/operation.ts:2216:25` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/operation.ts:2240:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/updates/service.ts:600:7` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/updates/service.ts:601:7` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `apps/server/src/modules/updates/service.ts:771:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/modules/workflows/handlers/context.ts:386:36` | equality | **Defect — POD-3690.** Async repository lookup is compared with a string; repository scope is refused/hidden. Production injects async, tests inject sync. |
| `apps/server/src/modules/workflows/handlers/context.ts:425:20` | equality, existence | **Defect — POD-3690.** Async repository lookup is compared with a string; repository scope is refused/hidden. Production injects async, tests inject sync. |
| `apps/server/src/modules/workflows/handlers/context.ts:491:48` | equality | **Defect — POD-3690.** Async repository lookup is compared with a string; repository scope is refused/hidden. Production injects async, tests inject sync. |
| `apps/server/src/modules/workflows/handlers/context.ts:574:30` | equality | **Defect — POD-3690.** Async repository lookup is compared with a string; repository scope is refused/hidden. Production injects async, tests inject sync. |
| `apps/server/src/repo-discovery.ts:245:22` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/steward.single-flight.test.ts:83:15` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/steward.test.ts:417:70` | unknown/any parameter | **Defect — POD-3695.** The async event batch is not joined; the expected cursor stringifies a Promise. |
| `apps/server/src/store/executor/post-commit.ts:262:16` | existence, unknown/any parameter | Intentional thenable discrimination in an effect adapter; the promise is tracked via then(), not interpreted as its resolved value. |
| `apps/server/src/store/executor/scheduler.ts:455:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/store/executor/scheduler.ts:518:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/store/executor/scheduler.ts:605:24` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/store/executor/scheduler.ts:674:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/server/src/store/runtime-events.test.ts:974:28` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/web/src/features/chat/useTranscriptWindow.ts:233:23` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/web/src/features/chat/useTranscriptWindow.ts:256:23` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/web/src/features/files/OpenInBrowserButton.tsx:47:25` | truthiness | Checks whether the native handoff is available; its promise is handled with catch() after dispatch. |
| `apps/web/src/features/issues/IssuePanelView.tsx:479:24` | truthiness | ReactNode includes a promise alternative; this call supplies a synchronous render callback and checks for an optional node. |
| `apps/web/src/features/settings/use-forced-setting.ts:57:15` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `apps/web/src/features/usage/UsageView.test.tsx:244:29` | unknown/any parameter | Deliberately injects a pending promise into a mock to test loading behavior. |
| `apps/web/src/features/usage/UsageView.test.tsx:256:29` | unknown/any parameter | Deliberately injects a pending promise into a mock to test loading behavior. |
| `apps/web/src/features/usage/UsageView.test.tsx:80:29` | unknown/any parameter | Deliberately injects a pending promise into a mock to test loading behavior. |
| `apps/web/src/features/worklist/useRowDrag.ts:470:24` | existence | Distinguishes a synchronous no-handoff return from queued work; attaches settlement handling to the returned promise. |
| `apps/web/src/lib/podium-link-click.ts:126:7` | truthiness | Checks whether the native handoff is available; its promise is handled with catch() after dispatch. |
| `apps/web/src/lib/podium-link-click.ts:128:9` | existence, truthiness | Checks whether the native handoff is available; its promise is handled with catch() after dispatch. |
| `apps/web/src/lib/podium-link-click.ts:90:21` | truthiness | Checks whether the native handoff is available; its promise is handled with catch() after dispatch. |
| `apps/web/src/lib/use-feature.ts:48:14` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `docs/evidence/pod-2987/drive.ts:58:12` | truthiness | **Defect — POD-3699.** Archived driver uses async exists() as a ternary condition; the condition always selects readlink. |
| `docs/evidence/pod-3028/drive.ts:68:12` | truthiness | **Defect — POD-3699.** Archived driver uses async exists() as a ternary condition; the condition always selects readlink. |
| `packages/agent-runtime/src/drivers/opencode/runtime.ts:1083:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/agent-runtime/src/runtime.ts:320:30` | existence | Optional-hook fallback selects which promise/value to use; the selected result is then awaited or returned to an awaiting caller. |
| `packages/client-core/src/engine/boot.ts:52:30` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/client-core/src/engine/boot.ts:66:17` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/client-core/src/logging/forward-sink.ts:267:17` | existence, truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/client-core/src/outbox.ts:591:27` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/client-core/src/react/use-model-catalog.ts:82:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/agent-state/opencode.ts:27:22` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/claude-code.ts:418:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/claude-code.ts:420:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/codex-state.ts:228:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/codex.ts:429:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/codex.ts:431:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/cursor.ts:294:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/cursor.ts:296:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/grok.ts:343:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/grok.ts:345:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/pi.ts:324:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/providers/pi.ts:326:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/scanner.ts:395:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/harness/src/discovery/scanner.ts:397:16` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/janitor/src/janitor.ts:260:14` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/janitor/src/worker-client.ts:317:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/pty/src/abduco.ts:313:13` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/runtime/src/machine-update.ts:388:18` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/runtime/src/parent-process.ts:565:29` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/runtime/src/parent-process.ts:823:28` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/sync/src/authority/scoping.ts:151:20` | existence | Checks whether the optional policy hook was called; awaits its result before using the prepared policy. |
| `packages/sync/src/authority/scoping.ts:280:20` | existence | Checks whether the optional policy hook was called; awaits its result before using the prepared policy. |
| `packages/sync/src/feed/identity.ts:142:23` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/sync/src/ledger.ts:412:20` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/sync/src/mirror.test.ts:305:24` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/sync/src/mutation-ledger.ts:122:22` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/sync/src/outbox/outbox.ts:572:23` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `packages/terminal-client-react/src/use-terminal-session.ts:22:30` | existence | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
| `scripts/fixtures/machine-events-runtime.ts:155:20` | unknown/any parameter | **Defect — POD-3697.** A runtime fixture compares unresolved operation reads or serializes an unresolved fleet read. |
| `scripts/fixtures/machine-events-runtime.ts:163:16` | unknown/any parameter | **Defect — POD-3697.** A runtime fixture compares unresolved operation reads or serializes an unresolved fleet read. |
| `scripts/fixtures/machine-update-runtime.ts:344:32` | existence | **Defect — POD-3697.** A runtime fixture compares unresolved operation reads or serializes an unresolved fleet read. |
| `scripts/fixtures/machine-update-runtime.ts:399:43` | unknown/any parameter | **Defect — POD-3697.** A runtime fixture compares unresolved operation reads or serializes an unresolved fleet read. |
| `tests/e2e/iso-handoff-host.ts:145:21` | unknown/any parameter | **Defect — POD-3698.** The control response serializes a Promise, directly or inside its state object. |
| `tests/e2e/iso-handoff-host.ts:146:21` | unknown/any parameter | **Defect — POD-3698.** The control response serializes a Promise, directly or inside its state object. |
| `tests/e2e/iso-handoff-host.ts:147:18` | unknown/any parameter | **Defect — POD-3698.** The control response serializes a Promise, directly or inside its state object. |
| `tests/e2e/iso-handoff-host.ts:151:18` | unknown/any parameter | **Defect — POD-3698.** The control response serializes a Promise, directly or inside its state object. |
| `tests/e2e/iso-handoff-host.ts:158:18` | unknown/any parameter | **Defect — POD-3698.** The control response serializes a Promise, directly or inside its state object. |
| `tests/e2e/serve-harness.ts:1053:21` | truthiness | Intentional presence check for cached, queued, or in-flight work; the promise is returned, awaited, or tracked separately. |
