# POD-1728 test inventory and cull proposal

Measured 2026-08-05 against `f952fe2885e59c06b252880951349892d565d8ab` (main). This is an audit and proposal only: no test files were deleted or edited.

## 1. Headline number

**Immediate removal recommendation: 0 files. Defensible full-suite time saving: 0 seconds claimed.**

That is deliberately conservative. Every apparent whole-file removal either:

- protects a named specification, past bug, security/isolation rule, or cross-boundary contract;
- contains unique assertions that are not covered by the newer owner-layer test; or
- is a small source/configuration guard whose invariant is intentional and still live.

There is one conditional consolidation proposal below. It is not a deletion to make in this issue:

| Target | Current size | Measured isolated cost | Proposal | Why it is not counted as a saving |
| --- | ---: | ---: | --- | --- |
| `apps/web/src/lib/recency-order.test.ts` | 167 lines, 9 tests | 13.88s wall | Move only the still-unique cases into the existing `client-core` owner suites, then retire this app-layer file if the provenance check passes | The tests would move, not disappear; the 13.88s is an isolated invocation cost, not a package/full-suite delta |

For comparison, the existing owner trio (`focus`, `session-urgency`, and partial-world worklist tests) ran 20 tests in 6.71s wall. The web-layer file has several overlapping cases, but also contains the equal-timestamp tie, shell filtering, and pinned/working ordering cases. Its history includes the recency and sidebar fixes that introduced those assertions, so it cannot be treated as disposable duplicate coverage without a case-by-case provenance check.

Other likely false positives were sampled, not included in the headline:

| Sample | Result | Measured isolated wall time |
| --- | --- | ---: |
| `apps/web/test/panel-mode.test.ts` — 8 tests | 2 owner tests exist, but 6 branch cases are not in the owner; the file names `POD-329` | 9.13s |
| `apps/web/test/ranking.test.ts` — 6 tests | Current owner has 4 tests, but the old file uniquely covers hidden paths, worktree filtering, sorting, and metadata | 4.99s |
| `apps/web/test/workspace-resolution.structure.test.ts` — 1 test | Vite config explicitly says its direct model alias is intentional for fresh checkouts | 1.51s |
| The three samples above together — 15 tests | All passed; this is a measured bundle cost, not safe savings | 13.22s |

No full `apps/web` or repository suite was run. The supplied full-web costs (about 350s wall in the normal case, with a loaded-host run reaching 5m54s) are therefore not used to extrapolate savings.

### Culling is not the machine-load fix

This audit found no evidence that redundant tests are the cause of the shared-host failure. The cost is primarily the real behavior and boundary coverage that remains valuable, plus concurrent execution pressure. Bound the test-run resource ceiling (POD-1729) or move execution off the shared host (POD-1716); do not delete coverage as a response to host load.

## Inventory

The exact count uses only executable test-file suffixes:

```text
rg --files | rg '\\.(test|spec)\\.(ts|tsx|js|jsx|mjs|cjs)$' | wc -l
1023
```

The supplied package breakdown reconciles exactly:

| Scope | Files | Scope | Files |
| --- | ---: | --- | ---: |
| `apps/server` | 288 | `apps/web` | 207 |
| `packages/client-core` | 81 | `apps/daemon` | 63 |
| `packages/sync` | 48 | `packages/model` | 40 |
| `packages/protocol` | 39 | `packages/harness` | 38 |
| `packages/terminal-client` | 25 | `apps/cli` | 25 |
| `packages/commands` | 22 | `packages/runtime` | 21 |
| `packages/pty` | 15 | `packages/transcript` | 12 |
| `apps/mobile` | 12 | `tests/e2e` | 11 |
| `packages/telemetry` | 8 | `tests/keyecho` | 7 |
| `packages/issue-client` | 3 | `packages/composer` | 2 |
| Other tracked test locations | 56 | **Total** | **1023** |

The 56 residual files are 53 under `scripts`, one under `services/telemetry-relay`, one under `apps/janitor`, and one under `apps/desktop`.

## Method and evidence limits

I read the repository testing guidance and the unit/integration/web Vitest configurations, then:

1. enumerated test files by suffix rather than by any filename containing `test`;
2. screened source and history for `[spec:SP-…]`, `POD-…`, security/isolation, wire, process, storage, and other boundary markers;
3. compared old-looking app tests with current package/feature owner tests by imported symbol and assertion case;
4. ran only individual files or small explicitly named groups with `bun --bun node_modules/vitest/vitest.mjs …`;
5. kept the worktree clean after the dependency setup needed to run those targeted samples.

The timings above include Vitest transform/import/environment startup. They are useful measured costs for ranking, but they are not a claim that removing a file saves that entire amount from the full lane.

## 2. Ranked proposals

The table intentionally contains only a conditional consolidation proposal. A conditional row is not permission to delete the current file.

| Rank | File | Reason it surfaced | What would still cover it | Confidence / required gate |
| ---: | --- | --- | --- | --- |
| 1 | `apps/web/src/lib/recency-order.test.ts` | Nine tests import pure `client-core` selectors from the web layer. Current owner suites already cover basic recency, grouping, sidebar urgency, and partial-world behavior. | First move the unique tie-break and shell/pinned ordering cases into `packages/client-core/src/focus.test.ts`, `packages/client-core/src/viewmodels/session-urgency.test.ts`, and the worklist partial-world suite. Then the package-owner tests would cover the retired app-layer file. | **Low for deletion now; medium for eventual consolidation.** Check each assertion's originating fix and retain any named regression/spec coverage. |

### Recommended action for the ranked row

Do not remove the file as-is. If the human wants a follow-up, make a separate small consolidation change that:

- maps every `it` block to an owner test;
- preserves the equal-recency deterministic order and shell/pinned exclusions;
- runs the three owner suites and the web file before and after the move; and
- measures the package lane on an idle host or in CI before claiming a time saving.

## 3. Explicit KEEP list

These were the files most likely to be mistaken for cull targets during this audit.

### Web structure, source, and configuration guards

Keep all of the following:

- `apps/web/test/features.structure.test.ts` — scans the source tree for feature-to-feature, `lib`-to-feature, and UI-layer import violations, and checks that grandfathered exceptions remain in use. This is an architecture boundary guard.
- `apps/web/test/pwa.structure.test.ts` — protects the service-worker fallback/denylist, mobile route, safe-area/dvh CSS, and update prompt behavior; it carries `POD-359`/`POD-405` context.
- `apps/web/test/shell.structure.test.ts` — protects the shell boot/layout contract and retired ConnectScreen/layout behavior; it carries several named bug references.
- `apps/web/test/settings.structure.test.ts` — negative guards known-wrong user-facing billing copy, with positive anchors to prevent vacuous passes.
- `apps/web/test/workspace-resolution.structure.test.ts` — looks like a one-line source grep, but `apps/web/vite.config.ts` explicitly documents the direct `@podium/model` source alias as necessary for a fresh checkout without a generated workspace link. The exact invariant is not duplicated by ordinary web tests.

### Web behavior that looked duplicated but is not safely removable

- `apps/web/test/panel-mode.test.ts` — `effectivePanelMode` has a newer `client-core` owner test, but the owner currently checks only two cases while this file checks eight branches. It also explicitly identifies `POD-329`.
- `apps/web/test/ranking.test.ts` — `apps/web/src/features/setup/ranking.test.ts` is the current owner, but it does not cover the old file's hidden-path, worktree, visible-sort, or metadata cases. The feature history also reaches `SP-3701`/`POD-832`.
- `apps/web/test/derive.test.ts` — 857 lines and 71 passing tests, with real overlap in `orderTabs`, `orphanSessionFor`, repo naming, sidebar grouping, recovery, and status dots. It still uniquely covers functions such as `hostMemoryView`, `formatMemBytes`, `defaultChatCapable`, `isKnownWorktreePath`, `panelLabel`, and `chatActivity`; it also contains `POD-169` retirement assertions. Remove blocks only after an assertion matrix, never the file wholesale on filename evidence.
- `apps/web/test/derive.machines.test.ts` — multi-machine target selection and fallback behavior are not the same as the newer agent-specific model predicates; it exercises a cross-machine view-model seam.
- `apps/web/test/chat.test.ts` — the newer chat owner tests cover newer folding behavior, but this file still covers search, pending-echo reconciliation, minimap ticks, reset pinning, and tool-batch titles. Those helpers are live production code.
- `apps/web/test/error-format.test.ts` — the older-relay diagnostic is still the live `formatAppError` branch used by error boundaries and several UI surfaces.
- `apps/web/test/home.test.ts` — owns the broad focus behavior set, including draft/snooze recency, attention summaries, kanban placement, and relative-time formatting. The newer focus tests do not replace all of it.
- `apps/web/test/mobile-routing.test.ts` — tests the Vite/server entry adapter, while `apps/web/src/app/mobile-entry-redirect.test.ts` tests the cached-browser/client fallback. These are two sides of a cross-boundary loop-breaker.
- `apps/web/test/usage.test.ts` — unique usage-window, model-cost, local-day, and token-format behavior.
- `apps/web/src/lib/derive-unified.test.ts` — a large pure-view-model suite, but its named `POD-166`, `POD-996`, and `POD-171` cases are explicit protected behavior.
- `apps/web/src/lib/recency-order.test.ts` — listed in the conditional table, but kept until the past-fix provenance and owner migration are complete.

### Expensive suites whose cost is not a removal argument

Keep the expensive examples below despite their size:

- `apps/server/src/relay.test.ts` (4,307 lines) — live server/transport/composition behavior, machine/session/message authorization, temp-resource cleanup, and wire seams.
- `apps/server/src/issues.test.ts` (4,195 lines) — issue service behavior through store, principal, session, and broadcast seams; it includes named authorization behavior.
- `apps/server/src/modules/messages/service.test.ts` (4,097 lines) — explicitly `[spec:SP-34d7]`, with delivery, containment, sender, ledger, and authorization behavior.
- `apps/server/src/modules/workflows/characterization.test.ts` (3,942 lines) — migration oracle and `POD-730`/workflow cutover characterization.
- `apps/daemon/src/daemon.test.ts` (2,748 lines) and `apps/daemon/src/session-observers.test.ts` (2,280 lines) — real daemon/WebSocket/filesystem/agent-observation boundaries.
- `packages/sync/src/outbox/outbox.test.ts` (2,430 lines) and `packages/sync/src/replica/replica.test.ts` (2,151 lines) — durable mutation, recovery, authority, and replica semantics; these are not UI duplicates.
- `packages/harness/src/agent-state/codex.test.ts`, `grok.test.ts`, and `claude-code.test.ts` — provider-specific parsing/state behavior; sharing a reducer does not make provider fixtures interchangeable.
- `packages/protocol/src/messages.test.ts` and the wire-golden/handshake suites — protocol and compatibility contracts.

### Security, isolation, and cross-boundary tests

Keep the security/isolation and real-boundary families, including `apps/server/src/authz-matrix.test.ts`, `apps/server/src/modules/messages/characterization.authz.test.ts`, `apps/server/src/modules/messages/characterization.spawn-await.test.ts`, `tests/e2e/harness-env.test.ts`, `tests/e2e/codex-fixture.test.ts`, `apps/daemon/test/worker-isolation.bun.test.ts`, `packages/runtime/src/hermetic-env.test.ts`, the `packages/pty` backend/behavior suites, and sync adapter conformance tests. A unit test for a helper is not a substitute for proving the process, storage, wire, principal, or machine boundary.

### Shallow wiring and type-looking tests that are still contracts

- `packages/harness/src/index.test.ts` checks the public package runtime exports used by daemon and E2E consumers; it is a package boundary, not a Vitest/framework test.
- `packages/commands/src/framework.test.ts` contains type-level assertions, but its runtime sections test the command-definition and canonical command-name contract. The implementation is itself `[spec:SP-3fe2]`; do not cull the file as “just types.”
- `apps/desktop/src-tauri/tauri-conf.test.ts`, `scripts/build-bun-windows.test.ts`, and `scripts/vitest-bun-runtime.test.ts` protect packaging/runtime contracts. The latter explicitly prevents the wrong Node-vs-Bun test runner from silently returning false failures.

Slow, annoying, or snapshot-like is not sufficient evidence for removal. No flaky test was proposed for deletion; flakiness would be a separate fix.

## 4. Not judged yet, and what would settle it

1. **Full-lane time delta.** A full web run was intentionally not attempted on this shared six-core/11 GB host. To claim a saving, compare the pre/post package lane in CI or on an idle host, not isolated Vitest startup time.
2. **Recency consolidation.** Build a nine-case matrix from `apps/web/src/lib/recency-order.test.ts` to the three current `client-core` owner files, then inspect `git blame` for the fix-origin cases (`121ebfc6a`, `f6f4fb0fe`, `2425396cc`, `06c1120be`, and later attribution changes). Any case tied to a named bug/spec remains.
3. **The old derive/chat/ranking umbrellas.** A symbol-level map is needed before deleting any file: list every `describe`/`it`, its production owner, and whether the current owner tests the same input/output partition. Static imports alone are not enough.
4. **Fresh-checkout resolution.** If anyone wants to challenge `workspace-resolution.structure.test.ts`, run the web lane from a checkout without generated `node_modules/@podium` links and prove that the Vite source alias and `@podium/source` condition remain protected by another executable check.
5. **Coverage against removed behavior.** For any proposed block deletion, first prove the production symbol is still live or has been removed. A test that fails because the old symbol disappeared is a cleanup task; a test that still exercises a live compatibility path is not.

The evidence supports deliberate owner-layer consolidation as future work, but it does not support deleting a test file in POD-1728.
