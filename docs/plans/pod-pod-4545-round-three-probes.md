# POD-4564 (L6b) — Five planted-mistake probes

Five deliberate mistakes, each written so that someone who did not build an
arm can plant it in either substrate, with the test that must fail once it is
planted and every detector that could see it. N1b (POD-4593, MobX) and N2b
(POD-4595, hand-rolled) plant them and record what fired. The question they
answer is the one round two's decision rested on: does this substrate make a
mistake loud or silent?

Code: `packages/worklist-proto/shared/src/probes/`. The planted arm that proves
every probe can fire: `packages/worklist-proto/harness/src/reference-arm/probe-arm.tsx`.

## 1. What is here

| File | What it is |
|---|---|
| `probe.ts` | What a probe is: recipes per substrate, the behaviour test, the expected detectors (per substrate, on the planted reference arm, on the legacy control), lint plants |
| `omitted-input.ts` … `missing-inverse.ts` | The five probes (P1–P5) |
| `index.ts` | `PROBES`, the catalogue |
| `run.ts` | `runProbe(probe, subject)`: drives any arm through the probe's fence steps and change sequences; `verdicts(probe, run)`: one verdict per instrument |
| `relations-check.ts` | The relation check (new instrument) and `capturingFence` |
| `probes.test.tsx` | Every probe: clean reference arm silent; planted reference arm fails as catalogued; legacy control baseline recorded. P4 history pair. The relation check on the real MobX pool |
| `probes-lint.test.ts` | Every probe's lint plants, linted through the lint fence's own config (the lint column, measured) |
| `harness/src/reference-arm/probe-arm.tsx` | The probe reference arm and its five plants |
| `harness/lint/fixtures/arms/planted/context.ts` | A type-only context module, so P3's aliased row can be linted |

Results of the last run land in `harness/browser/results/probes-reference.json`
(planted reference arm) and `probes-baseline.json` (legacy control).

## 2. The detectors

The brief names five families: compile, lint, fence, correctness gate, test.
Each run records one verdict per named instrument:

| Family | Instrument | What it is | Run by the suite? |
|---|---|---|---|
| compile | `typecheck` | `bun run typecheck -- --filter @podium/worklist-proto` | No: the exercise runs it on the planted arm |
| lint | `lint-fence` | The L6a lint fence over `arms/<folder>` | Shapes: yes (`probes-lint.test.ts`). An arm: the exercise runs `bun run lint` (ESLint cannot run in the happy-dom lane) |
| fence | `commit-fence` | `assertCommits`: exactly the rows whose row view changed redraw (L6a) | Yes, per fence step |
| fence | `reads-fence` | Reads per change against the step's budget (L5a, POD-4609) | Yes, per fence step |
| gate | `parity` | The step's snapshot against the oracle's | Yes, per fence step |
| gate | `gate` | L4b `checkArm` over the probe's sequence (rebuild and oracle after every change, shrunk on failure), plus snapshot against rebuild after each fence step | Yes |
| gate | `relation-check` | NEW. Every declared relation, both directions, against the feed's rows, through the arm's own `RelationReader` (§4) | Yes, after every fence step and every sequence change |
| gate | `history-check` | NEW. The long-lived arm against a fresh arm over the same feed, after every sequence change (§4) | Yes |
| test | `behaviour-test` | The probe's own test (§3) | Yes |
| test | `arm-tests` | The builder's own suite | No: the exercise runs it |

A verdict is FIRED, SILENT or NOT RUN. SILENT carries `blind` when the
instrument had nothing to inspect: the arm handed the fence no relation
accessor, it has no `rebuildFromScratch`, or it is not under `arms/`. Blind is
reported, never counted as a pass.

## 3. The catalogue

Each probe below: the mistake, the recipe per substrate (where it goes by the
L1 contracts, never by one arm's private names), the behaviour test, and the
detector table. In the tables, **MobX** and **hand** are what the exercise
should expect; `fires if …` names the condition in the arm's idiom that
decides it, and the exercise records which held. **Reference** is measured on
the planted probe reference arm (asserted in `probes.test.tsx`). **Control** is
measured on the unplanted legacy control (the baseline).

### P1 Omitted input

**Mistake.** A row view reads an input (the issue's own title) that the arm's
invalidation does not list or track, so a change to that input alone leaves
the row stale until another input of the same row moves and heals it.

**Seen before.** K MobX and K hand row D (a new input the arm never
declared: silent on typecheck, lint and parity, caught only by an
input-shaped behaviour test); audit §3.3 (the hand roll-up reads the clock,
`ClockChanged` is a no-op); pitfall (i).

**Recipe, MobX.** In the row view's own-row part (the computed that builds
the L1b own-row fields from the borrowed issue row), read the displayed title
through `untracked(() => pool.issue(id)?.title)` in a computed of its own, so
it has no tracked dependency. Equivalent (plant one): copy `title` into a
plain field at ingest and read the copy, or give the part an `equals` that
ignores `title`. Leave every other field tracked.

**Recipe, hand.** Remove `title` from the declaration of which feed fields
dirty the own-row part. If that map is typed exhaustively over the row
fields, the patch will not compile: record typecheck FIRED and plant the
runtime form (filter `title` out where the changed fields are computed).

**Behaviour test.** Every input a row reads reaches the row: after a change
to one input alone, the snapshot equals the oracle's and the rebuild. Steps
#2 (a session's phase), #3 (selection), #4 (title), #8b (clock across the
grace deadline). Sequence "title through the write path": an optimistic
title edit, its receipt and echo, a second edit, a remote update on the
pending field, the rejection that rewinds to the remote value (write contract
S2/S3), a 25 h tick. The rejection is last because a refused title parks its
outbox partition for good.

| Instrument | MobX | hand | Reference | Control |
|---|---|---|---|---|
| typecheck | silent | fires if the input map is exhaustively typed | not run | not run |
| lint-fence | silent | silent | blind | blind |
| commit-fence | fires | fires | FIRED | fires unplanted |
| reads-fence | silent | silent | SILENT | fires unplanted |
| parity | fires | fires | FIRED | SILENT |
| gate | fires | fires | FIRED | SILENT |
| relation-check | silent | silent | SILENT | blind |
| history-check | fires | fires | FIRED | SILENT |
| behaviour-test | fires | fires | FIRED | SILENT |
| arm-tests | fires if a title-only change is asserted | same | not run | not run |

### P2 Missing index cleanup on eviction

**Mistake.** A row arriving with `value: undefined` (delete or eviction)
leaves its table but stays in the inverse collections that held it.

**Seen before.** K MobX row E (the screen stays right, every read re-checks
the table; only `removal disposes buckets` fires); K hand row E (a ghost row);
audit §3.3 (an evicted row re-added is never re-seated); schema doc §4.3.

**Recipe, MobX.** In the pool's delete path (schema doc §4.3), return from
relation maintenance after the table delete and before the row leaves its
targets' inverse collections (at least `issue.parent` → `children`). For a
schema-driven pool, that is the one generic maintenance function.

**Recipe, hand.** In the delete handler's walk over the deleted row's
declared relations, skip the inverse-collection removal (at least
`issue.parent` → `children`).

**Behaviour test.** After every eviction, re-add and deletion, no
collection yields a row the feed does not hold and both directions agree.
Steps #6c (a childless root) and #6d (the only child of a rescue parent).
Sequence "evict, re-add, delete": evict a child, re-add it, evict and re-add
a parent with children (they must be found again), delete a child.

| Instrument | MobX | hand | Reference | Control |
|---|---|---|---|---|
| typecheck | silent | silent | not run | not run |
| lint-fence | silent | silent | blind | blind |
| commit-fence | fires if a view reads the collection unguarded (K MobX E: silent) | fires if so (K hand E: it does) | SILENT (fail-soft) | fires unplanted |
| reads-fence | silent | silent | SILENT | fires unplanted |
| parity | fires if unguarded | fires if unguarded | SILENT | SILENT |
| gate | fires if unguarded | fires if unguarded | SILENT | SILENT |
| relation-check | fires | fires | FIRED | blind |
| history-check | fires if unguarded | fires if unguarded | SILENT | SILENT |
| behaviour-test | fires | fires | FIRED | blind |
| arm-tests | fires if buckets are asserted after a removal | same | not run | not run |

### P3 O(N) scan inside a row

**Mistake.** A row component reaches the pool (a context, an import) and
walks an entity table while it renders, so one row's redraw costs the corpus.

**Seen before.** K MobX row F (loud in exact commit counts: the observer row
subscribes to every row it walks); K hand row F (silent everywhere
automated); L1b addendum; pitfall (e).

**Recipe, both.** In the row component (L1b `Row({ row })`, the module
`fence.json` lists under `rows`): read the pool from a React context the list
provides (`createContext` in a module importing the pool type only), and
inside render walk the issue table (`for (const issue of table.values()) if
(issue.parentId === row.id) children += 1`), rendering the count. Write the
walk over a local alias; the direct form over the declared table name is a
separate lint record. MobX: keep the row an `observer`.

**Behaviour test.** A row draw reads only its row: on #2 and #4 (each redraws
one row) the reads stay within budget and exactly the changed row redraws.

| Instrument | MobX | hand | Reference | Control |
|---|---|---|---|---|
| typecheck | silent | silent | not run | not run |
| lint-fence | fires if direct (measured: `no-store-in-component` + `no-table-walk`); silent aliased through a type-only context (measured) | same | blind | blind |
| commit-fence | fires (K MobX F) | silent (K hand F) | SILENT (plain React) | fires unplanted |
| reads-fence | fires | fires | FIRED | fires unplanted |
| parity | silent | silent | SILENT | SILENT |
| gate | silent | silent | SILENT | SILENT |
| relation-check | silent | silent | SILENT | blind |
| behaviour-test | fires | fires | FIRED | fires unplanted |
| arm-tests | fires if exact `commitsByRow` is asserted | silent (K hand F) | not run | not run |

The control fails P3's behaviour test with nothing planted: it reads 9,669
rows on #2 against a budget of 3. That is the baseline: on the control the
reads fence cannot attribute a scan.

### P4 Untracked state read inside a derivation

**Mistake.** A derivation reads the arm's own plain state (a `Set` guard or
cache, a variable) that nothing tracks, so its value depends on the history
of evaluation.

**Seen before.** Audit §3.3 (MobX): the visibility getter's plain `Set`
re-entrancy guard, read inside a computed; a row that hits it caches `false`
with no tracked dependency on the row it deferred to; unexercised by any
corpus. K MobX row D (a plain variable read by a computed: enforcement ON and
OFF identical). Pitfall (j).

**Recipe, MobX.** Audit shape: guard a recursive part (visible set or roll-up,
from the worklist phase) with a plain `Set<string>` instance field, returning
a default for a row already on the stack. Deterministic shape (when no
recursion exists yet): a plain `Set` of rows "already refreshed", filled when
a row-view part recomputes, cleared only on a clock notification; a part
whose row is in it returns its previous value from a plain `Map`. Not
`observable`; not at module scope (that is a separate lint record).

**Recipe, hand.** In the row-view derivation or the dirty-row pass: a plain
`Set` of rows "already refreshed", consulted inside the derivation (a row in
it keeps its previous view), filled on feed events, cleared only on a locals
notification. Instance field or closure.

**Behaviour test.** The output is a function of current inputs, never of
history: after every change of a sequence that changes one row twice with
nothing between, the long-lived arm equals a fresh arm and its rebuild.
Sequences "same row twice, nothing between" (edit, receipt, echo, second
edit) and "same row twice, a tick between". Steps #2 and #4.

| Instrument | MobX | hand | Reference | Control |
|---|---|---|---|---|
| typecheck | silent | silent | not run | not run |
| lint-fence | fires if at module scope (measured: `no-hidden-state`); silent as an instance field (measured) | same | blind | blind |
| commit-fence | silent | silent | SILENT | fires unplanted |
| reads-fence | silent | silent | SILENT | fires unplanted |
| parity | silent | silent | SILENT | SILENT |
| gate | fires | fires | FIRED | SILENT |
| relation-check | silent | silent | SILENT | blind |
| history-check | fires | fires | FIRED | SILENT |
| behaviour-test | fires | fires | FIRED | SILENT |
| arm-tests | fires if a test drives a row twice between ticks | same | not run | not run |

The fixed fence steps cannot see P4: each is one change on a fresh engine, so
there is no history for the state to carry. `probes.test.tsx` "P4 is history,
not inputs" pins it: the planted arm fails the sequence with nothing between
the two changes (history check red at step 3 only) and PASSES the same
changes with a one-minute tick between them.

### P5 Missing inverse on a declared relation

**Mistake.** An update that changes a relation's declared inputs (a
`belongsTo` key, or a field its `where` reads) rewrites the reference on the
row and does not move the row between the old and new target's inverse
collections.

**Seen before.** New in round three: relations are declared once with their
inverse and the pool maintains both directions (audit §7). Schema doc §4.2
(detach then attach, both endpoints, including every `where` field: "the one
round two got wrong three times").

**Recipe, MobX.** In the pool's update path (schema doc §4.2): when the row
existed and still exists, write the new forward reference and return before
the detach/attach of the inverse collections (at least `issue.parent` →
`children`). Leave insert and delete as they are.

**Recipe, hand.** In the update handler's detach-then-attach step: update the
forward reference only.

**Behaviour test.** Both directions of every declared relation agree after
every change that moves an edge. Step #7. Sequence "reparent there and back,
archive and unarchive": to another parent, to the root, back to the original,
then archive and unarchive (a `where` field of `issue.parent`).

| Instrument | MobX | hand | Reference | Control |
|---|---|---|---|---|
| typecheck | silent | silent | not run | not run |
| lint-fence | silent | silent | blind | blind |
| commit-fence | fires if a view reads `children` (the worklist roll-ups will) | same | SILENT (fail-soft) | fires unplanted |
| reads-fence | silent | silent | SILENT | fires unplanted |
| parity | fires if a view reads `children` | same | SILENT | SILENT |
| gate | fires if a view reads `children` | same | SILENT | SILENT |
| relation-check | fires | fires | FIRED | blind |
| history-check | fires if a view reads `children` | same | SILENT | SILENT |
| behaviour-test | fires | fires | FIRED | blind |
| arm-tests | fires if relations are checked after updates (the MobX pool gate's `diffRelations` does) | fires if both directions are asserted after an update | not run | not run |

## 4. The two new instruments

**Relation check** (`relations-check.ts`). Every round-three pool implements
the shared `RelationReader` (L5a) and hands it to `reads.wrapRelations` (arm
contract). `capturingFence` wraps the fence the arm is created with and keeps
that reader; the check reads it raw (uncounted, after the reads cell is
taken). Over the rows the feed holds, per single-valued relation R with
inverse I:

1. No ghosts: every id `many(to, y, I)` yields, for a row y the feed holds,
   is a row the feed holds (§4.3).
2. Both directions agree: `one(from, x, R) = y` implies x in `many(to, y, I)`,
   and x in `many(to, y, I)` implies `one(from, x, R) = y` (§4.1, §4.2).

It does not check that R resolves to the right target (the arm's gate
resolves from scratch; POD-4567's `diffRelations`). A reference kept to a
target the feed no longer has is allowed (§4.3), and a collection of an
absent target is not read. On the clean MobX pool it saw more than 1,000
edges after every change of P2's and P5's sequences and found nothing.

**History check** (`run.ts`). After every sequence change, a fresh arm is
created over the same feed and locals and its snapshot compared with the
long-lived arm's, row by row, for the rows present in both. It is the one
instrument that sees P4 directly. It compares only rows present in both
because which cold rows a lazy pool has loaded is history by design
(POD-4567); the row set and order are the gate's.

## 5. The probe reference arm

`probe-arm.tsx`, a `CheckableArm`, is where every probe is proven able to
fire. Its views are the oracle's row views (recomputed on every engine
publication and locals notification, previous view kept when deep-equal, so
it redraws exactly the changed rows), and its snapshot is its OWN held
views, so a stale view shows. It holds the fed issue rows through
`reads.wrapTables` and maintains every declared `belongsTo` from issue to
issue (today `parent`/`children`, with its `where`) by the schema doc §4
rules, handing the reader to `reads.wrapRelations`. Its views never read
those relations, so P2 and P5 are FAIL-SOFT here (screen right, graph wrong):
the variant only a graph check sees, as in K MobX E.

The plants: `omittedInput` (a title-only change keeps the prior view),
`evictKeepsIndex` (a deleted row stays in its parent's `children`),
`rowScan` (the row walks the fenced issue table through a context),
`guardSet` (a plain `Set` read inside the view derivation, filled on row
events, cleared on locals notifications), `oneWayRelation` (an update moves
the reference only).

It is not a candidate: it reads the engine store for its views and is never
in the roster. The L6a reference arm (`arm.tsx`) is unchanged: its snapshot
reads the engine, which L6a's planted tests rely on.

## 6. How N1b and N2b use it

On a throwaway branch of the arm, per probe:

1. **Clean first.** Run the probe against the clean arm and keep the record
   (every instrument SILENT and not blind, or the arm is not ready for the
   exercise: report it). A roster arm is a subject:

   ```ts
   const subject: ProbeSubject = {
     name: 'mobx',                        // or 'hand'
     mode: arm.mode,                      // ROUND_THREE_ARMS entry
     armFor: (ctx) => arm.armFor(ctx),
     lintFolder: arm.folder,
   }
   const run = await runProbe(omittedInput, subject)
   console.table(verdicts(omittedInput, run))
   writeResult(`probe-${omittedInput.id}-mobx`, verdicts(omittedInput, run))
   ```

   in a test under the package's happy-dom lane, run through the package
   config (`bun ../../scripts/validation-admission.ts focused --label <l> --
   bun --bun ../../node_modules/vitest/vitest.mjs run --config
   vitest.config.ts <file>`; `bun run test:file` skips this lane).
2. **Plant** by the probe's recipe for your substrate (`recipes.mobx` /
   `recipes.hand`), without the builder's help. If the recipe's seam does not
   exist in the arm, that is a finding: record where the arm put the
   equivalent code and plant there.
3. **Run** the probe again and record every verdict. Then the instruments
   the suite does not run: `bun run typecheck -- --filter
   @podium/worklist-proto`, `bun run lint` in the package (the lint fence
   over `arms/<folder>`), and the arm's own suite. Record FIRED / SILENT per
   instrument, with the first message.
4. **Compare** with the catalogue: an expectation not met is a finding in
   either direction. A `fires if` cell: record which branch of the
   condition the arm is in. A probe no instrument catches in either
   substrate is a finding, not a failure (coordinator ruling).
5. **Revert** and re-run: the clean record must come back. Commit the
   planted diff under `docs/decisions/<issue>-diffs/` as round two did.
6. **Time to notice.** As round two's Table 2: what the screen showed, what
   fired (named), and how long until a developer would notice.

The report is a table per substrate: probe × instrument, FIRED or SILENT
(blind named). The decision (N4) compares the two tables cell by cell, and
against the control baseline below: a detector that is blind on the control
is one the rewrite gains; one that fires unplanted on the control cannot
attribute a mistake there.

## 7. Write-path candidates (L1c §5)

The write contract names three candidate write-path mistakes. They are not
among the five: they need the optimism the arms add in phase c (Mc1, Hc1),
and each is already killed by a test against the contract's reference model:

| Mistake | Killed by (`shared/src/write-contract.test.ts`) |
|---|---|
| Rewinding to the stale `prior` instead of the latest server value | S2 "rewinds to the server value that landed while pending, not the stale prior" |
| Settling on the receipt alone | S1 "echo after the receipt settles on the echo"; S3 "a remote value after the echo but before the receipt is shown at settle" |
| Treating the stamp echo as exact | S1 "a stamp field settles on the server clock, not the client one"; "a stamp echo before the receipt is recognised as the echo" |

What this issue uses from §5: P1's sequence is built from its write-path
events (edit, receipt, echo, remote update on a pending field, rejection),
because a rejection that rewinds to a remote value is a title-only change
the P1 mistake swallows; P4's uses edit, receipt and echo. When N1b/N2b run
on a phase-c arm (`mode: 'truth'`), the first mistake in the table is
plantable with the same recipe shape (rewind from the transaction's `prior`)
and P1's sequence reaches it: its rejection lands after a remote update.

## 8. Evidence

- `probes.test.tsx`: 18 tests, green (15 per-probe: clean, planted, control;
  the P4 history pair; the relation check on the MobX pool for P2 and P5).
  One full run: about 230 s under load 8–10 (counts runs; the times are not
  evidence).
- `probes-lint.test.ts`: 10 tests, green. Module-scope guard →
  `fence/no-hidden-state`; direct row walk → `fence/no-store-in-component`,
  `fence/no-table-walk`; every other shape SILENT.
- Armed: the clean reference arm is SILENT and not blind on every instrument
  of every probe; the planted one fires exactly the `reference` column.
  Mutation: with the relation check's ghost branch disabled, P2's planted
  test goes red (`expected null not to be null`: the behaviour test no
  longer fires); restored, green.
- Baseline (legacy control, unplanted): commit fence and reads fence FIRE on
  every step with no plant (#2: drew 346 rows, the oracle changed 1; read
  9,669 rows against 3), parity, gate and history SILENT (looked, passed),
  relation check and lint SILENT blind. P2's and P5's behaviour tests pass
  BLIND on it: the control has no graph.

## 9. Limits and findings

- **The reference arm realises the hand idiom.** Its plants are plain
  React and plain maps, so P3's commit fence is silent there, as in K hand F;
  the MobX expectation (fires) rests on K MobX F and is for N1b to confirm.
- **P2 and P5 are fail-soft on the reference arm**, so screen detectors are
  silent there by construction. Whether they fire on a real arm depends on
  whether its views read the collection unguarded: the catalogue says so as
  `fires if`.
- **The fixed fence steps are blind to P4.** Only a sequence reaches it; the
  random gate may or may not. P4's own sequences are the targeted form.
- **The lint fence is syntactic.** An alias defeats `no-table-walk`, and an
  instance-field Set passes `no-hidden-state` (both measured).
- **The control has no plant site** for any of the five (no pool, index,
  relation or memo of its own), so its baseline is unplanted: what each
  detector says about the control with nothing wrong in it.
