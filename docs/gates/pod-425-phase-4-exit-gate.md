# POD-425 Phase 4 exit gate

## Re-candidate verdict — 2026-08-02

**Candidate:** `6fc75d094e8c7adde42654a9b2acff78fda95377`
**Audit branch tip before this report:** `8469640083f06d88c0a0f952678d5eaa5de177d1`
**Verdict:** **REFUSED — Phase 7 entry remains blocked.**

POD-1316 is closed and its fix is present in this candidate at `3a92ed56`, but that does not make
the complete Phase 4 exit gate green. The re-candidate proves that the runtime composition is
acyclic and that session/issue paths, isolated redeploy, environment locality, and multi-instance
isolation work. It also finds five independent acceptance gaps: the committed composition graph
documents are stale; the literal server god-object audit has 28 modules over 600 lines;
the green E2E lane contains no memory-service E2E; and the required ten-condition production-tree
mutation campaign was not performed at the candidate; and a cold browser-redeploy checkout fails
before test discovery because the Playwright build omits a required workspace build. The gaps are
tracked by POD-1384, POD-1385, POD-1390, POD-1394, and POD-1389 respectively.

The recursive Phase 4 subtree was re-derived rather than inferred from this issue's waits-on list.
The named implementation children and corrective work, including POD-1078, POD-1079, POD-1315,
POD-1316, POD-1343, POD-1351, and POD-1356, are present by ancestry or direct tree inspection.
However, POD-1356 remains open in the tracker at report time and the five gate-created blocking
children above are open. Therefore the “all Phase 4 children closed with evidence” criterion is
**refused** even though the original blocker that triggered this re-run is closed.

### Criterion verdicts

| Criterion | Evidence at candidate `6fc75d09` | Verdict |
| --- | --- | --- |
| Composition root acyclic | The real generated graph has 178 modules, 286 edges, and 0 cycles. Construction has 52 declarations, 0 forward dependencies, 0 deferred closures, and 0 non-null late bindings. The reactions ledger is current at 25. Four negative-test files pass 15/15 and exercise runtime import cycles, dependencies on later services, non-null late binding, `this.modules` reads, deferred closures around already-constructed services, and reaction totality. | **MET** |
| God-object audit items zero | `sessions/service.ts` is deleted. IssueService composes six capabilities over one store with no inheritance or protected-state sharing. The literal production-server size screen nevertheless reports 28 TypeScript modules over 600 lines, from 616 to 2,955 lines. The remaining paths and counts are recorded on POD-1385. | **REFUSED** |
| Module graph documents committed and current | The three documents exist, but `server-composition-graph.ts` and `server-construction-order.ts` both exit 1 without `--write`. A disposable exact-candidate regeneration reports 166 insertions/161 deletions. Only `reactions-ledger.ts` exits 0. POD-1384 owns the stale generated documents. | **REFUSED** |
| Session, issue, and memory E2E green | Isolated `bun run test:e2e` exits 0: 8 files/31 tests. Its eight files exercise session and issue/feed behavior but contain no named memory service, transcript lake/index, or omni-search E2E. POD-1390 owns the missing memory proof. | **PARTIAL / REFUSED** |
| Live redeploy keeps sessions | With the missing local model build supplied, the real authenticated browser test exits 0: 1/1. It logs in through `/auth/login`, restarts only the isolated server, and preserves the marker/grid. A zero-artifact cold checkout fails before discovery because the Playwright build does not build `@podium/model`; POD-1389 owns that harness self-containment defect. | **PRODUCT BEHAVIOR MET; ENVIRONMENT CHECK REFUSED** |
| Multi-instance isolation stays green | Fresh isolated `bun run test:multi-instance` exits 0: Bun 1/1 with 41 expectations, Vitest 1 file/3 tests, installer `ALL OK`. | **MET** |
| Landing evidence cited, not re-derived | At this same SHA, the POD-279 coordinator reports typecheck 22/22, `wsServer.client-auth` 7/7, and protocol wire goldens 90/0, all exit 0. The gate did not rerun those lanes. | **MET** |
| Ten multi-user deliberate-violation probes | Three detector controls exit 0 and catch their planted scoped-feed, machine-grant, and durable-class violations. The focused multi-user run exits 0 at 14 files/251 tests; an additional composition/capability run exits 0 at 8 files/190 tests. POD-1078 also retains historical evidence of one real cross-user production mutation going red and being restored. There is no fresh candidate-wide production-code mutation-and-byte-restore campaign covering every one of the ten conditions. Detector-local fixtures and positive tests do not meet POD-422 checklist E's production-tree counterfactual standard. POD-1394 owns the complete campaign. | **REFUSED** |
| Deliberately open questions remain flagged | O1 existence leakage (including room occupancy), O2 opaque cross-boundary references, O3 permission-affecting reparent, and O4 per-class owner/grant inheritance remain explicitly open in `multi-user-readiness.md`, ADRs 1/2/3/4/7/9, and `rearchitecture-v3.md`; no implementer silently resolved them. | **MET** |
| Phase 7 entry | The gate must compose with G5 and G6 only after every row above is met. | **BLOCKED** |

### Structural and audit detail

The three composition commands were run without `--write`. The graph and construction commands
correctly refused their stale checked-in outputs, while the reactions ledger passed. Regeneration
was used only in a disposable exact-candidate worktree to measure the drift; no candidate file was
changed. The 4-file/15-test refusal suite proves that the instruments can say no, not merely that
the current tree happens to pass its topology checks.

`bun scripts/rearch-audit.ts --phase POD-318` exits 0 and prints the declared three-site legacy
placeholder residue with its justification and expiry. `bun run audit:rearch` exits 0 at the exact
31-item/142-site baseline. Those green audit results do not override the separate literal
approximately-600-line gate criterion. The size screen's 28 paths are:

```text
2955 modules/sessions/lifecycle.ts
2595 modules/messages/service.ts
2026 relay.ts
1664 modules/issues/registry.ts
1404 migrations/schema.ts
1187 modules/superagent/service.ts
1152 modules/issues/service/workflow.ts
1080 steward.ts
969  modules/superagent/tools.ts
934  modules/issues/service/core.ts
915  modules/machines/rpc.ts
879  store/issues.ts
820  modules/issues/service/crud.ts
810  modules/messaging/service.ts
779  store/sessions.ts
738  modules/issues/service/reads.ts
724  modules/workflows/service.ts
716  modules/sessions/session.ts
713  modules/settings/service.ts
685  composition/reactions.ts
672  store/types.ts
651  server.ts
649  modules/sessions/command-plane.ts
648  modules/automations/service.ts
625  modules/machines/service.ts
622  store/workflows.ts
621  modules/sessions/session-state/service.ts
616  modules/sessions/handoff/coordinator.ts
```

### Isolation and environment evidence

Every runtime lane used fresh `PODIUM_STATE_DIR` and host roots, explicit ports, and only its own
PID markers. The live instance on 18787 was never addressed, restarted, or reaped. Before and
after the E2E, redeploy, and multi-instance legs, `/home/mgw/.podium/config.json` had identical
mtime `1785661627` (`2026-08-02 11:07:07.128162673 +0200`). All temporary roots, PID markers, and
ports were released.

A detached exact-candidate checkout started with zero `node_modules`; frozen install exited 0,
created all 25 local `node_modules/@podium` workspace links, and the runtime-resolution integration
test passed 1 file/3 tests. Thus the former cross-checkout resolution defect is fixed in this
candidate. The cold browser lane then exposed a narrower build-orchestration defect: the declared
Playwright web server builds protocol/web/mobile but not model, so it cannot import
`packages/model/dist/index.js`. Building only `@podium/model` made the unchanged isolated restart
test pass 1/1. This separates a valid product redeploy proof from an invalid cold-harness proof.

The passing restart emitted the already-tracked POD-1101 shutdown race (`RangeError: Cannot use a
closed database` from the transcript indexer after store close). It is not counted as a new issue,
but reinforces why memory E2E and clean teardown cannot be inferred from the session-preservation
assertion.

### POD-1316 disposition

Candidate ancestry contains `3a92ed56`. The corrected integration test passes 1 file/1 test
without increasing its timeout or restoring an ambient/test principal. It deliberately codifies
the protocol decision: current wire 2 receives scoped feed frames; stale wire 1 cannot express
`evict`, receives `scoping-requires-eviction`, and remains silent on the entity plane. The
coordinator independently inspected the assertion change and the unchanged fail-closed auth gate.
POD-1316 is therefore **met in the candidate**, not merely closed in the tracker.

## Successor candidate and evidence limits

The immutable `6fc75d09` refusal remains valid. POD-1384 has now closed after regeneration commit
`7509f2b4`, which is the minimum successor tree that can satisfy the current-document criterion.
Its evidence candidate `4b947e7d` contains that commit and reports all three generators exit 0:
178 modules/286 edges/0 cycles, 52 constructor declarations with zero forward dependencies,
deferred closures, or non-null late bindings, and 25 current reactions. The preserved negative
suite passes 7/7. The graph delta adds the layout service and user-layout store plus their expected
edges; the construction-order delta adds `layout | ledger`. Remaining changes are generated source
locations and renumbering. This clears POD-1384 for a successor candidate only; it does not
retroactively change the named `6fc75d09` result.

There is **no complete same-SHA landing record** for either `7509f2b4` or `4b947e7d`. The POD-279
coordinator has same-tree typecheck 22/22, client-auth 1 file/7 tests, wire goldens 1 file/90 tests,
the three generators, both rearchitecture audits, and POD-1316 ancestry. The following were
explicitly **not run** on those SHAs and are not cited as covered: session/issue/memory E2E,
authenticated live-redeploy survival, multi-instance isolation, and the full unit lane. Earlier
worker results on other commits remain different propositions. Heavy lanes are deliberately held
until all hard blockers land, then must run once against the final named candidate under controlled
load.

POD-1395 records the repeated process gap: three integration points became stale because nothing
requires generated composition artifacts to be current before merge. It is discovered work rather
than a new gate blocker; a final candidate still must have current artifacts regardless of whether
that enforcement improvement has shipped.

### Machine state is not code evidence

Three independently observed failures share one class:

- POD-1343 let a worktree resolve workspace packages from a neighbouring checkout.
- POD-1389 let the browser redeploy proof borrow warm `dist` artifacts; a cold checkout could not
  discover the test until `@podium/model` was built.
- POD-1393 makes the wire-golden corpus depend on agent CLIs installed on the host: the identical
  command and commit passed 90/90 on the five-CLI host but failed 2 of 87 tests on a zero-CLI host.

A result obtained only on the warm ludovico host therefore certifies the code only when the lane
also proves its inputs are candidate-local and machine-neutral. The isolated cold-checkout and
second-machine comparisons are the evidence that exposed this class; warm green alone is not.


## Historical candidate report — `aba864a9`


**Gate run:** 2026-08-02  
**Candidate:** `aba864a9e2531cd8b543633ef48bb60b8f7d76a4`  
**Verdict:** **REFUSED — Phase 7 entry is not unblocked.**

The scheduler dependency on POD-734 is closed, but dependency readiness is not the exit
verdict. Required children remain open, POD-318's own phase-close audit refuses, the isolated
live-redeploy proof cannot authenticate its browser, the literal module-size screen is non-zero,
the ten multi-user conditions lack the required production-tree counterfactuals, and the audited
candidate is stale relative to integration. The gate therefore does not infer green results from
child closure or from fixes merged after its named candidate.

## Evidence convention

This run follows the 2026-07-17 ruling on this issue. Integrator landing results are cited when
they exist at the candidate SHA; routine lanes are not rerun by the gate. The gate runs only
deliberate-violation instruments, environment-neutrality checks, and process close-outs.

The worktree was clean and exactly aligned with `issue/279-integration` (`git rev-list
--left-right --count HEAD...issue/279-integration` returned `0 0`). The candidate identity check
`apps/server/src/issues.expected-revision.test.ts` passed 147/147, exit 0.

### Tree-over-tracker rule

An issue's closed stage and its fix being present in the audited candidate are different
propositions. Only the latter is gate evidence. Every claimed blocker fix must be verified in the
candidate tree; dependency status is process metadata and cannot substitute for that measurement.
Likewise, later integration merges do not retroactively repair a named candidate. Once integration
moves, the existing report remains an honest result for its immutable SHA and candidate staleness
is a refusal ground until a new candidate is cut and verified.

POD-1315 demonstrates the rule. Candidate `aba864a9` still contains
`principal: CommandPrincipal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')` in the
production `IssueService.addComment` signature even though the tracker now says POD-1315 is
closed. At this report refresh, local `issue/279-integration` is `746580f2`, 35 commits ahead of
the candidate, and its tree removes the override. That later fix is required in the next candidate
but is not evidence for this one.

### Re-candidate scheduling and red attribution

This refusal is held against `aba864a9`. POD-1351 has now landed after that candidate and its
reported evidence is banked. POD-1356 has since landed; no new candidate should be cut until
POD-1316 lands.
The verified results below are banked rather than rerun against a moving integration branch.

The coordinator retracted the earlier rule that every red on this host is new. POD-1363 records a
load-dependent rearchitecture-audit timeout, and POD-1329 found a unit-test path that overwrites
the live host config. Therefore a future red is unattributed until it is compared under controlled
state isolation and host load; neither “new regression” nor “known baseline” may be inferred from
color alone. An assertion failure that reproduces on a quiet host is real. A red that disappears
when load drops is a host effect. A timeout whose elapsed time scales with load is also a host
effect even when it reproduces, because its protected assertions never ran.

Typecheck evidence uses `bun run typecheck` with Turbo's normal input-keyed cache. `--force` is
now refused: POD-1378 adds an environment fingerprint so installs, linker changes, and base swaps
automatically invalidate the cache, while an uninstalled checkout fails closed. A genuinely
missing cache input requires `bun run typecheck -- --uncached-because="<reason>"`; such a reason is
evidence of a fingerprint defect to report, not routine lane syntax. Test lanes follow the same
principle and do not bypass valid caches without a named reason.
The POD-279 coordinator later stated that the full landing lane was green with no baseline
failures, but supplied no candidate SHA, command list, exit codes, or counts that this report can
audit. The coordinator separately directed this gate to run the three structural generators,
their named refusal cases, the focused E2E lane, and the isolated redeploy check; those results
are recorded below. Vitest resolves workspace packages to this worktree through aliases derived
from `vitest.config.ts`'s own `import.meta.url`. The structural generators derive their repository
root from their own local `import.meta.dirname`. Direct Bun acceptance runs used temporary root
links whose `import.meta.resolve` output was checked against this worktree; the links were removed
afterward and are not treated as a fix for ordinary worktree installation.

## Process closure

- POD-645 and POD-734 are now `done`.
- POD-1078 is now `done` and reports reconciliation with integration `0e62caa9` at `02b65cbe`.
  Its focused room/feed/protocol evidence is 9 files/209 tests, with a cross-user non-leak
  production mutation refusing red then restoring green; the 50 Hz reattach storm is 1 file/2
  tests. Reported typecheck, composition, web, mobile, Bun SQLite, and multi-instance lanes are
  green. Its historical full unit lane exited 1 with 5 failed files/10 failed tests: seven timed-out
  tests plus three POD-1315 principal-refusal failures. A TerminalView keyboard-fidelity `beforeAll`
  hook failed at file setup and skipped 13 tests, so it added a failed file but not an eleventh
  failed test. The recovered transcript names five `scripts/rearch-audit.test.ts` CLI-exit
  timeouts: baseline match (20 seconds), unknown phase fails closed (20 seconds), nonzero/zero phase
  gating (40 seconds), output flag cannot disable the gate (40 seconds), and output flag cannot
  swallow the baseline write (20 seconds). The other two timeouts were normalized dependency
  emission without membership scans (60 seconds) and the session-free live-scale residue benchmark
  (300 seconds). All four affected files passed isolated with 72, 7, 1, and 13 tests. The recovered
  transcript closes the count/title reconciliation; it does not turn the historical full lane
  green.
  None of this work is in candidate `aba864a9` or can retroactively satisfy that candidate.
- POD-1079 is `done`.
- POD-1315 closed after this gate run, but its correction is not in candidate `aba864a9`, where
  the defaulted first-admin principal remains. POD-1078 reports integration `c557f306` passes its
  focused principal suite at 1 file/3 tests, exit 0. POD-1316 remains open: real-cookie auth now
  reaches product policy, which refuses stale wire 1 with `scoping-requires-eviction`.
- POD-1318 is now `done`; its test-only correction landed through the POD-1327 change.
- POD-1351 is now `done` and landed after this gate run at `61cf1b8b`, with reported phase-audit,
  baseline, one-to-one refusal, focused-test, and typecheck evidence. It remains absent from
  candidate `aba864a9` and is not credited there.
- POD-1356 is now `done` at clean branch HEAD `9f4b35d3` (tree `3476e973`). Review proved that
  browser and real-WebSocket consumers POST the production `/auth/login` route and use its
  `podium_session` cookie; bad-cookie rejection remains green and no timeout was increased. This
  correction is absent from candidate `aba864a9` and is not credited there.
- POD-1343 remains real work, but a detached `/tmp` worktree at ancestor `844c7ff1` reproduces
  the same resolution failure from a zero-`node_modules` start. It is top-level `discovered-from`
  work, not evidence that Phase 4 regressed; the environment-neutrality criterion remains refused.

The named Phase 4 child-closure criterion is therefore not met.

## Structural evidence disposition

| Requirement | Candidate evidence | Disposition |
| --- | --- | --- |
| Acyclic composition and no forward thunks | All three generators exit 0 without `--write`: 176 modules, topological construction, 25 reactions. Four files/15 named tests exercise every requested refusal mode. | **Met.** |
| God-object audit zero | `sessions/service.ts` is absent; IssueService has one store, six capabilities, no inheritance/protected sharing. A direct size screen finds 28 production server TS modules over 600 lines; only the 621-line session-state module and 1,080-line steward have explicit reviewed exceptions in the Phase 4 record. | **Refused under the literal size criterion.** |
| Module graph committed | All three documents are tracked and the generators report them current. The resolution ledger now has 14 former-cycle rows, not the prompt's stale count of 13. | **Met.** |
| Session, issue, memory E2E green | `bun run test:e2e` exits 0: Test Files 8/8, Tests 31/31. It covers real session and issue/feed paths but contains no named memory-service E2E assertion. | **Partial; memory-specific evidence absent.** |
| Live redeploy preserves sessions | At `aba864a9`, three isolated browser runs fail before session creation with `authenticated account is unavailable`; no restart assertion executes. POD-1356's later branch-local correction passes one authenticated restart test but is absent from this candidate. | **Refused for this candidate; child correction verified.** |
| Multi-instance isolation green | Candidate-local `bun run test:multi-instance` exits 0: Bun 1/1 (41 assertions), Vitest 1 file/3 tests, installer `ALL OK`. | **Met.** |

There is no fresh integrator landing record at `aba864a9` covering the required lanes. The latest
durable coordinator handover is for an older SHA and explicitly records red tests. It cannot be
promoted into same-candidate gate evidence.

### Structural command and refusal evidence

`bun scripts/server-composition-graph.ts`, `bun scripts/server-construction-order.ts`, and `bun scripts/reactions-ledger.ts` each exited 0 without `--write`: 176 modules, topological construction, and 25 reactions.
The corresponding Vitest run passed 4 files/15 tests and names the planted runtime import cycle, future service hidden in a thunk, deferred closure around an already-constructed service, non-null late binding, `this.modules` read, missing reaction properties, durable replay without reauthorization, and system attribution/scope violations.

The deletion ratchet exits 0 at the exact baseline (31 items/142 sites), but its phase-close commands disagree.
- `bun scripts/rearch-audit.ts --phase POD-321`: exit 0, its sole item at zero.
- `bun scripts/rearch-audit.ts --phase POD-318`: exit 1, with `local-placeholders=3`, `adoption-backfill-heals=5`, and `machine-id-unbranded-fields=26`; POD-1351 owns the required in-repository disposition and a negative case proving undeclared residue still fails.

### Isolated runtime evidence

Before the E2E lane, ports 9921–9923 were explicitly checked free. `bun run test:e2e` exited 0 with 8 files/31 tests and released all three ports.
The multi-instance lane used fresh roots and six reserved ports; its Bun process test passed 1/1 with 41 assertions, its Vitest process layer passed 1 file/3 tests, and its installer layer ended `ALL OK`.

For live redeploy, three fresh temp roots and explicit free ports 19921–19923 were used with `PODIUM_NO_RELAY=1`; the reaper's entire search root was redirected into each fresh directory and the test could signal only the PID stored there.
Two unmodified runs hit the 30-second test ceiling; a diagnostic raising only Playwright's outer ceiling to 120 seconds reached the helper's own 60-second limit. All failed before session creation or restart and showed:

```text
Podium could not open its private replica
authenticated account is unavailable
```

This is not evidence of a product restart failure: the Phase 3 authentication boundary is working
and terminates the unauthenticated socket before replica open. The missing proof must authenticate
the harness through a real account/login and session cookie; restoring an ambient principal or
raising the timeout would not satisfy the gate.

Every exact PID marker disappeared and every port was released. Immediately before and after these runs and the multi-instance lane, `/home/mgw/.podium/config.json` had unchanged mtime `1785657372` (`2026-08-02 09:56:12.911369050 +0200`). Because another live process rewrites that file periodically, the paired unchanged value is positive evidence that the isolated run did not interfere with the live instance. The live instance was never redeployed.

At POD-1356 branch HEAD `9f4b35d3` (tree `3476e973`), both reviewer-run and child-owned final
follow-up proved the correction with workspace resolution local to that branch. The socket-auth
suite exited 0 (1 file/7 tests, including bad-cookie rejection). The reviewer browser proof used
fresh short roots and port 19926: it authenticated through `/auth/login`, created a session,
restarted only the isolated server, and preserved its terminal marker/grid (1 test passed in 1.5
minutes). The child-owned final Playwright command repeated the proof on port 19933 with an explicit
isolated password: 1 ran, 1 passed, 0 skipped. Both runs fully cleaned their state, ports, and PIDs;
the live config mtime remained `1785661627`.

The same helper exposes POD-1316's remaining non-auth defect. Its real-socket lane reached feed
policy but exited 1 (1 file/1 test) under the child-owned integration command: all three
cookie-bearing sockets authenticated, stale wire 1 received 426 `scoping-requires-eviction`, then
the test waited for an entity frame that policy deliberately withheld. The unchanged 20-second
timeout is the symptom, not the repair target; reported host load was `43.96/54.56/76.02`.

## Deliberate-violation probes

At `aba864a9`, these detector-local planted-fixture probes completed:

| Command | Exit | What it proves |
| --- | ---: | --- |
| `bun scripts/audit-scoped-feed.ts --probe` | 0 | The detector catches an unscoped policy/read seam, `remove` used for revocation, and a batch without a certified range, while sparing clean fixtures. |
| `bun scripts/audit-machine-grants.ts --probe` | 0 | The detector catches fail-open ownership, a missing derived fleet gate, an unscoped fleet scan, and owner exposure on wire, while sparing clean fixtures. |
| `bun scripts/audit-durable-classes.ts --probe` | 0 | The detector catches an undeclared store, missing/mistyped matrix membership, and unaccounted durable writes. The script also reported 89 current durable stores classified or explained. |

These are useful instrument checks, but they are not substituted for the required real-tree
counterfactuals. POD-423 and POD-424 established that a gate mutation must alter production code,
make the real guardrail fail, and restore the original hash. The complete ten-condition production
mutation campaign has not run on this candidate, and POD-1078's completed work is absent from it
for conditions 1, 6, and 7. Accordingly, the criterion that *every* multi-user condition fired on
planted bad product code is **not met**.

## Environment neutrality

The initial worktree had no `node_modules`. `bun install --frozen-lockfile` installed 2,704
packages and exited 0, without changing tracked source. It still produced no local
`node_modules/@podium` scope. The focused identity probe then failed:

```text
bun test --conditions=@podium/source scripts/runtime-resolution.integration.test.ts
0 passed, 1 failed, exit 1
the drizzle migrator does not recognise this database handle ...
the package is loaded twice — check how the lane resolves it
```

This proves the ordinary gate environment can resolve two copies of `@podium/runtime`, including one from outside this worktree. POD-1343 owns the repair.

The failure is **pre-existing, not introduced by Phase 4**. In an isolated detached worktree at `b9cf3b91b7432cd0cfe72115247b0a8ed72cc576` — the first-parent integration commit immediately before the first Phase 4 merge — the same Bun 1.3.14 sequence produced the same result:

- `bun install --frozen-lockfile`: exit 0, 2,704 packages, root `node_modules/@podium` absent.
- `bun test --conditions=@podium/source scripts/runtime-resolution.integration.test.ts`: exit 1, 0/1, identical duplicate-runtime database-handle error.

POD-1343 is therefore top-level discovered work rather than evidence of a Phase 4 regression.
That attribution does not satisfy the environment-neutrality criterion.

A stronger historical control at ancestor `844c7ff1` used a detached `/tmp` worktree that could
not borrow a sibling checkout. From zero `node_modules`, its frozen install exited 0, left the root
`node_modules/@podium` absent, and reproduced the same dual-runtime failure: 1 file/1 test,
0 passed/1 failed.

The environment-neutrality criterion itself is **refused** for candidate `aba864a9`: it does not
guarantee that one local copy of every workspace package resolves into the audited worktree.
POD-1343 reports a `linker=hoisted` repair plus a 25-workspace realpath guard, cold-tested at
1 file/2 tests passing, but that fix has not landed in this candidate.

Evidence in this report is labelled local-by-relative-path, local-by-Vitest-alias, or local after
temporary root-link instrumentation; the earlier detector-fixture runs are not gate evidence.

## Deliberately open questions

This criterion is met. The shipped work continues to flag rather than silently answer:

- O1 existence facts, including room occupancy, in ADR 7 Amendment 1 and the ownership matrix;
- O2 hidden versus opaque cross-boundary graph edges in ADRs 1, 2, 3, 4, 7, and 9;
- O3 reparent as a permission-affecting operation over a moving subtree in ADRs 1, 2, 3, 7, and 9
  and the matrix;
- O4 owner/grant inheritance on create, declared per class, in ADR 9 and the matrix totality test.

`docs/agents/pod-320-issue-capabilities.md` also preserves default-closed switches for unresolved
issue existence surfaces and explicitly records reparent as permission-affecting without choosing
the cross-owner policy.

## Required next candidate

The gate may be rerun only after POD-1316 closes with evidence, and after POD-1078, POD-1315's
correction, POD-1351, POD-1356, and every other blocker land in the next candidate.
Closure alone is insufficient: the next candidate tree must be inspected for every claimed fix,
including POD-1315, before any dependency is credited as satisfied.
The candidate must start at integration `3a45f190` or later. The gate must independently verify the
protocol wire-golden suite is 90/90; the earlier integrated tree reported 3 failed/87 passed before
POD-1350's repair landed. A green wire-window test is also insufficient by itself: POD-1316 must
record whether the correct result is the stale client's 426 eviction or a delivered frame, and the
candidate tree must be inspected to prove that the accepted semantic decision—not merely a changed
assertion or accessor—is what made the lane green.
The integrator must then publish one fresh landing record at the resulting SHA with commands, exit
codes, and attribution for the structural audits, session/issue/memory E2E, live redeploy survival,
and multi-instance isolation. Against that same SHA, this gate must run and restore the real-tree
mutation campaign for all ten multi-user conditions. Phase 7 remains blocked until this gate and
G5/G6 all pass.
