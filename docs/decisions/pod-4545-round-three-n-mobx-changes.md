# N1a MobX change exercise (`POD-4592`)

I did not build this arm. I read only `packages/worklist-proto/arms/mobx/README.md`
before opening any arm code, wrote expectations first (NOTES.md, committed as
`N1a: README-only expectations for A/B/C2/D`), then read the code. Each change
was implemented on its own throwaway branch (`n1a-a-snooze`, `n1a-b-continuation`,
`n1a-c2-lanes`, `n1a-d-blockedby`), validated until the L4b gate, the fences and
parity passed or the change's nature closed the question, saved as a diff under
`docs/decisions/pod-4545-round-three-n-mobx-diffs/`, and reverted. The arm is
byte-identical to before (`git diff 4bea684b6 HEAD -- packages/` empty);
branches remain as the work log. Box load was 5–13 throughout (sibling sessions
testing alongside), so every verdict below rests on counts, never walls
(methodology §5.7). Gate runs were foreground with a timeout throughout, after
one coordinator reminder (NOTES.md §incident).

## Table 1 — changes (A/B/C2/D)

| Change | Files touched | Lines +/− | Places you must remember (clean-tip file:line) | First-attempt parity | First-attempt fence | What told you when it failed | Time |
|---|---|---|---|---|---|---|---|
| A snooze: `snoozedUntil` hides the row while `coarseNow` is before it; the crossing tick re-admits it | `shared/src/slice-types.ts`, `pool/worklist/visible.ts`, `pool/pool.ts` (3 files) | +50/−3 | `slice-types.ts:46` (`deferUntil` anchor — the new field sits beside it); `visible.ts:234` (`standingOf`, pure ms), `:624` (`flatPartOf` gate), `:661` (`presentPartOf` gate); `pool.ts:1013` (`syncWorklist` roots — armed rows hold nodes); `clock.ts:64` (`reached`, the only clock channel) | PASS (fixture parity green first try — no corpus row carries the field; oracle field test green) | PASS (`fences MobX pool` green every scenario; `counts` #1–#4 green) | n/a (arm code unchanged after the first validation run; four probe-harness misfires were test-side: nested `tracked()`, pre-settle baseline, missing `locals.flush()`, non-leaf target) | 83 min elapsed (hands-on ~50 incl. ~15 min stash-incident repair; two 22-min gates, one discarded per coordinator) |
| B continuation line: `continued · <ref>` from the `discoveredFrom` edge, null otherwise | `shared/src/row-view.ts` + 2 shared test literals, `shared/src/instrument/reads.ts`, `harness/src/oracle/row-views.ts`, `pool/views.ts`, `pool/models.ts`, `arms/hand/pool/views.ts` (stub) (8 files) | +65/−0 | `row-view.ts:185` (`originTick`, the pattern), `:310` (`sliceRowOf` drops the field); `views.ts:77` (`IssueParts`), `:356` (`originTickPartOf`, the channel), `:421` (`directParts`), `:479`/`:493` (`buildRowView`); `models.ts:101` (`IssueModel`), `:104` (annotation map); `reads.ts:168` (copy vocabulary); oracle `row-views.ts:82`; hand `views.ts:434` (stubbed assembly); `gate.test.ts:625` (oracle field list, does NOT cover the field) | PASS (sliceRowOf drops it — parity by construction; oracle test green) | PASS (origin repo move WEB-6→POD-6 re-derives exactly the visible spin-offs + the visible origin; `rowsDerived` == changed) | n/a (typecheck green first try; one probe misfire: picked a spin-off whose origin is resident but not visible — suspended computeds re-run on read without committing) | 35 min elapsed (hands-on ~15; one 22-min gate) |
| C2 worktree rows: `lane:<path>` rows for lanes seating sessions but no issues, in the same list and groups | `pool/worklist/visible.ts`, `pool/pool.ts`, `pool/worklist/groups.ts` (type only), `pool/views.ts`, `pool/rebuild.ts`, `pool/enumerate.ts`, `pool/react/list.tsx`, `pool/native/list.tsx`, `pool/gate.test.ts` (view resolution) (9 files) | +402/−29 | `visible.ts:1160` (collection), `:1257` (order), `:1313`/`:1356` (add/drop), `:1374` (ensure); `pool.ts:538` (groups node channel), `:660` (`issue()`), `:1013` (sync), `:1146` (`snapshot`); `rebuild.ts:79`/`116`; `enumerate.ts:73` (enumeration rule); lists `:81`/`:88` and `:35`/`:42` (slot branch, same components); `gate.test.ts:424` (whole-view reader) | FAIL by design: extra 33 lane rows (+3 lane-only groups), missing 0, changed 0 (`seed 1: step -1 diverged from the oracle: rows extra (33)…`) | FAIL by design: `#1 unrelatedHeartbeat: row set differs: missing [] extra [lane:…]` (the fence sees the second kind and names it); `counts` #1–#4 PASS (lanes static); fence-lint PASS | the gate's oracle diff text + the fence's row-set assertion, both quoting lane ids | 53 min elapsed (hands-on ~30; L4b core 22-min gate + fast suites) |
| D blockedBy relation: `blocked-by` edges over `deps` with inverse `blockedByOf`; the row view reads the inverse (`blocksCount`) | `shared/src/schema.ts`, `shared/src/row-view.ts` + 2 shared test literals, `shared/src/instrument/reads.ts`, `harness/src/oracle/row-views.ts`, `pool/views.ts`, `pool/models.ts`, `arms/hand/pool/views.ts` (stub) (9 files) | +84/−0 | `schema.ts:619` (`spinOffs`, the anchor pair); `pool/relations.ts:132` (`relationRef`), `:159` (`linkInputs`) — READ, never touched; `views.ts:77`/`493`; `models.ts:101`/:104; `row-view.ts:185`/`:310`; oracle `:82`; `reads.ts:168`; hand `:434` | PASS (sliceRowOf drops it; oracle test green) | PASS (dep add: changed == [blocker], `rowsDerived` == 1; withdrawal detaches both directions) | n/a (typecheck green first try; schema + relations suites 89/89 with zero engine changes — the headline result) | 29 min elapsed (hands-on ~10; one 22-min gate) |

## §2 Expectations (README-only) vs where things actually went

- A: expected schema decl + views band part + visible membership + clock deadline + rebuild. Half-right: there is NO schema declaration possible (no `IssueWire` property exists to cite, and `schema.test.ts` fails invented citations by design — a genuinely new input is model-first work outside the arm). `bandOf` untouched (hidden rows have no band). The real split the README recipe does not name: row FIELDS live in `views.ts`, membership lives in `worklist/visible.ts`, and the POD-4705 node closure (`pool.ts` roots) must retain rows that time alone can show — I added armed-row retention during initial coding from code reading, and the replace+wake probe proved it load-bearing (a snoozed leaf dropped at a `replace` never wakes without it).
- B: expected RowView field + target part + origin-fields part + assembly + computed + annotation. Right in full, including the annotation discipline. UNDERESTIMATED the fan-out: the oracle projection, the copy-sweep vocabulary, 2 shared test literals, and the OTHER arm's assembly all break typecheck on a contract field — none named in the recipe. The gate's oracle field list does not cover the new field (fidelity gap, coordinator call).
- C2: expected node kind + groups + both lists + contract mapping + rebuild, parity fail by design. Right about the shape (9 files, biggest change) and wrong in two details: (1) no `groups.ts` logic change — filing is id-opaque, only the host.node TYPE widened; (2) the membership rule I chose (bucket sizes, not visibility-coupled) keeps lanes fence-cheap, at the cost of repo-root lanes appearing too (same rule, recorded). The checker gap (arm gate reads views via `pool.issue`) cost one arm-side line.
- D: expected schema-only + consumer, `relations.ts` untouched or FINDING. Right exactly: the engine resolves edge specs generically, 89/89 schema+relations tests green with zero engine changes. The PITFALL did not fire.

## §3 What the exercise surfaced beyond the diffs (ranking evidence, R1/R2)

1. **The README's "How to add a field" recipe covers row fields, not membership and not relations.** A newcomer following it for A lands in the wrong file (`views.ts` instead of `visible.ts` + `pool.ts` roots); for D it gives no hint that schema addition is free but the oracle, the copy vocabulary, the shared test literals and the other arm all move. Cost-to-change lives in the fan-out the recipe does not name.
2. **Time-dependent hiding needs node retention past hidden** (A): the lazy closure's invariant ("present or keeping or parent-held") silently drops rows that time alone can show. The fix is 2 lines per roots site, but finding it needs the closure's mental model — a second place to remember.
3. **Second row kinds need checker support** (C2): snapshot-vs-rebuild held lanes with no changes, but the whole-view reader (`pool.issue` only) and the oracle baseline both assume one row kind. The fence, to its credit, fails LOUD on lanes (`missing [] extra [lane:…]`).
4. **Contract fields fan out to both arms + oracle + vocabulary + shared tests** (B, D: 8–9 files, all additive). The hand-arm stubs keep the package green while diverging semantically — no gate compares across arms. A real landing pays the hand arm's own part twice (once per arm), plus a gate-list update for fidelity.
5. **Present-gated attention zeroes hidden rows' views** (A probe): hiding re-derives exactly the hidden row (`rowsDerived` +1, all other views identical). Unobserved+invisible origins move cost nothing committed (B probe) — suspended computeds re-run on read.
6. **Process, for the record.** (a) Two `edit` calls with near-identical old/new strings mangled a line each (`bandOf` join, `IssueNode` join, a duplicated GroupsHost pair) — caught by re-reading the diff before every commit; the tool rewards unmistakably-different replacement blocks. (b) `git stash` on a clean tree popped another session's entry and conflicted — repaired to byte-identical (stash stack untouched), recorded in NOTES.md; baselines via `git show HEAD:<path>` from then on. (c) Probe-harness traps for the next exerciser: never wrap `snapshot()`/`rebuildFromScratch()` in `tracked()`; baseline views AFTER settle; `locals.set()` needs `flush()`; pick targets by observed properties (leaf, visible origin, active-human base).

## §4 Revert and green

Every scratch branch was abandoned after its diff was saved (`git apply --check` passes on all
four patches); the issue branch holds only the record: NOTES.md, the table doc (this file),
and the four patches. `git diff 4bea684b6 HEAD -- packages/` is empty (arm byte-identical,
both arms, shared, harness). The four diffs:

- `docs/decisions/pod-4545-round-three-n-mobx-diffs/n1a-a-snooze.patch` (3 files, +50/−3)
- `docs/decisions/pod-4545-round-three-n-mobx-diffs/n1a-b-continuation.patch` (8 files, +65/−0)
- `docs/decisions/pod-4545-round-three-n-mobx-diffs/n1a-c2-lanes.patch` (9 files, +402/−29)
- `docs/decisions/pod-4545-round-three-n-mobx-diffs/n1a-d-blockedby.patch` (9 files, +84/−0)

Focused suites green after the revert (single end-of-task run on the clean tree —
load ~7, counts only): `schema` + `row-view` + `row-contract` + `relations` +
`counts` in one lane: 115 passed; `fences MobX pool` 1 passed; `fences roster`
1 passed; `fence-lint` 29 passed; L4b `gate.test.ts` 2 passed (defaults 3×200
plus all plants, ~22 min foreground); `typecheck --filter @podium/worklist-proto`
8/8. The `bun run test` lean gate was not run: the landing is documentation plus
four inert patch files (nothing compiled, nothing imported), and the arm is
proven byte-identical below — the focused suites above are the proportionate
evidence, per the brief's skip clause.
