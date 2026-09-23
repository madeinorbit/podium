# M3: MobX pool shape review (POD-4591)

> **Re-review 2026-09-23 at `62e1a17b5`: FAIL on one line (G1), sent back to
> POD-4568.** F1 and F2 are fixed in the code, and C3, C4 and C8 now PASS. The
> 5×300 gate is green, with all four plants caught on every seed. But the F1 guard test reads only
> the pool's own counter, and it stays green on a copy-and-sort flush that
> does not report its copy. See §5. The first review follows unchanged.

**Verdict: FAIL, sent back to Ma4 (POD-4568).** Two checklist lines fail:
bucket maintenance scales with the bucket, and on live data one new
issue copies and sorts 4,575 entries, 88% of the issue table (F1), and the row views resolve relations themselves
instead of reading them from the relation engine (F2). Both fixes are small
and local. The b-phase issues (Mb1 onward) stay blocked until a re-review
records PASS.

- **Reviewed commit:** `4c0ccde73` (tip of `integrate/4545-round-three` when
  the review started). The last commit touching `arms/mobx/pool/` is `59e241697`
  (POD-4568). All `file:line` below are at `4c0ccde73`, paths relative to
  `packages/worklist-proto/arms/mobx/pool/`.
- **Independence:** I built no part of the MobX pool. The 40 commits touching
  `arms/mobx/pool/` at the reviewed SHA are all from POD-4565/4566/4567/4568
  (plus one each from POD-4572, 4606 and 4621). None is from this issue. My
  only changes are this document and a reviewer probe file,
  `harness/review/m3-shape-probes.test.tsx`, which sits outside the pool.
- **Sources:** code only. I read every non-test file in `pool/` top to bottom
  (2,264 code lines, 3,281 with comments). Where a README or header claim
  disagrees with the code, the code wins and the disagreement is listed in §3.
- **Load:** 13.9–17.5 (1-minute) during the review, so the evidence is counts
  and assertions only. I took no wall timings.

## 1. Checklist

| # | Check | Verdict | Evidence at `4c0ccde73` |
|---|---|---|---|
| C1 | Relations come from the schema only | PASS | `relations.ts:263-321` builds every link from `schema[entity].relations`: one `Link` per `belongsTo`/`prefix`/outgoing `edge`, paired with its `inverse` collection. It throws when a collection has no maintaining link (:315-321). No relation or foreign-key name appears in `relations.ts`. Resolution goes only through the declared `relationRef` (:119-143), `longestPrefixPath`/`prefixCandidates` (:161-179, 581-590) and `collapseLosers` (:503-507). The residency rule comes from `schema[entity].cold` (`residency.ts:77-104, 160-191`). Model field getters come from `SCHEMA[entity].fields` (`models.ts:80-99, 222-224`). |
| C2 | No relation maintenance inside derivations | PASS | Every inverse collection a derivation reads comes from the engine's buckets through `RelationReader.many` (`views.ts:342`, `pool.ts:346`). Nothing outside `relations.ts` writes `forward`/`buckets`/`under`. The only write paths are `changed`/`flush`/`promote`, called from ingest inside the action (`tables.ts:126-142`, `pool.ts:382-386, 365-368`). |
| C3 | No relation **resolution** inside derivations (the engine is the one path) | **FAIL (F2)** | `views.ts:286-294` (`repoRefPartOf` → `relationRef('issue','repo', row)`, then `prefixPartOf` → `input.repo(ref)`) and `views.ts:316-324` (`originRefPartOf` → `relationRef('issue','discoveredFrom', row)`, then `originIdPartOf` → `input.present('issue', ref)`) each resolve a single-valued relation inside a derivation. They bypass the engine's maintained `forward` map, and no production derivation calls `RelationReader.one` (grep `\.one(` over `pool/` and `shared/src`: only `enumerate.ts:232-233`, `instrument/reads.ts:559` and `probes/relations-check.ts`). So the forward maps for `issue.repo` and `issue.discoveredFrom` are maintained on every write but only tests read them, and the header claim at `relations.ts:64-65` ("Derivations … never resolve a relation themselves") is false at HEAD. |
| C4 | No whole-table walk outside the one declared enumeration (`fence.json` → `pool/enumerate.ts`) | **FAIL (F1)** | *Named tables:* PASS. A grep for `.keys()/.values()/.entries()/.forEach/for…of/spread/Object.*` over non-test `pool/` files finds table iteration only in `enumerate.ts` (`issueIdsOf` :56-58, `reseed` :67-91, the gate's `knownTables`/`scanRelations`/`diffResidency`), `rebuild.ts:48-50,71` (the from-scratch oracle, run only by the checker), `pool.ts:437` and `relations.ts:443-455` (`dispose`), and `residency.ts:215` `ids()` (called only from `enumerate.ts:83,313` and `gate.test.ts`). *Collections:* FAIL. Every membership change copies and sorts its target's whole bucket (`relations.ts:648-651` `new Set(peekBucket(…))`, `:419` `Object.freeze([...members].sort())`). `repo.issues` holds every issue of the repo, cold ones included. On the live export one repo holds 4,574 of the 5,170 issues, and one new issue copies and sorts **4,575** elements (§2.3). This breaks schema doc §4.4 ("No maintenance path may scan a whole collection. Every rule above is O(edges of the changed row)") and the engine's own claim at `relations.ts:43-45`. |
| C5 | Lazy construction present | PASS | Ingest builds no model: models are created on first access inside `MobxPool.model` (`pool.ts:310-320`) and hold no row (`models.ts:74-77`). Cold rows (closed issues, their sessions) never reach a table: `Residency.ingest`/`keepCold` register the id only (`residency.ts:297-324, 387-398`), and their relation slots live in plain twins (`relations.ts:194-197, 543-550, 425-432`) until `promote` (:620-640). Loads are batched in one 50 ms window, one action (`residency.ts:239-290`, `pool.ts:358-371`). Residency atoms exist only while observed (`residency.ts:449-461`), and so do clock atoms (`clock.ts:121-135`). |
| C6 | Enforcement asserts (MobX warnings trapped as failures) | PASS, with a coverage note (N3) | Configured at `enforce.ts:21-28` (all four flags). `pool.ts:40` imports it, so every pool constructor runs under it. The trap (`mobx-trap.ts:12-26`) throws on any `console.warn` and fails the test in `afterEach` on any recorded warning, so a warning MobX swallows inside a reaction still fails. MobX 7.0.3 emits all four enforcement messages through `console.warn` (`node_modules/mobx/dist/mobx.cjs.development.js:1478, 1573, 1578, 1623`). My plants (§2.1) show all four paths fail. Installed in all 8 pool test files. *Hand never-checks:* not applicable to this arm (H3). |
| C7 | Untracked state read inside a derivation (pitfall j) | PASS, with notes (N1, N2) | Plain state reached from derivations: the clock's `now` (`clock.ts:121-135`, paired with atoms); the residency registry (`residency.ts:239-252`, each question observes a per-id atom that `register`/`unregister`/`notify` fire, :432, 445, 255-257); the relation plain twins (`relations.ts:333-336, 356-360`, which observe that atom, while every plain write calls `cold.changed`, :550, 432, 639); and the model identity memo `models.session` (`pool.ts:261-263`), whose answer is the member's `activityMs`, tracked on the same slot either way (N1). None of these can produce a stale answer without a tracked dependency. The per-step gate (§2.2) holds the pool to a from-scratch rebuild and scan. |
| C8 | Stats honest | **FAIL (F1, counting side)** | `rowsDerived` counts `view` bodies (`models.ts:166`), `notifications` counts actions (`pool.ts:370, 390, 402`), `rollupsDerived` is honestly 0 (`pool.ts:91`), and all of these match the README definitions. But `indexUpdates` counts one per bucket **replaced** (`relations.ts:435, 656-659`), whatever the bucket's size. One new issue counts `indexUpdates +2` on the old fixture (19 elements copied), at 4× (42) and on live data (**4,575**); one new session counts +2 for **2,264** on live data (§2.3). This is pitfall (e): a per-slot counter hiding table-sized work. Also uncounted: the prefix ancestor index `under` (`relations.ts:555-579`, O(path depth) set writes per placement) and the collapse maps (:465-516). Separately, a reads-fence bypass (N4): `pool.ts:229-230` answers `resident` from the raw table, so presence probes from `one()`/`bucket()` are not counted, which contradicts the README ("every table read goes through `reads.wrapTables`"). |
| C9 | Size within reason | PASS | Non-test `pool/`: 2,264 code lines (3,281 with comments), covering tables, models, relations (493), residency (325), row views (283), enumeration and oracle (238 + 52), and React/native slots (80). No roll-ups, order or list yet. For comparison, round two's whole MobX arm was 2,516 lines (1.7× its envelope, audit §3.3). The pool is a larger base, but each module has one job and nothing is dead: every export has a production or gate caller, except the `forward` read path (F2). |
| C10 | L4b correctness gate, 5 seeds, run by me | PASS (old fixture) | 5 seeds × 300 steps, 0 skipped, 301 rebuild checks and 301 relation-vs-scan checks per seed, zero divergence. All four planted defects (`planted`, `coldDeaf`, `coldRelinkSkipped`, `promoteSkipped`) fail on every seed (§2.2). What it cannot see: F1 (cost, not correctness), and F2, because the rebuild reuses the same part functions and `relationRef` (`rebuild.ts:31-37`, `enumerate.ts:184`). |
| C11 | L6a lint clean, and able to fire on the pool | PASS, with a blind spot recorded | `bun run lint` (package: fence plugin plus `eslint-plugin-mobx`) exits 0. A walk planted in `views.ts` (`[...tables.issue.keys()]`) fires `fence/no-table-walk` at `views.ts:449`. A walk over the `repo.issues` bucket (`for (… of input.relations.many('repo', id, 'issues'))`) is silent: the rule matches table **names** (`fence-plugin.mjs:174-233`), so it cannot see F1. File restored with `cp`, tree clean. |

## 2. Evidence I ran

### 2.1 Enforcement plants (`harness/review/m3-shape-probes.test.tsx`)

`bun run test:file -- packages/worklist-proto/harness/review/m3-shape-probes.test.tsx`
passes 8 of 8. The five enforcement tests run under the pool's own trap
(`installMobxWarnTrap`):

| Plant | MobX path | What the trap did |
|---|---|---|
| a computed read outside a reaction | `computedRequiresReaction` (`console.warn`, :1478) | threw on the caller (`/trapped.*m3\.doubled.*outside a reactive context/`), recorded 1 |
| an observable read outside a reaction | `observableRequiresReaction` (:1578) | threw on the caller |
| a write to an observed box outside an action | `enforceActions: 'always'` (:1573) | threw on the caller (`/trapped.*strict-mode/`), recorded |
| a side-effect write inside an `autorun` | the same warning, raised inside a reaction MobX catches | the throw is swallowed (MobX logs `console.error`), and the recorded list still holds it, so `afterEach` fails the test |
| a plain `let` read by an `autorun` (pitfall j) | none: MobX has nothing to warn about | silent, as expected. The trap cannot catch pitfall j, which is why C7 is a code read. |

`reactionRequiresObservable` (:1623) uses the same `console.warn`, so the
trap covers it by construction. The pool's own `pool.test.tsx:133-150` also
plants an untracked `model.view` read.

### 2.2 L4b gate, 5 seeds × 300 steps (old fixture 1×)

Run from the repo root under the heavy lease (`test:heavy`), at `4c0ccde73` plus
my probe commits (which touch no pool file):
`POD_POOL_GATE_SEEDS=5 POD_POOL_GATE_STEPS=300 bun scripts/test-heavy.ts -- bash -c "bun --bun ./node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node packages/worklist-proto/arms/mobx/pool/gate.test.ts"`.
Result: `Tests 2 passed (2)`, 1,971 s, exit 0. Cells from
`harness/browser/results/mobx-pool-gate-1x-5x300.json` (gitignored):

| seed | steps / skipped | rebuild checks | relation checks | cold writes / hydrated / warmed | plant (removals) fails at step | coldDeaf caught by | relink-skipped caught by | promote-skipped caught by |
|---|---|---|---|---|---|---|---|---|
| 1 | 300 / 0 | 301 | 301 | 111 / 46 / 17 | 15 | partition | relations | checkpoint |
| 2 | 300 / 0 | 301 | 301 | 125 / 0 / 19 | 56 | relations | relations | checkpoint |
| 3 | 300 / 0 | 301 | 301 | 110 / 0 / 18 | 21 | relations | relations | checkpoint |
| 4 | 300 / 0 | 301 | 301 | 140 / 14 / 9 | 29 | relations | relations | checkpoint |
| 5 | 300 / 0 | 301 | 301 | 100 / 3 / 10 | 17 | relations | relations | checkpoint |

Seed 1's sequence covers every change kind, including the shapes round
two's hand arm got wrong (`evictThenReAdd` 8, `twoRankMovesInOneBatch` 6,
`clockDecay` 26, `offerRemovedOnFinishedChild` 10). The gate is `oracleEvery: 0`
by design (`gate.test.ts:6-8`): order and roll-ups are Mb4's. Its fidelity test
compares the own-row fields with the legacy oracle (`gate.test.ts:52-56`).

### 2.3 Bucket sizes (old fixture), and what the live export says

**Old fixture.** POD-4635 (L2d) reshapes the 1× fixture after this review, so
every fixture count below is provisional and applies only to the fixture at `4c0ccde73`.

Probe: boot the lazy pool, find the largest bucket per collection, then
apply one new open issue (a copy of an open issue in the largest repo) and one
new session (a copy of a non-headless session). For each insert it records the
`indexUpdates` the pool counted and the bucket elements its writes copied and
sorted (the size of each `collection:key` in `graph.lastWrites`).

| Corpus | issues / sessions / repos | largest `repo.issues` | largest `worktree.sessions` | largest `issue.children` / `issue.sessions` | new issue: counted → copied | new session: counted → copied |
|---|---|---|---|---|---|---|
| old fixture 1× | 4,867 / 4,304 / 468 | 18 | 9 | 6 / 4 | +2 → **19** | +2 → 4 |
| old fixture 4× | 19,468 / 17,216 / 1,872 | 41 | 9 | 6 / 4 | +2 → **42** | +2 → 4 |
| **live export** (POD-4552, 2026-09-23T06:38Z) | 5,170 / 4,624 / 9 | **4,574** | **2,263** | 245 / 190 | +2 → **4,575** | +2 → **2,264** |

The live row comes from the anonymised export attached to POD-4552 (read from
that worktree's gitignored `harness/.live/`, `M3_LIVE_EXPORT=<file>`). Its rows
are composed the way the feed composes them (probe comment). The scenario
engine cannot boot on it because `pickTargets` demands fixture-only targets.
One repo holds 4,574 of the 5,170 issues (issues per repo: 4,574, 481, 56, 20, …).

**Live shape (POD-4552 export, `docs/measurements/POD-4441-fixture-shape.md`
"Fixture vs live").** The live workspace has **9** kernel repo rows against
the fixture's 500, and one of them holds 88% of the issues. Live sessions in repo-root lanes: 1,287 across 17 roots, against 3,135
across 500 in the fixture. The fixture spreads issues over 500 repos, which is
why the per-insert copy is 19 on the old fixture and 4,575 on live data: the
fixture hides F1.

## 3. Findings

### F1 (FAIL): bucket maintenance is O(bucket), and on live data `repo.issues` is 88% of the issue table

**What.** A bucket is a sorted, frozen array replaced whole on every
membership change. `pendingSet` seeds a `Set` from the whole current bucket
(`relations.ts:648-651`), and `flush` spreads, sorts and freezes it
(`relations.ts:419`). For `repo.issues` (every issue of the repo, closed ones
included, because cold rows are linked too: 4,574 of 5,170 on the live
export, §2.3), `worktree.sessions` of a repo-root
lane, and `issue.children` of a large epic, the cost per insert, delete or
foreign-key move is the size of the collection, not of the change. `indexUpdates`
reports it as one slot (C8), and neither the reads fence nor the lint can
see it (C11). Bootstrap is unaffected: one action seeds each bucket once.

**Why it matters for the b-phase.** Mb1–Mb3 read `issue.children` and
`issue.sessions` in roll-ups and add issues in scenarios 4–10. Every such change
would also pay for a repo-wide array copy and sort, and nothing in the
counts would show it.

**Fix (Ma4).** Maintain members incrementally: an `ObservableSet` per bucket, or
an insert/remove into the sorted array at a binary-searched index. Either costs
O(log b) or O(1) per edge. Order, if a reader needs it, belongs at view time,
as schema doc §4 and audit §7 put it. Count bucket work in elements, not slots,
or add a counter for it. Re-run the gate. The re-review's bar: with
`M3_LIVE_EXPORT` set, the probe's live row shows a new issue and a new session
touching O(1) or O(log b) elements, not 4,575 and 2,264. The probe reports
`lastWrites` slot sizes, so a new bucket representation may need its measure
adjusted; the bar is elements touched per edge.

### F2 (FAIL): row views resolve `issue.repo` and `issue.discoveredFrom` themselves

**What.** `views.ts:286-294, 316-324`: `relationRef(...)` plus a table read or
presence check inside the part computeds. This is a second resolution path
next to the engine's `one()` (`relations.ts:326-339`), which no production
derivation calls. The builders give a reason: the reference/resolution split, so a
rename reads no target (README "Idiom"). That reason does not require
bypassing the engine: `one()` reads the `forward` slot and the target's
presence, never the own row, so a rename would not re-run it either. Today the
two paths agree by construction (both apply `where`, and collapse touches only
sessions). The design the epic removes, though, is exactly "each consumer
resolves relations itself". The rebuild reuses the same part functions
(`rebuild.ts:31-37, 61, 73`), so the gate cannot see a divergence between
the views' resolution and the engine's.

**Fix (Ma4).** Resolve through `inputs.relations.one('issue', id, 'repo')` and
`one('issue', id, 'discoveredFrom')`. Keep the loading check for a cold origin,
because `one()` answers a known cold target as present (`pool.ts:213`), while
`present` answers only a resident one. Then correct the `relations.ts:64-65`
header and the README bullet. `relationRef` can then stop being exported to
views.

### Notes (not send-back)

- **N1.** `pool.ts:261-263` reads the plain `models.session` memo inside a
  derivation. It is safe: either branch ends in a tracked read of the same slot
  (`models.ts:178-180` or `pool.ts:311`). But it contradicts `clock.ts:97-100`
  ("this is the one untracked read in `pool/`"), which is false at HEAD: the
  residency registry and the relation twins are also plain reads, made safe by
  atoms. The comment should list all of them.
- **N2.** `residency.loading()` queues a load and arms a timer from inside a
  computed (`residency.ts:239-245, 260-275`). No observable is written, so
  MobX has nothing to warn about. This is the deliberate Linear-style "load on first access".
- **N3.** The trap covers `console.warn` only. A throw inside a reaction goes
  to `console.error` (`mobx.cjs.development.js:2264`) and is not trapped
  (observers rethrow into React, and `tracked()` rethrows, `pool.ts:149-156`).
  Tests outside `pool/` that run the pool without the trap:
  `shared/src/probes/probes.test.tsx` (L6b, `mobxPoolArm` at :192-194) and
  `harness/native/mobx-pool.native.test.tsx`. A MobX warning there passes silently.
  Worth closing when Mb4 adds its browser and native lanes.
- **N4.** `pool.ts:229-230` `resident` reads `this.tables` (raw), not
  `this.fenced`. It is a presence probe of the collection owner in `bucket()`/`one()`,
  so the undercount is small, but it contradicts the README's "every table read
  goes through `reads.wrapTables`".
- **N5.** `tables.ts:146-201` hand-codes the repo-from-lane composition (field
  names `repoId`, `path`; a takeover through the maintained `repo.worktrees`).
  This is feed-shape composition declared in the schema's `repo.components`, not
  relation maintenance, so it does not fail C1. The hand pool will need the same
  routing, so it belongs in the shared feed or schema layer eventually. Likewise
  `residency.ts:56, 68-70` names the loadable kinds, which contradicts its header ("No
  entity or field is named here").

## 4. What happens next

- Ma4 (POD-4568) is set back to `in_progress` and mailed F1 and F2 with the
  lines above.
- Mb1 (POD-4569) and everything after it stay blocked on this issue.
- Re-review: re-run §2 at the new SHA (`M3_LIVE_EXPORT=<POD-4552 export>
  M3_PROBE_OUT=<file> bun run test:file --
  packages/worklist-proto/harness/review/m3-shape-probes.test.tsx`, the gate
  command in §2.2, `bun run lint` in the package), check C3/C4/C8, and record
  PASS here with the SHA.

## 5. Re-review, 2026-09-23, at `62e1a17b5`

**Verdict: FAIL, sent back to Ma4 (POD-4568) on one line: the F1 guard
test is not armed.** The pool code now passes every line: F1 and F2 are
fixed in the code, and I checked both with my own instruments, not the
pool's counter. But the test Ma4 added to guard F1 cannot fail on a
copy-and-sort flush unless that flush also reports its own copy. I planted
one that does not, and the guard stayed green (§5.3). The fix is test-only
and small (§5.5). Mb1 (POD-4569) and everything after it stay blocked until
this line passes.

- **Reviewed commit:** `62e1a17b5` (POD-4568's landing, tip of
  `integrate/4545-round-three` when this re-review started). My branch is
  that commit plus probe commits that touch only
  `harness/review/m3-shape-probes.test.tsx`. Paths below are relative to
  `packages/worklist-proto/arms/mobx/pool/` unless given in full.
- **Independence:** I built no part of the MobX pool. The six commits that
  touch `arms/mobx/pool/` between `4c0ccde73` and `62e1a17b5` are all
  POD-4568's (`c934005fc`, `270e746f4`, `e1aa71a6d`, `1e0b513e5`,
  `85135eb7c`, `3289651a7`). POD-4568 also edited my probe file, so that its
  output includes `elements touched` (the pool's own `bucketElements`). I kept
  that line and added a counter of my own beside it (§5.2).
- **Load:** 8.9–11.7 (1-minute) during the runs. Counts and assertions only;
  no wall timings.
- **Runner:** every test ran through the package config under the
  validation queue, from `packages/worklist-proto`:
  `bun ../../scripts/validation-admission.ts focused --label <l> -- bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts <files>`.
  Plants ran in throwaway detached checkouts of my branch in the session
  scratchpad, so my worktree stayed clean while the clean runs were going.

### 5.1 The three failed or noted lines, re-checked at source

| # | Check | Verdict at `62e1a17b5` | Evidence |
|---|---|---|---|
| C3 | No relation resolution inside derivations | **PASS** | `views.ts:295-297` `repoTargetPartOf` = `input.relations.one('issue', id, 'repo')`; `views.ts:328-330` `originRefPartOf` = `one('issue', id, 'discoveredFrom')`; `views.ts:356-358` `sessionIdsPartOf` = `many('issue', id, 'sessions')`, sorted at view time. `views.ts` no longer imports `relations.ts`. A grep for `relationRef` over non-test `pool/` finds only the engine (`relations.ts:129`, called at `:590`) and the scan (`enumerate.ts:39, 184`). The rebuild answers `one()` from the from-scratch scan (`rebuild.ts:54` `scanRelations(tables)`; `enumerate.ts:202-209`), so the gate now holds the engine's forward slots to a scan through the row views. Own-row reads that remain (`views.ts:239` `parentId == null` for "top-level", `:275` `repoKey`) read no target, so they are not resolution. Lint: `arms/mobx/eslint.config.mjs:50-67` forbids `views.ts` from importing `./relations`. It fires on my plant (§5.3). |
| C4 | No whole-table walk, and no bucket-sized upkeep | **PASS** | A bucket is an `ObservableSet` (`relations.ts:199`, `newBucket` `:740-745`). `flush` (`:447-497`) applies each touched bucket's netted moves one element at a time (`:476-482`) and never reads the rest of the bucket. Bounded exceptions, each proportional to what moves: `members()` (`:393-402`) sorts a copy only for a removed root (`:667-672`, every member moves) and a released repo row (`tables.ts:165`, `repo.worktrees`: tens); `promote` (`:678-701`) copies a cold bucket once in the row's lifetime, counted. My witness (§5.2) sees **1 element added, 0 iterated, 0 sorted** for a new issue into the 4,575-member live bucket, and the same for a new session into the 2,264-member bucket. Table walks: unchanged from §1 C4 (enumeration, rebuild, dispose only). See N6 for `rootAdded`. |
| C8 | Stats honest | **PASS** | `indexUpdates` still counts slots (`pool.ts:236-238`), and the new `counters.bucketElements` counts elements touched (`pool.ts:239-241`; `relations.ts:472, 493, 697`). The README gives both definitions (`README.md:137-152`). At this commit the counter agrees with my witness on all six probe inserts (1 = 1). N4 is fixed: the engine's residency probe reads `fenced` (`pool.ts:246-248`). The counter is honest here only because the code counts itself. Nothing outside the pool checks it, and that is the send-back (§5.3). |

The other lines of §1 (C1, C2, C5–C7, C9–C11) were re-read in the diff
`4c0ccde73..62e1a17b5` and none of them regresses. N1 is fixed: `clock.ts:24`
onward now lists every untracked read in `pool/`.

### 5.2 Bucket probe, clean, at `62e1a17b5`

`M3_LIVE_EXPORT=<POD-4552 export> M3_PROBE_OUT=<file>` with the runner
above on `harness/review/m3-shape-probes.test.tsx`: 8 of 8 passed. The live
export was fetched with `podium issue artifact 4552 --get 1` into the
gitignored `harness/.live/`. The **witness** is mine
(`independently()` in the probe). For one apply, it patches MobX's
`ObservableSet` prototype (`add`, `delete`, iteration) and
`Array.prototype.sort`, and counts what the pool actually did. It does not read
any pool counter.

| Corpus | largest `repo.issues` / `worktree.sessions` | new issue: pool's `elements touched` / witness | new session: pool's / witness |
|---|---|---|---|
| old fixture 1× | 18 / 9 | 1 / add 1, iterate 0, sort 0 | 1 / add 1, iterate 0, sort 0 |
| old fixture 4× | 41 / 9 | 1 / add 1, iterate 0, sort 0 | 1 / add 1, iterate 0, sort 0 |
| **live export** | **4,574 / 2,263** | **1 / add 1, iterate 0, sort 0** | **1 / add 1, iterate 0, sort 0** |

`indexUpdates` is +2 per insert (one forward entry, one bucket), as before.
This meets the F1 bar in §3.

### 5.3 Breaking each fix (plants; restored by deleting the throwaway checkouts)

**F1 plant: a copy-and-sort flush that does not report its copy.** In `flush`,
before the per-move loop, an existing observable bucket is rebuilt from
`[...bucket].sort()` into a new set and put back in `link.buckets`. The
per-move `elements += 1` is left as it is. This is the natural way a
regression would look: someone re-sorts the bucket and does not think about
the counter.

| Instrument | Result under the plant |
|---|---|
| `relations.test.ts` "bucket upkeep is proportional to the change, not to the bucket (M3 F1)" | **GREEN, so the plant is missed.** The whole file ran with no filter: 1 failure (the F2 test, from the F2 plant in the same run), and the F1 test passed. A second run of that test alone, with only the F1 plant and the verbose reporter, names it: `✓ … one insert and one delete touch 1 element each in a bucket of 4000`, `Tests 1 passed | 42 skipped`, exit 0. |
| the pool's `bucketElements` in my probe | **1**, so the plant is missed (live new issue and new session) |
| my witness in the probe | **caught it.** Live new issue: add **4,575**, iterate **9,148**, sort **4,574**. New session: add 2,264, iterate 4,526, sort 2,263. Old fixture 1×: add 19, sort 18. |

The guard asserts `graph.lastElements` and `stats.counters.bucketElements`
(`relations.test.ts:799-803`), and both are counted by the code under test.
Ma4's "red at `8869bf15e`" proof wired the counter to the old flush's copy,
so it shows that the test fails when the code counts its own copy. It does
not show that the test catches a copy the code does not count. That is
pitfall (e) in a new form: a counter kept by the code it is supposed to
measure.

**F2 plant: a view resolves `issue.repo` itself.** `repoTargetPartOf`
becomes `relationRef('issue', 'repo', input.issue(id))` plus a
`input.repo(ref)` presence check, with `import { relationRef } from
'./relations'`.

| Instrument | Result under the plant |
|---|---|
| `bunx eslint --config arms/mobx/eslint.config.mjs arms/mobx/pool/views.ts` | **fails**: `45:1 './relations' import is restricted … no-restricted-imports`, exit 1 |
| `relations.test.ts` "a wrong issue.repo forward slot reaches displayRef, and the rebuild disagrees" | **fails**: `the view reads the engine: expected 'POD-1' to be 'XYZ-1'` |

Both F2 guards are armed. The lint alone would not catch a view that reads
`issue.repoId` without importing anything; the test would.

### 5.4 L4b gate, 5 seeds × 300 steps at 1× (old fixture), clean

`POD_POOL_GATE_SEEDS=5 POD_POOL_GATE_STEPS=300`, runner above, `arms/mobx/pool/gate.test.ts`:
`Tests 2 passed (2)`, 1,953 s, exit 0. Cells from
`harness/browser/results/mobx-pool-gate-1x-5x300.json` (gitignored):

| seed | steps / skipped | rebuild checks | relation checks | cold writes / hydrated / warmed | checkpoints | removal plant fails at step | coldDeaf caught by | relink-skipped caught by | promote-skipped (sessions) caught by |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 300 / 0 | 301 | 301 | 111 / 46 / 17 | 1 | 15 | partition | relations | checkpoint (`session:s-g10.issue: live null`) |
| 2 | 300 / 0 | 301 | 301 | 125 / 0 / 19 | 1 | 56 | relations | relations | checkpoint |
| 3 | 300 / 0 | 301 | 301 | 110 / 0 / 18 | 1 | 21 | relations | relations | checkpoint |
| 4 | 300 / 0 | 301 | 301 | 140 / 14 / 9 | 1 | 29 | relations | relations | checkpoint |
| 5 | 300 / 0 | 301 | 301 | 100 / 3 / 10 | 1 | 17 | relations | relations | checkpoint |

Zero divergence on the clean pool. All four plants fail on every seed, each
caught by its intended check. Package lint (`bun run lint` in
`packages/worklist-proto`) exits 0.

### 5.4a Ma4's one plant change (promote-skipped is now sessions only)

**Is any defect class now uncaught? No.** Ma4's reason is correct, and I
checked that the change removes no coverage. Dropping issues from the
checkpoint plant removed the proof that the checkpoint catches an issue whose
promotion is skipped. It did not remove the check itself: `fullResidencyCheck`
(`gate.test.ts`) diffs every relation of every known row, with no branch on
the entity. And an issue whose promotion is skipped is still caught in
the gate, first by the rebuild through `displayRef`, and per step by
`diffRelations`.

To test that claim rather than read it, I ran one experiment in a
throwaway checkout (not committed). It adds a hook in `promote` that skips
chosen links, and five plant arms run through the gate's own `checked()` and
`plantOutcome()`, 3 seeds × 300 steps:

| Variant (promotion skipped for …) | checks on | seed 1 | seed 2 | seed 3 |
|---|---|---|---|---|
| issue, every slot (Ma4's old plant) | checkpoint only | rebuild, step 9 (`i168 displayRef "#169"`) | rebuild, step 26 | rebuild, step 14 |
| issue, forward `parent` + `worktree` only (no view reads them) | checkpoint only | **checkpoint** (`issue:i109.parent: live null`) | checkpoint | checkpoint |
| the same | per-step only | relations, step 9 | relations, step 26 | relations, step 14 |
| issue, buckets `children` + `spinOffs` only (no view reads them yet) | checkpoint only | **checkpoint** (`issue:i1212.children: live []`) | checkpoint | checkpoint |
| session, every slot (the gate's plant now) | checkpoint only | checkpoint | checkpoint | checkpoint |

So the checkpoint still catches issue-side promotion errors that the row
views cannot see, and the per-step relation check catches them at the first
step they occur. The one gap is in what the gate *records*, not in what it
catches: a future edit could weaken the checkpoint for issues only, and no
committed plant would show it. The checkpoint code has no per-entity
branch, so I do not require it. If Ma4 is touching the gate for G1 anyway,
adding the "issue forward `parent` only" arm above as a fifth plant would
close that gap for the cost of one plant per seed.

### 5.5 What Ma4 must change (the only send-back line)

**G1. Arm the F1 guard independently of the pool's counter.** In
`relations.test.ts` "bucket upkeep is proportional to the change", count the
work from outside the pool. Two ways to do it: MobX `spy` (count `add`/`delete`
events on sets named `pool.*.bucket`, plus any new bucket set created during
the push), or the prototype patch in my probe (`independently()`,
`harness/review/m3-shape-probes.test.tsx`). Also count
`Array.prototype.sort` elements, because a regression could sort a plain
copy. Keep the `bucketElements` assertion beside it, since the counter is a
published stat. Then show it red on the plant in §5.3, applied as written
(before the per-move loop in `flush`: `if (!plain && !created) { const copy
= newBucket(link); for (const m of [...bucket].sort()) copy.add(m);
link.buckets.set(target, copy); bucket = copy }`). The re-review of G1 is
that plant against the new test, plus the probe line.

### 5.6 Notes (not send-back)

- **N6.** `rootAdded` (`relations.ts:651-660`) iterates every member placed
  under the new root's path (`[...candidates]`, `:655`). That includes
  members that stay at a longer root. So a new repo-root lane over the live
  worktree tree reads about 2,263 plain-set entries to move none. The schema
  doc §4.3 names this bound ("the members under one root"), and lanes are
  rare, so it is not a fail. It is also invisible to `bucketElements` and to
  my witness (plain `Set`s).
- **N7.** The arm lint's F2 rule covers `views.ts` only. `models.ts` and
  `pool.ts` could resolve a relation without tripping it; today neither does
  (grep for `relationRef`, `repoId`, `parentId`, `issueId`, `cwd`, `deps`
  over them finds no resolution).
- N2, N3 and N5 are unchanged and remain with their owners.
