# Three-way store comparison: hand-written, MobX, TanStack DB (POD-4403)

## Recommendation

Keep the hand-written presentation layer.

It is the only one of the three whose cost per publication does not grow
with the size of the issue corpus, and the frameworks' maintenance
advantage turns out to be narrower than the toy comparison suggested:
equal on one realistic change, fewer bookkeeping places on the other,
while all three arms go silently stale on the same class of realistic
omission.

The cost of this choice, stated plainly: the hand-written layer keeps
its current size and its input-list discipline, and it does nothing
about the failed acceptance publish path measured in
`docs/measurements/POD-4332-f1-acceptance.md`, which lives upstream of
all three arms and is owned by separate diagnosis issues. This document
recommends an arm, not a fix for that path.

## Shape of the result

Three arms are compared on four dimensions. An *arm* is one complete
implementation of the pilot presentation layer: the relationship
indexes, per-issue summaries, worklist structure, addressed cells, id
enumeration and the worklist cell, all speaking the same
`PresentationModel` shape and consuming the same `EffectiveChanges`
publications. The *corpus scales* below are the acceptance corpora,
sized in the provenance table.

| Dimension | Hand-written (shipped) | MobX arm | TanStack DB arm |
|---|---|---|---|
| Performance | Targeted publishes at any corpus size; cheapest seed, mid-pack first read and rebuild | Precise derivation counts but a corpus-scale recompute pass per publish; slowest first read and heaviest heap, cheapest rebuild | Full-corpus derivation rerun per publish; fastest first read but slowest seed and rebuild |
| Maintainability | Most places on a new worklist input; equal on a new summary field | Fewest places on a new worklist input; equal on a new summary field | As many places as hand-written on a new worklist input; equal on a new summary field |
| Complexity | Own substrate plus input lists; no new dependency | Smallest code; library tracking semantics | Largest code; collection, query and envelope semantics |
| Error proofness | Silent stale reads; oracles catch removal, not omission | Silent stale reads, stickier; nothing catches it | Silent stale subscribers, self-healing reads; nothing catches the routing omission |

Downsides, stated plainly for the arm each sentence favors least.
Hand-written: a large layer to carry, an input-list discipline with a
silent omission case, and no help with the upstream publish-path cost.
MobX: per-publish wall cost that scales with the corpus, by far the
largest retained heap at live scale, and a brand-new production
dependency. TanStack: the worst per-publish cost of the three, the
largest arm code with the most overlapping wake mechanisms, and a
dependency whose zero-marginal-cost status expires with the legacy
adapter.

The rest of this document supports that table, change exercise and
failure classification first, measurement detail after. Vocabulary used
throughout. A *derivation-body execution* is one run of the function
that computes a summary part, a mission closure or a worklist slice;
the tables count these because they do not move with machine load. A
*wake* is one subscriber notification on a mounted cell; a wake with an
unchanged value still costs the subscriber a check. An *input list* is
a declared set of inputs a cell depends on; *invalidation* (a cell
going *dirty*) marks it for recompute. A *computed* is MobX's tracked
derivation; a *memo* is the TanStack arm's cached value retained while
it compares equal; a *coarse cell* is one subscribed at table
granularity rather than to a single address.

## Parity precondition: what was actually compared

Equal scope or the comparison is worthless, so each arm had to pass the
same tests the shipped layer passes before any number counted.

| Arm | Parity suite result | Scope status |
|---|---|---|
| MobX | All tests pass | Equal scope |
| TanStack DB | All but two tests pass | Values and wakes at parity; computation counts differ (see below) |
| Hand-written | All tests pass | The baseline |

The two TanStack failures are both derivation-count budgets: a single
session touch recomputes every subscribed summary, and at live scale
every subscribed mission recomputes per read. Values and notifications
match in those same tests. The failures are therefore not a testing
artifact; they are the performance finding, stamped by the suite. Every
timing below carries a stronger control: after the seed and after every
scenario, a canonical snapshot (worklist lanes, sample summaries, a
mission) must be identical across arms, and every record in the
companion data passed it.

## Maintainability: the change exercise

Two realistic future changes were implemented for real in all three
arms, then reverted; only the measurements remain. Change A adds a new
input that affects worklist row placement (a hide-closed flag staged as
a worklist local). Change B adds a new derived field to the issue
summary over existing inputs (an overdue flag from stage, update time
and the staged clock, with the policy shared as a pure function, the
same precedent as the existing shared builders).

| Change A: new worklist input | Hand-written | MobX | TanStack |
|---|---|---|---|
| Files touched | 2 | 1 | 1 |
| Lines added / removed | 14 / 7 | 10 / 3 | 12 / 5 |
| Separate places to update | 6 | 4 | 6 |

The six hand-written places are the local-key type, the staging-key
list, the input inventory, the validator, the derivation read, and the
inventory test. MobX needs the type, the staging keys, the validator
and the read; tracking is automatic. TanStack needs the type, the
staging keys, the validator, the storage-key list, the local-routing
branch and the read. The exercise caught a real latent inventory this
way: the TanStack routing branch silently drops any new worklist local
into the wrong namespace unless extended, a fourth list nobody had
named.

| Change B: new summary field | Hand-written | MobX | TanStack |
|---|---|---|---|
| Arm files touched | 1 (plus shared helper and type) | 1 | 1 |
| Lines added / removed | 15 / 2 | 13 / 2 | 13 / 2 |
| Separate places to update | 3 | 3 | 3 |

Change B costs the same everywhere: input wiring inside summary bodies
is automatic in all three arms (registered graph inputs, tracked reads,
coarse re-reads). The frameworks' maintenance advantage is confined to
top-level input wiring; a developer adding derivations notices no
difference. Oracle updates were needed in test files in every arm
regardless of reactivity choice, a cost of the shared-shape contract,
not of any arm.

## Error and bug proofness: the silent-failure test

In each arm the most plausible bookkeeping step was deliberately
omitted and two things were observed: what the user sees, and whether
any existing test fails. A failure is *loud* if a test or type error
fires, *visible* if the screen is obviously wrong, and *silent* if
stale data renders looking correct.

| Omission | Hand-written | MobX | TanStack |
|---|---|---|---|
| New input staged and read but not registered (input inventory / observable / routing) | Silent: worklist keeps showing pre-change rows; full suite green | Silent and stickier: cached value stays stale across fresh reads too; full suite green | Silent for subscribers on the routing omission; full suite green |
| New input never staged at all | Silent in all three arms: the absent value falls back to a default and no test publishes it | Same class | Same class |
| Dirty-list entry only (TanStack storage keys) | No equivalent list | No equivalent list | Benign: value comparison still wakes the cell |

On asymmetries. First, the hand-written mutation oracles
splice each *known* input out of the inventory and fail loudly, but
they cannot catch an input that was never listed: the inventory test
only knows the inputs someone remembered to write down. Removal is
guarded; omission is not. Second, staleness sticks differently. A
missed MobX update stays stale on every read until some unrelated
tracked input changes, because the cached computed never re-resolves.
A missed TanStack wake heals on the next read, because memos recompute
on read and only the notification was lost; but the same always-re-read
design is what makes its per-publish computation corpus-scale. Each
arm's failure character is the price of its mechanism.

What each approach makes possible and impossible, as classes:

- The hand-written arm makes *omitted registration* possible (a
  stringly-keyed inventory the compiler cannot check) and makes
  *unscoped recomputation* nearly impossible (cells recompute only
  when dirtied).
- MobX makes *untracked staging* possible (a plain variable where an
  observable belongs, invisible to every test) and makes
  *registration omission* impossible (there is no list to forget).
- TanStack makes *misrouted staging* possible (a second namespace
  inventory beside the first) and makes *stale reads* nearly
  impossible (reads always recompute), at the cost of making
  *unscoped recomputation* certain on every publish.

The validator in every arm rejects mistyped values at the boundary,
and the type checker forces the key-type and validator updates in all
three; what no checker in any arm sees is a string-keyed inventory
entry that was never added.

## Performance

Method, stated once. One corpus builder, one mounted tree (a worklist
cell, three summaries, one mission, one id enumeration, one row cell,
one draft cell, one navigation cell), one publication sequence per
scenario. Arm order rotates every repetition so a slow box hour cannot
favor one arm. Timing phases ran under the `bench:ludovico` lease with
the one-minute load average recorded per record. Counts lead; walls
support. Medians are reported, never a maximum presented as a
percentile. Companion data:
`docs/measurements/POD-4403-three-way-bench.json`.

| Apply wall, live scale, median ms | Hand-written | MobX | TanStack |
|---|---|---|---|
| Unrelated session touch | 0.1 | 130.0 | 259.5 |
| Visible title rename | 0.2 | 125.7 | 301.0 |
| Membership move | 0.6 | 127.1 | 286.0 |
| Clock advance | 0.1 | 107.2 | 292.4 |
| Wide fan-out (hundreds of cells subscribed) | 0.4 | 84.6 | 304.3 |

| Apply wall, ci scale, median ms | Hand-written | MobX | TanStack |
|---|---|---|---|
| Unrelated session touch | 0.1 | 9.3 | 33.0 |
| Visible title rename | 0.2 | 10.5 | 33.7 |
| Membership move | 0.5 | 10.2 | 31.4 |
| Clock advance | 0.1 | 9.0 | 32.6 |
| Wide fan-out | 0.4 | 9.9 | 50.3 |

The ordering is the same at both scales; the gap widens with the corpus.

Derivation work per publication at live scale, for the unrelated
session touch (the cleanest isolation case):

| Count | Hand-written | MobX | TanStack |
|---|---|---|---|
| Summary bodies rerun | 0 | 0 | 4870 |
| Phase parts rerun | 0 | 0 | 4870 |
| Unread parts rerun | 0 | 1 | 4870 |
| Readiness parts rerun | 0 | 0 | 4875 |
| Children parts rerun | 0 | 0 | 4870 |
| Membership parts rerun | 0 | 0 | 14610 |
| Missions rerun | 0 | 0 | 1 |
| Session visits | 0 | 1 | 8617 |
| Wakes | 1 (worklist) | 1 (worklist) | 1 (worklist) |

| Wide fan-out counts | Hand-written | MobX | TanStack |
|---|---|---|---|
| Summaries rerun | 0 | 0 | 5068 |
| Missions rerun | 2 | 2 | 200 |
| Session visits | 13 | 13 | 9405 |
| Wakes | 1 | 1 | 1 |

Wake counts are otherwise identical across arms with one exception: on
a title rename the hand-written arm also wakes its id enumeration,
whose value did not change.

| Rename wakes | Hand-written | MobX | TanStack |
|---|---|---|---|
| Subscriber notifications | 3 (worklist, summary, ids) | 2 (worklist, summary) | 2 (worklist, summary) |

Both alternatives stay quiet there; it is a small spurious wake in the
shipped layer, not a framework defect.

Bootstrap, first read and rebuild at live scale, median ms except where
noted:

| Step | Hand-written | MobX | TanStack |
|---|---|---|---|
| Seed apply over the full corpus | 117 | 119 | 436 |
| Cold first reads (worklist, summary, mission) | 396 | 790 | 219 |
| Teardown and rebuild on a warm source | 109 | 96 | 411 |
| First worklist read after rebuild | 558 | 536 | 265 |
| Heap after bootstrap, fresh process each, MB, single sample | 88 | 286 | 110 |
| Added bundle weight, minified bytes (gzipped) | 47766 (16206) | 98498 (30436) | 321530 (91719) |

On the coordinator's questions, explicitly. First, the publish
or apply step at live corpus scale: the hand-written presentation apply
is the fastest row in the table above, so the bulk of the failed
acceptance publish path lives outside the adapter — upstream shared
machinery plus the shared worklist tail on dirty reads, per the two
sibling diagnoses. MobX adds a corpus-scaling bookkeeping cost of its
own on top (a smaller version of the defect class), TanStack a larger
one. Neither alternative fixes the acceptance wall failure; both would
add to it.
Second, bootstrap and cold first read show no blowup in any arm.
Third, teardown and rebuild show no blowup in any arm at this layer:
nothing here resembles the long principal replacement from acceptance,
so that cost also lives above the presentation layer, where its
diagnosis issues already own it.

Why each arm costs what it costs (the mechanism, not just the
ranking):

- The hand-written arm dirties exactly the cells whose declared inputs
  changed and recomputes nothing else. Its per-publish cost follows the
  change, not the corpus.
- The MobX arm invalidates just as precisely (automatic tracking), so
  its counts match, but every publish re-resolves the cached computed
  nodes across the corpus-scale worklist recompute. Tracking
  bookkeeping has a per-access constant, and the corpus multiplies it.
- The TanStack arm re-reads every subscribed coarse cell on every
  apply and, through the worklist tail, reruns every issue's derivation
  bodies whether or not their inputs changed. Its per-publish cost
  follows the corpus times the subscriber count.

Limitations, honestly, including what two sibling diagnoses add.
The fixture's repository tree is empty, so the shared worklist tail
(identical code in all arms) costs almost nothing here and the walls
isolate reactivity bookkeeping. With the acceptance tree it does not:
the publish-path diagnosis measured hundreds of milliseconds for a
forced worklist read through that shared tail, a cost every arm pays
per worklist recompute on top of the bookkeeping differentials
tabulated here. The ordering stands; absolute production walls read as
shared tail plus per-arm bookkeeping, not as the rows above alone.
Teardown and rebuild were measured with a nine-cell mounted tree; the
principal-switch diagnosis traces the minutes-long production switch
to a fourteen-thousand-listener tail topology that would stress each
arm's fan-out loop differently and is unmeasured here. Heap figures
rest on one fresh process per arm. Absolute walls were recorded under
moderate load and are supporting evidence only.

## Complexity: what each approach forces on the reader

Implementation size at equal scope, tests excluded:

| Code | Lines |
|---|---|
| Hand-written layer, total (model, summaries, relationships, structure, computed substrate) | 1254 |
| Hand-written arm-specific (model, summaries, substrate; relationships and structure are shared by all arms) | 787 |
| MobX arm | 603 |
| TanStack arm (includes the dirty-tracking addition from this comparison) | 773 |

Dependency weight: the hand-written arm adds none. MobX would be a new
production dependency (weight in the bundle row of the performance
tables). TanStack DB is already a production dependency through the
legacy replica adapter, so it adds no new dependency today, but that
adapter is scheduled for deletion under a separate decision, after
which its weight (same row) becomes marginal to this use.

What a developer must understand to make a safe change, with named
examples rather than adjectives:

- Hand-written: the token DSL that names inputs (`collection`,
  `local`, `navigation`), the dependents registry that maps an
  invalidated input to cells, the staged-apply-then-notify ordering in
  `apply`, and the bounded least-recently-used eviction of cold
  derivations (what `summaries.evict` must cover on every removal
  path). The reasoning is hardest at invalidation completeness: there
  is no backstop behind the input lists.
- MobX: shallow observable maps and boxes holding borrowed immutable
  rows, computed nodes with value equality, `keepAlive` eagerness, and
  the synchronous fan-out loop over live cells. The reasoning is
  hardest at tracking scope: `readWorklist` transitively depends on
  every row it touches, so any touch recomputes the whole worklist
  node even though almost no derivation body reruns.
- TanStack: collections with synchronous sync configuration, envelope
  rows (every stored row wraps the borrowed value under a `value`
  field, and most of the arm's early fixes were unwrapping mistakes),
  narrow live queries as wake signals with the static-field-access
  constraint (a query cannot abstract over the key field, so each call
  site repeats its own `where`), memo-plus-value-comparison retention,
  and the input-version list that forces equal-value wakes. The
  reasoning is hardest at the seams: which of the overlapping
  mechanisms (query signal, memo, version, fan-out flag) decides a
  given wake.

A competent developer unfamiliar with this codebase would most likely
modify the MobX arm correctly on the first attempt: Change A needed the
fewest places, every one of them adjacent to the derivation, with
no inventory whose absence is silent. The TanStack change needed the
same core plus non-adjacent lists, one of which fails silently in
the wrong namespace. The hand-written change needed those plus the
input inventory, whose omission is the silent case above.

## Provenance

| Condition | Live scale | Ci scale |
|---|---|---|
| Issues / sessions in the fixture | 4867 / 4304 | 674 / 530 |
| Repetitions per arm per scenario | 3 | 5 |
| Recorded one-minute load across all records | 4.5 – 7.7 | (same run) |

Measured checkout at the bench commit, 2026-09-20 UTC, arms
interleaved with per-repetition rotation under the timing lease. Corpus
shape mirrors the acceptance fixture order with parent chains and a
small edge set; the repository tree is empty (see limitations).
Companion data holds every record with its load average. The
alternative arms live in
`packages/client-core/proofs/mobx-presentation` and
`packages/client-core/proofs/tanstack-presentation`; the bench in
`packages/client-core/proofs/three-way-bench`.
