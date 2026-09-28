# N1b MobX planted mistakes (`POD-4593`)

I did not build this arm. Each of L6b's five probes was planted per its
`recipes.mobx` on its own throwaway branch (`n1b-p1-omitted-input`,
`n1b-p2-evict-index`, `n1b-p3-row-scan`, `n1b-p4-untracked-state`,
`n1b-p5-missing-inverse`), run through the full detector set exactly as CI
runs it — `bun run typecheck -- --filter @podium/worklist-proto`, `bun run
lint` in `packages/worklist-proto`, the probe suite (`runProbe`: fence steps,
sequences, gate, relation check, history check), and the arm suite file most
likely to catch it — then reverted. The issue branch holds only the record:
this doc and the five patches under
`docs/decisions/pod-4545-round-three-n-mobx-probe-diffs/` (all five pass
`git apply --check`). The arm is byte-identical to before (`git diff
af1ef54e3 HEAD -- packages/worklist-proto/arms/` empty; §5). The probe runner
was a throwaway test file, deleted before landing. Clean baseline first: all
five probes against the clean pool SILENT on every run instrument, none blind
(relation check looked, gate ran) — the arm was ready. No probe-specific test
was added to make anything fire. Counts only, never walls (box load 5–8
throughout).

## Table 1 — the five probes (MobX)

| Probe (plant) | compile `typecheck` | lint `lint-fence` | fence `commit` | fence `reads` | gate `parity` | gate `gate` | gate `relation-check` | gate `history-check` | test `behaviour` | test `arm-tests` | Screen | Notice |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 omitted input (`models.ts` title via `untracked`) | SILENT (8/8 green) | SILENT (clean) | FIRED: #4 drew 0, oracle 1, `under=[i214]` | SILENT (#4 1/3) | FIRED: #4 stale title | FIRED: #4 vs rebuild | SILENT | SILENT (finding F1) | FIRED (via #4) | FIRED: `counts` #4 `drew 0… under=[i214]` | renamed row keeps old title | immediate |
| P2 evict keeps index (`relations.ts` delete: forward only) | SILENT | SILENT | SILENT | SILENT (1/15, 1/30) | SILENT | SILENT | FIRED: #6c/#6d ghosts; seq 0/2/4 ghost, re-adds heal | SILENT | FIRED (via relation) | FIRED: `relations` 8 fails, first `['I2','I3'] vs ['I3']` | right (fail-soft) | never from screen; at once via graph check |
| P3 row scan (observer row, aliased table walk) | SILENT | SILENT aliased; direct FIRED `no-table-walk` | FIRED: #4 drew 732, oracle 1 | FIRED: #2 2821/3, #4 2820/3 | SILENT | SILENT | SILENT | n/a (no sequence) | FIRED (via reads) | FIRED: `counts` #2 `read 2821, budget 3 (issue:2820)` | right (count correct) | never from screen; at once via reads fence |
| P4 untracked state (plain refreshed-set in `view`) | SILENT | SILENT (instance field) | SILENT | SILENT | SILENT | FIRED: step 3 vs rebuild, shrunk 2 | SILENT | FIRED: step 3 only; ticked pair green | FIRED (via history+gate) | FIRED: `counts` #3 `drew 0… under=[i214]`; `pool` click stale `selected` | 2nd change shows 1st value until tick | only via a two-change test |
| P5 missing inverse (`relations.ts` update: forward only) | SILENT | SILENT | SILENT | SILENT (1/21) | SILENT | SILENT | FIRED: #7 one-way (24); every seq step one-way | SILENT | FIRED (via relation) | FIRED: `relations` 30 fails, first `['I3','I4'] vs ['I4']` | right (views resolve forward) | never from screen; at once via graph check |

Every FIRED above names the detector and its first output; every other cell is
an explicit SILENT (looked, passed) except P3 history-check, which the probe
does not run (no sequence). Detail per probe below.

## §1 P1 — omitted input

Plant (`n1b-p1-omitted-input.patch`, 1 file): `IssueModel.displayTitle`
(`arms/mobx/pool/models.ts`) reads its issue row through `untracked()`;
every other input stays tracked, so another input of the same row heals it.
Shaping note: the first variant isolated the title with zero tracked deps and
tripped MobX's own "derivation without observable" warning under the arm's
warn trap — a plant-shape artifact, not P1 (a real omission still tracks its
row's other inputs); reshaped to the faithful form.

- `typecheck` SILENT (8/8). `lint-fence` SILENT (clean).
- `commit-fence` FIRED — `#4 visibleTitleRename: drew 0 rows, the oracle
  changed 1. under=[i214] rowsCommitted=0`.
- `reads-fence` SILENT (#4 reads 1/3: reading less is never over budget).
- `parity` FIRED — #4 keeps the seed title. `gate` FIRED — #4 against the
  rebuild (`title: "collapse rail 3" (expected "Renamed visible row")`); the
  write-path sequence leg passed (see F1).
- `relation-check` SILENT. `history-check` SILENT — finding F1 (§4).
- `behaviour-test` FIRED (parity #4 + gate #4).
- `arm-tests` FIRED — `counts.test.tsx` "meets the shared reads budget":
  `[commits] visibleTitleRename (#4): drew 0 rows… under=[i214]`.
- Screen: the renamed row keeps its old title until another input of the same
  row moves. Notice: immediate — the row never redraws on rename.

## §2 P2 — missing index cleanup on eviction

Plant (`n1b-p2-evict-index-cleanup.patch`, 1 file): `PoolRelations.changed`
(`arms/mobx/pool/relations.ts`) on a delete drops the forward entry only and
returns before the row leaves its targets' inverse buckets — the one generic
maintenance path, so every relation is affected.

- `typecheck` SILENT. `lint-fence` SILENT.
- `commit-fence`, `reads-fence` (#6c 1/15, #6d 1/30), `parity`, `gate`,
  `history-check` all SILENT — fail-soft on the real arm, as in K MobX E:
  every view re-checks the table, the screen stays right.
- `relation-check` FIRED — `#6c ghost: issue:i516.spinOffs holds issue:i57,
  which the feed no longer has`; `#6d ghost: issue:i390.children holds
  issue:i430…`; sequence steps 0/2/4 ghost while re-adds (1/3) heal
  (24,228 edges seen per step).
- `behaviour-test` FIRED (via the relation check).
- `arm-tests` FIRED — `relations.test.ts`, 8 failures, first:
  `issue.parent/children > delete removes the row from every inverse:
  expected [ 'I2', 'I3' ] to deeply equal [ 'I3' ]` (plus evict/re-add,
  M3-F1 upkeep, 3/3 random-sequence seeds vs the from-scratch scan).
- Screen: right throughout. Notice: never from the screen; the graph check
  (or the arm suite) fires at once.

## §3 P3 — O(N) scan inside a row

Plant (`n1b-p3-row-scan.patch`, 3 files): new `pool/react/pool-context.ts`
(pool type only), `pool/react/row.tsx` as an observer counting its children
over a local alias of `pool.fenced.issue`, `pool/react/list.tsx` providing
the context.

- `typecheck` SILENT. `lint-fence` SILENT on the planted alias; the direct
  form (`pool.fenced.issue.values()`) FIRED `fence/no-table-walk` (1 error;
  `no-store-in-component` stayed silent — the context indirection already
  defeats it). Restored via `cp`; lint clean again.
- `commit-fence` FIRED — `#4 drew 732 rows, the oracle changed 1` (K MobX F:
  the observer row subscribes to every issue it walks). #2 commits ok (a
  session change touches no issue slot).
- `reads-fence` FIRED — `#2 read 2821 rows, budget 3`; `#4 2820 vs 3`.
- `parity`, `gate`, `relation-check` SILENT — screen right, cost wrong.
- `behaviour-test` FIRED (via the reads fence).
- `arm-tests` FIRED — `counts.test.tsx`: `[reads]
  visibleSessionPhaseChange (#2): read 2821 rows, budget 3.
  byEntity={"session":1,"issue":2820}` (2 tests fail; the probe run proves
  the #4 commit leg fires too).
- Screen: right (the rendered count is even correct). Notice: nobody — until
  the reads fence or a budget test runs; then immediate, with exact
  attribution (`issue:2820` iterates).

## §4 P4 — untracked state read inside a derivation

Plant (`n1b-p4-untracked-state.patch`, 2 files): plain `refreshed: Set` +
`refreshedViews: Map` instance fields on `MobxPool` (`false` annotations),
consulted in `IssueModel.view`, cleared in `applyLocals` on `coarseNow`.
Shaping notes: (1) the zero-tracked-dep variant tripped the warn trap
(artifact, as in P1); (2) fill-on-every-recompute made even the mount history
(fence steps fired) and broke the ticked pair, because the post-tick snapshot
refilled the set. Final form: the derivation always runs tracked
(enforcement ON=OFF, per K MobX D) but plain state picks previous-vs-fresh,
and a row joins the set only when a pass gives it a NEW value — the reference
`guardSet` semantics exactly.

- `typecheck` SILENT. `lint-fence` SILENT (instance field; module scope is
  the separate measured `no-hidden-state` record).
- `commit-fence`, `reads-fence`, `parity` SILENT — the fixed steps (one
  change per fresh mount) carry no history, as catalogued.
- `gate` FIRED — `same row twice, nothing between step 3 vs rebuild:
  title: "Probe first title" (expected "Probe second title")`, shrunk to 2
  changes (catalogue §8 verbatim).
- `relation-check` SILENT. `history-check` FIRED — step 3 only
  (`[false,false,false,true]`, the reference pin); the `tick between`
  sequence fully green: history, not inputs.
- `behaviour-test` FIRED (via history + gate).
- `arm-tests` FIRED — `counts.test.tsx` (`#1–#4` run on ONE mount, so
  history accumulates): `[commits] selectionClick (#3): drew 0 rows, the
  oracle changed 1, under=[i214]`; `pool.test.tsx > a click re-derives
  exactly the old and the new selection`: stale `selected=true` after the
  second click — the catalogue's "row twice between ticks" catcher exists.
- Screen: a row changed twice with nothing between shows the first value;
  heals on the next clock tick. Notice: only a two-change test sees it —
  every single-change view passes.

## §5 P5 — missing inverse on a declared relation

Plant (`n1b-p5-missing-inverse.patch`, 1 file): `PoolRelations.point`
(`arms/mobx/pool/relations.ts`) — updates (old defined, target non-null)
move the forward entry only, skipping both bucket moves. Generic path, so
every relation is affected (reparents, archives, session worktree moves,
prefix re-files).

- `typecheck` SILENT. `lint-fence` SILENT.
- `commit-fence`, `reads-fence` (#7 1/21), `parity`, `gate`,
  `history-check` SILENT — fail-soft: views resolve forward, the screen
  stays right.
- `relation-check` FIRED — `#7 one-way: issue:i635.parent = issue:i214, but
  issue:i214.children does not hold i635` (24 problems); every sequence step
  one-way.
- `behaviour-test` FIRED (via the relation check).
- `arm-tests` FIRED — `relations.test.ts`, 30 failures, first:
  `issue.parent/children > insert attaches both directions; a reparent
  detaches the old and attaches the new: expected [ 'I3', 'I4' ] to deeply
  equal [ 'I4' ]` (plus R4 edges, lanes/repos, 7/7 random-sequence seeds vs
  the from-scratch scan).
- Screen: right throughout. Notice: never from the screen; the relation
  check (or the arm suite) fires at once.

## §4 Findings for the decision (N4)

- **F1 (P1 history-check SILENT, P4 needs a live arm).** On this arm the
  probe's sequence legs run on bare arms whose unobserved computeds recompute
  on every snapshot read — so P1's write-path sequence (gate ok, history ok)
  cannot bite; only a mounted observer (fence steps, the real list) caches
  the stale value. The catalogue's MobX `gate/history fires` for P1 rests on
  the reference arm's idiom (views held in plain fields), not on MobX
  caching. P4's sequences DO fire here, because the plant's own plain Map
  carries the history that bare-arm recompute cannot wash away. Lesson for
  N4: "the gate fires" for an untracked read depends on WHERE the history
  lives — in the substrate's cache (needs a mounted reader) or in the
  mistake's own state (fires anywhere).
- **F2 (P2/P5 are screen-silent here).** Both graph mistakes are fail-soft on
  the real pool exactly as on the reference arm: every screen detector
  (commit, parity, gate, history) stays green while the relation check names
  the ghost/one-way at once (24,228 edges seen per step, no problem clean).
  Without the relation check (new in L6b) both would be SILENT everywhere
  except the arm suite — the instrument earns its place.
- **F3 (lint is syntactic, confirmed on the real arm).** P3's alias through
  a type-only context module passes both fence rules; the direct walk fires
  `no-table-walk`. P4's instance-field Set passes; only module scope would
  fire `no-hidden-state` (measured on fixtures). A reviewer reading the lint
  column as "no store reach" over-reads it.
- **F4 (plant shaping matters).** Two variants tripped detectors the mistake
  itself would not: a zero-tracked-dep computed (P1, P4) fires MobX's own
  "derivation without observable" warning under the arm's warn trap, while
  the faithful shape (tracked reads intact, plain state picking the value)
  is enforcement-silent per K MobX D. Recorded so N2b does not mistake a
  warn-trap firing for a P1/P4 catch.
- **F5 (arm-tests caught 5/5).** Every probe fired at least one builder
  test: P1 `counts` #4, P2/P5 `relations` (8/30 failures), P3 `counts` #2,
  P4 `counts` #3 + the `pool` click test. No probe was silent-everywhere.

## §5 Revert and green

Every plant lived on its throwaway branch; the issue branch holds only this
doc and the five patches. `git diff af1ef54e3 HEAD --
packages/worklist-proto/arms/` is empty (arm byte-identical; shared and
harness likewise — the only `packages/` change ever made was the throwaway
runner, deleted). All five patches pass `git apply --check`; branches remain
as the work log.

Focused validation on the clean tree (single end-of-task run): `typecheck
--filter @podium/worklist-proto` 8/8 green; package `bun run lint` clean;
`counts.test.tsx` + `pool.test.tsx` green (14/14); `relations.test.ts`
green. The repo-root `bun run lint` is red on
`tests/native-cli-lifecycle/terminal-probe.ts` (biome `useTemplate`), a file
no round-three issue touches — reported, not fixed. Per the brief's skip
clause the `bun run test` lean gate was not run: the landing is documentation
plus five inert patch files (nothing compiled, nothing imported), and the arm
is proven byte-identical above.
