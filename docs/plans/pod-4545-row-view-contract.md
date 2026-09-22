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
| `title` | display title, never a draft's raw title (R-SUM) | own row |
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

## 5. Evidence

| Criterion | Evidence |
|---|---|
| `RowView` with a rule + inputs doc per field | `shared/src/row-view.ts` |
| Capability rule as types; `RowShell` enforces | `shared/src/row-shell.tsx` (`RowProps`, `RowComponent`, `RowOnly`, `RowShell`) |
| Type test: a store-handle component does not compile | `shared/src/row-contract.types.test.tsx`: 9 `@ts-expect-error` negatives (required, optional, and memo-wrapped store prop; entity-array prop; callback prop; wider row; store-only; store passed to the shell; children). Plain, `memo` and MobX `observer` positives compile. A compile-time check proves `RowView` has no array, Map, Set or function field. |
| Rank and group as pure functions, tested against §3.9 | `shared/src/row-view.test.ts` (16 tests: worked example in three input orders, pin A, each R-ORDER / R-GROUP clause) |
| Archived sessions, both directions (§4a) | `shared/src/row-seats.test.ts` (7 tests): an archived session passes the R2 and R3 membership filters, and neither filter reads `archived`; `isRowSeat` drops archived and shell sessions; composed, both sessions are R2 members of A and only the live one is a seat. Control: both filters reject a headless session, so they can say no. |
| Agreement with legacy | `harness/src/oracle/row-view-legacy.test.ts` (6 tests): `rankOf`/`groupKeyOf` assemble exactly the oracle `SliceOrder` over the 1x corpus at three clocks (FIXED_NOW, +25 h, +8 d) and a second seed. The latch matches `rowInClosedFold` row by row under all 4 selection × latch states. |

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
