# POD-425 Phase 4 exit-gate verdict at 71a9265e

**Named candidate:** `71a9265ea771ad3642bd6ba2789e6e44f27ee0e6`

**Audit branch tip before this report:** `94a5cba20a9a179da88199030a8d3e184f1910fd`

The audit branch's product tree is byte-identical to the named candidate. Its only
candidate-to-tip differences are this issue's immutable gate reports. Every
production mutation was restored before the next one ran, and the final product
diff is empty.

**Verdict: PASS — Phase 4's exit gate is satisfied.**

This gate releases the Phase 4 dependency on Phase 7. Phase 7 entry still composes
with the separate G5 and G6 gates; this report does not grade those gates.

## Criterion-by-criterion grade

| Criterion | Deciding evidence | Grade |
| --- | --- | --- |
| All Phase 4 children closed with evidence | A fresh recursive `podium issue tree 291` reports every Phase 4 child done and this gate as the only open child. This includes POD-1078, POD-1079, POD-645/POD-734, POD-1467, POD-1470, POD-1494, POD-1495 and POD-1505. POD-1506 is a closed duplicate of POD-1505; POD-1507 is closed by the regenerated records. | **PASS** |
| Composition root acyclic and topological | No-write graph check exits 0 at 211 runtime modules, zero cycles. Construction exits 0, topological and current; the committed record has 54 declarations, zero forward dependencies, deferred closures or non-null late bindings. Reactions ledger exits 0 at 25. `audit:composition` exits 0. | **PASS** |
| God-object audit items zero | `audit:god-objects` exits 0 after its fixture control: zero items, 26 reviewed production modules. Machines service is 718 physical lines against its unchanged 800 budget; enrollment is 434; session lifecycle is 590. A separate real production mutation raises machines service to 819 lines and the audit exits 1 with exactly one named `review-budget-exceeded` item. Restoration returns 718, zero mutant markers, candidate byte identity and zero audit items. | **PASS** |
| Module graph document committed and current | Both no-write generators exit 0. The graph records 211 modules / 352 edges / zero cycles; construction records 54 topological declarations. The two new graph modules are the read-position feed and store, and the reviewed regeneration changed no cycle/order result. | **PASS** |
| Session, issue and memory E2E green | Fresh isolated `bun run test:e2e` exits 0: **10 files / 36 tests**. The suite includes the named memory-service real-stack proof as well as session and issue/feed flows. The coordinator's same-candidate landing run also reports full modules plus commands at **131 files / 2,023 tests**, exit 0. | **PASS** |
| Live redeploy keeps sessions | Authenticated Chromium restart exits 0: **1 test passed / 0 skipped**. On explicitly free port 19960 it logs in through the real auth route, restarts only its isolated harness, and preserves the terminal marker and grid. The harness base is absent afterward, the port has no listener, and live `~/.podium/config.json` mtime is exactly `1785661627` before and after. | **PASS** |
| Multi-instance isolation remains green | Fresh `test:multi-instance` exits 0: Bun runtime **1/1 with 41 expectations**, managed-account **1 file / 3 tests**, installer **ALL OK**. It used a fresh isolated state directory. | **PASS** |
| Environment neutrality | Final locality suite exits 0: **1 file / 3 tests**, proving all workspace packages resolve into this checkout. Its test, bunfig, lockfile/fingerprint inputs are byte-identical to the earlier real missing-link counterfactual: removing the local runtime link made the same suite exit 1 with 1 failed / 2 passed. | **PASS** |
| Landing evidence cited with exits and attribution | POD-279's same-candidate landing record is cited rather than re-derived: typecheck exit 0, Tasks 22/22, Cached 22/22; modules + commands 131/2,023 exit 0; rearchitecture 32 items / 113 sites exit 0; ambient census 41/41 exit 0. Gate-only structural, mutation, environment and runtime close-out commands are recorded below with real exits. | **PASS** |
| Every multi-user gate condition fires on bad production code | The 31-mutant census is complete at this product tree: **17 changed subject/guardrail pairs rerun and caught**, **14 pairs carried only after byte identity of both subject and every grading path**, zero survivors. Sixteen fresh raw records are committed beside this report; N5b is recorded separately because its old compound anchor correctly no longer exists after distinct diagnostics landed. | **PASS** |
| Deliberately open questions remain flagged | `multi-user-readiness.md` and `rearchitecture-v3.md` still explicitly flag existence leakage (including counts, machine-session lists, lock holders, ref-letter allocation and room occupancy), hidden-versus-opaque cross-boundary edges, permission-affecting reparent, and per-class owner/grant inheritance. No Phase 4 implementation silently chose them. | **PASS** |
| Phase 7 entry with G5/G6 | This gate contributes a passing Phase 4 result. | **UNBLOCKED BY PHASE 4** |

## Structural, audit and runtime measurements

| Command or evidence source | Exit | Result |
| --- | ---: | --- |
| POD-279 landing: `bun run typecheck` | 0 | Tasks 22/22; Cached 22/22 |
| `bun run audit:god-objects` | 0 | fixture control green; zero production items |
| real 819-line machines mutation | 1 | one named `review-budget-exceeded` item; restored to 718 |
| `bun scripts/server-composition-graph.ts` | 0 | acyclic/current, 211 modules |
| `bun scripts/server-construction-order.ts` | 0 | topological/current, 54 declarations |
| `bun scripts/reactions-ledger.ts` | 0 | current, 25 reactions |
| `bun run audit:composition` | 0 | all three structural records current |
| POD-279 landing: modules + commands | 0 | 131 files / 2,023 tests |
| POD-279 landing: `audit:rearch` | 0 | 32 items / 113 sites, baseline exact |
| POD-279 landing: ambient census | 0 | FIRST_ADMIN_USER_ID 41 / baseline 41 |
| `bun run test:e2e` | 0 | 10 files / 36 tests |
| authenticated isolated restart | 0 | Chromium 1/1; session survives restart |
| `bun run test:multi-instance` | 0 | runtime 1/41 expectations; managed 3/3; installer OK |
| runtime-resolution integration | 0 | 1 file / 3 tests |

The E2E lane needed 81.86 seconds under host load. Two non-PTY attempts were
terminated by the execution wrapper at 30 seconds after only the Vitest banner and
were not counted. The unchanged persistent run completed with the counts above.
The browser restart logged event-loop starvation but completed its assertions. It
also emitted the already-tracked transcript-indexer shutdown race after the passing
assertion; that known teardown warning does not change session survival or isolation.

## Multi-user production mutation census

Detector-local `--probe` fixtures are controls only. Every credited result below
mutates shipped code, proves the anchor matched exactly once, observes a nonzero
guardrail exit, restores the original bytes, and confirms a clean tree.

### Freshly replayed because subject or grading guardrail changed

| Condition | Mutants | Result |
| --- | --- | --- |
| 1. One subscription registry | C1, C1b | both exit 1 |
| 5. Machine ownership fails closed | C5a, C5b, N2, N2b2, N2c | all exit 1 |
| 6. Presence ephemeral and gated | C6a, C6b, C6c | all exit 1 |
| 7. No existence oracle | C7a, N3b, N3c | all exit 1 |
| 8. Default-closed classification | N4 | exits 1 |
| 9. System writers stay system | N5, N5b | both exit 1 |
| 10. Not multi-tenancy | C10 | exits 1 |

Raw JSON for C1, C1b, C5a, C5b, C6a, C6b, C6c, C7a, C10, N2, N2b2,
N2c, N3b, N3c, N4 and N5 is under
`docs/gates/pod-425-final-71a9265e-records/`. Every record has
`restored_identical=true`, `git_clean_after=true`, per-edit anchor counts
1 before and after, and successful grep-back.

N5b required an updated target rather than laundering an anchor miss into a pass.
The historical edit expected one compound actor/write-scope condition; the repair
split those clauses and diagnostics. Deleting only the new production write-scope
block makes both the registry test and real composition-root test fail: 2 files,
2 named failures, exit 1. Exact restoration then passes 2 files / 11 tests.

### Carried by subject plus every grading path being byte-identical

C2b, C3a2, C3b, C4a, C4b2, C4c, C8a2, C8b, C9a, C9b, N1, N1b, N1c and N6.

This is explicitly weaker than a rerun: it proves the production subject and every
test/audit that graded the prior caught mutant are unchanged. It does not claim the
guardrail was observed firing again at this SHA. No pair was carried from subject
identity alone.

Mapped to all ten conditions:

| Condition | Evidence | Grade |
| --- | --- | --- |
| 1. One registry | C1/C1b fresh | **PASS** |
| 2. No global broadcast | C2b carried | **PASS** |
| 3. Principal from transport only | C3a2/C3b/N6 carried | **PASS** |
| 4. Scoped-feed integrity | C4a/C4b2/C4c/N1/N1b/N1c carried | **PASS** |
| 5. Machine ownership closed | C5a/C5b/N2/N2b2/N2c fresh | **PASS** |
| 6. Presence ephemeral/gated | C6a/C6b/C6c fresh | **PASS** |
| 7. No existence oracle | C7a/N3b/N3c fresh | **PASS** |
| 8. Classification default closed | C8a2/C8b carried; N4 fresh | **PASS** |
| 9. System attribution/no widening | C9a/C9b carried; N5/N5b fresh | **PASS** |
| 10. No instance partition columns | C10 fresh | **PASS** |

## Deviations and scope boundaries

- POD-1465's proposed break-glass mint path is not present in this integration
  line; its measured close remains a nonblocking deviation, with the main-line
  concern refiled as POD-1487.
- The intentional machine unauthorized-versus-unreachable distinction remains
  confined to M5 and is still flagged against the open existence-leak policy.
- The known `lint:shadowing` TypeScript-overload false positive is POD-1500 and
  is not a Phase 4 acceptance criterion.

No blocking Phase 4 work remains on this named candidate.
