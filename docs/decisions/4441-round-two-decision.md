# Round-two decision: the MobX tracked object graph is the shape of the rewrite (POD-4459, re-decided against the quiet numbers)

Status: decision document for POD-4441 · applicants: the three round-two arms on
`integrate/4441-round-two` · plan of record: methodology rev four · re-decision
owned by this issue against the quiet-window re-run, which tripped the
provisional section's own reopen condition and is now folded in.

## Reading conventions, stated once

A *term* below is explained where it first appears; the vocabulary table follows the
recommendation. A *table* carries every measured figure with its source named beneath
it; the prose between tables describes and points but states no figure. Strings of
digits that do appear in prose are identifiers, not measurements: issue references,
scenario labels, methodology section numbers, and file pointers. A *pointer* of the
form `path:line` names evidence; it asserts nothing by itself. *Counts carry the
verdict; walls are now real where the quiet-window re-run measured them and
stay provisional only where it names a gap*: the M2 hot-path walls, the growth
walls except where withheld, and the click walls are verdicts; the lifecycle
walls and the named withheld cells are not. Which conclusions the remaining gaps
could still change is stated where the quiet tables appear.

A final convention on counting units. The three arms count different units inside
their derivations: the TanStack arm counts query-function evaluations, the MobX arm
counts settled derivation bodies, the hand-rolled arm counts delta-handler runs. Raw
derivation counts are therefore never compared across arms in this document. The
shared currency is *rows committed*: rows whose committed snapshot changed on a
scenario step, measured identically everywhere by the same harness fence, flat in all
three arms. Per-arm derivation bodies appear only inside a per-arm table marked
not-comparable, never in a cross-arm comparison.

## Recommendation

Rewrite the frontend read model as a MobX tracked object graph, following the
POD-4447 arm as built — re-affirmed under shared performance failure, not
restated past it.

The quiet-window re-run tripped the provisional section's own reopen condition:
every arm exceeds the hot-path and click wall budgets under quiet conditions,
so every arm fails the performance gate regardless of its counts, and the MobX
overrun reopened this recommendation. The re-decision below weighs the three
things now in tension rather than defending the earlier line.

Safety still points at MobX and the re-run touched nothing there: the
render-path mistake that made the current application slow is loud in this arm
and silent in both others, verified by planting the defect in each arm, and the
safety standing does not depend on walls.

Walls now point at the hand-rolled arm, plainly and by a clear margin: it is
fastest on the hot path in both pipeline and wall-to-paint medians, and it is
the only arm with no long tasks at all on the rename step. The quiet tables
name the gap; the winner's downside names what MobX costs in exchange.

No arm passes the performance gate, so a gate that everything fails cannot by
itself select between the arms — but it can disqualify, and the answer is split.
The shared absolute miss does not disqualify the two arms inside the bundle
budget, because the budget was set too tight rather than all three approaches
being unusable: the legacy control the arms replace misses the same hot-path
and click lines by a far larger margin while committing the visible set on
steps the arms commit a single row or nothing, so a line that disqualifies all
three survivors disqualifies the status quo by an order of magnitude more and
prices paint, collection, and cold-start shape rather than approach. What does
disqualify is approach-specific: the TanStack clock finding the document said
would convert on a quiet reproduction has reproduced — engine re-run cost with
no commits and no long tasks, against a control tick that pipelines near
nothing — and it joins the standing bundle overrun and the slowest hot-path
walls to keep that arm third. Between the remaining two, the constant-factor
wall lead does not overturn the detector lead: the hand arm buys speed today at
the cost of silence on exactly the failure class that created the rewrite need,
with no demonstrated fence to replace the detector, while the MobX wall costs
are bounded, commit-free, and priced in the winner's downside.

This recommendation survives only with the withheld gaps stated alongside it:
the named unmeasured cells, the lifecycle walls with no browser method, and the
pending live-corpus re-runs for the keeper-evict steps could
still change the standing as listed, and the hand arm becomes eligible on a
demonstrated render-path fence with the same can-say-no proof burden the
document already places on it. Every quoted wall is as-of the measured revision;
the staleness table in the quiet verdict section says which conclusions survive
the re-runs and which are probably-stable.

## Vocabulary on first use

| Term | Meaning |
|---|---|
| Arm | One complete first-principles implementation of the slice: hand-rolled, MobX, or TanStack DB |
| Slice | The frozen vertical cut all arms build: three entity types, four relations, about eight rules, three components (spec) |
| Parity oracle | The current derivation run on the same fixture; the executable spec each arm must match row for row |
| Rows committed | Rows whose committed snapshot changed on a scenario step; the cross-arm currency |
| Derivation body | One run of one derivation function; counted in arm-relative units, never compared across arms |
| Isolation fence | The harness check that an unrelated change commits no rows; the legacy control must fail it |
| Commit log | The per-row render-commit record the fence reads; mount and unmount phases are excluded by design |
| Over-commit check | The proof that every committed row is a row the oracle also changed |
| Slope | Per-event cost at the largest corpus relative to the smallest, divided by the corpus multiple; the budget is near-flat |
| Corpus scales | The live-shaped fixture at single, double, and quadruple issue counts |
| Foot-gun | A planted developer mistake testing whether an arm stays silent or fires |
| Change exercise | Realistic future changes implemented by a developer who did not build the arm, then reverted |
| Loud / silent | Whether the mistake surfaces as a thrown error, failing test, or failing lint, or passes everything green |
| Never-check | The hand arm's exhaustive switch over its closed delta union plus a compile-time unreachable marker |
| Observer row | A MobX-tracked component that subscribes exactly to the fields its render read |
| Live query | A TanStack DB reactive query whose output is itself a watched collection |
| Rollup | The recursive subtree aggregate: progress, working state, and ask state up the ancestor chain |
| Seat / bucket | A maintained relation index entry: which children, sessions, or members belong to a row |
| Write-path sketch | A bounded spike of one optimistic edit through an arm's own write idiom, judged on semantics not speed |
| Coexistence | One kernel feeding the arm screen and the legacy sidebar side by side with neither waking the other |

## Gate table

Sources: foot-gun rows from the three exercise documents; counts and slopes from the
milestone measurement notes; walls from the quiet-window re-run as verdicts;
bundle from the same-build production bundle comparison.

| Gate | Hand-rolled arm | MobX arm | TanStack DB arm |
|---|---|---|---|
| Safety: every planted mistake loud | FAIL: the render-path scan stays silent | PASS | FAIL: the render-path scan stays silent |
| Performance: budgets at live corpus plus slope | FAIL: hot-path and click walls over budget under quiet conditions; counts and count-slope pass; lifecycle walls and named cells still withheld | FAIL: hot-path and click walls over budget under quiet conditions, which reopens the recommendation and is re-decided here; counts and count-slope pass; lifecycle walls and named cells still withheld | FAIL: bundle over budget, self-declared, plus hot-path and click walls over budget under quiet conditions and the quiet-reproduced clock engine finding; counts and count-slope pass; lifecycle walls and named cells still withheld |
| Fidelity: parity on all scenarios, lifecycle green | PASS | PASS | PASS |

The failing item is named in each cell. Detail per gate follows in the gate sections.
No gate result is averaged across scenarios and no miss is smoothed: each FAIL names
the single item that caused it.

## Ranking table

Source: change-exercise documents for effort, milestone notes for slope and bundle,
quiet-window re-run for walls.

| Rank | Arm | Standing | What decides it |
|---|---|---|---|
| First | MobX | Passes safety, fidelity, bundle, counts and count-slope; fails the shared absolute wall budgets | Sole safety passer; smallest change diffs on the comparable changes; bundle inside budget; wall costs bounded and priced against a control far worse still |
| Second | Hand-rolled | One safety gate failed plus the shared absolute wall miss | The render-path silence; otherwise the cheapest bundle, the fastest quiet walls with the only zero-long-task rename, and a compile-time exhaustiveness check the others lack |
| Third | TanStack DB | Two gates failed plus the quiet clock engine finding | The render-path silence plus the bundle overrun plus the slowest hot-path walls and the reproduced engine-cost tick; the fastest large-change time but the largest diffs |

The ranking among survivors is decided first by the change exercise, then by growth
slope, then by bundle and heap. All three arms tie the slope on counts, so the change
exercise and the bundle decide. The quiet-window re-run has now contradicted the
withheld walls as the provisional section allowed: the performance standing no
longer selects on the absolute budgets, which every arm including the control
misses, but selects on the approach-specific findings — the TanStack engine-cost
tick and bundle weight against it, the hand wall lead for it, the MobX detector
lead for the winner; the safety standing never depended on walls.

## Safety gate: the foot-gun table

The quiet-window re-run touched nothing here: it measured walls and corrected
commits, planted no defect, and changed no arm. The render-path divergence below
was verified by planting the defect in each arm, and stands as the safety lead
the recommendation rests on.

Each planted mistake is described once; the per-arm column states what the screen
showed and what fired. A *probe* is the intended-behavior test the examiner wrote for
the change; an *existing test* is one the arm already carried; the *oracle* is the
parity or rebuild check.

| Gun | Hand-rolled | MobX | TanStack DB |
|---|---|---|---|
| Omitted bookkeeping for a new time-dependent input | LOUD: the never-check fails compilation when the new kind is added unhandled; the rebuild oracle fires once a tick-plus-input test touches it; the behavior probe fails | LOUD via the behavior probe; no framework warning fires with enforcement on or off, and fixture parity stays green because the corpus carries no such input | LOUD via the behavior probe; typecheck, unit tests, interface tests, and fixture parity stay green, with no self-healing on later events |
| Forgotten index cleanup on eviction | LOUD: the existing rescue-keeper unit test fails and the rebuild oracle names the ghost parent; the milestone gate stays green because the specced evict removes no keeper | LOUD: the existing bucket-disposal unit test fails; rendered output stays correct because every bucket read guards on its table | LOUD via the kept sole-asker probe; typecheck, unit tests, fixture parity, interface tests, and the milestone gate stay green because the specced evict removes no sole asker |
| Whole-corpus scan hidden inside one row component | SILENT everywhere automated: typecheck, unit tests, interface tests, and parity green; commit assertions unchanged; no component lint exists in the arm; full-render cost at live corpus is on the order of a hot-path budget by itself and grows with the corpus (Node micro-calc) | LOUD: the exact-commit assertions catch it, with an untouched sibling row committing while its row object stays identical; typecheck, lint, and parity stay green | SILENT everywhere automated: typecheck, unit tests, interface tests, parity, and the milestone gate green with every count identical; no component lint exists in the arm; full-render cost at live corpus is an order of magnitude above the hand arm and grows quadratically toward the largest corpus (Node micro-calc) |

Sources: hand exercise document, MobX exercise document, TanStack exercise document;
kept probe diffs under the three per-arm diff directories. Micro-calc tallies:
hand render cost and TanStack render cost at the three corpus scales, per the K
notes.

Three qualifications the table does not hide. First, the omitted-input row is loud
in all three arms only where a behavior test on an input-shaped corpus exists; the
fixture corpus carries no such input, so parity never covers it, and the MobX and
TanStack arms provide no framework signal beyond the test. The hand arm additionally
fires at compile time when the new input kind is added unhandled, before any test
runs. Second, the eviction row is loud in all three arms only with the corpus-shape
qualifier: the specced scenario-six evict removes neither a keeper nor a sole asker,
so the milestone gate stays green on the defect branch in every arm. The methodology
expectation needed that qualifier until the keeper-evict variant landed and chose
for it: the variant seeds its own keeper pair with arming proved both directions
at the small corpus, green identically on all three arms with live-corpus re-runs
filed separately. Third, the render-path row is the one place the
three genuinely diverge on safety, verified by planting the defect in each arm: the
MobX commit set grows, the hand and TanStack checks stay green. The mechanism is
honest in both directions: the MobX observer subscribes every row to every row read,
so the scan re-renders all rows and the fence prices each re-render; the hand row
reads the store without subscribing and the TanStack row reads committed state
without subscribing, so no commit signal exists to catch. The MobX finding carries
its own two qualifications: what fires is the render-commit log, not the derivation
counters, so a suite without exact per-row commit assertions on a subtree change
would stay blind; and per-commit processor cost remains invisible, so a variant that
re-renders without committing would go quiet again. The fence prices what
re-rendered, never how much each re-render cost.

Safety verdicts follow mechanically. The MobX arm turns every planted mistake into a
thrown error, a failing test, or a failing lint: PASS. The hand-rolled arm leaves the
render-path scan silent with no check named in-arm that would catch it: FAIL on that
item. The TanStack arm leaves the same scan silent with no check named in-arm that
would catch it: FAIL on that item.

## Safety gate: what each arm would need

| Arm | To pass safety | Standing of the fix |
|---|---|---|
| Hand-rolled | A component-enumeration rule or render-path fence with a proven can-say-no demonstration | Not named in-arm by the examiner; future work, and the demonstration must show the detector failing before it passes |
| TanStack DB | The same render-path coverage, likewise demonstrated | Not named in-arm by the examiner; future work with the same proof burden |
| MobX | Nothing for the gate; carry the exact-commit assertions and bucket-disposal tests into the rewrite as named below | Already in-arm; the enforcement checklist makes them permanent |

## Performance gate, counts half: per-scenario rows committed at live corpus

Cells are rows committed at the single-corpus scenario seed. Budgets are the
methodology scenario budgets. Mount arrivals and departure unmounts are excluded
from commits by RowShell design; the work behind them is order plus one row
derivation. The control column shows the legacy behavior the arms replace. The
eviction row below predates the keeper-evict variant: the live-corpus counts gain
two steps per arm with re-runs filed separately, and the arming is green
identically on all three arms at the small corpus with existing steps unchanged
there.

| Scenario | Budget | Hand | MobX | TanStack | Control |
|---|---|---|---|---|---|
| Unrelated session heartbeat | 0 | 0 | 0 | 0 | FAILS: commits the visible set |
| Session phase change on a visible row | the row plus ancestors | 1 | 1 | 1 | whole-world derive |
| Selection, engine path | 0 on the engine path | 0 | 0 | 0 | commits on click |
| Selection, mounted click path | 2 with no derivations | 2 with no derivations | 2 with no derivations | 2 with no derivations | whole-world derive |
| Title rename on a visible row | 1 | 1 | 1 | 1 | whole-world derive |
| Stage move across groups | affected rows plus order | 1 | 1 | 1 | whole-world derive |
| New issue | order plus the row | mount only | mount only | mount only | whole-world derive |
| Archive issue | order plus the row | 1, the parent chain | 1, the parent chain | 1, the parent chain | whole-world derive |
| Evict without revision | order plus the row | unmount only | unmount only | unmount only | whole-world derive |
| Parent reassignment | both chains | 2, both chains | 2, both chains | 2, both chains | whole-world derive |
| Coarse clock tick | band-movers only | 0 moved | 0 moved | 0 moved | near zero on the tick itself; its cost arrives with the next engine write |
| Optimistic echo and rejection | like a phase change, no full rebuild | quiet | quiet | quiet | whole-world derive |
| Fifty-event burst | bounded | 21 | 21 | 21 | whole-world derive per event |

Sources: hand milestone-two note, MobX milestone-two note, TanStack milestone-two
note; mounted-click two-row assertions from the shape review; control whole-world
behavior from the harness document and the milestone browser notes. The MobX
small-corpus phase step commits nothing on the current seed because the oracle
itself changes nothing there; parity is green (MobX milestone-three note).

## Isolation detector proof

| Control check | Small corpus | Live corpus |
|---|---|---|
| Heartbeat commits on the legacy control | 39 committed of 37 visible: the detector says no | commits the visible set: the detector says no |
| Heartbeat commits on each arm | 0 in all three arms | 0 in all three arms |

Source: harness document for the control tallies; milestone-two notes per arm.

The burst row commits the identical tally in all three arms; the derivation tallies
beside it use different units per arm and are tabulated separately below, never
compared. The tick row commits nothing in all three arms; the settled re-runs
behind the zero differ by arm and are tabulated the same way. Every committed row
on every step was proved to be a row the oracle also changed: no over-commit in
any arm.

## Arm-relative derivation bodies: tabulated, never compared

The tallies below share no unit across columns. The TanStack column counts
query-function evaluations including retraction-plus-assertion pairs; the MobX
column counts settled bodies observed through mounted reactions; the hand column
counts delta-handler runs. They are recorded here for traceability so no figure
in the milestone notes lacks a home, and they feed no verdict.

| Step at the single-corpus scenario seed | Hand bodies | MobX bodies | TanStack bodies |
|---|---|---|---|
| Title rename | row plus handler runs beside it | row plus settled bodies beside it | row plus evaluation runs beside it |
| Stage move | chain plus handler runs beside it | chain plus settled bodies beside it | chain plus evaluation runs beside it |
| Archive | archived row settling out plus the chain row | archived row settling out plus the chain row | archived row settling out plus the chain row |
| Clock tick | re-evaluations with no commits after the sensitivity fix | settled re-runs with no commits | broad function re-runs with value-equal suppression and no commits |
| Fifty-event burst | handler runs beside the identical commit tally | settled bodies beside the identical commit tally | evaluation runs beside the identical commit tally |
| Fixture-corpus boundary-free tick | re-runs with no commits | settled bodies with no commits | contained re-runs with no commits |

Sources: the three milestone-two notes and the MobX exercise claims check. The
cross-arm currency stays rows committed, flat everywhere, per the table above.

## Performance gate, quiet-window verdict: walls, lifecycle walls, and heap at live corpus

The quiet-window re-run measured the same invocations with unchanged flags,
interleaved across arms and scales with the bench lease held per invocation and
per-record load and revision recorded in the driver files. Every number in this
section is as-of the measured runtime revision: the driver records carry it,
and the harness change that landed after measurement is not in it. That change
adds a keeper-evict variant to the eviction scenario in every arm's gate with no
arm source touched; the re-run of the measurement notes it requires is filed
separately and is not attempted here. The hot-path and click walls below are verdicts as-of that revision, not proxies; the lifecycle walls and the named
withheld cells stay provisional as listed.

| Arm | Scenario | actionMs p50 / p95 / max | taskMs p50 / p95 / max | commits | longTasks per twenty | per-record load |
|---|---|---|---|---|---|---|
| hand | rename | 9.6 / 22.2 / 23.3 | 21.1 / 39.6 / 40.9 | 1 | 0 | 5.1–6.8 |
| hand | stagemove | 7.2 / 13.7 / 16.8 | 18.4 / 26.6 / 29.6 | 0–1* | 0 | 5.1–6.8 |
| hand | clock | 2.2 / 3.4 / 3.5 | 12.6 / 20.6 / 23.0 | 0 | 0 | 5.1–6.8 |
| mobx | rename | 16.2 / 57.5 / 131.8 | 27.1 / 83.5 / 161.6 | 1 | 3 | 4.8–8.0 |
| mobx | stagemove | 12.9 / 25.5 / 39.5 | 25.8 / 47.2 / 48.6 | 0–1* | 0 | 4.8–8.0 |
| mobx | clock | 49.3 / 113.2 / 116.8 | 62.7 / 126.5 / 128.2 | 0 | 0 | 4.8–8.0 |
| tanstack | rename | 88.3 / 108.2 / 110.4 | 101.6 / 118.4 / 120.1 | 1 | 18 | 5.9–8.2 |
| tanstack | stagemove | 33.1 / 81.6 / 126.7 | 46.1 / 96.0 / 145.2 | 0–1* | 5 | 5.9–8.2 |
| tanstack | clock | 1529.5 / 2037.3 / 2196.7 | 1537.5 / 2047.3 / 2210.6 | 0 | 0 | 6.4–8.7 |
| control | rename | 190.6 / 260.4 / 264.8 | 199.0 / 276.0 / 286.8 | 346 | 20 | 7.1–8.4 |
| control | stagemove | 192.4 / 330.5 / 434.3 | 204.2 / 341.5 / 522.2 | 346 | 20 | 7.1–8.4 |
| control | clock | 0.0 / 0.1 / 0.2 | 13.8 / 18.0 / 19.5 | 0 | 0 | 7.1–8.4 |

Sources: quiet-window re-run note with its driver files, as-of the measured
runtime revision named above; pooled across both
invocations per cell. The stagemove zero-commit shape is the known fold-blocked
form rotating fresh rows per sample, identical across the milestone notes. The
control clock pipeline near zero is asymmetric by construction: its tick emits
no publication and its cost arrives with the next engine write, as the milestone
notes state.

The per-invocation medians below verify the pooled table against the raw driver
records rather than transcribing it; each invocation holds the same sample count
with scenarios rotating round-robin per sample.

| Arm | Rename wall-to-paint median, invocation A | Rename wall-to-paint median, invocation B | Per-record load window |
|---|---|---|---|
| hand | 20.8 | 21.5 | 5.1–6.8 |
| mobx | 26.4 | 27.1 | 4.8–8.0 |
| tanstack | 97.8 | 105.8 | 5.9–8.2 |
| control | 199.0 | 203.5 | 7.1–8.4 |

Sources: raw driver records from the quiet-window artifact bundle, checked
record by record; pooled medians above match their pool. Wall-to-paint is the
budget's asserted field; the pipeline field beside it separates sync-plus-drain
cost from paint and collection cost.

The prose between these tables points at them without restating them. On the
hot path the hand arm is fastest by a clear margin on both pipeline and
wall-to-paint medians and is the only arm with no long tasks at all on the
rename step; the MobX arm sits in the middle with a small long-task tail on
rename and a clock price several times its own rename; the TanStack arm is
slowest by multiples with most rename records carrying long tasks. The control
misses the same hot-path line by a far larger margin while deriving the whole
world per rename and stagemove against a single committed row on the arms, with
every hot-path record carrying a long task. The TanStack clock with no commits
and no long tasks separates engine re-run cost from frame starvation and
converts, by the provisional section's own rule, from a load artifact into a
TanStack performance finding; against it the control tick pipelines near
nothing. The MobX clock price with no commits confirms the settled-body
re-run tag the milestone note priced. The commit correction stands: the stale
all-zero browser commit tallies are superseded, with the rename committing a
single row per arm against the control's whole-world tally and the clock
committing nothing everywhere.

| Budget | Verdict under quiet conditions | What decides it |
|---|---|---|
| Hot-path event within the main-thread budget at live corpus, wall-to-paint | NOT MET on any arm for rename and stagemove, including by hand | Every pooled wall-to-paint tail sits above the line by multiples; the only sub-line pipeline number is the hand clock, which the budget's asserted field still fails on paint plus collection |
| Row click input-to-paint within budget at live corpus and at the largest corpus | NOT MET anywhere at either scale | Medians sit near the single-scale line but every file carries one slow first click from cold-list warm-up, present on all four pages including the control, which single-handedly sets the tail at the stated sample count |
| Publish on an unrelated change within budget | Carried by counts; wall covered by the heartbeat medians below | Heartbeat commits nothing on every arm against the control's visible-set commit |
| Principal switch within twice the control | Mechanism proved by counts, wall withheld | No browser-harness method exists for it; happy-dom table-equality proxies stand |
| Cold bootstrap within the control multiple | Mechanism proved by counts, wall withheld | Same method gap as above |
| Retained heap within the control multiple, no growth after rescope | Proxy only | Same method gap as above |

Sources: quiet-window re-run note for the hot-path and click verdicts with
their growth medians; milestone-three notes for the lifecycle mechanism halves;
harness document for the budget lines as asserted fields.

| Scale | Arm | heartbeat action p50 / p95 | click input-to-paint p50 / p95 | heartbeat commits |
|---|---|---|---|---|
| single | hand† | 22.8 / 54.1 | 12.1 / 154.6 | 0 |
| single | mobx | 21.6 / 29.8 | 11.3 / 45.9 | 0 |
| single | tanstack | 37.8 / 109.0 | 16.8 / 43.1 | 0 |
| single | control | 88.8 / 138.6 | 14.0 / 138.1 | 346 |
| double | hand | 23.7 / 35.1 | 14.4 / 43.2 | 0 |
| double | mobx | 36.8 / 46.6 | 17.1 / 45.6 | 0 |
| double | tanstack | 53.1 / 123.5 | 13.6 / 49.1 | 0 |
| quadruple | hand | 42.6 / 99.6 | 11.5 / 42.0 | 0 |
| quadruple | tanstack | 93.7 / 200.3 | 12.3 / 48.1 | 0 |

Sources: quiet-window re-run note with its growth driver files. The daggered
hand single-scale row is a quiet subset of three contaminated attempts,
provisional with full count withheld; the MobX quadruple event walls and the
control quadruple walls are withheld as below; the control double row is a thin
provisional subset.

What stays genuinely withheld even in the quiet window, and what each gap could
still change, belongs in the record rather than the drawer.

| Withheld cell | Status after the quiet window | What it could still change |
|---|---|---|
| MobX event walls at the largest corpus | WITHHELD after two contaminated attempts that self-heat | Could reverse the hand-over-MobX relative wall order at scale or show a superlinear blow; the single-to-double medians give no sign of it but the cell itself is unmeasured |
| Control walls at the largest corpus and full count at double | WITHHELD and thin provisional respectively | Could move the wall-slope-against-control comparison at scale; the count slope already carries the verdict and the control commits scale exactly with the corpus |
| Hand single-scale heartbeat and click full count | WITHHELD beyond the quiet subset | Could move the hand click tail but not past the line: the subset already misses by multiples and the cold-first-click shape is present on every page |
| Lifecycle walls — principal switch, cold bootstrap, retained heap, rescope | STILL WITHHELD — no browser-harness method exists for them; the driver covers event walls only | Could reopen the recommendation on its own if the winner misses the control multiples on bootstrap or heap; the mechanism halves are proved by counts meanwhile |
| Phase-split timed shares | Unchanged box-load proxies, not browser numbers | Could settle the server-projection question if a largest-corpus browser split shows rollups dominating there too |

Sources: quiet-window re-run note for the withheld list and the method gap;
milestone-three notes for the happy-dom proxies that stand meanwhile.

What the re-run changed about the conclusions it was allowed to change. Any arm
exceeding the hot-path or click wall budget under quiet conditions fails the
performance gate regardless of its counts, and the MobX overrun reopened the
recommendation: both conditions have now fired on every arm, and the
recommendation above is the re-decision, not the earlier line carried forward.
A wall slope across corpus scales exceeding the budget while the count slope
stays flat would fail the slope on walls; the wall medians scale by low single
digits for a quadrupled corpus while rows committed stay flat, so the count
slope carries and the wall slope prices the named inherent per-read rebuilds
rather than new work. The TanStack clock anomaly reappearing under quiet
conditions with starvation separated from engine cost has become a TanStack
performance finding rather than a load artifact. Nothing the re-run showed
changes the safety verdicts or the bundle verdicts: those rest on counts and
build output, not on walls.

What the later harness change means for the numbers above. The keeper-evict
variant landed after measurement in harness and methodology scope only, with the
arming proved at the small corpus identically on all three arms and existing
steps unchanged there; the live-corpus counts gain two steps per arm and their
re-runs are filed separately. Which conclusions survive those re-runs and which
are merely probably-stable is stated plainly rather than left to inference.

| Conclusion | Survives the pending re-runs, or probably-stable | Why |
|---|---|---|
| Safety verdicts on every planted mistake | Survives | They rest on planted defects, commit sets, and build output, none of which the harness change alters; the new variant strengthens the eviction row's arming without moving its loud verdicts |
| Bundle verdicts | Survives | Build output is untouched by a harness-and-methodology change |
| Fidelity verdicts | Survives | Parity is green on the new steps at the small corpus on all three arms with identical tallies |
| Rows-committed equality across arms on existing steps | Survives at the small corpus; live-corpus re-runs pending | Existing steps unchanged where measured; the new steps are identical across arms by construction |
| TanStack clock engine finding | Survives | No arm source was touched and nothing in the harness change reaches the clock path |
| Relative wall ordering between arms | Probably-stable, not proven | The gaps between arms are multiples and no arm source was touched, but the walls themselves are as-of the measured revision and the re-runs are the proof |
| Absolute wall verdicts against the budgets | Probably-stable, not proven | Same revision caveat: the misses are by multiples, so crossing a budget on re-run is unlikely, but the quoted tails are as-of the measured revision either way |

Sources: the keeper-evict issue with its arming proof and landed commit; the
quiet-window re-run note for the measured revision; the milestone notes for the
existing-step counts.

## Performance gate: growth slopes across corpus scales

Cells are rows committed at the three corpus scales with parity and the rebuild or
over-commit proof green on all twelve steps. Slope is cost at the largest corpus
relative to the smallest on rows committed against the near-flat budget. Issue
tallies across scales are single, double, and quadruple of the live-shaped fixture.

| Scenario | Hand across scales | MobX across scales | TanStack across scales | Verdict |
|---|---|---|---|---|
| Heartbeat | flat at none at all scales | flat at none at all scales | flat at none at all scales | PASS all arms |
| Phase change | flat at the row at all scales | flat at the row at all scales | flat at the row at all scales | PASS all arms |
| Click, engine path | flat at none at all scales | flat at none at all scales | flat at none at all scales | PASS all arms |
| Stage move | flat at the moved row at all scales | flat at the moved row at all scales | flat at the moved row at all scales | PASS all arms |

Sources: hand milestone-three note with its summary file, MobX milestone-three note
with its growth file, TanStack milestone-three note with its growth file. Visible
rows per scale differ slightly between milestone notes because the seeds differ;
the invariant is flatness within each note, not equality of tallies across notes.

Two further honest records sit beside the flat slopes. First, each arm names
corpus-scale cached walks that commit nothing and are therefore invisible to this
table: the hand arm rebuilds the order snapshot per snapshot read; the MobX arm
re-buckets groups per affected change and scans seat maps per ingest; the TanStack
arm rebuilds the order surface per affecting cycle and scans seat maps per ingest.
These processor-only costs now have quiet wall medians beside them in the verdict
section above: walls scale by low single digits for a quadrupled corpus while rows
committed stay flat, which prices the named inherent per-read rebuilds rather than
new work. The slope verdict above stays on counts; the wall slope is stated
alongside it, not withheld for a later run. Second, the MobX largest-corpus wall
cells and parts of the control and hand single-scale cells remain withheld as
listed above; the slope verdict on counts does not need them.

## Performance gate: lifecycle mechanism

| Check | Hand | MobX | TanStack |
|---|---|---|---|
| Cold bootstrap at live corpus | construction snapshots full once, parity and rebuild oracle green | construction snapshots full once, parity green | construction snapshots full once, parity green |
| Principal switch over a fresh replica | fresh store, parity and oracle green, no surviving listeners after dispose | fresh store, parity green, post-dispose publication touches nothing | fresh store, parity green, no surviving listeners and error-silent teardown after dispose |
| Rescope growth then back | tables grow and return exactly, parity and oracle green at every state | literal corpus swap and exact return, parity green at every state | literal corpus swap and exact return, parity green at every state |
| Mobile lane, heartbeat through click | parity and oracle green on all three scenarios | solo semantics match on all three scenarios | parity green on all three scenarios |

Sources: hand milestone-three note, MobX milestone-three note, TanStack milestone-three
note; native lane tests per arm.

Lifecycle verdicts are mechanism PASS in all three arms; the wall and heap halves
are still withheld with no browser method, as listed in the quiet verdict section
above. Corpus notes sit in the table below rather than in
prose; none of them changes a verdict.

| Corpus note | Detail |
|---|---|
| Hand seed | Counts measured on the earlier seed; after the rebase onto the later seed the mount parity fails by an extra row, byte-identical across arms, owned as a fixture-seed matter under its own issue rather than chased per arm |
| MobX seed | Two stale count assertions on the small corpus where the oracle itself changes no rows; parity green throughout; seed-caused and mailed to the coordinator |
| TanStack rescope | Replace tears the live graph down and rebuilds over the new corpus after the join layer threw on bulk reseeds; the retained commit layer still transitions rows incrementally and the lifecycle pin is green |

## Performance gate: bundle

All three entries from the same production build against the same control entry;
the shared engine-plus-harness chunk is common to all pages and is not arm cost.

| Entry | Hand chunk | MobX chunk | TanStack chunk | Control entry |
|---|---|---|---|---|
| Compressed-size delta over control | inside the web budget: PASS | inside the web budget: PASS | over the web budget: FAIL, self-declared | the baseline |
| Native compatibility | mounts in the native lane | mounts in the native lane | mounts in the native lane | mounts in the native lane |
| Dependency status | no new dependency | new production dependency | already a production dependency; the weight is new for this surface | not applicable |

Sources: the three milestone-three notes from the same production build,
reproduced by the quiet-window build with byte-matching chunks.

The TanStack budget verdict is unchanged since the first milestone and is reported
as a finding, not a fix: adopting it ships the incremental-view-maintenance engine
plus the query compiler, and the quiet window now joins it with the slowest
hot-path walls and the engine-cost clock finding. The MobX cost is a new dependency
plus the quiet-priced wall and clock overhead named in the winner's downside; the hand cost is none
plus the uncovered render path. No arm is penalized twice: dependency novelty is recorded here and not re-counted
in the ranking.

## Fidelity gate

| Check | Hand | MobX | TanStack |
|---|---|---|---|
| Parity oracle on every scenario | green | green | green |
| Lifecycle scenarios green | green | green | green |
| Over-commit proof on every step | green via rebuild oracle plus subset proof | green via subset proof; no rebuild oracle by construction | green via subset proof; no rebuild oracle by construction |

Sources: the three milestone-two notes and the three milestone-three notes.

Fidelity verdict: PASS all three arms, with the corpus notes from the lifecycle
section attached and not re-litigated here. One further fidelity event belongs in
this section: the TanStack change-exercise bubbling attempt broke mount parity and
was reverted rather than landed, which is the fidelity process working as designed.
The adjudication of what that attempt means for the other two arms' bubbling
changes follows in the change-exercise section.

## Change exercise: the comparable changes

The bubbling change is excluded from the maintainability comparison for the reason
adjudicated below; the table reports the remaining three changes. First-attempt
parity is vacuous on the first two changes in all arms because the fixture corpus
carries no row with the new field; that hollowness is stated rather than scored.

| Change | Hand | MobX | TanStack |
|---|---|---|---|
| Time-dependent membership input | files touched: a pair; diff in the low dozens; parity green first try; fence corrected once on the mount-exclusion reading; inside the hour | files touched: a pair; smallest diff of the three; parity green first try; fence corrected once on the same reading; inside the hour | files touched: four; mid-size diff; parity green first try; fence failed then fixed, with a flat-only flip retracting silently until commit-layer driving was added; fastest of the three |
| Derived continuation line beside the row | files touched: a pair; mid-size diff; parity green first try; fence green first try; inside the hour | files touched: three; mid-size diff; parity green first try; fence green; the annotation discipline rejected a missing entry at typecheck; inside the hour | files touched: five; larger diff; parity green by construction; fence partial then fixed, with bootstrap ordering needing a two-pass rebuild; fastest of the three |
| Second row kind in the same list and groups | files touched: seven; largest small-change diff of the exercise; over the timebox; fail-by-design extra rows with nothing missing and nothing changed; the rebuild oracle caught a latent attach gap and the author's own first signal | files touched: five with one new model file; mid-large diff; inside the timebox; fail-by-design extra rows with nothing missing and nothing changed; probe green first try | files touched: four; largest diff of the exercise by lines; fastest of the three; fail-by-design extra rows with nothing missing and nothing changed; one uncovered lane on the evict step |

Sources: the three exercise documents with their per-arm diff directories. Exact
per-change files, line deltas, and durations are in the exercise Table One records.

Reading the table without averaging over it. On the two comparable small changes the
MobX diffs are smallest or tied, the hand diffs sit in the middle, and the TanStack
diffs touch the most files while taking the least time; the TanStack speed reflects
examiner fluency as well as arm shape and is not scored as an arm property. The
fence feedback favored MobX once: the annotation omission failed typecheck, which is
the discipline working rather than ceremony. The TanStack arm bit its examiner twice
on documented traps: the silent retraction on a flat-only flip and the bootstrap
interleave, both fixed inside the change. The hand arm's large change overran the
timebox but its oracle caught two real defects, one latent in the arm and one in the
author's own first signal. The extra-row tallies on the large change are not
comparable head-to-head across arms because the corpora differ; within each arm the
classification is pure addition with nothing missing and nothing changed.

## Change exercise: the bubbling contradiction, adjudicated

The TanStack examiner attempted the same bubbling change the other two arms
implemented, found it breaks mount parity against the oracle, read the legacy
source, concluded the real behavior bubbles through the visible subtree only, and
reverted. The question is whether that invalidates the hand and MobX bubbling
diffs whose parity stayed green.

Adjudication from the legacy source: the TanStack reading is right. The flat row
pass skips archived, deleted, proposed-stage, and system-stage issues before any
row object exists; the nesting pass builds its lookup from visible rows only and
drops children with no visible row; the session aggregate sums attached children
only; and both the pending-decision walk and the attention-source walk traverse
attached children only. An ask on an invisible descendant therefore cannot reach
the root in the current derivation. The oracle confirmed it where exhibited: the
bubbling walk marks rows asking that the oracle leaves quiet. The hand and MobX
implementations bubble from invisible-but-edged descendants; their parity passes
are vacuous on exactly that point because their probe corpora contain no
invisible-but-edged asker. The TanStack examiner's conclusion stands: the hand and
MobX bubbling diffs implement behavior the oracle contradicts where exhibited.

Disposition: the bubbling change is not comparable across arms and is excluded from
the maintainability ranking; its lines and times feed no average. The rewrite
carries the corrected rule: asks bubble through the visible formal subtree only,
and invisible descendants detach at ingest, which all three arms already do. The
slice spec shorthand should be amended to say the visible formal subtree before the
rewrite begins.

## Change exercise: complexity and reading burden

| Item | Hand | MobX | TanStack |
|---|---|---|---|
| Implementation lines, tests excluded | in the largest class with the TanStack arm | smallest, at roughly two thirds of the hand arm | largest arm, no compression achieved |
| Places a newcomer must remember | the delta union plus sensitivity sets, topology order, key mapping, and rebuild order, inventoried as six items, oracle and fence covered | bucket maps on one shared ingest path plus equality annotations: oracle and fence covered | query definitions with collection options, index calls, removal drains, and disposal order |
| Guide accuracy | mostly accurate; the places list is the union of possible places so a newcomer cannot tell which subset a change needs; one stale topology comment | high; the same union-list deduction; the tick precedent lives in code but not in the recipe | high; the same union-list deduction; two traps documented in milestone notes and hit again in the exercise |

Sources: the three exercise complexity tables; the shape review for line-basis
adjudication. Exact line tallies and test-line tallies are in the exercise Table
Three records.

All three guides exhibit the same union-list weakness: each lists every place a
change could touch without saying which subset a given change needs, and every
examiner guessed wrong about at least one file. The rewrite should replace the
union list with per-change-shape recipes. All three arms exceed the early line
budget openly; the review ruled the budget was set before the rule surface was
known and forbade compressing parity-exact rules to meet it.

## Screen coverage map for the winner

Each surface is covered by the slice, a named exclusion, or a gap with a probe,
citing which slice mechanism covers it or what the probe is.

| Screen or surface | Mechanisms it needs | Status after the slice |
|---|---|---|
| Worklist sidebar, rail, mobile Work tab | all twelve slice mechanisms | covered: the slice is this surface, web and native lanes green |
| Command palette | membership, ordering, text filter over titles | named exclusion: text filter is a full scan by nature, bounded by the visible set |
| Workspace and Flight Deck | recursive rollup, key relations, ordering within one mission, per-mission aggregates | covered by rollup plus relations; per-mission aggregates are group-by over one subtree: probe at the largest corpus |
| Issues board and Tasks | membership by stage, counts per stage, ordering, epic progress | group-by plus rollup: probe at the largest corpus |
| Repo picker, cold-start composer | most-recent-use over sessions and repos | covered by the prefix relation |
| Host indicators, machine facts | high-frequency numeric stream | named exclusion: stays off the graph in its own store, as today |
| Chat transcript, presence, connection | already off the store | named exclusion |
| Issue detail, properties, edges | single entity plus edges | covered by the composite entity plus the graph edge; the continuation walk beyond the single tick is a probe, already priced cheap by the change exercise |
| Drafts | per-id local ledger | probe: local state with persistence semantics before the rewrite plan is written |

Source: the methodology coverage table filled per the winner's slice mechanisms and
exercise evidence.

## The two open decisions

### Where optimism lives

The arms kept the kernel as the only writer for comparability; each milestone three
adds a bounded write-path sketch of one optimistic edit through the arm's own write
idiom, reconciled against the kernel's echo and rejection. Not measured for speed;
judged on how much of the kernel's optimism semantics the idiom expresses without
special cases.

| Sketch | Pending representation | Echo | Rejection | What is new work |
|---|---|---|---|---|
| Hand-rolled | side map beside the tables; the pending value flows through the ordinary dataflow | settles with parity green, no special-case code | re-applies the saved prior row through the same dispatch | surfacing a dead letter needs a fresh delta kind plus a row field, priced by the exhaustiveness check |
| MobX | side map beside the tables; the pending value flows through the same action | settles with no commits, parity green, no special-case code | re-applies the captured prior row through the same action | surfacing a dead letter needs a row-visible field plus a render read, no new level |
| TanStack DB | the transaction itself; no side map; synced state untouched | the shadow drops onto the identical value with no commits, parity green | the transaction rolls back by itself with no restore code, then a restoring commit | optimism needs a public commit-flush method; the failure surface needs a row-visible field plus a render read |

Sources: the three write-path sketches with their spikes. Pending-window commit
tallies: the hand and TanStack spikes commit the single pending row; the MobX spike
commits the renamed row plus the dependent tick that quotes its title, the same
pair the milestone rename commits.

All three sketches cover the steady state and both exits with no new levels, and
all three agree the kernel keeps transport, retry, ordering, authority,
persistence, conflict resolution, and readmission replay. The differences are
prices, not verdicts: the TanStack rollback costs a restoring commit the others do
not pay because rows are assembled anew instead of borrowed; the TanStack flush
bridge is a method the others do not need; the hand dead-letter path pays for a
delta kind where the others pay for a read. What would settle it: a spike of
the dead-letter surfacing plus a readmission replay through each write idiom under
the echo-and-rejection scenario variants, priced in places to remember. Until that
spike exists the decision stays open and the rewrite keeps optimism in the kernel.

### What the server precomputes

Each arm's instrumentation reports the share of per-event computation spent in
rollups versus row assembly.

| Arm | Count split per hot-path event | Timed split | Reading |
|---|---|---|---|
| Hand-rolled | row assembly about a quarter, rollup about three quarters, index none | rollup-dominated at both scales | rollup-dominated; absolute milliseconds are box-load noise |
| MobX | row assembly about a quarter, rollup about three quarters, index none | rollup-dominated at both scales | rollup-dominated; the event pipeline is sub-millisecond in the counting harness either way |
| TanStack DB | row assembly about a sixth or less, rollup the rest, index none by count | index-heavy by wall | the wall share overstates index work because eager propagation is inseparable at the write boundary; the per-query walls are microseconds at every scale |

Sources: the three milestone-three notes with their summary files. Exact
millisecond shares are in the milestone phase-split tables.

The methodology's settlement rule says server-side projections are the next lever
if rollups dominate at the largest corpus. The count splits already clear that bar
at every scale in every arm, but the timed shares are still load-contaminated proxies:
the quiet window did not collect browser phase splits, so the browser half of the
settlement is unmeasured. What would settle it: a largest-corpus browser phase split
from a future lane with a method for it. If rollups dominate there too, the rewrite plan prices server-side
projections; if not, the question closes with those numbers. The quiet verdict
section lists this gap alongside the lifecycle walls.

## Enforcement checklist for the rewrite

Everything on this list is already in-arm in the winner, already proven to fail
before it passes, and non-negotiable for the rewrite. Each item names what fires.

| Carry | What it is | What fires |
|---|---|---|
| Runtime enforcement flags on, always | the strictness flags in the winner's config, imported by every entry | untracked writes and reads outside reactions throw or warn |
| No suspended-derivation escape hatch | the keep-alive marker banned | a derivation that must stay alive to be correct is a design review, not a flag |
| Component and model lint clean | the missing-observer and exhaustive-observable rules | an unobserved component and a half-annotated model fail the lint |
| Exhaustive annotation verified by the compiler | every model member in the annotation map | a missing entry fails typecheck, as demonstrated in the change exercise |
| Observer on every row, one subscription key per row | rows read model fields directly, never whole arrays | whole-array props fail review; the shape review's grep stays in CI |
| Exactly one table enumeration | the visible-set computed is the only body that walks a table | any second enumeration fails review |
| Exact per-row commit assertions on every subtree change | the commit-by-row log asserted exactly, not just derivation counts | the render-path scan commits an untouched sibling and fails |
| Bucket-disposal unit tests for every index | removal asserts the buckets, not just the screen | a forgotten cleanup fails even where the screen stays correct |
| Behavior tests on input-shaped corpora for every new input | carriers of the new input in the test corpus | parity on the fixture corpus cannot cover a field no fixture row carries |
| Over-commit proof on every scenario | every committed row proved inside the oracle-changed set | a row committed beyond the oracle fails |
| Mount-excluded fence with pass and fail directions | the isolation assertion plus its both-directions guard test | a detector that can only fail, or only pass, fails its own test |
| Disposal and replace pins | no surviving listeners after dispose; replace clears and reseeds atomically | a surviving listener or a half-replaced table fails |
| Clock pins | settled-body tally and exact band-mover commits on ticks | a tick that commits the world, or a stale clock row, fails |

Sources: the winner's guide and config, the shape review, the MobX exercise
document, and the harness guard tests.

Two asymmetry verdicts from the exercises are recorded here so they are not
re-litigated. Commit counts are the comparison's currency: any suite that cannot
catch a commit-count regression is held to a lower standard, and the hand arm's
count harness should be raised to the MobX standard rather than the reverse.
Index-bucket unit tests are not redundant with parity: they are the only tests
that price the index.

## Migration order

| Step | Surface | Why this order | Exit signal for the step |
|---|---|---|---|
| First | Worklist sidebar | already covered by the slice; the fence, parity, and coexistence proofs exist | parity green beside the legacy sidebar with solo and co-mounted tallies equal on both sides |
| Next | Rail and mobile Work tab | the same twelve mechanisms; the native lane already mounts them | native lane tallies match the web lane per scenario |
| Next | Issue detail, properties, edges | single entity plus the proven graph edge | parity on the detail projection; the continuation probe closed |
| Next | Issues board and Tasks, then Workspace and Flight Deck | need the largest-corpus aggregate probes first | probes green at the largest corpus, then parity per surface |
| Next | Repo picker and cold-start composer | non-key relation already proven by the prefix mechanism | parity on recency ordering |
| Never | Command palette text filter, host indicators and machine facts, chat transcript and presence | named exclusions with their own stores | no migration; the boundary stays |

Source: the coverage map above; coexistence evidence below.

## Coexistence evidence and the exit criterion for deleting the old store

One kernel feeds the arm screen and the legacy sidebar side by side; solo tallies
and co-mounted tallies are compared on both sides, on a heartbeat and on a click,
with parity green throughout.

| Co-mount | Arm solo to co-mounted | Control solo to co-mounted | Detector |
|---|---|---|---|
| Hand arm beside the legacy sidebar | unchanged, none committed | unchanged, commits the visible set | the control still says no |
| MobX arm beside the legacy sidebar | unchanged, none committed | unchanged, commits the visible set | the control still says no |
| TanStack arm beside the legacy sidebar | unchanged, none committed | unchanged, commits the visible set | the control still says no |

Sources: the three milestone-three notes with their coexistence files. Exact
solo-to-co tallies per side are in those files.

Neither side wakes the other beyond its solo shape in any arm, and the control
fails isolation in every co-mount, so the detector is not blinded by the arm's
presence. The small-corpus control tallies differ between milestone notes because
the seeds differ; the invariant is solo-equals-co on both sides within each note,
not the absolute tally across notes. That invariant is the mechanism a
screen-by-screen migration relies on.

The old store is deleted when all four of these hold: every non-excluded surface
has migrated with parity green; a repo-wide lint bans new imports of the legacy
worklist derivation paths, inverting the shape review's forbidden-import rule;
a co-mounted legacy sidebar commits nothing beyond its solo shape on arm
scenarios while the arm commits nothing beyond its solo shape on legacy
scenarios; and the disposal pin shows no surviving listeners after the legacy tree
unmounts. Then the legacy worklist derivation and its view cache are removed. The
rewrite itself is not started here.

## Losing arms' costs, stated as accurately as the winner's

### Hand-rolled arm: what it costs and what it keeps

The hand arm fails safety on exactly one item: a whole-corpus scan inside a row
component passes typecheck, unit tests, interface tests, parity, and commit
assertions unchanged, costing real render time at live corpus and growing with the
corpus, with no automated signal and no check named in-arm. Its performance counts
are identical to the winner's on every scenario with a flat slope, its bundle is
the cheapest of the three inside budget, its fidelity is green with the rebuild
oracle as an extra proof no other arm carries, and its change-exercise large change
caught two real defects through that oracle. On the quiet walls it is fastest by a
clear margin on the hot path and the only arm with no long tasks at all on the
rename step — and it still exceeds the hot-path and click budgets under quiet
conditions, so the shared absolute miss sits beside its relative lead rather than
erasing it. Its strengths are real: the
exhaustiveness check fires at compile time when a new input kind is added
unhandled, the dataflow topology is explicit, and it adds no dependency. Its
lasting costs are the reader burden of its hand-maintained lists, the union-list
guide weakness, and the uncovered render path. To become eligible it needs a
demonstrated render-path fence; nothing else in its record blocks it.

### TanStack DB arm: what it costs and what it keeps

The TanStack arm fails safety on the same render-path item with every tally
identical and fails performance on bundle, over budget by a margin it declared
itself, unchanged since the first milestone. The quiet window adds two
approach-specific wall findings beside the shared absolute miss: the slowest
hot-path walls by multiples with most rename records carrying long tasks, and
the reproduced clock tick that spends engine re-run cost with no commits and no
long tasks against a control tick that pipelines near nothing. Its performance counts are otherwise
identical to the winner's on every scenario with a flat slope, its fidelity is
green, its write-path sketch is the most elegant of the three with transaction
self-rollback and no restore code, and it adds no new dependency. Its lasting
costs are the largest implementation, the shipped engine weight, the documented
traps that bit its own examiner twice — silent retractions on flat-only flips and
bootstrap ordering — the rescope teardown-rebuild workaround for the join-layer
throw, the restoring commit on rollback, and the omission behavior with no
self-healing, worse than the MobX equivalent. To become eligible it needs the same
demonstrated render-path coverage plus a bundle diet or a changed budget, and now
an engine-cost answer for the clock path; nothing
less reopens it.

## The winner's downside, stated plainly

A recommendation without its cost named is not acceptable, so the MobX costs are
listed with the same care as the losers'. The quiet walls miss the hot-path and
click budgets under quiet conditions, which fails the performance gate on the
same absolute line that fails both losers: the rename wall-to-paint sits well
above the line with a small long-task tail, the stagemove follows it, and the
click tail misses at both scales on the cold-first-click shape every page shows.
The wall lead belongs to the hand arm, plainly, and the only zero-long-task
rename belongs to it as well. The tick re-runs settled bodies while
committing nothing on a boundary-free tick, now quiet-confirmed at several times
the arm's own rename pipeline: correct by construction, bounded,
processor-only, but the single largest behavioral cost the comparison found, and
unsubscribing would mean hand-maintained sensitivity sets, which is becoming the
hand arm. Seat maintenance walks relation buckets per ingest and group bucketing
walks the visible set per affecting change: counted, commit-free, removable in one
case and inherent in the other short of incrementalizing groups and order, which is
again becoming the hand arm. Inputs that arrive as plain values have no framework
signal: the enforcement flags warn about observable reads outside reactions, and a
plain variable is not an observable read, so the testing convention in the
checklist carries that case entirely. The annotation discipline is load-bearing
rather than ceremonial, and the library is a new production dependency. The wall
miss is shared and does not select; the detector lead is sole and does. All of
these are permanent residents of the rewrite, priced
above.

## What the harness got wrong, for the record

Six instruments in this tree could not fail until someone checked. A Stage 0
guard was tested in one direction: a fix with two mechanisms kept every test green
when the faster one was removed. The isolation assertion was asserted only to
throw until a follow-up test proved it can pass; every arm would otherwise have
failed isolation against a detector that throws unconditionally with no test
noticing. The hand arm was missing from the typecheck file list, leaving its core
compile-time claim unverified by the gate until the review caught it. And the
eviction expectation cannot trigger on its corpus: the specced scenario-six evict
removes no keeper and no sole asker, so the milestone gate stays green on a branch
carrying a real eviction defect in every arm. The fifth is the hot-path budget as
an absolute usability line: asserted on wall-to-paint, which prices paint and
collection beside the pipeline, it disqualifies the status quo by an order of
magnitude more than any survivor, so the shared miss reads as calibration rather
than approach failure — the approach-specific findings beside it still select.
The sixth is the click tail at the stated sample count: with one slow first click
per file from cold-list warm-up on every page including the control, the tail
prices warm-up rather than steady state. The first two are fixed in-tree with
both-directions guard tests; the third was fixed with an include-list correction;
the fourth is fixed by the keeper-evict variant with arming proved both directions
and live-corpus re-runs filed separately; the fifth and sixth are recorded here so a future budget
revision owns them explicitly. No verdict in this document rests on an instrument that
cannot fail: the control fails isolation in every co-mount, the exact-commit
assertions fail on the planted scan in the winner, and the bundle overrun is
declared by the arm itself.

## Traceability

Every figure in this document traces to the file named beneath its table. The
in-repo record is the milestone notes, the shape review, the three exercise
documents with their diff directories, the three write-path sketches, the harness
document, the slice spec, the methodology, the stage-zero baseline, the
keeper-evict change with its arming proof, and the
quiet-window re-run note with its driver bundle. The
attached machine record is the per-issue files: the milestone count summaries, the
browser result files, the growth, lifecycle, and coexistence files, the
control live-corpus file, and the quiet-window driver files with per-record load
and revision. Browser walls measured quiet are verdicts as-of the measured
revision wherever they appear, with the later harness change and its pending
re-runs labelled where they matter;
lifecycle walls and the named withheld cells stay provisional as listed. Terms explained on first use as
listed above; figures live in tables, never in prose.

## Attachments and routing

This document attaches to this issue and to the round-two parent; the parent moves
to review with an offer naming the re-affirmed MobX recommendation against the
quiet numbers; the summary posts as a comment on this issue, since the mail
listing is capped and hides recent coordinator messages. The
rewrite itself is not started here.
