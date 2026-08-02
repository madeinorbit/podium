# POD-425 final Phase 4 exit-gate verdict

**Named candidate:** `2359f9d94e3a847e53b00c73c060f1cf7ca1f96d`

**Audit product tree:** byte-identical to the named candidate. The audit branch differs only in
the two gate-report documents; every deliberate mutation below was restored and the final
worktree had no product diff.

**Verdict:** **FAIL — Phase 4 is not closed and Phase 7 entry remains blocked.**

The candidate has sound runtime topology and green behavioral lanes, but the literal exit
criteria are not met. The checked-in graph documents are stale. The god-object audit reports two
items, including the unlanded lifecycle decomposition. The actual Phase 4 subtree still contains
open children. Most importantly, the exact N5b production mutation deletes the system-writer
write-scope invariant and every intended guardrail remains green. A gate that passed this tree
would certify a property its instrument demonstrably cannot enforce.

## Criterion-by-criterion verdict

| POD-291 / POD-425 criterion | Deciding evidence on `2359f9d9` | Grade |
| --- | --- | --- |
| All Phase 4 children closed with evidence | `podium issue tree 291` still reports POD-1465, POD-1467, POD-1470, POD-1479 and POD-1480 open. POD-1396 is closed in the tracker but its lifecycle cut is absent from this candidate; `lifecycle.ts` remains 2,510 physical lines and is a live audit item. Closed stage and fix present in the candidate are different propositions. | **FAIL** |
| Composition root acyclic and topological | Temporarily generated current diagnostics report 201 runtime modules, 321 edges, zero cycles, and 52 declarations with zero forward dependencies, deferred closures or late bindings. `reactions-ledger.ts` exits 0 at 25 reactions. A planted production import cycle exits 1 with the full cycle path; a planted `machines -> requestBroker` forward reference exits 1 with the named later dependency. | **PASS** |
| God-object audit items zero | `bun run audit:god-objects` exits 1 with **2 items**: `sessions/lifecycle.ts`, 2,510 physical / 1,737 code lines over the unexplained 600-line threshold; and `machines/service.ts`, 929 physical lines over its reviewed 800 budget. `sessions/service.ts` is deleted and the issue capability inheritance chain is gone, but zero means zero. | **FAIL** |
| Module graph documents committed and current | All three documents exist and `composition-root-resolutions.md` records 14 named former-cycle resolutions. The two generated documents are not current: both no-write generators exit 1. Disposable regeneration changes the graph by 200 insertions / 196 deletions and construction order by 52 insertions / 52 deletions. | **FAIL** |
| Session, issue and memory E2E green | `bun run test:e2e` exits 0: **10 files / 36 tests**. It includes `memory-service.e2e.test.ts` alongside the session, relay, feed and state-channel flows. The required full `apps/server/src/modules/sessions/` run also exits 0: **45 files / 513 tests**. | **PASS** |
| Live redeploy keeps sessions | Authenticated Playwright restart on explicitly free port 19943 exits 0: **1 ran / 1 passed / 0 skipped**. It performs a real server restart and preserves the terminal marker and grid. The per-port state, abduco, tmux and home roots were removed; the port was released. Live `~/.podium/config.json` mtime was exactly `1785661627` before and after, and port 18787 was never addressed. | **PASS** |
| Multi-instance isolation stays green | `bun run test:multi-instance` exits 0: runtime **1/1 with 41 expectations**, managed-account **1 file / 3 tests**, installer **ALL OK**. | **PASS** |
| Environment neutrality | The local-resolution suite exits 0: **1 file / 3 tests**. Moving only the local `@podium/runtime` workspace link makes it exit 1 with **1 failed / 2 passed** and the exact message that the package is not linked from this checkout. Restoring the link returns its realpath to this worktree. | **PASS** |
| Landing evidence recorded with real exits and attribution | POD-279 supplied parent `c3b8247e` standing evidence, whose product tree is identical to this candidate: typecheck, rearchitecture audit, ambient census and boundaries all exit 0. Its explicit instruction required remeasurement here. The gate remeasurement agrees: typecheck **22/22 tasks, Cached 22/22**, rearchitecture **32 items / 113 sites**, ambient **41/41**, boundaries **6 allowlisted / 0 new**. Heavy criteria above have same-tree gate-run counts and real exit codes; no piped status was used. | **PASS** |
| Every multi-user gate condition fires on bad production code | POD-1394 records 31 production mutants: 14 rerun at the product-identical parent, 16 carried by byte identity of both subject and guardrail, and N6 new. The carry is explicitly weaker than a rerun. Thirty were caught; N5b survived. This gate replayed N5b directly on `2359f9d9` and reproduced the survivor. | **FAIL** |
| Deliberately open questions remain flagged | `multi-user-readiness.md` section 3.1.2 explicitly retains existence leakage, hidden-versus-opaque cross-boundary edges, and per-class owner/grant inheritance. The same record names reparent as permission-affecting because subtree scope is dynamic. `pod-320-issue-capabilities.md` preserves default-closed switches rather than choosing a permissive policy. | **PASS** |
| Phase 7 entry with G5/G6 | This gate must pass before it can compose with G5 and G6. | **BLOCKED** |

## Structural, audit and isolation measurements

| Command | Exit | Measured result |
| --- | ---: | --- |
| `bun run typecheck` | 0 | Tasks 22/22; Cached 22/22; 216 ms full Turbo |
| `bun scripts/server-composition-graph.ts` | 1 | committed graph missing or stale |
| temporary current graph generation, then no-write check | 0 | 201 modules; 321 edges; 0 cycles |
| `bun scripts/server-construction-order.ts` | 1 | committed construction document missing or stale |
| temporary current construction generation, then no-write check | 0 | 52 declarations; 0 forward; 0 deferred; 0 late binding |
| `bun scripts/reactions-ledger.ts` | 0 | current, 25 reactions |
| focused structural negative suite | 0 | 4 files / 15 tests |
| `bun run audit:rearch` | 0 | baseline exact, 32 items / 113 sites |
| `bun scripts/rearch-audit.ts --phase POD-318` | 0 | three declared legacy-placeholder sites, with justification and expiry |
| `bun run audit:ambient-principals` | 0 | FIRST_ADMIN_USER_ID 41 usage sites, baseline 41 |
| `bun run lint:boundaries` | 0 | 6 allowlisted, 0 new |
| `bun run audit:god-objects` | 1 | 2 production findings |
| full sessions directory | 0 | 45 files / 513 tests |
| `bun run test:e2e` | 0 | 10 files / 36 tests |
| authenticated browser restart | 0 | 1 test passed |
| `bun run test:multi-instance` | 0 | 1 runtime test / 41 expectations; 3 managed-account tests; installer OK |
| workspace-resolution suite | 0 | 1 file / 3 tests |

The temporary current documents were moved aside after measurement and the candidate's committed
stale documents were restored. This distinguishes two facts that the no-write commands combine:
the runtime topology itself is acyclic/topological, while the as-built records committed in the
candidate are not current.

The first full sessions invocation emitted only the Vitest banner and no exit status. It was not
counted. One unchanged rerun completed with the counts above. Redness on this shared host was
treated as unattributed until an assertion ran; no timeout was promoted into a product finding.

## Deliberate production violations

Detector-local `--probe` fixtures are controls only. The following evidence changes the shipped
object or its installed workspace and records the real guardrail result.

| Production violation | Guardrail red/green result | Restore proof |
| --- | --- | --- |
| Runtime import from `command-principal.ts` back to `relay.ts` | graph exits 1; reports `issue-attach-orchestrator -> command-principal -> relay -> issue-attach-orchestrator` | import removed; source first line restored; no product diff |
| `machines` initializer reads later `requestBroker` | construction audit exits 1: `machines at line 338 depends on later service(s): requestBroker` | property removed; no product diff |
| One extra production fallback to `FIRST_ADMIN_USER_ID` | ambient census exits 1: 42 sites versus baseline 41, +1 | function removed; restored census source |
| One undeclared production `__local__` site | phase gate exits 1 naming the exact file/line; global audit exits 1 at baseline 3 -> 4 | site removed; phase/global positive runs remain the candidate record |
| Forbidden `apps/server -> @podium/harness` import | boundaries exit 1 with exactly one new violation in `command-principal.ts` | import removed; candidate has only 6 allowlisted / 0 new |
| Missing local `node_modules/@podium/runtime` link | resolution suite exits 1: 1 failed / 2 passed, exact missing-link diagnostic | link moved back; realpath resolves to this worktree's `packages/runtime` |
| N5b: delete the system reaction `writeScope` clause | **SURVIVES**: scoped composition suite exits 0, 1 file / 8 tests; reaction ledger exits 0 at 25 | exact one-match anchor restored at `reactions.ts:668`; no product diff |

The existing 4-file/15-test structural suite remains useful control evidence for runtime cycle,
later-service, deferred-closure, non-null late-binding, `this.modules` read and reaction-totality
fixtures. It is not credited for N5b: the candidate replay proves its compound system fixture does
not independently exercise write scope.

## Ten multi-user conditions

The durable POD-1394 transcript and all 31 raw JSON records are committed under
`docs/gates/pod-1394-records/`. Between `c3b8247e` and `2359f9d9` the product tree is
identical. The 14 candidate-parent reruns therefore measure the same product. The 16 carried
mutants remain arguments from byte identity of both subject and guardrail, not observations of
the guardrail firing at this SHA; they are labelled as such.

| Condition | Campaign production mutants | Grade |
| --- | --- | --- |
| 1. One subscription registry | C1, C1b caught in candidate-parent reruns | **PASS** |
| 2. No global broadcast | C2b caught; carried by subject+guardrail identity | **PASS, carried evidence** |
| 3. Principal from transport only | C3a2/C3b caught by carried evidence; N6 caught at candidate parent | **PASS** |
| 4. Scoped feed integrity | C4a/C4b2/C4c and N1/N1b/N1c caught; carried evidence | **PASS, carried evidence** |
| 5. Machine ownership fails closed | C5a, N2, N2b2 and N2c rerun and caught; C5b carried and caught | **PASS** |
| 6. Presence ephemeral and gated | C6a/C6b/C6c rerun and caught | **PASS** |
| 7. No existence oracle | C7a/N3c rerun and caught; N3b carried and caught | **PASS** |
| 8. Default-closed classification | C8b rerun and caught; C8a2/N4 carried and caught | **PASS** |
| 9. System writers still system | C9a/C9b rerun and N5 carried are caught, but N5b directly survives on this candidate | **FAIL** |
| 10. Not multi-tenancy | C10 caught; carried by subject+guardrail identity | **PASS, carried evidence** |

## Blocking findings and exact missing work

### POD-1467 blocks

The machines-service overage is not excused because POD-1114 added the lines rather than a
decomposition worker. The acceptance criterion is current structure, not provenance. The reviewed
800-line argument explicitly says growth past the budget voids it, and the candidate is at 929.
POD-1467 must either decompose the service or land a new reviewed, machine-readable argument that
the audit accepts. Until the production audit reports zero, this criterion fails.

The same audit reports the more serious lifecycle defect: `lifecycle.ts` is 2,510 physical lines
with no accepted ledger entry. POD-1396's tracker stage cannot repair an immutable candidate; its
cut was deliberately reset out after two oracle regressions. A new candidate must contain the
actual cut, preserve the full 45-file sessions oracle, and make the god-object audit report zero.

### POD-1470 blocks

N5b is an open defect, not accepted risk. The repair standard is already written and remains:

1. Give actor and write-scope violations distinct diagnostics and independent single-clause
   fixtures.
2. Arm 1: replay the exact N5b deletion and observe a nonzero result for write scope.
3. Arm 2: leave the check intact, ship a reaction declaring `writeScope: all` through the
   composition root, and observe runtime refusal.

A fixture that violates actor and write scope together does not close the defect. If neither arm
can fail, the clause has no observable behavior and must be reported as such.

### Candidate and process work

A passing successor needs all of the following in one named tree:

- close the actual open Phase 4 children, or explicitly reparent genuine nonblocking discoveries
  out of the phase so “all children closed” is measurable rather than interpretive;
- land the lifecycle decomposition and POD-1467 repair, then obtain zero god-object items;
- regenerate and commit both composition documents after the last module-moving merge;
- land POD-1470 and replay N5b with both required arms red;
- retain the green 45/513 sessions, 10/36 E2E, authenticated restart, environment-neutrality and
  multi-instance results.

Only then may this gate unblock Phase 7 together with G5 and G6.
