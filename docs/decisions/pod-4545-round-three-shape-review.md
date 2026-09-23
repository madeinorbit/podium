# M3: MobX pool shape review (POD-4591)

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
| C10 | L4b correctness gate, 5 seeds, run by me | TBD | §2.2. |
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

### 2.2 L4b gate, 5 seeds × 300 steps

TBD

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

### F1 (FAIL): bucket maintenance is O(bucket), and `repo.issues` is the issue table

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
- Re-review: re-run §2 at the new SHA (`bun run test:file --
  packages/worklist-proto/harness/review/m3-shape-probes.test.tsx`, the gate
  command in §2.2, `bun run lint` in the package), check C3/C4/C8, and record
  PASS here with the SHA.
