# POD-4547 (L1b) — The row view contract

What one rendered worklist row is, where each field comes from, and what a row
component may and may not reach. Code: `packages/worklist-proto/shared/src/row-view.ts`
(the type and the ordering and grouping functions) and `shared/src/row-shell.tsx`
(the capability rule).

## 1. Why

In round two's K exercises, a planted O(N) scan inside a row component
(`for (const issue of store.issues.rows.values())` in `HandRow`) was **silent**
in two arms. Typecheck, unit tests, exact commit counts, parity and the scan
vocabulary all stayed green. Commits count renders, not work per render
(`docs/decisions/4441-k-hand-exercise.md` Table 2 F,
`4441-k-tanstack-exercise.md` Table 2 F). The scan was only possible because
the row had a store handle. In the MobX arm it was a prop:
`MobxRowView({ model, store })`.

Round three removes that channel. A row component receives its own `RowView`
and nothing else. A `RowView` holds only scalars and one flat record: no
arrays, no entity objects, no store.

`RowView` is an interface, not necessarily an object built for the row. The
hand arm builds a plain view per row. The MobX arm's issue object implements
it, and its row reads the issue directly (§4d, POD-4756).

## 2. The fields

Every field names its rule (slice spec `docs/plans/pod-4441-round-two-slice.md` §3)
and its inputs from a closed vocabulary:

| Input | Meaning |
|---|---|
| own row | this issue's fields (wire + projection joined by id) |
| one hop | a single `belongsTo`/edge target's own fields via a relation declared in `schema.ts` (`issue.repo`, `issue.discoveredFrom`); never a collection |
| own sessions | the graph's members, `issue.sessions` (R2) first, then `session.worktree` containment (R3) for sessions with no `issueId`, passed through `isRowSeat` (no archived, no shell); see §4a |
| children's roll-ups | each formal child's (`issue.children`, R1) already-derived roll-up; a parent composes from its children, never walks its subtree, so a change costs the ancestor chain |
| coarseNow | `SliceLocals.coarseNow`; never `Date.now()` |
| selection | `SliceLocals.selectedIssueId` (+ fold latch); never stored data |

### Rendered, as named by the brief (the oracle's `SliceRow` + `selected`)

| Field | Rule | Inputs |
|---|---|---|
| `id` | issue id | own row |
| `displayRef` | `prefix-seq`, or `#seq` (R-SUM) | own row; one hop (`issue.repo.prefix`) |
| `title` | display title, never a draft's raw title (R-SUM); a draft is named after its first nameable member (§4b) | own row; own sessions (drafts only: the one nameable member) |
| `phase` | waiting > working > done > queued over the formal subtree (R-SUM, §3.9 erratum) | own sessions; children's roll-ups |
| `progressDone` / `progressTotal` | accepted formal members; a root with members is not its own unit (R-SUM / R-ROLL) | children's roll-ups; own row (lone root) |
| `working` | any subtree session computing (R-SUM) | own sessions; children's roll-ups |
| `asking` | waiting sessions (offer-only counted once) or pending decisions in the subtree (R-SUM) | own sessions; own row; children's roll-ups |
| `band` | 0 pinned or returned from defer, 2 snoozed, 1 otherwise (R-ORDER 1) | own row; coarseNow |
| `repoKey` | `repoId ?? repoPath` (R-GROUP 2) | own row |
| `closed` | closed-fold verdict with NO selection, as the oracle projects it (R-GROUP 3) | own row; own sessions + children's roll-ups (zero waiting); coarseNow (grace) |
| `selected` | `selectedIssueId === id`: derived from the local, never stored (R-SEL) | selection |

### Beyond the brief's list, and why

The brief's twelve fields cannot satisfy two of its own done criteria. Nine
more fields fix that, all scalar or flat. **These are the one thing in this
issue for the coordinator to veto.**

| Field | Needed because |
|---|---|
| `originTick` `{id, seq, title, ref}` \| null | spec §4 Row renders the R-ORIGIN tick (round-two arms render it too); without it the row needs a store handle. The substrate reaches spin-offs through the declared inverse `spinOffs` when the origin changes. |
| `activityAt` (epoch ms) | spec §4 Row renders the recency stamp from (`activityAt`, coarseNow), R-BAND. Display only; never sorts. |
| `workingSince` (epoch ms \| null) | R-BAND: working rows show an elapsed timer from the earliest working `agentState.since`. The ticking display is the row's own local timer over this fact. |
| `pinned` | `groupKeyOf`: R-GROUP 1 moves *pinned* rows, but band 0 also means returned-from-defer. |
| `sortKey`, `createdAt`, `seq` | `rankOf`: R-ORDER steps 2 and 3. Locals do not carry them. |
| `foldAt` | `compareClosedFold`: the fold sorts by `tuckedAt ?? closedAt ?? updatedAt` (R-GROUP 3), not by rank. |
| `dismissed` | `groupKeyOf`: the selection latch holds open a row folded by the grace window, but never an abandoned or tucked one (`rowInClosedFold` returns before the latch). `closed` alone cannot tell them apart. |

`SliceRow` is unchanged and stays the parity oracle's projection.
`RowView extends Readonly<SliceRow>` so the compiler keeps the two in step, and
`sliceRowOf(view)` projects back.

## 3. Ordering and grouping

Pure functions in `row-view.ts`:

- `rankOf(row)` returns `RowRank` and `compareRank` compares two of them: band
  ascending; keyed before unkeyed; `sortKey` ascending by code unit;
  `createdAt` descending; `seq` descending; `id` ascending. The rank reads no
  locals. Activity, phase and timers never enter it, so rows hold still while
  agents work (#64). Time enters only through `band`.
- `compareClosedFold(a, b)`: newest `foldAt` first; ties fall back to rank.
- `groupKeyOf(row, locals)` returns a `RowPlacement`: `pinned` (a flat section
  with no fold) or `group` with a `repoKey` and a lane (`open` / `closed`). The
  only local it reads is `selectedIssueWasFolded` (the R-GROUP 5 latch).
  Selection itself arrives already folded into `row.selected`. Snoozed rows
  stay in the open lane.
- Groups appear in the rank order of their first member, open or closed
  (legacy `groupUnifiedWorkRows` creates a group on first encounter).

How a substrate keeps the ordered list up to date is its own business. The
contract fixes only the keys.

## 4. The capability rule

- `RowProps = { readonly row: RowView }`, `RowComponent = ComponentType<RowProps>`.
- `RowShell({ row, component })` renders `<component row={row} />` inside the
  per-row commit counter. `component` is typed
  `ComponentType<P> & RowOnly<P>`. `RowOnly` rejects any prop besides `row`
  (optional ones too; `key`/`ref` excepted) and any `row` wider than `RowView`.
  The compiler error names the offending prop.
- Callbacks (spec §4: click selects) come through `RowActionsContext`
  (`RowActions.select(id)`), never props. `useRowActions()` throws outside a
  provider rather than silently doing nothing.
- `RowShell` throws if `component` changes identity between renders. An
  inline component remounts its row on every render, and it is the most
  natural way to capture a store in a closure.
- `CommitBoundary({ id, children })` is round two's `RowShell`, renamed. It
  enforces nothing. It exists for the legacy control, which must be able to
  break row isolation because that is what it measures, and for the frozen
  round-two arms. Ten call sites moved to it; no behaviour changed. A
  round-three arm that renders a row through it fails the shape review.

- `row` may be a live object that implements `RowView` (§4d). The component
  is then a MobX `observer` and redraws itself when a field it read changes.
  The shell's counter sees that commit as well, exactly per row.

**What the types do not close:** a row module importing a module-level store,
calling a store hook, or a *memoised* closure over a store. These are
lint-shaped. They belong to the safety fences (L6), not the type system
(open question 3).

## 4a. Archived sessions: a resolved conflict

**The conflict.** The slice spec lists `session.archived` as "R2/R3 (excluded)"
(`docs/plans/pod-4441-round-two-slice.md` §1, the `session.archived` row). The
hand arm keeps archived sessions *in* both relations and filters when it reads
(`packages/worklist-proto/arms/hand/indexes.ts:52-55`, "archived included";
the filter is at `:348`). L1a left this open (schema doc §8 question 1).

**The ruling** (coordinator, 2026-09-22): archived sessions **are** graph
members, and the exclusion is a read-side filter owned by this contract. Both
sources were right about something. The spec states the visible outcome; the
arm has the right shape.

**Why.**
- If membership depended on a mutable flag, every archive toggle would become
  a detach and re-attach across two relations. That is a second maintenance
  path for one edge, which is exactly what round three exists to remove.
- The views need different seats. Row retention drops archived sessions
  (`sessionRetainsWorklistRow`, `visibility.ts:44-50`). The unread rollup
  counts explicit members minus shells, archived included
  (`indexes.ts:348-355`).
- It matches L1a one level up: the graph holds both the explicit edge and the
  prefix edge, and the precedence between them is decided at read time.
- If archived volume ever costs too much, the answer is residency (cold until
  touched), not absence. A filter change can recover an entity that is
  resident; it cannot recover one that was never in the graph.

**In code.** `schema.ts` filters only `headless`. `isRowSeat(session)`
(`row-view.ts`) is the row's filter: no archived, no shell. The time decay of
finished runs is an R-VIS rule over coarseNow, applied on top.

## 4b. Draft title: the first nameable member

Legacy names a draft after `sessionsForIssueNav(...)[0]` (`draftIssueLabel`,
`slices/issues.ts:218`, over `session-ownership.ts:282-310`), which skips
shells, archived and headless sessions. The pool takes the first session of
its sorted member list admitted by the shared `isDraftNameSession`
(`row-view.ts:339-348`): not archived, `agentKind !== 'shell'`,
`headless !== true`. Only a draft asks for the member; a non-draft's title is
its own. Both pools filter through the one shared function (MobX
`firstMemberOf`, hand `displayTitle`).

Invisible below 4x: at 1x no draft's lowest-id member is a shell, so parity
there cannot see the old rule (first member of any kind). The 4x browser
parity caught `i10142` ("New Shell session" against the oracle's "New Codex
session"), `i13682`, `i3081` (`docs/measurements/POD-4572-b.md` §6; M4 lesson
1 row 6). Named cover: `arms/mobx/pool/worklist/draft-title.test.tsx` and
`arms/hand/pool/worklist/draft-title.test.tsx` — every visible 4x draft's
title equals the oracle's, with a guard that at least one visible draft's
lowest-id member is a shell. The old rule fails it
(`i13682.title: expected 'New Shell session' to be 'New Codex session'`).

## 4c. `originTick`: what the `SliceRow` rebuild cannot see

`SliceRow` (11 fields, `slice-types.ts:137-154`) carries no `originTick`, so
the `SliceRow` rebuild comparison (`rebuildSnapshot` vs `snapshot()`,
projected through `sliceRowOf`) cannot see an `issue.discoveredFrom` error
through row views (M3 §5.1 open item; `arms/mobx/NOTES.md:773-776`;
`docs/measurements/POD-4568-a.md:339-341`). `RowView` does carry it (one hop
via `issue.discoveredFrom`, reaching spin-offs through the declared inverse
`spinOffs`, §2), and the whole-view check (`rebuildViews` + shared
`diffViews`, POD-4674) compares it — but the cover this contract holds is the
per-step relation scan: every gate snapshot also runs `diffRelations` (the
live engine against a from-scratch `scanRelations` over the same tables) and
fails on any divergence.

`SliceRow` stays 11 fields deliberately: it is the parity oracle's projection
(§2). Adding `originTick` to it would be the alternative; the scan is the
cover taken instead. Named cover:
`arms/mobx/pool/relations.test.ts` "a wrong issue.discoveredFrom forward slot
reaches originTick" — plants a wrong forward slot, asserts the view follows
the plant and `diffRelations` reports
`issue:I3.discoveredFrom: live "I1", scan "I2"`; the hand mirror
("a planted wrong forward entry is what the row view shows, and the scan
names it" in `arms/hand/pool/relations.test.ts`) plants both `issue.repo`
and `issue.discoveredFrom` forward slots and asserts both views follow while
`diffRelations` reports both slots. Both pool gates run `diffRelations` at
every snapshot (per-step) plus the full-residency checkpoint.

## 4d. The MobX arm: the issue is its row (POD-4756)

**Decision** (operator, 2026-09-28): rows read the issue object directly
instead of a separately built summary. Before, the MobX pool built one plain
`RowView` per drawn issue (a structural computed, `IssueModel.view`), and a
`memo` row drew it.

**Now.** `IssueModel` (`arms/mobx/pool/models.ts`) implements `RowView`. Each
field is a getter with its own cached value (`IssueModel.fields`), computed
by the same rules the rebuild's plain view uses (`views.ts`: `unlessWaiting`,
`rowActivityAtOf`, `rowLoadingOf`). `id` is the object's own, and `selected`
is a keyed read of the selection. The list's slot observes only
`issue.inMemory` and hands the issue itself to `RowShell`. The row
(`pool/react/row.tsx`, `pool/native/row.tsx`) is an `observer` that reads the
fields directly. A field whose inputs moved but whose value did not notifies
no row, so a row redraws exactly when a field it reads changes.

**The row reads every field.** The exact-commit fence's oracle says a row
must redraw when any `RowView` field changes (§4, `assertCommits`). So the
row reads all of them. The web row draws the rendered fields as text and the
placement fields and stamps as data attributes. The native row puts them in
its accessibility state and label and in its style. A row that stopped
reading a placement field (`sortKey`, say) would under-commit on the fence.
To make a placement-only change redraw nothing, the oracle would need each
arm's list of the fields its row shows. That is left open (§6, question 5).

**Five schema fields are row fields too:** `title`, `seq`, `createdAt`,
`pinned` and `sortKey`. The row's getter answers them (`IssueModel.answers`;
`installFields` keeps the class getter and adds only the schema setter). So
`issue.title` is the title as the row shows it: a draft's derived name, or
any other issue's own title with its pending edit. `issue.pinned` is a
boolean, and `issue.sortKey` is null when the field is absent. The row as fed
stays at `issue.row`. `issue.title = x` still edits the title.

**Projection.** `sliceRowOf(issue)` projects the object for parity
(`MobxPool.snapshot`). `plainRowView(row)` (`row-view.ts`) copies every
field into one plain view, and `rowViewOf(issue)` is that projection, or
undefined while the row is not in memory. The gate and tests use it to
compare with the rebuild's plain views. Drawing never builds one.

**Safety.** Collections are not banned. The row receives only its own issue,
typed `RowView`. There is no store prop, and the lint still refuses a row
module that imports a store module by value (`no-store-in-component`,
`harness/lint`). A cast past the interface to the object's other members is
a review item. A walk over data that grows with the corpus is the scale
check's (POD-4746, `harness/src/scale-check.ts`), which the fences run on
every roster arm.

**Cost.** Each drawn row holds about 20 small cached fields where it held one
view. A change re-runs only the fields whose inputs moved (`rowsDerived` now
counts field runs, `arms/mobx/README.md`). The census baseline
(`tracking-counts.baseline.json`) moved with this change, and the reason is
recorded in it.

## 5. Evidence

| Criterion | Evidence |
|---|---|
| `RowView` with a rule + inputs doc per field | `shared/src/row-view.ts` |
| Capability rule as types; `RowShell` enforces | `shared/src/row-shell.tsx` (`RowProps`, `RowComponent`, `RowOnly`, `RowShell`) |
| Type test: a store-handle component does not compile | `shared/src/row-contract.types.test.tsx`: 9 `@ts-expect-error` negatives (required, optional, and memo-wrapped store prop; entity-array prop; callback prop; wider row; store-only; store passed to the shell; children). Plain, `memo` and MobX `observer` positives compile. A compile-time check proves `RowView` has no array, Map, Set or function field. |
| Rank and group as pure functions, tested against §3.9 | `shared/src/row-view.test.ts` (16 tests: worked example in three input orders, pin A, each R-ORDER / R-GROUP clause) |
| Archived sessions, both directions (§4a) | `shared/src/row-seats.test.ts` (7 tests): an archived session passes the R2 and R3 membership filters, and neither filter reads `archived`; `isRowSeat` drops archived and shell sessions; composed, both sessions are R2 members of A and only the live one is a seat. Control: both filters reject a headless session, so they can say no. |
| Agreement with legacy | `harness/src/oracle/row-view-legacy.test.ts` (6 tests): `rankOf`/`groupKeyOf` assemble exactly the oracle `SliceOrder` over the 1x corpus at three clocks (FIXED_NOW, +25 h, +8 d) and a second seed. The latch matches `rowInClosedFold` row by row under all 4 selection × latch states. |
| Draft title, first nameable member (§4b) | `arms/mobx/pool/worklist/draft-title.test.tsx`, `arms/hand/pool/worklist/draft-title.test.tsx` (4x: every visible draft title equals the oracle's; at least one visible draft's lowest-id member is a shell). |
| `discoveredFrom` cover (§4c) | `arms/mobx/pool/relations.test.ts` "a wrong issue.discoveredFrom forward slot reaches originTick" (the view follows the plant; `diffRelations` reports the slot); hand mirror in `arms/hand/pool/relations.test.ts`; both pool gates run per-step `diffRelations` plus the full-residency checkpoint. |

**The instruments were shown to fail:**

- *Mutants.* 8 mutants of `row-view.ts`, all killed:

  | Mutant | Tests failed |
  |---|---|
  | createdAt ascending | 6 |
  | drop keyed-before-unkeyed | 5 |
  | seq ascending | 1 |
  | latch ignores `dismissed` | 2 |
  | no latch | 2 |
  | ignore `pinned` | 6 |
  | fold ascending | 5 |
  | drop band | 5 |

- *Compile-time negatives.* With the 9 `@ts-expect-error` lines removed, each
  line fails typecheck for its stated reason. The error text names the prop,
  e.g. `"row component takes a prop other than row: store"`. Adding an array
  field to `RowView` fails the no-array check (`Type 'true' is not assignable
  to type 'never'`).
- *Archived, both directions.* Adding `archived !== true` to the schema's
  membership filters fails 3 tests. Making `isRowSeat` ignore `archived`
  fails 2.
- *Draft title (§4b).* Taking the first member of any kind (dropping the
  `isDraftNameSession` filter) fails the 4x draft-title test in both arms
  (`i13682.title: expected 'New Shell session' to be 'New Codex session'`).
  Removing the shell-first guard (the `shellFirst.length > 0` assertion) lets
  the test go green on a corpus where the case is not exercised, so the guard
  is the cover for the cover.
- *`discoveredFrom` (§4c).* Planting a wrong `issue.discoveredFrom` forward
  slot makes the row view follow the plant (`originTick.id` flips) while
  `diffRelations` reports the slot; the `SliceRow` rebuild comparison stays
  green throughout, which is why the scan is the held cover. Bypassing the
  per-step `diffRelations` check lets the plant through the gate.
- *Runtime guards.* Disabling the identity throw fails its test, and so does
  forwarding an extra prop from the shell.
- *Differential sensitivity.* The ARMED control drops the manual key and
  asserts disagreement with legacy. On the unmodified corpus it **failed**:
  no visible row has a `sortKey`, so R-ORDER step 2 was never exercised (open
  question 2). The differential test now keys every third issue, with
  collisions and against creation order, before legacy derives. The latch
  test asserts the corpus contains grace-folded rows, dismissed rows, and at
  least one row where ignoring the latch would disagree.

**Regression.** All 40 `@podium/worklist-proto` test files are green: 36
files and 232 tests in the node lane (`test:file`), plus the 4
`harness/native` files through the package config, which the node lane
excludes. `typecheck --filter @podium/worklist-proto` is green. The repo lean
gate is green.

## 6. Open questions for the coordinator

1. **Accept the nine extra fields** (§2), or strike some. Each strike means
   either the §4 Row cannot render that element, or rank/group stops being a
   pure function of the view.
2. **Corpus coverage (for L2's corpus owner):** in `buildCorpus`, the only
   issues with a `sortKey` are the children of the first vWork roots, and none
   of them is a visible row. Parity therefore never tests manual order.
3. **Channels types cannot close:** a row module importing a store module, a
   store hook, or a memoised closure. Suggested fence (L6): row component
   modules may not import store modules, and `RowShell`'s `component` must be
   a module-scope identifier.
4. **Scope versus L1a §7.** L1a's handoff gives L1b visibility (R-VIS),
   roll-ups (including `issue.unread`), the repo label and the
   explicit-before-prefix session precedence. L1a's question about archived
   sessions is settled (§4a). This issue freezes the rule and
   inputs per rendered field and the local-only functions. The graph walks
   themselves (roll-ups, R-VIS, precedence) are each substrate's worklist-phase
   work against these statements. `unread` and the repo label are not row
   fields in the slice (the Row does not render them; the label belongs to the
   group header), so neither appears here. Confirm, or name who writes R-VIS
   down for the pool.
5. **Placement-only changes (§4d).** The fence counts a redraw as required
   whenever any `RowView` field changes, so the MobX row reads the placement
   fields (`sortKey`, `foldAt`, `repoKey`, …) it does not draw as text. If a
   row should not redraw when only its position changes, the oracle needs
   each arm's list of the fields its row shows. That is a shared-harness
   change for the coordinator.
