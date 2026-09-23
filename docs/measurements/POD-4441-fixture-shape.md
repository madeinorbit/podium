# POD-4441 fixture shape (G2: POD-4443; reshaped by POD-4635)

Deterministic live-shaped corpus + parity oracle. Code:
`packages/worklist-proto/harness/src/fixture/` (`buildCorpus`),
`packages/worklist-proto/harness/src/oracle/` (`expectedSnapshot`).
Seed default 4443; `FIXED_NOW` = 2026-09-20T12:00:00Z.

**Every count in this document before POD-4635 is the OLD fixture's.** The
old fixture was not live-shaped on most structural dimensions ("Fixture vs
live (POD-4552)" below). POD-4635 reshaped it to the live table; the current
numbers are in the next section.

## The reshaped fixture (POD-4635, seed 4443)

`buildCorpus(scale)` is `scale` units of one workspace plan: 4,867 issues,
4,304 sessions and 468 worktrees per unit, in ONE set of 9 kernel repos and 17
repo roots. A bigger workspace is more work in the same repos, so repo rows,
roots and groups stay while issues, sessions, worktrees and everything
counted over them multiply; shares and depths stay. The unit plan is the live
export's per-kind table (POD-4552, 5,170 issues, 2026-09-23T06:38Z) scaled to
4,867 issues: counts per issue kind (audience × stage × archived/deleted),
depth weights, edge shares and session means per kind. Only the export's
shape is used. None of its content is copied.

| scale | issues | sessions | scan entries | worktrees | repo rows / roots | visible rows | top / nested | groups | pinned |
|---|---|---|---|---|---|---|---|---|---|
| 1x | 4,867 | 4,304 | 485 | 468 | 9 / 17 | **732** | 272 / 460 | 8 | 21 |
| 2x | 9,734 | 8,608 | 953 | 936 | 9 / 17 | 1,465 | 543 / 922 | 8 | 42 |
| 4x | 19,468 | 17,216 | 1,889 | 1,872 | 9 / 17 | 2,928 | 1,085 / 1,843 | 8 | 84 |

Scan entries are the 17 roots plus the standalone entry a real scan reports
for every linked worktree (live: 541 = 34 root entries + 507), dropped by
legacy `reposToViews` and by the row source alike.

### Against the live table, at every scale

Measured by `measureShape` (`harness/src/fixture/shape.ts`), the instrument
the live comparison uses. Asserted in `harness/src/fixture/corpus.test.ts`,
"buildCorpus shape at %ix": one named case per dimension, each within 20% of
live (counts times the scale; shares and depths as they are; repo rows, roots
and groups unscaled), so a drift fails the dimension that drifted.

{table}

**Chosen, not copied (one moment).** The export is 06:38Z, the quiet end of
the operator's day: 32 live sessions, 5 working rows. A benchmark fixture at
that level would give #2 and the working roll-up almost nothing to move, so
the fixture keeps a working-day level instead: about 2% of sessions live and
6–7% of rows working (the old fixture had 15% and 67%). The phase shares
(queued, waiting, done) follow live within 20%; the working share is held to
2–10% of rows and live sessions to 1–4% of sessions. Pinned rows (21) are
matched to the export.

**Not matched (not in the brief, recorded):** resume-twin groups stay at
the planted three per unit (live 10), so the twin collapse removes 2 sessions
per unit (live 10). Depth 6 holds 3 issues at 1x (live 4). The per-issue
extremes differ: live's largest `issue.sessions` bucket is 190 and its largest
`issue.children` 245 (M3, POD-4591); the fixture's missions carry at most
~100 children and ~6 sessions.

**What the generator keeps from before.** Resume twins (one group of each kind
per unit), hidden askers (20 per unit), valid sort keys (`spreadSortKeys`),
the unscanned worktree (POD-4550) and the rescue/keeper pair (#6d), all
asserted as before. The named fork trap (`/w/alpha` vs `/w/alpha-fork`,
`/w/beta` vs `/w/beta-fork`) is two of the 19 pairs per unit.

**Deliberate limits** (each tested, so a later change is loud):

- *A visible row is never blocked by unfinished work.* `blocks` edges are
  live-shaped (32–33% of issues), but a `blocks` edge from a visible row only
  ever points at finished work. A blocked row changes what the row asks
  (`issuePendingDecision`), and spec §6 keeps dependency semantics out of the
  comparison. On the live export that costs 4 of 759 rows (phase and asking;
  measured by stripping the edges and re-running the oracle). Test: "never
  blocks a visible row on open work".
- *No visible review row is a spin-off origin.* A review row whose work
  continued in a live spin-off stops asking (`issueContinuation`,
  `row-attention.ts:150`); spec §6 keeps the continuation walk out. On the
  live export, stripping `discovered-from` changes 10 rows' phase and asking
  and 44 rows' progress.
- *`needsHuman` sits on hidden open issues only* (44 per unit, live 46).
- *`startedBySession` nests exactly the 12 planted top-level issues per unit*
  (live 12). Every other visible top-level row that carries a starter is a
  spin-off, which legacy keeps top-level (`rows.ts:288`), as live's 55 are.
- *Pins state stays empty* (live: 8 panels, 10 worktrees). The scenario
  engine answers `pins.list` empty, so the oracle and the engine would
  disagree on pinned lanes. `issue.pinned` covers the PINNED section.
- *A `shipping` cover* (5 per unit): a system-owned stage the derivation
  skips, not seen live.
- *Ids follow creation order*: a child is created after its parent and gets
  a later id, as live `seq` does. Rule-picked targets ("first by id") are the
  oldest that qualify.

### The #2 target (from Ma4, POD-4568)

`pickTargets` now requires the #2 root's family (every session bound to it,
the schema's `issue.sessions`) to be larger than one level of the #2 reads
budget (`PHASE_FAMILY_FLOOR` = `READ_BUDGETS.phaseChangePerLevel` = 3). Every
unit's first five open missions with children carry one working session
among five. The rules live once, in `targetRules` (`phaseRoot` is the rename's
`openRootWithChildren` plus #2's session condition); `pickTargets` and the
browser page both call it.

Proof (`scenarios.test.ts`, "#2 target family is larger than one level of the
reads budget"): the floor equals the harness budget; the family exceeds it at
1x, 2x and 4x; `startEngineOnCorpus` boots at 1x, 2x and 4x with the
rule-picked targets; control: the same root with its family trimmed to 3 is
refused. And the planted arm (`arms/mobx/pool/counts.test.tsx`, member
activity read from the rows again) now FAILS #2's reads fence: it reads the
whole family (7 sessions at 1x: five that keep the row, two historical)
against a budget of 3. On the old target (`i17`, 3 sessions) it passed at
exactly 3.

**The live export still cannot boot the engine.** At 06:38Z it had 6 live
working sessions and none on an open root with children whose subtree is
otherwise idle, so no #2 target exists at that moment (`targetRules` finds 39
open roots with children, 130 childless open roots, 0 `phaseRoot`). The #2
rule needs a working session by design; an export taken during a working day
would be expected to satisfy it.

### What moves (re-run before comparing)

Every number measured on the old fixture must be re-run on this one before
anything is compared against it:

- **Ma4 fence cells** (`docs/measurements/POD-4568-a.md`, "Fence steps #1–#4
  at 1x"): the targets moved (old `i17` / `s34` / `s2135`, new at 1x: root
  `i214`, phase session `s15`, heartbeat `s2284`), so every cell there
  (changed rows, drawn rows, reads, rows committed, pool counters) and the
  finding in its "#2 cannot catch a sibling re-read" section are old-fixture
  numbers. The finding is resolved by the target rule above.
- **The flatblock no-op floor (POD-4558)** was measured on the old fixture's
  211-row list; the list is now 732 / 1,465 / 2,928 rows.
- **Reads budgets that depend on the corpus**, replayed exactly as
  `runFenceScenarios` computes them (budget before each write, one engine per
  scale, steps in order):

| step | old 1x / 2x / 4x | new 1x / 2x / 4x |
|---|---|---|
| #8b clock grace crossing | **0 / 0 / 0** | **144 / 288 / 576** |
| #10 burst (50 issues, 3 × (ancestors + 1) each) | 171 / 195 / 243 | 168 / 177 / 156 |
| every other step (#1–#8, #9a–c) | unchanged | unchanged |

  #8b had no row crossing the 24 h grace window on the old fixture, so its
  budget was 0 and the step exercised nothing; now 6 rows per unit cross.
  The burst's chain mix now follows creation order; its budget no longer
  grows with scale, because a bigger workspace does not deepen the oldest
  issues' chains.
- **The #5, #6 and #7 constants rest on "~850 visible rows at 4x"**
  (`READ_BUDGETS` comments, log2 ≈ 10 probes). The list is now 2,928 rows at
  4x: log2 ≈ 11.5, about two more probes per binary search. The constants
  did not change; their premise did.
- **Oracle and build time** (next line) and every wall time taken on the
  old fixture.

**Oracle time, and a harness fix it forced.** The oracle's projection
(`projectRow`, `harness/src/oracle/oracle.ts`) rebuilt
`indexMissionSessions(sessions)` for every row without a stamped roll-up, that
is every nested row: O(rows × sessions). The old fixture had 65 nested rows;
this one has 460 per unit, and a CPU profile at 2x put 76% of the oracle's
time there. The index is now built once per projection (a pure function of
the sessions, so the result is identical; every parity test is unchanged).
In-process under bun, NOT under the bench lock, load average 19–22, so only
an order of magnitude: build 0.7 / 0.8 / 1.6 s and oracle 1.2 / 1.8 / 4.7 s
at 1x / 2x / 4x after the fix, against 46 s at 4x before it (old fixture,
quiet box: oracle 0.16 / 0.66 / 2.2 s). On the live export the same oracle
takes ~2 s at 1x, the fixture ~0.8 s, in the same run.

## Shape at every scale, old fixture (POD-4551)

Kept as history; superseded by the section above.


Asserted in `harness/src/fixture/corpus.test.ts`, "buildCorpus shape at %ix".
Measured with the resume twins and hidden askers in place (below). No
generator proportion drifted between scales, so the generator's minting was
left as it was.

| measure | 1x | 2x | 4x | assertion |
|---|---|---|---|---|
| visible rows | 211 | 422 | 844 | 211 × scale ± 10% |
| depth 1 share | 59.4% (2,891) | 58.2% (5,664) | 58.7% (11,419) | within 5 points of 1x |
| depth 2 share | 28.4% (1,383) | 29.1% (2,835) | 28.8% (5,611) | within 5 points of 1x |
| depth 3 share | 9.1% (445) | 9.9% (962) | 9.8% (1,906) | within 5 points of 1x |
| depth 4 share | 3.0% (148) | 2.8% (273) | 2.7% (532) | within 5 points of 1x; max depth 4 |
| prefix-owned sessions | 430 (10.0%) | 860 (10.0%) | 1,721 (10.0%) | 9–11% |
| discovered-from edges | 249 (5.1%) | 536 (5.5%) | 1,066 (5.5%) | 4–6% |
| hidden askers | 20 | 40 | 80 | exactly 20 × scale, roots visible and not asking |
| resume-twin groups | 3 | 6 | 12 | one of each kind per scale unit |
| open issues | 2,170 | 4,340 | 8,680 | (1x only: ~2,230) |
| groups / pinned | 165 / 6 | 350 / 12 | 691 / 24 | — |
| phases (waiting / working / queued / done) | 101 / 57 / 32 / 21 | 182 / 133 / 65 / 42 | 397 / 232 / 131 / 84 | not asserted |

The phase mix is not proportional to scale: waiting is 47.9% / 43.1% / 47.0%
of visible rows and working 27.0% / 31.5% / 27.5%. Those phases come from
per-row `rng` draws over the live sessions, not from a scaled count, so they
wobble by a few points. No acceptance line covers them; recorded so a growth
reader does not mistake the wobble for a regression.

### Hidden askers (the POD-4549 shape)

20 × scale asking sessions (live, idle, standing offer) on open archived or
proposed leaves, reparented under sessionless visible roots that are not in
`review` (a review root asks on its own account). Legacy detaches the ask:
the hidden child has no row (`rows.ts:63-69`) and its sessions join no lane
(`rows.ts:201-210`). So every root reads NOT asking at every scale. Control:
un-hiding those children makes every one of their roots ask.

### Resume twins (coordinator addendum)

One group of each kind per scale unit, each on its own sessionless visible
root, sharing a `codex-thread` resume ref:

| kind | rows | legacy collapse keeps | root row |
|---|---|---|---|
| inactive | hibernated ask (6 h ago) + exited run (3 h ago) | the hibernated ask (rank beats recency) | asking, not working |
| tie | hibernated ask (6 h ago) + hibernated quiet (2 h ago) | the quiet row (most recent) | queued, not asking |
| live | live working (1 min ago) + hibernated ask (6 h ago) | both (a live row keeps the group whole) | working and asking |

**The oracle changed.** `runLegacyDerivation` (`harness/src/oracle/oracle.ts`)
used to pass `corpus.sessions` raw as `store.sessions`. The runtime does
not: it sets `store.sessions = dedupeSessions(replica sessions)` at boot
(`client-core/src/engine/runtime.ts:465`) and on every session change
(`:1172`), through `dedupeSessions` (`engine/optimism.ts:875`). With twins
in the corpus, the raw oracle disagreed with the app on exactly the tie
rows, so parity was inverted: a pool that implemented the collapse would
have failed, and one that forgot it would have passed. The oracle now
dedupes the same way. Its stub replica stays raw, as the runtime replica
keeps every row. Every parity result from this commit on depends on it
(coordinator ruling on POD-4551).

Proved both ways, at every scale (`corpus.test.ts`):
- the oracle shows each tie root the way the app does (queued, not asking);
- a derivation that forgets the collapse (the same corpus with the resume
  refs stripped, a test-local switch) fails parity on exactly the tie roots,
  1 / 2 / 4 rows at 1x / 2x / 4x;
- mutation: reverting the oracle to raw sessions fails both twin tests at
  all three scales (6 failures);
- the round-two arms, which never implemented the collapse, now fail parity
  on the tie root (`i286` at 1x) in 18 tests across 13 files. They were
  green on the integration tip before this change.

Both shapes reuse rows the corpus already had: sessions come from the tail
of the closed-bulk decayed remainder, the children are existing archived
or proposed leaves. They draw nothing from `rng`. Diffed against the
previous corpus, only the reseated sessions, the reparented children, the
roots, and the rollups of the issues that gave up a session changed. Every
other row is byte-identical (1x: 26 sessions, 49 wire issues).

### Sort keys a server would send (from L4a, POD-4555)

The corpus used to mint `a0`, `a1` and `r<k>`. `isSortKey`
(`model/src/predicates/sort-key.ts:58`) refuses `a0` and `r0`, `r30`, and so
on (a trailing minimum digit), and the model's own `sortKeyBetween` refuses
them as bounds. Legacy parity ordered them as plain strings, which is why
nothing caught it. Keys now come from the model's `spreadSortKeys`: two
sibling keys (oldest, then second-oldest) and one per keyed root, ascending.
That keeps the ordering properties the sort-key cases rely on: keyed rows
ahead of unkeyed ones, keyed order running against creation order, and
mixed groups (`oracle.test.ts` sort-key block, unchanged and green).
`corpus.test.ts` asserts every key passes `isSortKey` at every scale. A
planted `a0` fails that check.

### Scenario server writes (from L4a, POD-4555)

`patchIssue` and `patchSession` in `shared/src/scenarios.ts` built their
"server" rows from the runtime snapshot, which is painted with the client's
pending overlays. So a scenario write could echo a pending value back as
server truth. They now read the kernel cache, as the change generator does
(`gen/run.ts`). Test (`scenarios.test.ts`, "scenario server writes build on
server truth"): a title edit is held pending by a server that never answers,
then a stage move lands on the same row. The written row carries the
server's title. Mutation: building from the snapshot again makes it carry
"Pending title" and fail.

## Shape at 1x, old fixture

Kept as history (before POD-4635).


- Open issues (no `closedAt`): 2,170 (~2,230).
- With parent (`parentId`): 1,976 / 4,867 = 40.6% (~40% children; 1,963 before POD-4551 reparented the 13 askers that were roots).
- Depth histogram: depth 1: 2,891 · depth 2: 1,383 · depth 3: 445 · depth 4: 148
  (max 4; chains depth 1–4).
- Outgoing `discovered-from` edge: 249 issues = 5.1% (~5%); origins always
  hold open sessions, so no origin reads as vacated and no continuation is
  ever stamped.
- Sessions with no `issueId`: 430 / 4,304 = 10.0% (~10%), all with `cwd`
  under a `/w/` worktree root (R3 prefix ownership). Fork trap pair present:
  `/w/alpha` vs `/w/alpha-fork`, `/w/beta` vs `/w/beta-fork`.
- Bands at 1x: 0: 13 · 1: 182 · 2: 16 (pinned/returned, middle, snoozed —
  all non-trivial; `deferUntil` minted ±45 d around `FIXED_NOW` plus two
  `next-message` sentinels).
- Phases at 1x: queued 32 · working 57 · waiting 101 · done 21 (all four
  covered). Closed-fold rows: 17 (`closed: true`).
- Session ids unique; `resume` refs only on the twin groups (see above).
  No `startedBySession` anywhere (see below).
- `displayRef` covers both spellings (`POD-<seq>` and `#<seq>`); repo `r5`
  spans two paths (`/repo-5`, `/other-path-5`) for the group-merge rule.

## Fixture vs live (POD-4552)

**This table is the OLD fixture against live.** The reshaped fixture's
comparison is "Fixture vs live after POD-4635" below.

The fixture's realism, measured instead of asserted. One anonymised export of
the live workspace (ludovico, backend `:18787`) at **2026-09-23T06:38:21Z**,
feed seq 5,828,147, exporter at `964133e06`, box load 12–13 (no timing is read
from it; every number below is a count). The export itself is NOT committed:
it is attached to POD-4552 (`live-snapshot-2026-09-23.json.gz`, gitignored
under `packages/worklist-proto/harness/.live/`).

**How it was read.** `harness/src/fixture/export-snapshot.ts` reads what the
web client reads, the way it reads it: the kernel rows from
`HttpBootstrapSource` (`/sync/bootstrap`, the class the web replica
bootstraps through), the machine scan and pins from the runtime's two boot
calls (`discovery.refreshRepos`, `pins.list`), with the web's auth (the
`podium_session` cookie from the CLI's `~/.podium/cli-session.json`). One
bootstrap stream, read once.

```
bun --conditions=@podium/source packages/worklist-proto/harness/src/fixture/export-snapshot.ts
bun --conditions=@podium/source packages/worklist-proto/harness/src/fixture/export-snapshot.ts --compare <export.json.gz>
```

**Anonymisation.** Every string is hashed with a keyed HMAC (random key per
run, never stored) unless its key is an id, enum, timestamp or `displayRef`
AND its value is one token. Paths are hashed per segment so every containment
relation survives, the string-prefix fork trap included. Proven on this
export: the oracle over the raw rows and over the hashed rows agree on all
759 rows except titles (`anonymisation.parity` in the file); an audit of the
file finds no verbatim string that is not a single token. What stays readable:
ids, enums, timestamps, `POD-123`-style refs and the nine 3-letter repo
prefixes. The first export of the day kept `closedReason` verbatim (live rows
hold closing summaries there); it was deleted, and the one-token rule was
added (test: "hashes a sentence under a kept key").

**One instrument for both sides.** `measureShape` (`harness/src/fixture/shape.ts`)
runs on the fixture and on the export alike. Rows come from `expectedSnapshot`
(the oracle `corpus.test.ts` counts); lanes come from the legacy sections
(`slice.sections`, the lanes the app shows, a repo root being a lane of its
own); seating is the legacy longest-prefix rule (`worktreeForCwdIndexed`).
Before any live number was read, `shape.test.ts` proved it on the fixture:
parents, open issues, depth histogram, origin edges and prefix-owned sessions
equal `buildCorpus`'s own `stats`, and the row count equals `corpus.test.ts`'s.

Deviation is |live − fixture| / fixture, on the share where the row says
"/ issues", "/ sessions" or "/ visible", on the count otherwise.

| measure | fixture 1x | live | deviation | follow-up |
|---|---|---|---|---|
| issues | 4,867 | 5,170 | 6% |  |
| sessions | 4,304 | 4,624 | 7% |  |
| repo prefixes (kernel `repo` rows) | 500 | 9 | 98% | **yes** |
| scan repos (`GitRepositoryWire`) | 500 | 541 | 8% |  |
| visible rows (oracle `rowsById`) | 211 | 759 | 260% | **yes** |
| top-level rows | 146 | 283 | 94% | **yes** |
| nested (started-by) rows | 65 | 476 | 632% | **yes** |
| worktree-kind rows (dropped) | 200 | 4 | 98% | **yes** |
| open issues / issues | 2,170 (44.6%) | 2,284 (44.2%) | 1% |  |
| with parent / issues | 1,976 (40.6%) | 3,159 (61.1%) | 50% | **yes** |
| depth 1 / issues | 2,891 (59.4%) | 2,011 (38.9%) | 35% | **yes** |
| depth 2 / issues | 1,383 (28.4%) | 1,699 (32.9%) | 16% |  |
| depth 3 / issues | 445 (9.1%) | 889 (17.2%) | 88% | **yes** |
| depth 4 / issues | 148 (3.0%) | 506 (9.8%) | 222% | **yes** |
| depth 5 / issues | 0 (0.0%) | 61 (1.2%) | ∞ (fixture 0) | **yes** |
| depth 6 / issues | 0 (0.0%) | 4 (0.1%) | ∞ (fixture 0) | **yes** |
| max depth | 4 | 6 | 50% | **yes** |
| discovered-from edges / issues | 249 (5.1%) | 1,788 (34.6%) | 576% | **yes** |
| `blocked-by` deps / issues | 0 (0.0%) | 13 (0.3%) | ∞ (fixture 0) | **yes** |
| `blocks` deps / issues | 0 (0.0%) | 1,751 (33.9%) | ∞ (fixture 0) | **yes** |
| `bogus` deps / issues | 0 (0.0%) | 1 (0.0%) | ∞ (fixture 0) | **yes** |
| `duplicate` deps / issues | 0 (0.0%) | 16 (0.3%) | ∞ (fixture 0) | **yes** |
| `duplicates` deps / issues | 0 (0.0%) | 3 (0.1%) | ∞ (fixture 0) | **yes** |
| `related` deps / issues | 0 (0.0%) | 249 (4.8%) | ∞ (fixture 0) | **yes** |
| `supersedes` deps / issues | 0 (0.0%) | 27 (0.5%) | ∞ (fixture 0) | **yes** |
| `waits-on` deps / issues | 0 (0.0%) | 11 (0.2%) | ∞ (fixture 0) | **yes** |
| prefix-owned sessions / sessions | 430 (10.0%) | 701 (15.2%) | 52% | **yes** |
| lanes | 968 | 521 | 46% | **yes** |
| repo-root lanes | 500 | 17 | 97% | **yes** |
| worktree lanes | 468 | 504 | 8% |  |
| nested lanes (inside another lane) | 0 | 202 | ∞ (fixture 0) | **yes** |
| fork-trap lane pairs | 1,674 | 19 | 99% | **yes** |
| prefix-owned → repo-root lane / sessions | 0 (0.0%) | 152 (3.3%) | ∞ (fixture 0) | **yes** |
| prefix-owned → worktree lane / sessions | 425 (9.9%) | 40 (0.9%) | 91% | **yes** |
| prefix-owned → no lane / sessions | 5 (0.1%) | 509 (11.0%) | 9376% | **yes** |
| sessions in repo-root lanes / sessions | 3,135 (72.8%) | 1,287 (27.8%) | 62% | **yes** |
| `startedBySession` / issues | 0 (0.0%) | 3,770 (72.9%) | ∞ (fixture 0) | **yes** |
| `coordinatorSessionId` / issues | 0 (0.0%) | 1,315 (25.4%) | ∞ (fixture 0) | **yes** |
| `needsHuman` / issues | 0 (0.0%) | 46 (0.9%) | ∞ (fixture 0) | **yes** |
| sessions with `resume` / sessions | 6 (0.1%) | 3,493 (75.5%) | 54088% | **yes** |
| live sessions / sessions | 631 (14.7%) | 32 (0.7%) | 95% | **yes** |
| resume-twin groups (2+ sessions, one ref) | 3 | 10 | 233% | **yes** |
| sessions removed by the twin collapse | 2 | 10 | 400% | **yes** |
| discovery-only lanes | 43 | 200 | 365% | **yes** |
| scan repos on hidden machines | 0 | 0 | 0% |  |
| closed issues in the 24 h grace window | 4 | 68 | 1600% | **yes** |
| `PREFIX-seq` rows / visible | 177 (83.9%) | 757 (99.7%) | 19% |  |
| groups | 165 | 8 | 95% | **yes** |
| pinned rows | 6 | 21 | 250% | **yes** |
| closed-fold rows / visible | 17 (8.1%) | 71 (9.4%) | 16% |  |
| asking rows / visible | 101 (47.9%) | 281 (37.0%) | 23% | **yes** |
| working rows / visible | 142 (67.3%) | 9 (1.2%) | 98% | **yes** |
| phase queued / visible | 32 (15.2%) | 284 (37.4%) | 147% | **yes** |
| phase working / visible | 57 (27.0%) | 5 (0.7%) | 98% | **yes** |
| phase waiting / visible | 101 (47.9%) | 281 (37.0%) | 23% | **yes** |
| phase done / visible | 21 (10.0%) | 189 (24.9%) | 150% | **yes** |

### What the snapshot contains

Exactly these, as the web client holds them: 5,170 `issue` rows and their
5,170 `issueProjection` rows, 4,624 `session` rows, 9 `repo` rows (id,
prefix), 3,872 `issueDep` rows, the machine scan (541 repositories with 507
worktrees on 6 machines, `GitRepositoryWire`), the 6 machine rows, and the
operator's pins (8 panels, 10 worktrees). The bootstrap's other kinds
(conversations, issue events, layouts, pending interactions, automations,
read positions) are counted in `bootstrapEntityCounts` and not exported.
Readable: ids, enums, timestamps, `POD-123`-style refs, the nine repo
prefixes, machine ids and pin panel ids. Hashed: titles, descriptions, briefs,
notes, labels, branches, offers, asks, closing summaries, machine names and
inventories, origin URLs and every path. The file stays on the issue and in the
gitignored `harness/.live/`; it is not published anywhere else.

### Live-only cases the fixture barely has

| case | fixture 1x | live |
|---|---|---|
| resume-twin groups (2+ sessions sharing a ref) | 3 | 10 |
| sessions the runtime's twin collapse removes | 2 | 10 |
| discovery-only lanes (no issue names them, no session sits in them) | 43 | 200 |
| scan repos on machines the principal cannot see | 0 | 0 (the operator sees all 6 machines) |
| closed issues in the 24 h grace window | 4 | 68 |
| repo-root lanes / unbound sessions seated only by a root | 500 / 0 | 17 / 152 |

Hidden-machine repos cannot be measured here: the snapshot is the operator's,
and the operator can see every machine. The feed's known divergence (it does not
apply machine scoping) is therefore not exercised by this snapshot either.

**Prefix join (POD-4624).** 757 of the 759 live rows read `PREFIX-seq` through
the repo-row join. The other two have no repo row with a prefix, so `#seq` is
correct for them. The
exporter refuses to write, and `--compare` refuses to measure, a snapshot with
no repo rows, no `PREFIX-seq` row, or any row whose label disagrees with its
repo row (`assertPrefixFidelity`). Tests: "labels rows through the repo-row
prefix join", and a control where losing the repo rows, or only their join,
throws "prefix join lost".

### Reading the table

- **Visible rows: 759, not 211.** 283 are top-level rows and 476 are nested
  started-by rows: 72.9% of live issues carry `startedBySession`, and the
  fixture mints none (see "Deliberate fixture divergences" above, which
  predicted ~200 extra nested rows; live adds 476). The stage-0 "211 visible
  rows" (POD-4286, 4,968 issues) is not reproduced by either count today. It
  was a different definition or a different day; this export cannot tell which.
  The oracle's row set, which arms must match, is 759.
- **The row count is the stub oracle's, not a booted runtime's.**
  `startEngineOnCorpus` refuses the live corpus: `pickTargets` finds none of
  the fixture's planted targets ("no open human root with children and
  exactly one working session"). So the engine cross-check was not run.
  `expectedSnapshot` is the same oracle the fixture's 211 comes from, so the
  two sides were measured the same way.
- **Time-dependent rows** (live sessions, working, asking, the phase mix,
  pinned) describe one moment, 06:38Z. They are listed because they cross
  20%, but a single export cannot give a typical value. Live had 32 live
  sessions and 5 working rows then.

### Repo-root lanes (coordinator addendum, POD-4565)

The live feed carries 17 repo-root lanes. 152 unbound sessions (3.3%) sit in a
repo root and in no worktree, so only a root lane seats them. 202 lanes are
nested inside another lane (`<repo>/.worktrees/x`), where the longest prefix
must pick the worktree over the root. 509 unbound sessions (11.0%) are under
no lane at all. The fixture's feed lanes (derived from its scan, as the row
source derives them) do include 500 roots, one per scan repo, but none of its
unbound sessions sits in a root, and no lane nests. Its static
`sliceWorktrees` has 468 worktree lanes and no root at all.

Assertion: `shape.test.ts`, "repo-root lanes (POD-4565 addendum)". A
four-session workspace (root, nested worktree, `/r` vs `/r-fork`, no lane)
must measure 2 root lanes, 1 nested lane, 1 fork-trap pair and 2 / 1 / 1
root / worktree / unresolved seatings. The control hands the same workspace a
root-less lane list (the `sliceWorktrees` shape), and the root sessions become
unresolved. Mutation: dropping `isMain` lanes from `measureShape` fails the
test (`expected 1 to be 3`); hashing path segments without sibling knowledge
fails "keeps every lane relation" and the fork-trap control.

### Fixture follow-ups (deviation above 20%)

Grouped by what the generator would have to change; the coordinator decides
which to take.

1. **Started-by nesting.** `startedBySession` 0% vs 72.9%. Nested rows 65 vs
   476, top-level 146 vs 283, visible 211 vs 759. The row budget of 211 holds
   only because the fixture never nests. `coordinatorSessionId` 0% vs 25.4%;
   `needsHuman` 0% vs 0.9%.
2. **Hierarchy.** With parent 40.6% vs 61.1%; depth 1 59.4% vs 38.9%, depth 3
   9.1% vs 17.2%, depth 4 3.0% vs 9.8%, depths 5–6 absent vs 65 issues; max
   depth 4 vs 6.
3. **Dependency edges.** The fixture mints only `discovered-from`, on 5.1% of
   issues; live has it on 34.6%. `blocks` 0 vs 1,751 (33.9%), which makes the
   fixture's "blocked is always false" unrealistic. Live also has `related`
   249, `supersedes` 27, `duplicate` 16, `blocked-by` 13, `waits-on` 11,
   `duplicates` 3 and one `bogus`.
4. **Repo identity and grouping.** Kernel repo prefixes 500 vs 9; groups 165
   vs 8. Fork-trap lane pairs 1,674 vs 19: the fixture's `/repo-1`,
   `/repo-10`, `/repo-100` naming makes string-prefix pairs almost everywhere.
5. **Lanes and seating.** Root lanes 500 vs 17, lanes 968 vs 521, nested lanes
   0 vs 202. Unbound sessions are 10.0% vs 15.2% of sessions, seated by a
   worktree 9.9% vs 0.9%, by a root 0% vs 3.3%, by nothing 0.1% vs 11.0%.
   Sessions in root lanes 72.8% vs 27.8%. Worktree-kind rows 200 vs 4.
6. **Resume refs.** 0.1% vs 75.5% of sessions. On live the twin collapse
   (`dedupeSessions`) runs over most sessions, not over six.
7. **Time-dependent, one moment.** Live sessions 14.7% vs 0.7%; working rows
   67.3% vs 1.2%; phases queued 15.2% vs 37.4%, working 27.0% vs 0.7%,
   waiting 47.9% vs 37.0%, done 10.0% vs 24.9%; pinned rows 6 vs 21. It would
   take several exports across a working day to settle these.

Within 20%: issues, sessions, scan repos, open share, depth 2, worktree lanes
and closed-fold rows.

## Fixture vs live after POD-4635

The same command on the reshaped fixture, against the same export:

```
bun --conditions=@podium/source packages/worklist-proto/harness/src/fixture/export-snapshot.ts --compare <export.json.gz>
```

| measure | fixture 1x | live | deviation | follow-up |
|---|---|---|---|---|
| issues | 4,867 | 5,170 | 6% |  |
| sessions | 4,304 | 4,624 | 7% |  |
| repo prefixes (kernel `repo` rows) | 9 | 9 | 0% |  |
| scan repos (`GitRepositoryWire`) | 485 | 541 | 12% |  |
| largest repo / issues | 4,055 (83.3%) | 4,574 (88.5%) | 6% |  |
| visible rows (oracle `rowsById`) | 732 | 759 | 4% |  |
| top-level rows | 272 | 283 | 4% |  |
| nested (started-by) rows | 460 | 476 | 3% |  |
| worktree-kind rows (dropped) | 4 | 4 | 0% |  |
| open issues / issues | 2,166 (44.5%) | 2,284 (44.2%) | 1% |  |
| with parent / issues | 2,969 (61.0%) | 3,159 (61.1%) | 0% |  |
| depth 1 / issues | 1,898 (39.0%) | 2,011 (38.9%) | 0% |  |
| depth 2 / issues | 1,620 (33.3%) | 1,699 (32.9%) | 1% |  |
| depth 3 / issues | 797 (16.4%) | 889 (17.2%) | 5% |  |
| depth 4 / issues | 485 (10.0%) | 506 (9.8%) | 2% |  |
| depth 5 / issues | 64 (1.3%) | 61 (1.2%) | 10% |  |
| depth 6 / issues | 3 (0.1%) | 4 (0.1%) | 26% | **yes** |
| max depth | 6 | 6 | 0% |  |
| discovered-from edges / issues | 1,697 (34.9%) | 1,788 (34.6%) | 1% |  |
| `blocked-by` deps / issues | 12 (0.2%) | 13 (0.3%) | 2% |  |
| `blocks` deps / issues | 1,597 (32.8%) | 1,751 (33.9%) | 3% |  |
| `bogus` deps / issues | 1 (0.0%) | 1 (0.0%) | 6% |  |
| `duplicate` deps / issues | 15 (0.3%) | 16 (0.3%) | 0% |  |
| `duplicates` deps / issues | 3 (0.1%) | 3 (0.1%) | 6% |  |
| `related` deps / issues | 234 (4.8%) | 249 (4.8%) | 0% |  |
| `supersedes` deps / issues | 25 (0.5%) | 27 (0.5%) | 2% |  |
| `waits-on` deps / issues | 10 (0.2%) | 11 (0.2%) | 4% |  |
| prefix-owned sessions / sessions | 654 (15.2%) | 701 (15.2%) | 0% |  |
| lanes | 485 | 521 | 7% |  |
| repo-root lanes | 17 | 17 | 0% |  |
| worktree lanes | 468 | 504 | 8% |  |
| nested lanes (inside another lane) | 202 | 202 | 0% |  |
| fork-trap lane pairs | 19 | 19 | 0% |  |
| prefix-owned → repo-root lane / sessions | 142 (3.3%) | 152 (3.3%) | 0% |  |
| prefix-owned → worktree lane / sessions | 38 (0.9%) | 40 (0.9%) | 2% |  |
| prefix-owned → no lane / sessions | 474 (11.0%) | 509 (11.0%) | 0% |  |
| sessions in repo-root lanes / sessions | 1,129 (26.2%) | 1,287 (27.8%) | 6% |  |
| `startedBySession` / issues | 3,577 (73.5%) | 3,770 (72.9%) | 1% |  |
| `coordinatorSessionId` / issues | 1,291 (26.5%) | 1,315 (25.4%) | 4% |  |
| `needsHuman` / issues | 44 (0.9%) | 46 (0.9%) | 2% |  |
| sessions with `resume` / sessions | 3,279 (76.2%) | 3,493 (75.5%) | 1% |  |
| live sessions / sessions | 84 (2.0%) | 32 (0.7%) | 65% | **yes** |
| resume-twin groups (2+ sessions, one ref) | 3 | 10 | 233% | **yes** |
| sessions removed by the twin collapse | 2 | 10 | 400% | **yes** |
| discovery-only lanes | 193 | 200 | 4% |  |
| scan repos on hidden machines | 0 | 0 | 0% |  |
| closed issues in the 24 h grace window | 70 | 68 | 3% |  |
| `PREFIX-seq` rows / visible | 730 (99.7%) | 757 (99.7%) | 0% |  |
| groups | 8 | 8 | 0% |  |
| pinned rows | 21 | 21 | 0% |  |
| closed-fold rows / visible | 73 (10.0%) | 71 (9.4%) | 6% |  |
| asking rows / visible | 269 (36.7%) | 281 (37.0%) | 1% |  |
| working rows / visible | 50 (6.8%) | 9 (1.2%) | 83% | **yes** |
| phase queued / visible | 264 (36.1%) | 284 (37.4%) | 4% |  |
| phase working / visible | 29 (4.0%) | 5 (0.7%) | 83% | **yes** |
| phase waiting / visible | 269 (36.7%) | 281 (37.0%) | 1% |  |
| phase done / visible | 170 (23.2%) | 189 (24.9%) | 7% |  |

Above 20%: the chosen time-dependent measures (live sessions, working rows,
phase working), the planted twin count (3 groups against live's 10) and
depth 6 (3 issues against 4). Every follow-up the POD-4552 table raised for
structure (1–6 in "Fixture follow-ups") is within 20%.

## Timings under load below 8 (POD-4551, as of ae70508a3, old fixture)

Measured at 2ef9f6606 before the landing rebase. Its corpus, oracle and
scenario code is byte-identical at ae70508a3 on the integration branch.
Bench lock `bench:ludovico` held for the run. `uptime` before: load average
4.10, 6.77, 8.36; after: 5.39, 6.91, 8.37. The 1-minute load was read before
each of the 15 records and stayed between 4.10 and 5.43. Five rounds, with
the scale order rotated each round (1-2-4, 2-4-1, 4-1-2, 1-4-2, 2-1-4), after
one unrecorded warm-up build. In-process `performance.now()` under bun, so
these are wall times of generation and of the oracle, not browser work
times. Medians (min–max):

| scale | build | oracle (incl. twin collapse) |
|---|---|---|
| 1x | 47 ms (42–126) | 155 ms (110–332) |
| 2x | 104 ms (80–110) | 657 ms (556–1,071) |
| 4x | 207 ms (177–226) | 2,160 ms (1,887–2,601) |

Build time grows about linearly with scale (47 → 104 → 207 ms, 2.2x then
2.0x). The oracle grows faster than linearly (155 → 657 → 2,160 ms, 4.2x
then 3.3x). That is the legacy derivation's own cost growth, the thing round
three measures, not a property of the corpus. Budgets in `oracle.test.ts`
(4x build < 10 s, 1x oracle < 5 s) hold with wide margin.

## Timings, round two (old fixture; bench lock held; box heavily loaded — see uptime)

`uptime: 22:57:14 up 9 days, 5:35, 4 users, load average: 23.67, 20.18, 15.74`.
Load was above 8 throughout, so counts carry the verdict; walls are recorded
with 10–30× of headroom against their budgets either way.

| measurement | wall | budget |
|---|---|---|
| 1x build | 113 ms | — |
| 2x build | 179 ms | — |
| 4x build | 308 ms | < 10 s ✓ |
| 1x oracle | 523 ms | < 5 s ✓ |
| 2x oracle | 1,224 ms | — (informational) |
| 4x oracle | 2,782 ms | — (informational) |

Asserted in `oracle.test.ts` (4x build < 10 s, 1x oracle < 5 s).

## Dropped at the projection boundary

Every rule below is live in the legacy derivation, is NOT compared by the
oracle, and is in G1's out-of-scope list (spec §6), so no arm re-discovers
them:

1. `startedByChildren` structure — flattened (out: provenance/started-by nesting).
2. `aggregateSessions` as a separate field — folded into the per-row
   phase/working/asking verdicts (same cell).
3. `continuation` ("where the work went") — out: continuation walk.
4. `blocks` / other dependency semantics — out: dependency edges (the
   fixture mints no `blocks` edges at all, only `discovered-from`).
5. `missionRollup.fromChildren` detail beyond done/total — out: the slice
   compares the progress pair only.
6. `activityAt` as a compared field — display-only R-BAND input; arms
   re-derive recency from their own (`activityAt`, `coarseNow`).
7. The `WORKING` move-out partition — out verbatim (`working` is a row flag).
8. Worktree-kind rows — out: worktree rows (dropped before ordering).
9. The snoozed lane as a separate lane — merged into `rowIds` in R-ORDER
   position (the snoozed disclosure is outside the slice's three components).
10. Unread emphasis beyond the R-VIS decay anchors — out: render isolation.
11. Selection-latch placement — the oracle asserts the unselected baseline
    (`null, false`); selection never re-derives rows (R-SEL).
12. Tuck-away control flows, context menu, rename, drag-sort, draft-vessel
    click rule, origin flash — interaction behaviors, out.

## Deliberate fixture divergences (realism notes, not defects)

Superseded by POD-4635: see "Deliberate limits" under "The reshaped fixture".
The old fixture minted no `startedBySession`, no `coordinatorSessionId`, no
`blocks` edges and no `needsHuman`, and kept pins empty; only the last of
those still holds.

## LOUD: two spec §3.9 errata (oracle follows legacy in both)

Replicated the worked example (A/B/C/D + s1/s2/s3) through
`runLegacyDerivation` and the legacy derivation disagrees with the spec text
twice. Per the spec's own precedence rule (legacy wins), the oracle encodes
legacy:

1. **A.phase**: spec says `working`; legacy `rowMotionPhase` returns
   **`waiting`**. B's review decision and s2's waiting both bubble through
   the nested aggregate (`row-attention.ts:45-65`), and waiting dominates —
   which is also what the spec's own R-SUM rule ("waiting if anything in
   the formal subtree waits") says. The example's `working (s1)` line
   contradicts its rule.
2. **A.progress units**: spec says units `{A,B}`, total 2; legacy
   `missionRollup` returns units **`{B}`**, total 1. A root with accepted
   formal members is not its own unit (`mission.ts:1374-1375`: units =
   members when `fromChildren`, else `[root]`).

Everything else in the example checks out verbatim (B `waiting`/`POD-9`/
0/1, C `closed`/`POD-8`, D absent, order A,B, one group `r1` with
`closedIds: [C]`, pinning semantics).
