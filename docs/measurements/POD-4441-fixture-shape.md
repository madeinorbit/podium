# POD-4441 fixture shape (G2: POD-4443)

Deterministic live-shaped corpus + parity oracle. Code:
`packages/worklist-proto/harness/src/fixture/` (`buildCorpus`),
`packages/worklist-proto/harness/src/oracle/` (`expectedSnapshot`).
Seed default 4443; `FIXED_NOW` = 2026-09-20T12:00:00Z.

## Counts per scale (seed 4443)

| scale | issues | sessions | repos | worktrees | machines | visible rows | groups | pinned |
|---|---|---|---|---|---|---|---|---|
| 1x | 4,867 | 4,304 | 500 | 468 | 6 | **211** | 165 | 6 |
| 2x | 9,734 | 8,608 | 1,000 | 936 | 6 | 422 | 350 | 12 |
| 4x | 19,468 | 17,216 | 2,000 | 1,872 | 6 | 844 | 691 | 24 |

Visible rows scale linearly (211 × scale): the corpus is shape-identical at
every scale, which is what the growth-slope measurement wants. POD-4551
asserts this at every scale (next section).

## Shape at every scale (POD-4551, seed 4443)

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

Disabled-collapse control (test-local, per the coordinator's lane ruling):
the oracle over the raw rows differs from the oracle over
`dedupeSessions(sessions)` on exactly the tie roots (1 / 2 / 4 rows at
1x / 2x / 4x): the stale ask shows. The shared oracle
(`harness/src/oracle/oracle.ts`) still feeds raw rows as `store.sessions`,
whereas the runtime dedupes them (`runtime.ts:465`). That change has been
routed to the oracle's owner (POD-4563).

Both shapes reuse rows the corpus already had: sessions come from the tail
of the closed-bulk decayed remainder, the children are existing archived
or proposed leaves. They draw nothing from `rng`. Diffed against the
previous corpus, only the reseated sessions, the reparented children, the
roots, and the rollups of the issues that gave up a session changed. Every
other row is byte-identical (1x: 26 sessions, 49 wire issues).

## Shape at 1x

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

## Timings (bench lock held; box heavily loaded — see uptime)

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

- The fixture mints no `startedBySession`, so top-level agent-audience rows
  are dropped by the legacy nesting pass (`rows.ts:354`) and their live
  sessions surface as worktree-kind rows, which the slice drops. Arms must
  reproduce the drop. (In the live corpus, agent issues typically carry
  `startedBySession` and nest; nesting would add ~200 visible rows here and
  break the 211 budget, so the drop path is the budgeted one.)
- `needsHuman` is always false; `coordinatorSessionId` is absent;
  `supersededBy`/`duplicateOf` are absent.
- Pins are empty (`issue.pinned` still covers the PINNED section + band 0).
- Repos are unstamped (`machineId` absent ⇒ visible) except five stamped
  `m0` (stamped-but-visible path); no repo is machine-hidden.
- No `blocks` edges ⇒ `blocked` is always false and `issuePendingDecision`
  is `review`-only.

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
