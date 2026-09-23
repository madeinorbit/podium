# M3: MobX pool shape review (POD-4591)

> **Final review, 2026-09-23 at `b29ea68ce`: FAIL on two lines (G4, G5), both
> small, and neither changes what the pool does.** G2 and G3 PASS: my cold-issue plant now fails #2 through
> the shared fence (2,839 reads against a budget of 3), and the F1 guard is
> red on both of my copy-on-write plants. (G4) Two other copy idioms,
> `set.union(new Set())` and `structuredClone(set)`, still get past the F1
> guard, at 8,002 elements per new session. A check that no engine set is
> replaced by another object catches all four plants, and it is written
> (`harness/review/m3-index-identity.test.ts`). (G5) The arm's lint is red at
> `b29ea68ce`: the new load hooks have no `makeObservable` annotation. This
> is the complete list. It does not block Mb1 (operator decision). See §7.
>
> Re-review 2, 2026-09-23 at `7ebeb9897`: FAIL on two lines (G2, G3), sent
> back to POD-4568. G1 now PASSES: the F1 guard counts from outside the pool
> and fails on my plant and on the old flush. But two ways of doing
> change-sized work still get past the tests. (G2) A load that a fence step's
> own change triggers lands after the counts test has sampled its reads, so
> it is charged to no step: on a planted change it costs 2,839 reads and the
> counts test passes. (G3) The F1 guard does not see an unsorted copy of a
> plain `Set`: a copy-on-write of the prefix index copies 8,003 elements per
> new session and the guard stays green. See §6.
>
> Re-review 1, 2026-09-23 at `62e1a17b5`: FAIL on one line (G1), sent back to
> POD-4568. See §5. The first review follows unchanged.

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

This is the old 1× fixture. POD-4635 (L2d) landed its live-shaped
fixture on `integrate/4545-round-three` (tip `164b9ae7d`) during this
re-review. It changes no non-test file in `arms/mobx/pool/`
(`git diff --stat 62e1a17b5 164b9ae7d`), so the source checks above stand.
The gate numbers are old-fixture numbers.

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

## 6. Re-review 2, 2026-09-23, at `7ebeb9897`

**Verdict: FAIL, sent back to Ma4 (POD-4568) on two lines, G2 and G3.** G1
(the only line from §5.5) PASSES. The pool code is unchanged since
`62e1a17b5` (G1 was test-only), so every code line of §5.1 still holds. Both
new lines are about what the tests can see, not about the pool's code: on the
clean pool, every number the tests report is right (§6.3, clean steps). Mb1
(POD-4569) and everything after it stay blocked until a re-review records
PASS.

- **Reviewed commit:** `7ebeb9897` (POD-4568's G1 landing, tip of
  `integrate/4545-round-three` when this re-review started). It contains
  POD-4635 (L2d) at `164b9ae7d`. My branch is that commit plus commits that
  touch only `harness/review/m3-step-load.test.tsx` and this document.
  Paths are relative to `packages/worklist-proto/`.
- **Independence:** I built no part of the MobX pool. Between `62e1a17b5` and
  `7ebeb9897`, `arms/mobx/pool/` changed only in POD-4568's test commits and
  POD-4635's test commits. None is mine.
- **Load:** 10.6–13.7 (1-minute) during the runs. Counts and assertions only;
  no wall timings.
- **Runner:** every run went through the package config under the validation
  queue, from `packages/worklist-proto`
  (`bun ../../scripts/validation-admission.ts focused --label <l> -- …vitest.mjs run --config vitest.config.ts <files>`).
  The queue was full (two slots, both held by long runs, five waiters), so
  the plant runs share one slot through a script that runs vitest once per
  plant with the same config. Plants were written into my worktree and
  restored with `cp` from copies taken before (a shell `trap` restores them
  on any exit). `git status` was clean afterwards apart from my probe.

### 6.1 Checklist lines in this round

| # | Check | Verdict at `7ebeb9897` | Evidence |
|---|---|---|---|
| G1 | The F1 guard counts bucket work from outside the pool | **PASS** | `arms/mobx/pool/relations.test.ts:802-851` `countedOutside()` patches MobX's `ObservableSet` prototype (`add`, `delete`, `values`; `:806`) and `Array.prototype.sort`/`toSorted` (`:835-836`) for one push, and reads no pool counter. The test (`:855-895`) asserts that outside count is exactly 1 per edge, then checks `bucketElements` and `lastElements` against it. Red on my §5.5 plant and on the old flush, green on clean code (§6.2). |
| G2 | A fence step counts the load its own change triggers | **FAIL** | `arms/mobx/pool/counts.test.tsx:69` builds the pool with a load window that never closes (`schedule: () => () => {}`). A load that a step queues lands only in `runCountScenario`'s `snapshot()` call (`harness/src/count-harness.tsx:380`; `arms/mobx/pool/pool.ts:430-444` settles by calling `hydrate()`). That happens after the reads are sampled (`count-harness.tsx:377-379`), and the next step resets them. Planted, the counts test's pool charges #2 **2 reads and passes**; with the load landing inside the step, the same change charges **2,839 and fails** (§6.3). |
| G3 | The F1 guard sees every bucket-sized copy in relation upkeep | **FAIL** | The guard counts `ObservableSet` work and sorts only. The prefix index `under` is a map of plain `Set`s (`arms/mobx/pool/relations.ts:320`, written at `:613-636`), holding every session under each ancestor path. An unsorted copy of one of those sets is not counted by the guard or by the pool: plant P4 copies 8,003 elements per new session and the guard stays **green** (§6.2). |

### 6.2 The F1 guard, planted (`arms/mobx/pool/relations.test.ts -t "M3 F1"`)

| Run | Code | Result | Outside count on the first failing edge |
|---|---|---|---|
| clean | `7ebeb9897` | **green** (`Tests 1 passed \| 42 skipped`) | 1 on all four edges |
| P1 | my §5.5 plant, as written: before the per-move loop in `flush`, rebuild an existing observable bucket from `[...bucket].sort()` and put it back | **red** | `new issue: {"added":4001,"deleted":0,"iterated":4000,"sorted":4000}: expected 12001 to be 1` |
| old flush | every non-test file of `arms/mobx/pool/` from `54c1e0b23` (frozen sorted-array buckets) | **red** | `new issue: {"added":0,"deleted":0,"iterated":0,"sorted":4001}: expected 4001 to be 1` |
| P3 | read-only copies, no sort, same place: `Array.from(bucket)`, `[...bucket]`, `new Set(bucket)` | **red** | `new issue: {"added":1,"deleted":0,"iterated":12000,"sorted":0}` |
| P4 | in `place()`, after `set.add(id)`: `under.set(path, new Set(set))` (copy-on-write of the plain prefix index) | **green: missed** | none (`Tests 1 passed`) |
| P4s | P4 with a sort: `under.set(path, new Set([...set].sort()))` (the control arm for P4) | **red** | `new session: {"added":1,"deleted":0,"iterated":0,"sorted":8003}: expected 8004 to be 1` |

What this answers:
- **Does `Array.from` or spread over an `ObservableSet` go through `values()`
  in the installed MobX (7.0.3)?** Yes. In the source,
  `ObservableSet[Symbol.iterator]` returns `this.values()`, `forEach` loops
  `for…of this`, `toJSON` is `Array.from(this)`, and the set algebra starts
  from `new Set(this)` (`node_modules/mobx/dist/mobx.cjs.development.js:4444,
  4245, 4438, 4378`). P3 confirms it in the build vitest loads: the three
  copies count 3 × 4,000 = 12,000 elements, so none escapes.
- **Does a copy into a plain `Set` or array go uncounted?** A copy *of an
  observable bucket* into a plain `Set` or array is counted when it is read
  (P3). A copy *of a plain `Set`* is not counted unless it is sorted. P4 and
  P4s are the same copy of the same plain sets, with and without a sort: the
  guard sees 8,003 elements when they are sorted and nothing when they are
  not. The sets are the prefix index for `/`, `/repo` and `/repo/y`, which
  hold the rig's 4,000 sessions. On the live export, `worktree.sessions`
  holds 2,263 under one root (§2.3). The only other path that skips
  `values()` is MobX's private `data_` field, which no code in `pool/`
  touches.
- The cold twins (`coldBuckets`) are plain `Set`s too, but they are keyed by
  closed issues and hold that issue's children or sessions (tens), and the F1
  rig has no residency. So they are not part of G3.

### 6.3 Does a step count the load its own change triggers? (`harness/review/m3-step-load.test.tsx`)

**The settle itself hides nothing.** `counts.test.tsx:87-97` runs before
step #1: it closes the mount's load windows under `act` and then zeroes the
log, stats and reads. It cannot remove anything a step does. But it is there
because the pool in that test has a load window that never closes on its own
(`:69`). So a load that a step's **own** change queues never lands inside
that step. It lands in the harness's `snapshot()`, after the reads have been
sampled, and it is charged to no step.

**The plant.** From step #2 on, the pool's `sessionActivity` input (the #2
session change re-runs it) also asks whether cold issue `i103` is resident
(`pool.resident`, the check a view does before it reads a row). Once `i103`
is loaded, the plant also lists its sessions (`relations.many`). That is a
change whose own work triggers a load. The probe runs four arms with the same
settle and zeroing as `counts.test.tsx`, then steps #1 and #2, and records
#2. `hydratedInStep` is the number of rows loaded before the harness sampled
the reads.

| Arm | Load window | Plant | #2 reads charged | by entity | rows loaded in the step | rows committed | reads fence (budget 3) |
|---|---|---|---|---|---|---|---|
| D | never closes (as `counts.test.tsx`) | no | 1 | session 1 | 0 | 1 | pass |
| C | closes on the next microtask | no | 1 | session 1 | 0 | 1 | pass |
| **A** | never closes (as `counts.test.tsx`) | yes | **2** | session 1, issue 1 | **0** | 1 | **pass** |
| **B** | closes on the next microtask | yes | **2,839** | session 3, issue 2,833, repo 1, worktree 2 | **3** | 2 | **fail**: `read 2839 rows, budget 3` |

C equals D, so the window alone changes nothing on the clean pool. A and B
are the same plant and the same step. The only difference is whether the
load lands inside the step. The counts test's configuration (A) charges the
step for asking about the row (1 issue key) and nothing more. When the load
lands inside the step (B), the step reads 2,839 rows and commits one more row.
The 2,833 issue reads are iterations of the issue table (the fence's
`iterate` accesses are 2,833). That is the pool's resident-issue list,
`issueIds` (`arms/mobx/pool/pool.ts:323-324` → `enumerate.ts:56`
`issueIdsOf`, the one declared enumeration the a1 list draws from). It is a
computed over the table's keys, so it runs again when a loaded issue joins
the table. That list is Mb1's to replace, but it is the real cost of this
load today, and A never charges it. The probe
asserts this A/B, and it passes (`Tests 2 passed`).

**Clean steps.** The same probe runs #1–#4 on the clean pool under both
windows. The cells match exactly: #1 charges 2, #2–#4 charge 1, 0 rows are
loaded in or after any step, and commits are 0/1/1/1. So the numbers the
counts test reports at `7ebeb9897` are right. What fails is that test's
ability to say NO: a regression that makes a step load a row passes it.

### 6.4 What Ma4 must change (send-back lines)

**G2. Count a step's own loads.** In `arms/mobx/pool/counts.test.tsx`, a
load that a step's change queues must land inside that step, before
`runCountScenario` samples reads and commits. For example, give the pool a
window that the step closes inside its `act` (a microtask schedule, as in my
arm B), or have the step's `apply` hydrate until nothing is queued. Keep the
mount settle. After each step, assert that nothing is left queued. Then show
it red: add a planted test next to the sibling re-read one, with the
cold-issue plant from `harness/review/m3-step-load.test.tsx` (`plantedArm`),
and show that #2 fails its reads fence.

**G3. The F1 guard must see unsorted copies of the relation engine's plain
sets.** Extend `countedOutside` (or the test around it) so that plant P4
(§6.2) goes red while clean code stays green. The prefix index writes one
entry per ancestor path when a session is placed, so if plain `Set` work is
counted, restate the per-edge bound to include that (for example, 1 bucket
element plus one index entry per ancestor path of the new row). Do not count
MobX's own internal sets. Keep the counter assertions as they are.

The re-review of G2 and G3 is: P4 and the G2 plant, each red against the
landed tests; clean green; and my probe re-run.

### 6.5 Notes (not send-back)

- **N8.** POD-4635 also changed `arms/mobx/pool/pool.test.tsx` "removes a row
  with its model": it now picks an open issue with no spin-off origin. That
  test asserts exactly one issue model (`modelCount('issue') === 1`), and an
  origin would correctly build a second one, so this narrows the target
  without hiding anything the test is about.
- **N6** (`rootAdded` iterates the plain `under` set) is unchanged. If G3 is
  fixed by counting plain `Set` work, that iteration becomes visible too. It
  is still bounded by the schema doc's "members under one root" rule, and
  the F1 rig adds no root.

## 7. Final review, 2026-09-23, at `b29ea68ce`

**Verdict: FAIL on two lines, G4 and G5. Both are small and neither changes
what the pool does.** G2 and G3, as sent back in §6.4, both PASS: my cold-issue plant now
fails #2 through the shared fence, and the F1 guard is red on both of my
copy-on-write plants. But two other ways of copying the prefix index's plain
sets, `set.union(new Set())` and `structuredClone(set)`, each copy 8,002
elements per new session and the guard stays green. That is the same gap G3
was about, reached by a different idiom (§7.3). The fix is test-only and
closes the whole class: a check that no set the engine holds is replaced by a
new object during one change. It is already written and armed
(`harness/review/m3-index-identity.test.ts`, §7.3). G5: the arm's own lint
(L6a, `eslint-plugin-mobx`) is red at `b29ea68ce`, because the two new load
hooks on `MobxPool` have no `makeObservable` annotation. The fix is two
`false` entries. By operator decision this
review no longer blocks Mb1 (POD-4569). The findings go back to POD-4568 and
land under Mb1. This is the complete list (coordinator ruling): every
remaining concern is either G4 or a note in §7.6.

- **Reviewed commit:** `b29ea68ce` (POD-4568's G2/G3 landing, the tip of
  `integrate/4545-round-three` when this review started). My branch is that
  commit plus commits that touch only `harness/review/*` and this document.
  Paths are relative to `packages/worklist-proto/`.
- **Independence:** I built no part of the MobX pool. Between `7ebeb9897` and
  `b29ea68ce`, `arms/mobx/` changed only in POD-4568's commits `bee3d58ca`,
  `9820d0e4b` and `b29ea68ce`. `shared/src/schema.ts` changed only in
  POD-4580's `c533c6fc2`, which adds `coldByRule`/`viaTargetOf` for the hand
  pool. The MobX pool does not import them. None of these commits is mine.
- **Pool code read:** the only pool changes are the load hooks:
  `arms/mobx/pool/pool.ts:397-414` (`settleLoads`, `pendingLoads`),
  `residency.ts:282` (`queued`) and `arm.ts:78-88` (the handle's
  `settleLoads`: flush this arm's React roots, then land what they queued,
  until nothing is queued). Everything in §5.1 still holds line for line.
- **Load:** 8.9–15.2 (1-minute) during the runs. Counts and assertions only,
  no wall timings.
- **Runner:** package config under the validation queue, from
  `packages/worklist-proto`
  (`bun ../../scripts/validation-admission.ts focused --label <l> -- bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts <files>`).
  Plants were applied by scripts that copy each file aside first and put it
  back with `cp` (a shell `trap` also restores on any exit). The G2 and G3
  plants ran in my worktree, one batch at a time. The identity-check plants
  ran in a detached checkout of my branch. The L4b gate ran in a separate
  detached checkout of `b29ea68ce`, so no plant was ever on disk under it.
  `git status` was clean after every batch.

### 7.1 Checklist lines in this round

| # | Check | Verdict at `b29ea68ce` | Evidence |
|---|---|---|---|
| G2 | A fence step counts the load its own change triggers | **PASS** | `harness/src/fence-scenarios.ts:384-432` `runFenceStep`. Before the step, it lands the loads that were already queued, outside the count (:396-405). Inside `apply`, after the write and `flush()`, it awaits the arm's `settleLoads()` (:414). After the step it refuses a load still pending (:425) and a row read through the feed after the settle (:428-429). `loadHooks` (:353-372) refuses a lazy arm that lacks either hook. The MobX handle's settle flushes its roots' redraws before landing loads (`arms/mobx/pool/arm.ts:78-88`). My plant fails #2 at 2,839 reads under both windows, and the probe is red on the pre-G2 fence (§7.2). |
| G3 | The F1 guard sees an unsorted copy of the relation engine's plain sets | **PASS** | `arms/mobx/pool/relations.test.ts:825-838` `calledByMobx`, `:860-966` `countedOutside` (plain `Set`/`Map` writes, deletes and every iterator, plus `Array.from`), and the per-edge bound `:986-988, 1013`. Clean code is green. P4 fails with `plain … expected 16029 to be less than or equal to 23`, and P4s fails with `sorted 8003` (§7.3). |
| G5 (C11) | L6a lint clean on the pool | **FAIL** | `bun run lint` in the package exits 1, both in my worktree and in a clean detached checkout of `b29ea68ce`: `arms/mobx/pool/pool.ts:290:5 error Missing annotation for settleLoads, pendingLoads … mobx/exhaustive-make-observable`. `MobxPool.settleLoads`/`pendingLoads` (`pool.ts:397, 412`) are new in this landing, and Ma4's G1 landing mail reported the package lint green at `7ebeb9897`. Functionally harmless, since `makeObservable` leaves an unannotated method alone. But the arm's enforcement gate is red at the landed SHA, and the landing mail did not report lint. |
| G4 | The F1 guard sees a copy-on-write of those sets **whatever idiom makes it** | **FAIL** | The guard counts calls to patched prototype methods. `Set.prototype.union` copies the receiver's elements natively, and `structuredClone` calls no prototype method, so neither is counted. As copy-on-writes in `place()` (P7, P8), each copies 8,002 elements per new session and the guard is **green** (§7.3). My identity check is red on P4, P4s, P7 and P8 and green on clean code. |

### 7.2 G2: a step's own load, through the shared fence (`harness/review/m3-step-load.test.tsx`)

My probe now pins the new contract. The old line, `expect(a.hydratedInStep).toBe(0)`,
pinned the defect, and it is now red on the integration branch. It is
replaced by: the load lands in the step (`hydratedInStep > 0`), none lands
after the sample (`hydratedAfterSample === 0`, which is new and counted
directly), the reads fence fails, and A is charged exactly what B is. I
dropped one line I tried first, "reads after the step equal reads charged".
It held only by coincidence: the harness's own `snapshot()` reads the whole
issue table after the sample (2,833 reads even on the clean arm D), and
reads are deduplicated by row.

| Run | Arm | #2 reads charged | by entity | loaded in step / after sample | fence |
|---|---|---|---|---|---|
| clean `c8002b3b9` | D, never, no plant | 1 | session 1 | 0 / 0 | pass |
| clean | C, microtask, no plant | 1 | session 1 | 0 / 0 | pass |
| clean | **A, never (the counts test's window), planted** | **2,839** | session 3, issue 2,833, repo 1, worktree 2 | **3 / 0** | **fail**: `read 2839 rows, budget 3` |
| clean | B, microtask, planted | 2,839 | same | 3 / 0 | fail |
| P-G2a: `fence-scenarios.ts` from `7ebeb9897` | A, planted | 2 | session 1, issue 1 | 0 / **3** | pass (the defect) → probe **red**: `expected 0 to be greater than 0`; Ma4's counts test is red too (`rows loaded in #2`) |
| P-G2b: handle's settle without `flushSync` | A, planted | – | – | – | refused: `#2 … loaded 2 row(s) after the step settled its loads: charged to no step` |

Clean steps #1–#4 are unchanged under both windows: #1 charges 2, #2–#4
charge 1 each, commits are 0/1/1/1, and no row is loaded in or after any
step. P-G2b shows why the handle flushes: a load that a redraw queues at
`act()` exit would otherwise be refused rather than charged. It is still a
NO, not a silent pass.

### 7.3 G3 and G4: the F1 guard and the identity check, planted

Each plant adds one line in `RelationEngine.place()`
(`arms/mobx/pool/relations.ts:627-634`), after `set.add(id)`:
`under.set(path, <copy>)`. That is a copy-on-write of the prefix index's plain
set for every ancestor path of the new session. The rig is the F1 guard's:
4,000 sessions under `/repo`.

| Plant | `<copy>` | F1 guard (`relations.test.ts -t 'bucket upkeep'`) | Identity check (`harness/review/m3-index-identity.test.ts`) |
|---|---|---|---|
| clean | none | green | green: 0 sets replaced on all four edges |
| P4 | `new Set(set)` | **red**: `new session: plain {written 8019, deleted 2, iterated 8008}: expected 16029 <= 23` | **red**: `new session: {keys 2, elements 8002}` |
| P4s | `new Set([...set].sort())` | **red**: `sorted 8003: expected 8004 to be 1` | **red**: same |
| P7 | `set.union(new Set<string>())` | **green: missed** | **red**: same |
| P8 | `structuredClone(set)` | **green: missed** | **red**: same |
| P9 (withdrawn) | `toJS(set)` | green | green: `toJS` returns a plain `Set` unchanged (checked in MobX 7.0.3: `toJS(s) === s`), so P9 copies nothing. It is not a plant. |

The identity check does not count work. Before and after each edge, it
records every set the engine holds (`under`, `buckets` and `coldBuckets` per
link, and each collapse's `groups`) and counts the ones that were replaced
by another object. An in-place update keeps the object. A copy-on-write
swaps it, whatever idiom made the copy. Put together with `countedOutside`,
the two close the class. A copy that is stored changes an object's identity.
A rebuild in place (`clear` and then add everything back) is counted by the
patched `add`. **The residual** is a native copy that is made and then thrown
away, such as `set.union(∅)` whose result is never stored. That wastes
bucket-sized work and changes nothing either check can see. Only an
allocation or time instrument would see it. I record it as N11 rather than
as a fail, because a copy nobody stores has no reason to exist in upkeep
code.

### 7.4 L4b gate, 5 seeds × 300 steps at 1×, live-shaped fixture (POD-4635)

**GREEN.** Run in a detached checkout of `b29ea68ce` with nothing planted,
through the package config under the validation queue:
`POD_POOL_GATE_SEEDS=5 POD_POOL_GATE_STEPS=300 bun ../../scripts/validation-admission.ts focused --label m3-final-gate-5x300 -- bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts arms/mobx/pool/gate.test.ts`.
`Test Files 1 passed`, `Tests 2 passed` (the gate and the own-row oracle
test), 2,778 s, 20:18–21:04 UTC, load 9.0–15.0. The fixture is the 1×
fixture as POD-4635 (L2d, `164b9ae7d`) reshaped it to live shape. That commit
is in `b29ea68ce`. The run was not chunked. The MobX gate has no
`POD_POOL_GATE_FIRST_SEED` (only the hand gate has it, at
`arms/hand/pool/gate.test.ts:91`), and one run fit.

| Seed | Steps / skipped | Rebuild checks | Relation checks | Rows loaded | Checkpoints | `planted` (removals) | `coldDeaf` | `coldRelinkSkipped` | `promoteSkipped` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 300 / 0 | 301 | 301 | 8,281 | 1 | fails, step 15 | fails (partition) | fails (relations) | fails (checkpoint) |
| 2 | 300 / 0 | 301 | 301 | 9,707 | 1 | fails, step 32 | fails (relations) | fails (relations) | fails (checkpoint) |
| 3 | 300 / 0 | 301 | 301 | 4,164 | 1 | fails, step 19 | fails (relations) | fails (relations) | fails (checkpoint) |
| 4 | 300 / 0 | 301 | 301 | 6,916 | 1 | fails, step 3 | fails (relations) | fails (relations) | fails (checkpoint) |
| 5 | 300 / 0 | 301 | 301 | 5,519 | 1 | fails, step 1 | fails (partition) | fails (relations) | fails (checkpoint) |

Zero divergence on the clean pool: 1,505 rebuild comparisons, 1,505
relation-against-scan checks and 5 full-residency checkpoints. Every plant
fails on every seed, each caught by its intended check. `promoteSkipped` is
the sessions-only plant from §5.4a. The gate runs rebuild-only
(`oracleEvery 0`), per the coordinator's correction on POD-4568.

**Other suites at my branch** (pool code identical to `b29ea68ce`), one run
through the package config: `arms/mobx/pool/{bootstrap,counts,models,pool,relations,residency}`,
`harness/native/mobx-pool.native.test.tsx` and my three `harness/review/`
probes gave `Test Files 10 passed`, `Tests 87 passed | 1 skipped` (the
skipped one is the live-export probe, which needs `M3_LIVE_EXPORT`), in 108
s. `bun run typecheck -- --filter @podium/worklist-proto` passed. `bun run
lint` in the package failed, which is G5.

### 7.5 What must change (G4 and G5, go to POD-4568, land under Mb1)

**G5. Annotate the load hooks.** In `arms/mobx/pool/pool.ts:290`, add
`settleLoads: false` and `pendingLoads: false` to the `makeObservable` map.
Acceptance: `bun run lint` in the package exits 0. Report lint in the landing
mail.

**G4. Add the identity check beside the F1 guard.** In
`arms/mobx/pool/relations.test.ts`, "bucket upkeep is proportional to the
change": before and after each edge, record every set the engine holds, then
assert that none was replaced by another object. `harness/review/m3-index-identity.test.ts`
has the code, and its `held()`/`replaced()` pair can be moved in as it is.
Keep `countedOutside` as it is. The two checks see different things (§7.3).
Acceptance: P7 and P8 from §7.3 fail the F1 test, and clean code stays
green. When it lands, my probe file can be deleted.

### 7.6 Notes (not send-back)

- **N9. The fence's lazy-arm detection depends on the caller passing the
  feeds' own `flush`.** `runFenceStep` finds the feeds through a `WeakMap`
  keyed on the `flush` function (`harness/src/fence-scenarios.ts:132, 172,
  392`). If a caller passes a wrapper (`() => feeds.flush()`), `feeds` is
  undefined. The per-row read count is then 0, so a lazy arm without hooks
  is not refused, and the "loaded after the settle" check reads 0 − 0.
  Plant P-G2c: the "no hooks" case in `counts.test.tsx:262` with a wrapped
  flush. The fence then accepts the step (`promise resolved … instead of
  rejecting`). Today all eight call sites pass `feeds.flush` itself (grep
  `runFenceStep(`), so no current test is blind. Fix: throw in
  `runFenceStep` when `FEEDS_OF_FLUSH.get(flush)` is undefined.
- **N10. The pre-step settle is uncounted by design.** It lands only what was
  queued between steps. A step's own loads cannot reach it: those are
  refused after the step if they are still pending. The one path left is a
  load queued on a later macrotask. Nothing in `arms/mobx/pool/` defers work
  that way: the only timer is the residency window's own
  (`residency.ts:130`), which the in-step settle preempts. The only autorun
  is `tracked()`'s, which is synchronous (`pool.ts:160`).
- **N11.** The residual from §7.3: a bucket-sized native copy that is never
  stored is invisible to both upkeep checks.
- **N12.** The handle's settle flushes only the arm's own web roots
  (`arm.ts:80`, `roots`). A native mount (`mountNative`) is rendered by the
  caller's root, so a native-lane fence step would have loads queued by a
  redraw refused (P-G2b's message), not charged. That is a NO, not a silent
  pass. No native lane runs `runFenceStep` today.
- **N3** is unchanged: `shared/src/probes/probes.test.tsx` and
  `harness/native/mobx-pool.native.test.tsx` run the pool without
  `installMobxWarnTrap`. It stays with Mb4. **N5** (feed-shape composition in
  `tables.ts`) and **N6** (`rootAdded` iterates the members under one root)
  are unchanged. N1, N4, N7 and N8 are closed or were already answered in §5
  and §6.
- **Not mine:** `arms/hand/pool/counts.test.tsx` is red at `b29ea68ce` until
  POD-4581 lands the hand handle's `settleLoads`. This is the refusal the G2
  ruling asks for.
