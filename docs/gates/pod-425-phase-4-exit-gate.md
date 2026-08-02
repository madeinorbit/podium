# POD-425 Phase 4 exit gate

**Gate run:** 2026-08-02  
**Candidate:** `aba864a9e2531cd8b543633ef48bb60b8f7d76a4`  
**Verdict:** **HELD OPEN — Phase 7 entry is not unblocked.**

The scheduler dependency on POD-734 is closed, but dependency readiness is not the exit
verdict. The candidate still has an open required child, open Phase 4 defects, no fresh
same-candidate landing record for all required lanes, and a reproduced environment-neutrality
failure. The gate therefore does not infer green results from child closure.

## Evidence convention

This run follows the 2026-07-17 ruling on this issue. Integrator landing results are cited when
they exist at the candidate SHA; routine lanes are not rerun by the gate. The gate runs only
deliberate-violation instruments, environment-neutrality checks, and process close-outs.

The worktree was clean and exactly aligned with `issue/279-integration` (`git rev-list
--left-right --count HEAD...issue/279-integration` returned `0 0`). The candidate identity check
`apps/server/src/issues.expected-revision.test.ts` passed 147/147, exit 0.

## Process closure

- POD-645 and POD-734 are now `done`.
- POD-1078 is still `in_progress`. Its owner was mailed the required exit evidence: one shared
  registry, ephemeral/gated rooms, non-distinguishing refusal, and drop-not-buffer pressure
  behavior, each with a deliberate violation and candidate SHA.
- POD-1079 is `done`.
- POD-1315 and POD-1316 remain open direct Phase 4 children. The first leaves a defaulted
  first-admin principal on `IssueService.addComment`; the second leaves the real wire-window
  integration test unauthenticated and timing out at the fail-closed client gate.
- POD-1318 is now `done`; its test-only correction landed through the POD-1327 change.
- POD-1343 is a blocking child of this gate for the reproduced worktree runtime-resolution
  failure below.

The named Phase 4 child-closure criterion is therefore not met.

## Structural evidence disposition

| Requirement | Candidate evidence | Disposition |
| --- | --- | --- |
| Acyclic composition and no forward thunks | Committed `docs/architecture/server-composition-graph.md`: 176 runtime modules, 282 edges, 0 cycles. Committed `docs/architecture/server-construction-order.md`: 51 declarations, 0 forward dependencies, 0 deferred service closures, 0 non-null late bindings. POD-734 attaches the latter document. | **Documented**, but no same-candidate command/exit record was attached. |
| God-object audit zero | POD-395 records deletion of `sessions/service.ts`; POD-320 records zero IssueService inheritance and six composed capabilities over one store. The living Phase 4 ledger explicitly accepts the 600-plus session-state module as a cohesion-reviewed exception; POD-355 likewise records line count as a review signal. | **Earlier child evidence only**; no same-candidate audit result with exit code. |
| Module graph committed | Both generated graph documents are committed at the candidate; `aba864a9` regenerates construction-order line numbers after POD-734. | **Met as a repository fact.** |
| Session, issue, memory E2E green | POD-395 records session E2E 8 files/31 tests at its earlier candidate. POD-320 records focused issue suites but refers final lanes to its handoff. POD-322 attaches only the living ledger. | **Not evidenced at `aba864a9`.** |
| Live redeploy preserves sessions | POD-395 records a successful supervised redeploy on 2026-08-01, including unchanged durable scope and agent PID start time. | **Attributable earlier child evidence**, not a candidate landing record. |
| Multi-instance isolation green | POD-395 records an earlier green lane. POD-734's sole artifact is the construction-order document; its issue has no command, exit code, or same-candidate multi-instance result. | **Not evidenced at `aba864a9`.** |

There is no fresh integrator landing record at `aba864a9` covering the required lanes. The latest
durable coordinator handover is for an older SHA and explicitly records red tests. It cannot be
promoted into same-candidate gate evidence.

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
mutation campaign has not run on this candidate, and POD-1078 is still changing the code for
conditions 1, 6, and 7. Accordingly, the criterion that *every* multi-user condition fired on
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

This proves the gate environment can resolve two copies of `@podium/runtime`, including one from
outside this worktree. POD-1343 owns the repair. Until it is green, further resolution-sensitive
probe results are not trustworthy as environment-neutral evidence.

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

The gate may be rerun only after POD-1078, POD-1315, POD-1316, and POD-1343 close with evidence.
The integrator must then publish one fresh landing record at the resulting SHA with commands, exit
codes, and attribution for the structural audits, session/issue/memory E2E, live redeploy survival,
and multi-instance isolation. Against that same SHA, this gate must run and restore the real-tree
mutation campaign for all ten multi-user conditions. Phase 7 remains blocked until this gate and
G5/G6 all pass.
