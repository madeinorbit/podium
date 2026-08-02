# POD-425 Phase 4 exit-gate verdict at 2b637a2b

**Named candidate:** `2b637a2bbf28e570f10f811aa47966162c3f9351`

**Audit branch tip before this report:** `753b8569d2c57d6efab9f979d27c56cb59dca19f`

The audit branch's product tree is byte-identical to the named candidate. Its only
candidate-to-tip differences are this issue's historical gate reports.

**Verdict: FAIL — Phase 4 remains open and Phase 7 entry remains blocked.**

Two literal structural criteria fail on the coordinator-designated stable tree. The
god-object audit reports one real production item: `machines/service.ts` is 802
physical lines against its unchanged reviewed budget of 800. Both generated
composition documents are stale: current code measures 211 modules / 352 edges and
54 constructor declarations, while the committed records say 209 / 350 and 53.

POD-1470 is repaired. Two independent derivations now agree: POD-1394's original N5b
record and this gate's earlier replay both showed that deleting the write-scope clause
survived; on this candidate the same deletion makes both the registry and real
composition-root tests fail. A second production mutation that widens the shipped
system reaction also fails with the new, distinct write-scope diagnostic.

## Criterion-by-criterion grade

| Criterion | Deciding evidence | Grade |
| --- | --- | --- |
| All Phase 4 children closed with evidence | The initial recursive sweep found every pre-existing Phase 4 child done and this gate as the sole open child. This gate then found and filed POD-1506 (machines budget regression) and POD-1507 (composition records stale) as blocking children. A gate-created blocker is still an open Phase 4 child. | **FAIL** |
| Composition root acyclic and topological | The exported production audits exit 0 at 211 runtime modules, 352 edges, zero cycles, and 54 declarations with zero forward dependencies, deferred closures or non-null late bindings. The reactions ledger exits 0 at 25. The no-write document checks fail later, on currentness rather than topology. | **PASS** |
| God-object audit items zero | `bun run audit:god-objects` exits 1. Its fixture self-probe runs first and passes, then the production audit names one item: `apps/server/src/modules/machines/service.ts`, 802 physical lines past the reviewed 800-line budget. `sessions/lifecycle.ts` is now 590 and no longer appears. Zero means zero. | **FAIL** |
| Module graph document committed and current | Both files exist, but `server-composition-graph.ts` and `server-construction-order.ts`, run without `--write`, each exit 1 as stale. Committed counters are 209 modules / 350 edges and 53 declarations; current code is 211 / 352 and 54. `audit:composition` therefore exits 1. | **FAIL** |
| Session, issue and memory E2E green | The coordinator's exact-candidate landing record reports server + daemon + harness at 356 files / 4,881 tests, protocol at 38 / 847, both exit 0. The prior gate's named session/issue/memory E2E was 10 / 36 at 2359f9d9, but the lifecycle and machine trees changed afterwards. The expensive final E2E was deliberately not started once this candidate failed structural preconditions. | **NOT RE-CERTIFIED ON REJECTED CANDIDATE** |
| Live redeploy keeps sessions | The isolated authenticated restart was green at the earlier immutable candidate, with live config mtime unchanged. It was not spent on this structurally rejected candidate. | **NOT RE-CERTIFIED ON REJECTED CANDIDATE** |
| Multi-instance isolation remains green | The earlier immutable candidate passed runtime 1/1 with 41 expectations, managed-account 3/3 and installer all OK. Machine code changed after that proof. The final lane was not spent after the structural refusal. | **NOT RE-CERTIFIED ON REJECTED CANDIDATE** |
| Landing evidence cited with exits and attribution | POD-279 supplied exact-candidate landing evidence: typecheck exit 0, Tasks 22/22; server + daemon + harness 356/4,881 exit 0; protocol 38/847 exit 0; rearchitecture 32 items / 113 sites exit 0; durable classes 92 stores exit 0; ambient census 41/41 exit 0; boundaries 6 allowlisted / 0 new exit 0. The gate directly remeasured the cheap checks and agreed except for the two structural claims above. | **PASS** |
| Every multi-user guardrail can refuse bad production code | POD-1394's 31-record campaign remains the primary record. Its one survivor, N5b, is now caught by both required arms on this candidate and restores to 2 files / 11 tests green. The full subject-plus-grading-guardrail identity classification was not completed after the candidate failed its structural preconditions, so no broader final-SHA certification is claimed. | **PARTIAL; NO REMAINING N5b DEFECT** |
| Deliberately open questions remain flagged | The authoritative readiness record still flags existence leakage, hidden-versus-opaque cross-boundary edges, permission-affecting reparent, and per-class owner/grant inheritance. No candidate change silently resolves them. | **PASS** |
| Phase 7 entry together with G5/G6 | This gate is not green. | **BLOCKED** |

## Direct measurements

| Command or probe | Exit | Result |
| --- | ---: | --- |
| `bun run typecheck` | 0 | Tasks 22/22; Cached 22/22; 687 ms |
| `bun run audit:god-objects` | 1 | fixture control green, then one production item at 802 > 800 |
| `bun scripts/server-composition-graph.ts` | 1 | checked-in graph stale |
| exported import/topology audit | 0 | 211 modules; 352 edges; 211 topological; 0 cycles |
| `bun scripts/server-construction-order.ts` | 1 | checked-in construction record stale |
| exported construction audit | 0 | 54 declarations; 0 forward; 0 deferred; 0 late |
| `bun scripts/reactions-ledger.ts` | 0 | current, 25 reactions |
| `bun run audit:composition` | 1 | fails on stale graph document |
| `bun run audit:rearch` | 0 | exact baseline, 32 items / 113 sites |
| `bun scripts/rearch-audit.ts --phase POD-318` | 0 | only the declared three-site legacy placeholder residue |
| `bun run audit:ambient-principals` | 0 | fixture control green; FIRST_ADMIN_USER_ID 41 / baseline 41 |
| `bun run lint:boundaries` | 0 | 6 allowlisted; 0 new |
| `bun run audit:durable-classes` | 0 | fixture control green; 92 durable stores classified |

The typecheck result is not used as a substitute for runtime evidence. The candidate
contains no file-wide `@ts-nocheck` under the decomposed sessions or machines modules;
that matters because the earlier lifecycle cut briefly hid thirteen missing imports
behind four such suppressions while still reporting typecheck green.

## Deliberate N5b violations

The detector-local fixtures are controls only. These runs changed production code,
recorded the real nonzero exit, restored the exact diff, and ended with a clean product
tree.

1. Delete only the `principal.writeScope !== 'acted-on-entity'` enforcement block from
   `reactions.ts`. The focused registry and composition-root suite exits 1:
   2 files fail, with the two independent write-scope assertions named. This is the
   exact production mutant that survived both POD-1394 and this gate at 2359f9d9.
2. Restore the clause, then widen the shipped `system()` reaction principal from
   `acted-on-entity` to `all`. Import/assembly exits 1 before tests with the distinct
   diagnostic: `settings.feature-cache: system reactions must not widen write scope
   beyond the acted-on entity`.
3. Restore the production literal. The clean focused suite exits 0: 2 files / 11 tests.
   `git diff --exit-code` confirms byte restoration.

This closes POD-1470's measurement defect. The original survivor and the final caught
replay are independent derivations of the same clause, not one campaign citing itself.

## Exact blocking work

- POD-1506 must make the production god-object audit return zero again. The existing
  800-line review budget has not been raised; the actual file is 802 physical lines.
  The prior enrollment extraction is real, but later additive work crossed its budget.
- POD-1507 must regenerate and review both architecture records after the last module
  additions, then make both no-write generators exit 0. Regeneration alone is not
  evidence until the 209-to-211 module and 350-to-352 edge delta is explained.

After those two fixes land in one newly named stable candidate, the gate needs only its
accepted delta rerun: the god-object positive plus one real production refusal, both
no-write graph checks, changed POD-1394 subject/guardrail pairs, and the final same-SHA
session/issue/memory E2E, isolated authenticated redeploy, and multi-instance lanes.
No tracker close or later merge retroactively repairs this immutable candidate.
