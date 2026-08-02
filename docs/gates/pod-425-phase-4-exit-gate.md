# POD-425 Phase 4 exit gate

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
reported evidence is banked. No new candidate should be cut until POD-1356 lands and POD-1316
either lands independently or is demonstrably covered by a correct shared authenticated-client
bootstrap. The verified results below are banked rather than rerun against a moving integration
branch.

The coordinator retracted the earlier rule that every red on this host is new. POD-1363 records a
load-dependent rearchitecture-audit timeout, and POD-1329 found a unit-test path that overwrites
the live host config. Therefore a future red is unattributed until it is compared under controlled
state isolation and host load; neither “new regression” nor “known baseline” may be inferred from
color alone. An assertion failure that reproduces on a quiet host is real. A red that disappears
when load drops is a host effect. A timeout whose elapsed time scales with load is also a host
effect even when it reproduces, because its protected assertions never ran.

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
  green. Its full unit lane is red (5 failed files/10 failed tests), and the submitted attribution
  currently lists eight timeouts plus three other failures, an unresolved 10-versus-11 mismatch.
  None of this work is in candidate `aba864a9` or can retroactively satisfy that candidate.
- POD-1079 is `done`.
- POD-1315 closed after this gate run, but its correction is not in candidate `aba864a9`, where the defaulted first-admin principal remains. POD-1316 remains open and leaves the real wire-window integration test unauthenticated and timing out at the fail-closed client gate.
- POD-1318 is now `done`; its test-only correction landed through the POD-1327 change.
- POD-1351 is now `done` and landed after this gate run at `61cf1b8b`, with reported phase-audit,
  baseline, one-to-one refusal, focused-test, and typecheck evidence. It remains absent from
  candidate `aba864a9` and is not credited there.
- POD-1356 was sent back from review at clean branch HEAD `c9d90507`. Its ordinary harness path
  deletes `PODIUM_PASSWORD`, causing `requestPrincipal` to map a cookieless request to
  `FIRST_ADMIN_USER_ID` when credentials are absent. That is the forbidden ambient-admin path,
  not real cookie authentication; the server-restart flow performs no login, and POD-1316's
  wire-window test is unchanged.
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
| Live redeploy preserves sessions | Three isolated browser runs fail before session creation with `authenticated account is unavailable`; no restart assertion executes. POD-395 remains older historical evidence. | **Refused; POD-1356.** |
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

The gate may be rerun only after POD-1316 and POD-1356 close with evidence, and after POD-1078, POD-1315's correction, POD-1351, and every other blocker land in the next candidate.
Closure alone is insufficient: the next candidate tree must be inspected for every claimed fix,
including POD-1315, before any dependency is credited as satisfied.
The integrator must then publish one fresh landing record at the resulting SHA with commands, exit
codes, and attribution for the structural audits, session/issue/memory E2E, live redeploy survival,
and multi-instance isolation. Against that same SHA, this gate must run and restore the real-tree
mutation campaign for all ten multi-user conditions. Phase 7 remains blocked until this gate and
G5/G6 all pass.
