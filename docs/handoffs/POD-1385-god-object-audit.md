POD-1385 report — the audit half is done and verified; the decomposition half is filed, not finished. Read the LIMITS section before you treat this as gate evidence.

TIP SHA: d34e7b9d (branch issue/1385-finish-server-module-decomposition). Integration 89b24118 IS merged, as instructed.

WHAT I DID NOT DO, FIRST. I did not decompose lifecycle.ts or messages/service.ts. The issue is titled "finish server module decomposition" and I am delivering the audit, 24 written exceptions, and four filed targets — not the cuts themselves. Reasons, in order of weight:

1. Your own sequencing. Both flagship targets are in modules/sessions/ or adjacent to it, you told me modules/sessions/ has a live neighbour (POD-1386's ~59 lines in command-ctx.ts), and you said to merge integration and read what arrived BEFORE moving anything there. Those messages arrived while I was mid-session; 89b24118 is now merged, but reading what arrived and then restructuring 2955 lines on top of it is not something I was willing to start and half-finish.
2. Neither flagship has characterization coverage for the seams I would cut, and you were explicit that this is a reason to write the coverage first rather than to proceed carefully.
3. Doing a 2955-line restructure in the tail of a session, on top of someone's pending additive change, is precisely the shape of the two defects you said existed in NEITHER branch alone.

So: four sub-issues, each carrying the seam I identified and the hazard I found. POD-1396 lifecycle, POD-1397 messages, POD-1398 issues/registry, POD-1399 handoff/coordinator.

THE INSTRUMENT. scripts/audit-god-objects.ts + .test.ts, "bun run audit:god-objects", modelled on audit-durable-classes.ts as you asked — same Finding shape, same probe-runs-unconditionally-first structure, same package.json "--probe && audit" convention.

The definition it encodes, taken from the criterion rather than from the number: an audit item is a production module over 600 physical lines that is either UNDECOMPOSED (no argument) or UNEXPLAINED (an argument that is not checkable, is stale, or has stopped being true). 600 physical lines because that is exactly the screen POD-425 ran, so the audit's population and the gate's screen are the same set with no reconciliation step.

Every exception kind pairs a WRITTEN ARGUMENT with a STRUCTURAL PREDICATE the audit re-derives from source each run, because prose cannot notice that the file it describes changed underneath it:

  type-declarations      zero runtime exports
  declaration-table      no exported class, no owned state, named table export present
  composition-root       the single root, and the construction-order record still reports 0/0/0
  documented             code lines (comments stripped) under the threshold
  operation-surface      one class, <=2 owned mutable fields, no method over 180 lines
  cohesive-owner         every owned mutable field named in the entry, <=12 of them
  capability-composition no inheritance, every named capability actually imported

RESULT: 28 modules over the line. 24 now carry a reviewed exception whose predicate holds; 4 are open items. Exit 1.

I want to be clear that exit 1 is the deliverable and not a shortfall I am dressing up. I could have reached zero today by writing four more entries. I did not, because none of the four has an argument that is true, and an accepted explanation that is false is the exact failure POD-425 refused the last candidate over.

THE ONE THAT PROVES THE LEDGER ISN'T A RUBBER STAMP: handoff/coordinator.ts, 616 physical / 421 code. It satisfies the "documented" predicate OUTRIGHT — 421 is under 600, entry accepted, audit green. And that would have papered over a single private method spanning 401 of its 421 code lines, which is effectively the whole module. I refused it on the argument, not the predicate. If you want one thing to spot-check in my work, make it this file.

WATCHING IT REFUSE. You asked for a negative run and said fixture probes are not enough. Both were done.

Fixture level: --probe plants a violation for every check and requires it to fire on the dirty fixture and spare the clean one; it runs unconditionally before every audit, and exits 2 if any check cannot say YES. It has already earned its keep — when I tightened the declaration-table predicate, the probe immediately failed on my own stale fixtures.

Real tree, 5 mutations, each reverted, tree verified clean after:
  1. 3 owned mutable fields added to store/issues.ts   -> predicate-failed, "holds 3, 2 is the ceiling"
  2. a runtime export added to store/types.ts          -> predicate-failed, "now exports 1 runtime symbol"
  3. sessions/session.ts truncated to 399 lines        -> stale-ledger-entry
  4. construction-order record set to "Forward dependencies: 3" -> composition root loses its exception
  5. population glob broken (src -> srcTYPO)           -> test suite fails 2 of 19, CLI throws

Number 5 is the one you actually asked about — an auditor going green the day someone breaks its glob. It is caught without a dedicated rule: an empty screen leaves all 24 accepted entries defending files the audit cannot see, and every one of them reports.

REPORTING A NEGATIVE RESULT HONESTLY: my FIRST attempt at mutation 1 added only ONE field and the audit correctly stayed silent, because the ceiling is 2. I had a green fixture probe at that point and would have been entitled to call the instrument proven. The real tree is what showed the mutation was too weak to prove anything. That is recorded in the doc.

COMPOSITION / CONSTRUCTION NUMBERS — UNMOVED, and here is why that is CORRECT rather than merely current:

  composition graph:   178 modules / 286 edges / 0 cycles   (exit 0)
  construction order:  52 declarations / 0 forward / 0 deferred / 0 late binding  (exit 0)
  reactions ledger:    25 reactions  (exit 0)

Identical to your baseline. This is the expected value, not a coincidence I am reporting as a pass: `git diff --stat c0902647..HEAD -- apps packages` is EMPTY. This branch adds no runtime module to apps/server/src — the instrument lives in scripts/, which the composition graph does not walk. If these numbers had moved, that would have been the anomaly.

For the same reason the ambient-principal constraint is satisfied by construction rather than by measurement: no production file changed, so the FIRST_ADMIN_USER_ID count cannot have risen. (My grep scope gives 77 repo-wide non-test, which differs from your 84 — different scope, and the delta is provably zero either way.)

ON YOUR RATCHET WARNING, which changed the design: you said prefer a baseline recording WHY each file is where it is over one pinning today's numbers. Each entry does carry a physical-line budget, but set 15-25% ABOVE reviewed size, and I widened relay.ts to 2300 specifically so POD-1386's dispatch arm cannot trip it. The budget only catches growth large enough that the reviewer's model of the file is gone; the KIND PREDICATE is what catches a module changing shape. There is deliberately no --update flag — regenerating budgets from the tree is how growth gets laundered into an accepted baseline.

relay.ts: NOT touched, per your instruction. It is in the ledger as composition-root, which is a written exception rather than a restructure, so it does not collide with POD-1386's arm. Its predicate is external: if the construction-order record stops reporting 0 forward / 0 deferred / 0 late binding, the root loses its exception automatically. Mutation 4 above verifies that.

TEST COUNTS.
  Baseline, before any change, at c0902647:
    unit    651 files passed | 3 skipped (654) — 9406 tests passed | 20 skipped (9426)
    web     183 files passed (183) — 1460 tests passed (1460)
    mobile  4 files passed (4) — 34 tests passed (34)
  After, at dd97e28b (PRE-merge): unit 652 files passed | 3 skipped (655) — 9425 tests passed | 20 skipped (9445).
    Delta vs baseline is EXACTLY +1 file and +19 tests, which is my suite and nothing else. No existing test changed state.
    Be precise about what this run covers: it STARTED BEFORE I merged 89b24118, so it does not include your merge.
  New suite: scripts/audit-god-objects.test.ts, 19 tests, all passing — run three times, including after biome reformatting. 2 of 19 fail under the broken-glob mutation.
  typecheck: 22/22.

A CAVEAT ON THAT TYPECHECK NUMBER, because it is weaker than it looks and I would rather you hear it from me: NO tsconfig project in this repo includes scripts/. Root tsconfig.json is "files": [] with no include and no references, and nothing under apps/, packages/ or tooling/ lists a scripts path. So "22/22 green" does not cover my instrument — and it does not cover audit-durable-classes.ts, audit-scoped-feed.ts, audit-machine-grants.ts or the composition/construction generators either. Worse, adding a file to scripts/ CAN force a full 22/22 uncached run (package.json is a turbo task input), so the gate looks like it covered the new file when it did not. I verified my instrument is type-correct by pointing tsgo at it explicitly with tooling/tsconfig/node.json: exit 0. Filed as POD-1401 with a discovered-from edge to POD-1385; it affects the instruments the gate cites, so it is worth someone's time independent of me.

WHY THE FULL-SUITE RESULT IS NEARLY IRRELEVANT HERE, and I would rather say so than lean on it: `git diff --stat c0902647..HEAD -- apps packages` is EMPTY. This branch is 4 files — the instrument, its test, one package.json line, one doc. No production code path can have changed. The load-bearing evidence is the baseline being green, my new suite passing, and the diff being what it is.

WHAT I'D WANT REVIEWED. The kind vocabulary is mine and it is the load-bearing judgment in this change. In particular MAX_METHOD_LINES is applied to operation-surface but deliberately NOT to cohesive-owner — applying it there would have overturned steward.ts, an exception POD-355 reviewed and accepted on cohesion grounds, on a criterion that review never considered. That is a judgment call about deferring to a prior review, and you may want it the other way.

ON PRESERVING THE ONE-STORE CAPABILITY COMPOSITION, which the issue brief named as a constraint: it is intact and I left it alone. Concretely, modules/issues/service/index.ts — the IssueService that composes the six capabilities over the single IssueStore — is 334 lines and does not appear in the screen at all. POD-320's decomposition worked: the composing module is small and the CAPABILITIES are what is large (workflow 1152, core 934, crud 820, reads 738). Those four are ledgered as the capabilities they are, not re-split, because re-splitting a capability that already sits behind its own port adds a module boundary without moving a responsibility.

A consequence worth flagging: the "capability-composition" kind therefore has NO member in the ledger at this candidate. It is exercised by the probe and the tests but nothing currently claims it. That is the correct outcome rather than dead code — it is the kind a composing module would need if one were ever over the line, and today none is, which is the state we want.

Also: I dropped control-flow density as a discriminator after measuring it. It does not work. issues/registry.ts measures 6.0% and sessions/lifecycle.ts — the flagship god object — measures 5.8%. A table whose entries carry per-entry guards branches about as much as a service does.


POST-MERGE VERIFICATION (after merging 89b24118, at d34e7b9d):
  typecheck               22/22, 19 cached + 3 rebuilt, 22s
  audit-god-objects.test  19/19
  composition graph       178 modules / 286 edges / 0 cycles, exit 0
  construction order      52 declarations / 0 forward / 0 deferred / 0 late binding, exit 0
  reactions ledger        25 reactions, exit 0
  god-object audit        4 items, exit 1 (unchanged by the merge)
I did NOT re-run the full unit lane after the merge; the 652/9425 figure predates it. Your own verification of 89b24118 (89 passed / 2 skipped, typecheck 22/22) plus the five gates above is what I have for the merged tree.

YOUR MERGE MADE THE CONSTRUCTION-ORDER DOC STALE AND I REGENERATED IT. Why the new values are CORRECT and not merely current, checked mechanically rather than eyeballed: 52 rows before and after with identical ordinals; ZERO rows changed name or dependency set; all 52 line numbers moved by EXACTLY +5. A uniform shift with no semantic change is the signature of a pure insertion above the construction block. The headline stays 52 / 0 / 0 / 0 because POD-1386 added a dispatch ARM, not a service DECLARATION, and an additive arm introduces no construction edge. Had the regeneration laundered a real change, a dependency set or the count would have moved. Neither did. (+5 rather than +48 because the other 43 lines landed below the last tracked declaration — consistent with an arm at ~line 1476.)

ON YOUR POINT ABOUT WHAT A LINE COUNT CANNOT SEE — this was the most useful thing you sent me and I acted on it in commit d34e7b9d. The instrument header and the doc now open with what the audit is BLIND to, naming three shapes that are all real in this tree today:
  1. a module owning async work that outlives its owner — POD-1390's find, SessionRegistry.dispose() never touching modules.memory, a one-line fix no line count would ever surface;
  2. protected state shared by reference across a boundary — observationLeases is a raw Map that THREE modules read and write (lifecycle, repository, daemon-lifecycle). Recorded on POD-1396 with an explicit warning not to move the terminal-proof methods out while leaving the Map shared, which would make my audit greener and the design worse;
  3. a split that only looks like one, since each half is measured alone.
It also says plainly that lifecycle ownership has NO instrument at all today, and that this audit is one of four inputs to the criterion and the weakest of them: it proves an argument EXISTS, not that the argument describes a good design. Please do not let the gate quote a green here as "decomposition is sound" — the doc now refuses that reading in its own words.

BUDGET DESIGN VINDICATED BY YOUR OWN MERGE: relay.ts went 2026 -> 2072 and its ledger budget of 2300 absorbed it with NO finding and no re-baseline. That is the loose-budget choice you argued for, working.

relay.ts: untouched, and I will not touch it until you tell me POD-1390's line has landed.