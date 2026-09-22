# POD-4442 — Round-two worklist slice: frozen spec + package skeleton

Status: frozen for round two · 2026-09-20 · G1 of POD-4441 (integration branch
`integrate/4441-round-two`).

Plan of record: `docs/plans/pod-4286-prototype-methodology.md` rev 4 (cited below as
"methodology §X"). This spec freezes exactly what the three arms
(POD-4446 hand-rolled, POD-4447 MobX, POD-4448 TanStack DB) build: the entity
fields, the four relations, the eight rules, the UI contract, the locals, and
the measurement interface — so three teams produce comparable things and the
oracle (POD-4443) has a definition to check against.

## How this spec was written, and the two things it is not

Every rule below was transcribed from the legacy derivation as it stands on
`integrate/4441-round-two`, and every rule cites the `file:line` it was read
from. A reviewer with the legacy tree open can reproduce each rule by hand from
the text alone — the worked example in §3.9 is designed for exactly that.

It is not an improvement. Where the methodology's shorthand and the legacy
behavior disagree, the legacy behavior wins and the disagreement is named in
place (see the note under R-ORDER). The oracle checks legacy behavior; a
"better" rule that fails parity is a failed arm.

It is not the whole worklist. §6 lists what is out, verbatim from methodology
§5.6, with a gloss saying what each exclusion means for an arm. In particular
the slice is **flat**: one row per visible issue, no nested rendering. The
legacy nests formal children and started-by provenance children inside their
parent's row (`rows.ts:254-359`); the slice keeps the parent→child *relation*
(R1, for rollups) but renders every visible issue as its own top-level row.
The three components are a windowed list, a group header and a row.

Conventions: `now` below always means `SliceLocals.coarseNow` — epoch ms on a
60-second cadence (`COARSE_CLOCK_MS`, `engine/runtime.ts:221`; published as
`Store.coarseNow`, `engine/types.ts:141`). No derivation reads `Date.now()`.

## 1. Entities and fields

Three entity types. An issue is the wire row joined with its projection row by
`id`: the projection is a separate replica kind (`issueProjections`) carrying
the issue's own durable fields, while the per-user cursor (`readAt`) and the
repo prefix arrive by join — never off the projection
(`replica/contract.ts:97-110`, `replica/issue-views.ts:500-553`).

| Field | Type | Legacy source | Used by |
|---|---|---|---|
| `issue.id` | IssueId (string) | `replica/contract.ts:92` (`ReplicaRows`) | all rules (join key) |
| `issue.parentId` | IssueId \| null | `mission.ts:905-907` (`missionParentId`) | R1, R-ROLL |
| `issue.seq` | number | `replica/issue-views.ts:115` (`IssueViewInput.seq`) | R-ORDER, R-SUM (`displayRef`) |
| `issue.createdAt` | ISO string | wire row | R-ORDER |
| `issue.updatedAt` | ISO string | wire row | R-ROLL (finish anchor), R-BAND |
| `issue.closedAt` | ISO string \| null | wire row | R-ROLL (`issueFinishedAt`, `slices/issues.ts:310-316`), R-GROUP |
| `issue.deletedAt` | ISO string \| null | wire row | R-VIS (excluded) |
| `issue.archived` | boolean | wire row | R-VIS (excluded), R-ROLL (stops walks) |
| `issue.stage` | string | `model/src/predicates/issue-stage.ts:17` | R-VIS, R-ROLL, R-ORDER (via defer, no) |
| `issue.closedReason` | string \| null | wire row | R-VIS, R-ROLL, R-GROUP |
| `issue.audience` | 'human' \| 'agent' | `model/src/entities/issue.ts:294` | R-VIS (rescue is human-only) |
| `issue.draft` | boolean | wire row | UI contract (click rule) |
| `issue.pinned` | boolean | `model/src/entities/issue.ts:223` | R-ORDER (band 0), R-GROUP (PINNED section) |
| `issue.sortKey` | string \| null | `model/src/entities/issue.ts:228` | R-ORDER (sibling scope only) |
| `issue.deferUntil` | string \| null | `model/src/entities/issue.ts:203` | R-ORDER (bands), R-GROUP (snoozed lane) |
| `issue.tuckedAt` | string \| null | `model/src/entities/issue.ts:220` | R-GROUP (closed fold) |
| `issue.repoId` | string \| null | projection join | R-GROUP (`repoKey`) |
| `issue.repoPath` | string | wire row | R-GROUP (`repoKey` fallback, label) |
| `issue.worktreePath` | string \| null | `model/src/entities/issue.ts:149` | R3 (prefix ownership) |
| `issue.coordinatorSessionId` | SessionId \| null | `model/src/entities/issue.ts:327` | session ordering within a row (R-SUM input; order transcribed, not re-derived) |
| `issue.startedBySession` | SessionId \| null | `model/src/entities/issue.ts:334` | provenance fallback — OUT (see §6) |
| `issue.deps` | {id, type}[] | `issueDeps` kind joined by `fromId` (`replica/issue-views.ts:510-516`, `contract.ts:102-105`) | R-ORIGIN (`discovered-from` only); `blocks` edges OUT (see §6) |
| `issue.needsHuman` | boolean | wire row | R-SUM (`asking`) |
| `issue.blocked` | boolean | derived in `deriveIssueViews` (`replica/issue-views.ts:354-356`) | R-ROLL classification |
| `issue.readAt` | string \| null | `issues` kind (`replica/issue-views.ts:507`) | R-VIS (decay anchor) |
| `issue.unread` | boolean | replica rollup | R-VIS (decay anchor) |
| `issue.title` | string | wire row | R-SUM (via display title) |
| `issue.prefix` | string \| null | `repos` kind joined by `repoId` (`replica/issue-views.ts:508-509`) | R-SUM (`displayRef`) |
| `session.sessionId` | SessionId | `replica/contract.ts:93` | all session rules (join key) |
| `session.issueId` | IssueId \| undefined | `SessionMeta` (`model/src/entities/session.ts:712`) | R2 (explicit membership first) |
| `session.cwd` | string | `SessionMeta` | R3 (prefix containment) |
| `session.agentKind` | string \| null | `SessionMeta` | R2/R3 (shells excluded from membership), R-SUM (phase) |
| `session.headless` | boolean | `isHeadlessSession`, `model/src/identity/session-identity.ts:20` | R2/R3 (excluded) |
| `session.status` | string | `SessionMeta` | R-SUM (phase: `starting`/`reconnecting`/`exited`) |
| `session.archived` | boolean | `SessionMeta` | R2/R3 (excluded) |
| `session.lastActiveAt` | ISO string | `SessionMeta` | R-BAND (`activityAt`), R-SUM (timing anchor) |
| `session.stoppedAt` | ISO string \| null | `SessionMeta` | R-VIS (session decay) |
| `session.readAt` / `session.unread` | string \| null / boolean | `SessionMeta` | R-VIS (session decay anchors) |
| `session.agentState.phase` | string \| null | `SessionMeta` | R-SUM (`motionPhase`, `viewmodels/session-status.ts:455-474`) |
| `session.agentState.since` | ISO string | `SessionMeta` | R-SUM (timing anchor) |
| `session.agentState.workingMsTotal` | number | `SessionMeta` | R-SUM (timer base/total) |
| `session.offer.createdAt` | ISO string | `SessionMeta` | R-SUM (waiting-age anchor) |
| `worktree.path` | string | nav sections (`slices/worklist/nav.ts`) | R3 (containment root) |
| `worktree.repoId` / `worktree.repoPath` | string \| null / string | nav sections | R-GROUP (`repoKey`) |
| `worktree.repoName` | string | nav sections | R-GROUP (label) |
| `worktree.prefix` | string \| null | `repos` kind | R-SUM (`displayRef` join) |

`SliceIssue` / `SliceSession` / `SliceWorktree` in `shared/src/slice-types.ts`
carry exactly these fields. Worktree rows are not rendered (out, §6) — the
worktree entity exists for R3 ownership and for the repo facts grouping and
`displayRef` need.

## 2. Relations

Four relations. Each states its maintenance rule: what an arm does on upsert,
on a move (key change), and on remove (evict carries no tombstone — a row with
`value: undefined` in the stream deletes the row and every bucket holding it).

**R1 — children by parent.** Adjacency `parentId → child[]` over live issues
(`mission.ts:936-957`: the index build; eligibility `missionParentId`,
`mission.ts:905-907` — archived or deleted issues contribute no edge).
Upsert: re-bucket when `parentId`/`archived`/`deletedAt` moves. Remove: drop
the node's edge and its bucket; orphaned children surface as roots (never
vanish — the same rule as `buildIssueTree`, `replica/issue-views.ts:429-444`).

**R2 — sessions by issue.** Explicit `session.issueId` first; the index holds
slice order (`session-ownership.ts:128-167` `indexSessionOwnership`,
`session-ownership.ts:282-320` `sessionsForIssueNav`). Archived, headless and
(by default) shell sessions are never members. Upsert: move the session's
membership when `issueId` changes. Remove: drop from the bucket.

**R3 — sessions by worktree path prefix.** Sessions with a resolvable `cwd`
but no `issueId` are owned by longest-prefix containment against the worktree
roots — a session whose cwd sits under an issue's worktree belongs to that
issue and never renders orphaned (`session-ownership.ts:161-164`,
`session-ownership.ts:282-320`; shared predicate `sessionBelongsToIssue`,
`session-ownership.ts:264-274`; resolution `issueIdOwningSession`,
`session-ownership.ts:371-410`). A session attached to a *different* issue
never shows here even if its cwd is contained. Upsert: re-resolve when `cwd`
or `issueId` moves. Remove: drop from the bucket.

**R4 — discovered-from origin edge.** An outgoing `discovered-from` dep names
the spin-off's origin (`spinOffOriginId`, `mission.ts:479-483`; rendered as
the ⤷ tick, `UnifiedIssueRow.tsx:228-236`, resolved `UnifiedIssueRow.tsx:450-460`).
Upsert of the edge moves the tick; removal clears it. The full continuation
walk and the `blocks`/dependency edges are out (§6) — R4 is the single edge,
not the graph.

## 3. Rules

### R-VIS — visible predicate

An issue earns a row iff, in order (`rows.ts:51-118` `buildUnifiedRows`):

1. It is not archived, not deleted, not `proposed`-stage, and not in a
   system-owned stage (`rows.ts:62-69`; system stages per
   `isSystemOwnedIssueStage`).
2. It has ≥1 retained session — sessions of R2∪R3 minus shells, passing
   `sessionRetainsWorklistRow` (`rows.ts:70-76`;
   `slices/worklist/visibility.ts:44-70`: archived sessions never retain;
   finished runs decay after `SIDEBAR_FINISHED_GRACE_MS` (24 h,
   `visibility.ts:18`), unread ones after `SIDEBAR_FINISHED_UNREAD_WINDOW_MS`
   (7 d, `visibility.ts:22`) — OR it is kept without sessions:
   an active human issue (`planning`/`in_progress`/`review`) carries its own
   lifecycle; a finished (`done` or `closedReason`) issue stays only if it
   awaits merge (`issueAwaitingMerge`, `slices/issues.ts:369`) or is a closed
   top-level issue (`isClosedTopLevelIssue`, `slices/issues.ts:318`) *and*
   passes `issueVisibleInSidebar` (`rows.ts:90-106`;
   `visibility.ts:25-41` — finished rows decay by grace/unread windows, but
   closed top-level and awaiting-merge rows do not decay by time).
3. Rescue: walk each row's full ancestor chain and materialize every missing
   *live human-audience, unfinished* ancestor as a sessionless row, so live
   work under bookkeeping nodes surfaces under its nearest visible ancestor
   (`rows.ts:121-158`). Finished (`done`/closed) ancestors are never
   resurrected. The walk is cycle-guarded (`walked` set, `rows.ts:134-135`).

The methodology's shorthand — "visible = not archived, not deleted, root or
has own session" (§5.6) — is this rule with the finished/active-human/rescue
clauses above spelled out. Snooze/tuck/defer-driven membership nuances beyond
what is written here are out (§6).

### R-SUM — per-issue summary (`SliceRow`)

One flat row per visible issue with exactly these fields (citations are where
each field's derivation was read from):

- `displayRef`: `prefix-seq` or `#seq` (`issueDisplayRef`,
  `replica/issue-views.ts:233-236`).
- `title`: the display title, never the raw title on a draft
  (`issueDisplayTitle`, `slices/issues.ts:236`; `UnifiedIssueRow.tsx:178-185`).
- `phase`: `waiting` if anything in the visible formal subtree waits on the
  human, else `working` if any session in the subtree computes, else `done`
  if the subtree's sessions are all finished runs, else `queued`
  (`rowMotionPhase` / `aggregateMotionPhase`, `row-attention.ts:45-78`;
  per-session verdict `motionPhase`, `session-status.ts:455-474`).
- `working`: any session in the subtree computing right now — asked
  separately from `phase` because an ask outranks `working` in it
  (`rowHasWorkingSession`, `row-attention.ts:95-97`).
- `asking`: visible-subtree waiting sessions (offer-only sessions on an already
  counted review decision counted once, `row-attention.ts:116-125`) plus
  pending decisions in the visible subtree (`rowPendingDecision`,
  `row-attention.ts:136-152`; a `review` decision withdrawn while a session
  works, and while the continuation holds — the continuation itself is out,
  so in-slice the withdrawal is on working sessions only).
- `progressDone` / `progressTotal`: the formal child-task rollup
  (`missionRollup`, `mission.ts:1329-1343`): units are the accepted formal
  members (proposed, abandoned and vacated origins excluded,
  `mission.ts:1368-1388`); exclusive classification done → blocked → review →
  run/stall → wait (`mission.ts:1395-1404`); `run` splits staffed vs `stall`
  (started, nobody on it), `shipping` never stalls (`mission.ts:1399-1403`).
- `band`: 0/1/2 (see R-ORDER).
- `repoKey`: `repoId ?? repoPath` (`folds.ts:194-197`).
- `closed`: in the closed fold (see R-GROUP).

"Subtree" in `phase`, `working` and `asking` is always the **visible
formal subtree**: the row's own sessions plus those of every formal
descendant (R1) that has a row of its own (R-VIS). A descendant with no row
adds nothing, and the walk continues past it to its own descendants. The
legacy additionally bubbles through started-by provenance children
(`aggregateSessions`, `row-types.ts:128-132`); that nesting is out (§6), so
in-slice there are no `startedByChildren` and no aggregate — own sessions
plus visible formal descendants. `progressDone`/`progressTotal` are not
affected: they keep R-ROLL's member set and `missionRollup`'s own exclusions.

> AMENDED 2026-09-23 (POD-4549, round three L1d). This paragraph used to say
> "the formal parent-child closure (R1)". Round two's hand and MobX arms read
> that as "bubble every formal descendant's ask, hidden ones included", and
> their parity stayed green only because no probe corpus had an asking
> session on a hidden descendant. The legacy derivation does not bubble those
> asks. The decision document settles it
> (`docs/decisions/4441-round-two-decision.md`, "Change exercise: the
> bubbling contradiction, adjudicated"): asks bubble through the visible
> formal subtree only. Read from the source (`packages/client-core/src/viewmodels/slices/worklist/`):
>
> - The flat pass skips archived, deleted, `proposed`-stage and system-stage
>   issues before any row object exists (`rows.ts:62-69`). The rescue walk
>   stops at such a parent (`rows.ts:137-146`).
> - The nesting pass builds its lookup from visible rows only
>   (`nestStartedByIssues`, `rows.ts:262-266`). `attach` drops a child id
>   that has no row (`rows.ts:323-327`).
> - A row's session aggregate is its own sessions plus its ATTACHED
>   children's aggregates (`rows.ts:331-334`). `rowMotionPhase`,
>   `rowHasWorkingSession` and `rowWaitingCount` read that aggregate
>   (`rowSessions`, `row-types.ts:129-132`; `row-attention.ts:45-65`,
>   `:95-97`, `:116-125`).
> - The pending-decision walk (`pendingDecisionStats`,
>   `row-attention.ts:162-187`) and the attention-source walk
>   (`deepAttentionSource`, `row-attention.ts:193-210`) follow attached
>   children only.
> - A hidden issue's sessions are also kept out of the worktree lanes
>   (`rows.ts:196-210`), so the ask shows up nowhere on the list.
>
> So an asking session on an archived or proposed child of a visible root
> leaves the root quiet: not asking, and not `waiting`. Hiding detaches only
> the hidden issue's OWN sessions, not its visible descendants. Nesting walks
> past a parent with no row to the nearest visible ancestor
> (`rows.ts:272-283`), so a visible grandchild under a hidden child still
> bubbles to the root. An arm drops hidden issues from the attention roll-up
> at ingest and keeps walking R1 through them.
>
> Checked by: the fixture's hidden askers (`corpus.edgedAskers`, 20 × scale,
> POD-4551); `oracle.test.ts` "asks bubble through the visible formal subtree
> only (POD-4549)", which requires every such root to read not asking and
> goes red on the planted formal-subtree rule
> (`oracle/hidden-askers.ts` `plantFormalSubtreeBubbling`); and the isolated
> cases in `oracle/hidden-askers.test.ts` (archived child, proposed child,
> un-hide control, visible grandchild under a hidden child).

### R-ROLL — recursive subtree rollup

The rollup walks R1 recursively with chain invalidation: a change to any
member recomputes every ancestor's summary up to the root (`missionRollup`
memoized per (slices, root), `mission.ts:1340`; member set `missionIssueIds`,
`mission.ts:1093-1101`).

Transcribed recursion (`computeMissionIssueIds`, `mission.ts:1103-1157`):

1. Formal walk: stack from the root over `children` adjacency; visited-set
   guard makes it cycle-safe (`mission.ts:1110-1117`).
2. Provenance fallback (started-by fixpoint, `mission.ts:1118-1156`) is **out**
   (§6) — in-slice the member set is the formal walk alone.
3. Root resolution stops at archived/deleted parents: a walk that reaches an
   archived or deleted parent stops there and resolves to the highest live
   node (`missionRootFor`, `mission.ts:388-408`, stop rule
   `mission.ts:401-405`). An archived mission is not on screen.
4. Classification is R-SUM's exclusive buckets over the formal units.

### R-BAND — activity band from the coarse clock

Each row carries `activityAt` = max member-session `lastActiveAt`, else the
issue's `updatedAt` (`rows.ts:108-117`; rescue rows use the parent's
`updatedAt`, `rows.ts:152`; worktree-fallback rows the guests' max,
`rows.ts:219`). The UI renders recency from (`activityAt`, `coarseNow`) in the
coarse buckets "just now / Nm ago / Nh ago / Nd ago" (`relativeTime`,
`focus.ts:194-204`, thresholds 60 s / 60 m / 24 h; rendered by `AgoStamp`,
`time-indicators.tsx:60-69`, whose `now` rides the caller's coarse clock).
Working rows instead show the live elapsed timer from the earliest working
`agentState.since` (`workingSinceMs`, `time-indicators.tsx:34-43`;
`formatElapsed`, `time-indicators.tsx:17-25`).

Rule: recency is a pure function of (`activityAt`, `coarseNow`); on a coarse
tick only rows whose bucket boundary crossed re-derive. This is the "time as
an input" mechanism (§5.6): the overnight snooze lapse is out (§6), but band
crossings, defer transitions (R-ORDER) and decay/grace crossings (R-VIS,
R-GROUP) are the tick's only legal effects.

### R-ORDER — order

Banded order, stable while agents work (`sortUnifiedWorkRows`,
`row-order.ts:65-71`):

1. Band ascending (`unifiedRowBand`, `row-order.ts:16-22`): 0 = pinned or
   returned-from-defer (`issueReturnedFromDefer`,
   `model/src/predicates/issue-stage.ts:70-77`), 2 = snoozed
   (`isIssueDeferred`, `model/src/predicates/issue-stage.ts:42-46`), 1 =
   everything else.
2. Manual `sortKey` ascending among siblings; a keyed row sorts before any
   unkeyed row (`compareManualOrder`, `row-order.ts:49-58`). Keys are only
   meaningful against siblings.
3. Immutable creation order, newest first: `createdAt` desc, `seq` desc,
   `id` asc (`compareCreationDesc`, `row-order.ts:29-40`).

Note (transcribed, not improved): the methodology shorthand says "pinned
first, then activity" (§5.6). Legacy is explicit that activity, urgency and
`updatedAt` do **not** sort — attention is carried per-row, never by
reordering (`row-order.ts:60-64`, issue #64). The oracle follows legacy:
`activityAt` feeds display and timing only.

### R-GROUP — groups with one closed fold

1. Pinned issues move (not copy) out of their project group into one PINNED
   section above all groups, preserving incoming order (`splitPinnedWork`,
   `folds.ts:35-43`).
2. Remaining rows bucket by repo (`repoId ?? repoPath`, so one repo on two
   paths merges), open-row and group order following the incoming R-ORDER
   order (`groupUnifiedWorkRows`, `folds.ts:185-222`; labels from the repo
   name / path tail, `folds.ts:200-203`).
3. Each group has **one** closed fold: settled top-level closures with nothing
   still asked of the human — closed top-level, no `needsHuman`, no awaiting
   merge, zero waiting (`finishedIssueSettled`, `folds.ts:93-102`) — placed by
   `rowInClosedFold` (`folds.ts:118-141`): abandoned (cancelled/duplicate/
   superseded) outcomes fold immediately; explicit `tuckedAt` folds even while
   selected; otherwise the row stays open through the finished-grace window
   (`SIDEBAR_FINISHED_GRACE_MS`, 24 h) and folds after. The fold sorts newest
   first by `tuckedAt ?? closedAt ?? updatedAt` (`issueClosedFoldAt`,
   `folds.ts:82-86`; sort `folds.ts:214-220`). The fold is per group, never
   global.
4. Snoozed-band rows sit in their group's open lane position (their band
   already sank them); the snoozed disclosure is outside the slice's three
   components, so `SliceGroup` carries `rowIds` (open lanes, R-ORDER order)
   and `closedIds` only.
5. Selection latch: a selected settled-but-unremarked closure stays in the
   lane it was clicked in until focus moves (`closedFoldEligible`,
   `folds.ts:106-116`). The latch reads the locals (§5), never stored state.

### R-ORIGIN — spin-off origin tick

An outgoing `discovered-from` dep names the origin; the row shows one quiet
⤷ tick with the origin's `{id, seq, title, ref}` (`legacyOriginTick`,
`UnifiedIssueRow.tsx:450-460`; edge direction `spinOffOriginId`,
`mission.ts:479-483`). Selecting the row flashes the origin's row
(`flashLineage`, `UnifiedIssueRow.tsx:56-63`). Spin-offs stay top-level:
provenance renders as the tick, never as nesting (`rows.ts:284-288`).

### R-SEL — selection

Selection is a local (`selectedIssueId`, §5), never a row field. Click sets
it; the closed-fold latch (§R-GROUP.5) and the origin flash (R-ORIGIN) are its
only derivation effects — selection never re-derives rows (POD-4420 S2,
`placeWorklistSelection`, `published.ts:296-336`: regroup over derived rows,
base identity returned when placement is unchanged).

### 3.9 Worked example (reproduce by hand)

Repo `podium` (prefix `POD`, repoId `r1`). `coarseNow` = 2026-09-20T12:00:00Z.
Sessions: `s1` on A, `agentState.phase: working`, `lastActiveAt` 11:58;
`s2` on B, standing offer `createdAt` 11:40, phase idle (waiting);
`s3` no `issueId`, `cwd` = A's worktree + `/sub` (R3 → owned by A).

| | A | B | C | D |
|---|---|---|---|---|
| stage / audience | in_progress / human | review / human | done, closedReason shipped / human | in_progress / human |
| parent | — | A | — | — |
| seq / sortKey | 10 / "a0" | 9 / "b0" | 8 / "c0" | 7 / "d0" |
| tuckedAt / archived | — | — | tuckedAt 10:00 | archived: true |
| R-VIS | own sessions (s1, s3) | own session (s2) | finished + closed top-level + tucked | excluded (archived) |

Summaries (R-SUM): A `displayRef POD-10`, phase `waiting`, working true,
asking true (s2 waits in formal subtree; B's review decision pending),
progress 0/1 review (units {B}: a root with accepted formal members is not
its own unit), band 1, repoKey `r1`, closed false.

> ERRATUM, corrected 2026-09-20 by the coordinator after G2 (POD-4443) ran
> this example through the real derivation and both were verified against the
> source. The text previously said A.phase was `working (s1)` and A's units
> were `{A,B}` totalling 2. Both were wrong. `rowMotionPhase`
> (`row-attention.ts:45-65`) lets waiting dominate through the nested
> aggregate, which is what this spec's own R-SUM rule already says, so the old
> line contradicted its own rule. And `missionRollup` sets
> `units = fromChildren ? members : [root]` (`mission.ts:1374-1375`), so a
> root with accepted formal members is not counted as a unit itself. The
> oracle encodes the legacy behaviour, so arms are judged against the values
> above, not against the old text.

B `POD-9`, phase `waiting`, asking true, progress 0/1 (units {B}: review,
total 1 — a lone root is its own unit), band 1, closed false. C `POD-8`,
closed true (tucked settles it). D has no row.

Order (R-ORDER): all band 1 → sortKey a0, b0 → A, B. Groups (R-GROUP): one
group key `r1` label `podium`, `rowIds: [A, B]`, `closedIds: [C]`;
`pinnedIds: []`. Pinning A would give band 0, `pinnedIds: [A]`, and remove A
from the group (move, not copy).

## 4. UI contract

Three components per arm, in its idiom, windowed; no whole-array props
(methodology §6.1 — a row receives its row object/scalars plus stable
callbacks, never the issue/session arrays, cf. `UnifiedIssueRow.tsx:105-111`):

- **List**: renders `pinnedIds` then each group's `rowIds` in order;
  windowed; row click selects (R-SEL). Closed folds render under their group
  header from `closedIds`.
- **Group header**: `label`, open count, closed count; toggles the closed
  fold. Closed-fold rows render newest-tucked-first (R-GROUP.3).
- **Row**: renders the `SliceRow` fields, the origin tick (R-ORIGIN), and the
  recency stamp from the arm's own (`activityAt`, `coarseNow`) via the R-BAND
  buckets. Click: a draft vessel whose only content is agents opens its
  session directly, otherwise selects the mission (`isDraftAgentVessel`,
  `slices/issues.ts:273`; `UnifiedIssueRow.tsx:363-370`). The tuck-away
  control and its flows are out (§6); `closed` is read-only in the slice.

## 5. Locals

`SliceLocals` (`shared/src/slice-types.ts`): `selectedIssueId: IssueId |
null`, `selectedIssueWasFolded?: boolean` (the R-GROUP.5 latch), and
`coarseNow: number` (epoch ms, 60 s cadence). Time is an explicit input: a
quiet snooze lapses only from a real tick (the rule `published.ts:36-43`
states for the legacy slice, and it binds the arms unchanged).

## 6. Out of scope

The methodology §5.6 "left out" column, verbatim, with what each cell means
for an arm:

| Mechanism | Left out (verbatim) | Gloss |
|---|---|---|
| Per-entity invalidation at live scale | — | nothing left out: the heartbeat isolation fence applies fully |
| Composite entity from two row kinds | — | nothing left out: wire + projection join is in §1 |
| Key relation, maintained by delta | — | nothing left out: R1/R2 are fully maintained |
| Non-key relation | machine scope | repos/worktrees are not machine-scoped; every repo is visible |
| Graph edge | continuation walk, dependency edges | R4 is the single origin tick; the "where the work went" walk (`rows.ts:166-170`) and `blocks`/other dep semantics are out |
| Recursive derivation with chain invalidation | provenance nesting, started-by nesting | formal-subtree rollup only; no `startedByChildren`, no aggregate sessions, no started-by fixpoint |
| Membership predicate | snooze, tuck, defer | R-VIS is exactly §3; snooze/defer *fields* drive bands, but snooze-tuck-defer membership behaviors beyond R-VIS/R-ORDER/R-GROUP are not exercised |
| Ordering and grouping | worktree rows, nav tree | no worktree-kind rows; no nav-tree sections — flat issue rows grouped by repo |
| Local state that must not touch data | pane, focus | only `selectedIssueId` (+ fold latch) and `coarseNow` exist |
| Time as an input | overnight snooze lapse | band/defer/decay/grace crossings are in (R-BAND); the overnight lapse journey is not separately exercised |
| Lifecycle | drafts, offline hydration | fresh store per principal, replace, evict-without-tombstone and optimism echo/rejection arrive via the stream; composer drafts and offline hydration do not |
| Render isolation | everything else on screen | only list, group header, row |

Also out (read across the rules, stated once here so no arm re-discovers
them): the WORKING move-out split (`partitionUnifiedWork`, `rows.ts:436-480`
— `working` is a row flag, not a section); tardiness/unread emphasis beyond
R-VIS anchors; the context menu, rename, drag-sort and tuck controls;
Flight Deck, board, palette, rail and every other surface.

## 7. Oracle projection

The parity oracle (POD-4443) runs the legacy derivation on the same fixture
and projects it onto `SliceSnapshot` field by field. The projection:

| Snapshot field | Legacy source |
|---|---|
| row set | `unifiedWorkList` (`rows.ts:368-379`), minus worktree-kind rows, flattened (no nesting) |
| `order.pinnedIds` | `splitPinnedWork` (`folds.ts:35-43`) |
| `order.groups` key/label/`rowIds` | `groupUnifiedWorkRows` (`folds.ts:185-222`) with `null, false` selection |
| `order.groups` `closedIds` | same, `closedRows` lane |
| `row.id` | issue id |
| `row.displayRef` | `issueDisplayRef` (`replica/issue-views.ts:233-236`) |
| `row.title` | `issueDisplayTitle` (`slices/issues.ts:236`) |
| `row.phase` | `rowMotionPhase` (`row-attention.ts:45-65`) over own + visible-formal-subtree sessions (R-SUM amendment) |
| `row.working` | `rowHasWorkingSession` (`row-attention.ts:95-97`) over the visible formal subtree |
| `row.asking` | `rowWaitingCount > 0` (`row-attention.ts:116-125`) or visible-subtree pending decision (`row-attention.ts:136-152`) |
| `row.progressDone/Total` | `missionRollup(...).progress` (`mission.ts:1329-1343`) |
| `row.band` | `unifiedRowBand` (`row-order.ts:16-22`) |
| `row.repoKey` | `repoId ?? repoPath` (`folds.ts:194-197`) |
| `row.closed` | `rowInClosedFold` with unselected baseline (`folds.ts:118-141`) |

Dropped at the projection boundary (in legacy, out of slice): `startedByChildren`
/ `aggregateSessions` (`row-types.ts:128-132`), `continuation`
(`rows.ts:166-170`), `missionRollup.fromChildren` detail beyond done/total,
`activityAt` (display-only input, R-BAND), and the `WORKING` partition
(`rows.ts:436-480`).

## 8. Measurement interface

`shared/src/stats.ts` exports `ArmStats`
(`rowsDerived, rollupsDerived, indexUpdates, notifications, reset()`) and the
stream events `RowRecord` / `RowSourceEvent` (`{type: 'replace' | 'update',
rows: {kind, id, value | undefined}[]}` — `undefined` = evict, no tombstone).
`shared/src/arm.ts` exports `Arm { create(source, locals): ArmHandle }` and
`ArmHandle { snapshot(): SliceSnapshot; stats: ArmStats; dispose(): void;
mountWeb(el): () => void; mountNative(): ReactElement }`. The G4 harness
(POD-4445) drives scenarios 1–15 (methodology §5.8) against this surface;
counts are asserted in CI on happy-dom, walls in Chromium. Surface minimal;
arms keep idiomatic APIs underneath.

## 9. Package skeleton

`packages/worklist-proto/` (private, `type: module`, no dist, no build step;
exports map with the `@podium/source` condition pointing at `src`, after
`packages/model/package.json`): `shared/` (this spec's shapes, frozen),
`arms/{hand,mobx,tanstack}/` (one arm each, owned by POD-4446/4447/4448),
`harness/` (owned by POD-4445; hosts the G2 fixture+oracle and G3 row
stream+scenarios unless those issues relocate them). Each folder carries a
README with its ownership rule. `tsconfig.json` extends the same base as
`packages/client-core/tsconfig.json` (`tooling/tsconfig/react.json`);
`vitest.config.ts` follows the `apps/web/vitest.config.ts` happy-dom pattern.
Typecheck runs through the generic `typecheck` turbo task (no per-package
override needed — the override entries in `turbo.json` cover only packages
with extra inputs); `test:file` routes package files to the root node lane
(`scripts/test-lanes.ts:168-180`), so no roster change in
`scripts/test-configuration.test.ts` was required — that test enumerates lane
configs, not per-package configs.
