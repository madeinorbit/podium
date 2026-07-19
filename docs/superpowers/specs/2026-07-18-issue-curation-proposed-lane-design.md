# Issue curation: Proposed lane, sidebar tree, human/agent field split

Issue: POD-953 (User-facing sidebar issue curation) · Status: design for review
Supersedes part of SP-a859 (M6 decision q6: forced `audience:human` + `needsHuman` on agent top-level creates).

## 1. Problem

The sidebar and board no longer let the human track what's going on. Evidence from the
live tracker (2026-07-18, 457 open issues):

- **83 agent-created top-level issues sit on the human board** (74 still in `backlog`),
  because the server *forces* `audience:'human'` + `needsHuman` on every agent top-level
  create (`registry.ts:641-645`, M6 q6). Agents are simultaneously *instructed* to file
  every discovered bug/follow-up as a top-level issue with a `discovered-from` link —
  62 of the 83 carry one. Following instructions produces board spam.
- **163 agent-created human-audience sub-issues** are properly structured trees, but the
  sidebar flattens them: `buildUnifiedRows` (client-core `derive.ts:1210`) shows every
  `audience:'human'` issue with a live session as its own top-level row. It nests only by
  `startedBySession` provenance (`nestStartedByIssues`), never by `parentId`.
- The `needsHuman` "review, claim, or reparent" flag q6 relies on survives on only 15 of
  the 83 — it is also the "agent has a question" primitive, so it gets cleared/replaced
  and is semantically overloaded.
- Sidebar and board disagree: the board has parent-chain rescue + a `showAgentTasks`
  toggle; the sidebar has neither, and different ordering.

## 2. Concepts (decided 2026-07-18)

Three kinds of issue, not two:

| Kind | Created by | Where it lives | Mechanism |
|---|---|---|---|
| **Tracked work** | Human, or agent on explicit human ask | Board + sidebar, root of a tree | `audience:'human'`, stage ≥ backlog |
| **Internal decomposition** | Agent, breaking down tracked work | Nested under its tracked ancestor; hidden by default | `audience:'agent'` sub-issue (unchanged, SP-a859) |
| **Discovered / adjacent work** | Agent, found along the way | **Proposed lane**, awaiting human approval | NEW: stage `proposed`, `audience:'human'` |

Boundary rule for "adjacent work needed to finish a bigger task": if the parent
genuinely cannot ship without it → blocking **sub-issue** (internal decomposition, plus a
`blocks` dep). If the parent can ship → **top-level proposed** issue with a
`discovered-from` link. Sub-issues are for decomposition of a deliverable; discovered
work outlives its origin and must not hold the parent open or vanish when it closes.

**Why `proposed` is a stage and not `audience:'agent'`:** the human *is* the audience of
a proposal — they must see and triage it. `audience` answers "who tracks this long-term";
`stage` answers "where is it in its lifecycle". A proposal is human-facing work that has
not yet been accepted, i.e. a lifecycle state before `backlog`. (This corrects the earlier
suggestion in this investigation to park proposals at `audience:'agent'`.)

## 3. Data model changes

### 3.1 Stage `proposed`

- `IssueStage` gains `'proposed'` ordered before `'backlog'`:
  `['proposed','backlog','planning','in_progress','review','done']`
  (protocol `messages/issues.ts:9`, DB CHECK constraint, board column config).
- **Server rule (replaces q6):** an agent top-level create (`origin:'agent'`, no
  `parentId`) lands at `stage:'proposed'`, `audience:'human'`, **no** auto `needsHuman`.
  Agents cannot pass a stage to escape this; `--audience` is ignored for top-level agent
  creates (it is always human — that's what proposed means). Origin is already
  server-derived and unforgeable, so this cannot be worked around.
- Agent sub-issue creates are unchanged (`audience:'agent'` default, normal stages —
  a coordinator's internal children start work immediately, no approval loop).
- **Promotion** = human moves the issue to `backlog` (or straight to a working stage /
  `claim`). Add `podium issue promote <id>` sugar + a one-click approve on the lane card.
  Dismissal = archive (already exists). Promotion/dismissal are operator-only actions;
  an agent moving its own proposal out of `proposed` is rejected server-side.
- `issue ready` excludes `proposed` (not approved ⇒ not dispatchable). The steward/pump
  must treat `proposed` as inert.
- `needsHuman` reverts to a single meaning: *an agent has a question* (humanQuestion +
  options + askedBy). It is no longer set on create.

### 3.2 Field split: `description` vs `brief`

- **`description`** is re-scoped: targeted purely at the human — concise, jargon-free,
  understandable without context. Shown on cards, lane previews, sidebar tooltips.
- **New field `brief`** (name chosen over "agent instructions": it holds *any* technical
  handoff content — repro steps, file pointers, constraints, suggested approach — and
  "brief" matches how coordinators already talk about spawn briefs. Alternatives
  considered: `worknotes` (sounds mutable/log-like), `techNotes` (vague),
  `agentInstructions` (excludes technical context that isn't instructions)).
  - Nullable text column, full markdown, no length pressure.
  - CLI: `--brief` on `create`/`update`; `issue show` prints it after the description;
    `issue tree` snippets keep using `description`.
  - UI: collapsed "Brief" section on the issue page, hidden from cards.
  - Agent-facing prompts (`issue prime`, spawn briefs, `--start` first prompt) include
    `brief` verbatim; the description is included as the one-line human summary.
  - Pointer text instructs agents: description = 1–3 plain sentences for the human;
    everything technical goes in `brief`.

### 3.3 Migration / backfill

- Additive migration: stage CHECK gains `proposed`; `brief TEXT NULL` added.
- Backfill: open, non-archived issues with `origin:'agent'`, no `parentId`, and
  `stage:'backlog'` **and no human touch** (never claimed/staged by the operator, no
  operator edits — detectable via the event log) move to `proposed`. This sweeps the
  current 74 into the lane in one shot instead of leaving legacy spam. Issues the human
  has touched stay where they are.
- No `description` rewrite migration; agents fix descriptions opportunistically when they
  next touch an issue.

## 4. Sidebar changes

The sidebar answers **"what is running for me right now?"**

- **Nest by tree:** roll up children by `parentId` in addition to the existing
  `startedBySession` provenance nesting (`nestStartedByIssues` generalizes to both edge
  kinds; `parentId` wins when both apply; cycle-safe as today). Sessions render under the
  issue they serve. Top-level sidebar rows are only *tracked roots* (`audience:'human'`,
  stage > `proposed`, no visible parent).
- **Roll-up of status:** activity state (working / idle / needs_user / …) and
  needs-attention bubble to every ancestor row so a collapsed tree still shows them:
  - each row gets an aggregate = max-severity over its own sessions + all descendants
    (severity order: needs-attention/needs_user > working > idle > none);
  - needs-attention renders as the existing attention bubble on the ancestor row with a
    count; working renders as the activity dot. Expanding drills to the source.
- **Internal (`audience:'agent'`) issues DO appear in the sidebar** (decided 2026-07-18,
  revising an earlier draft of this doc): as nested rows under their tracked ancestor,
  whenever they pass the normal sidebar filter (≥1 attached session), **visually
  de-emphasized** (dimmer/smaller + origin badge) so the human's issues and the agents'
  self-organization read as two layers of one tree. The sidebar is the live operational
  map — hiding internal children would leave "3 agents working" with no way to see on
  what. The session-required filter is the curation: internal backlog children with no
  sessions stay invisible. Internal issues still never appear at TOP level (an internal
  issue with no visible ancestor is a structural bug; the orphan warning covers it).
  The board keeps hiding them behind `showAgentTasks` — board = curation, sidebar =
  observation.
- `proposed` issues never appear in the sidebar (they have no sessions and aren't
  tracked). If a proposal somehow has a session, it still stays out — sidebar filters
  `stage !== 'proposed'`.
- Ordering within a level keeps the current banding (pinned/returned > normal > snoozed,
  creation-desc within band); this design adds no ordering churn.

### 4.1 Completion visibility & decay (decided 2026-07-18)

`podium session/issue stop` (POD-954) makes "stopped" a durable, reversible state
(record + transcript + branch kept, worktree freed). Finished work decays from view
gated on **acknowledgment first, time second** — a pure timer loses signal when the
human is away and lingers when they're watching. Three states:

1. **Finished, unseen** — full visibility. A self-stopped reviewer session or a closed
   milestone sub-issue stays exactly where it was in the sidebar, restyled done
   (check/dim + outcome chip) with an unread badge, bubbling up the tree like any
   attention state (a collapsed parent shows "2 finished ✓"). Outcome chip keys on
   stop reason: *self-stop after done* = "finished"; *stopped by parent* = "reaped";
   *stopped `--force`* = "interrupted" (attention-styled — unmerged work may sit on
   the branch). Never removed before the human has seen it.
2. **Finished, seen — 24h grace.** Once read, it stays dimmed in the sidebar for
   **24 hours**, then drops out as a row, surviving only in the parent's rollup count
   ("4/6 done"). The sidebar is the "running now" view; seen-and-done work has no
   claim on it.
3. **Archived** — gone from all live views, reachable forever via show-archived /
   search; transcript + branch intact per POD-954.

Per-surface rules:

- **Left sidebar:** fastest decay (states above).
- **Issue tree / right panel / board epic drill-down:** done sub-issues stay for the
  **whole life of the parent** — they are the progress record backing "3/5 done".
  Collapse them into a "✓ n done" group at the bottom of the subtree; never age them
  out while the parent is open.
- **Archive trigger = the parent closing**, not per-child timers: when a parent issue
  closes, its whole subtree (done children + their stopped sessions) archives together.
  Top-level issues + directly-attached sessions: janitor auto-archives **7 days** after
  done/stopped — only from state 2, never sweeping something unread.

Wire/schema implications:

- Sessions need durable `stoppedAt` + stop reason (`self | parent | forced`) so chips
  and the sweep have keys (extends POD-954's state).
- Session `readAt` must mean "seen after it finished": reset unread on the terminal
  transition (same pattern as issue-unread on update).
- The 24h sidebar grace keys on `max(readAt, stoppedAt/closedAt)`.

## 5. Board changes

- **New "Proposed" lane** left of Backlog (list view: a "Proposed" group on top).
  Cards show: title, human `description` snippet, origin badge, `discovered-from`
  source ("found while working POD-xxx"), age. Actions: **Approve** (→ backlog,
  optionally set priority), **Approve & start**, **Archive**.
- Lane count surfaces in the TopBar next to the existing needsHuman badge (they are
  different things now: questions vs proposals).
- `filterBoardScope` unchanged for internal issues; `showAgentTasks` toggle stays.
- Board and sidebar now share one mental model: board = curated backlog + triage inbox;
  sidebar = live tree of tracked work.

## 6. Agent instruction changes

Update `issue-system-pointer.ts` + `issue prime` + `docs/agents/delegating.md`:

- Discovered/adjacent work: file **top-level** + `dep-add --type discovered-from`; it
  lands in Proposed automatically; do not attempt to stage/claim it; write the
  description for the human and put everything technical in `brief`.
- Decomposition: always sub-issues under your issue (`--parent-id`), internal by
  default; never sibling top-level creates to organize your own work.
- Blocking adjacent work (parent can't ship without it): blocking sub-issue, not a
  proposal.
- Description/brief split rule (per §3.2).
- Remove the current "audience human puts it on the human board" framing for top-level
  creates (no longer a choice the agent makes).

## 7. Guardrails (server-enforced, not prompt-hoped)

1. Agent top-level create → forced `proposed` (cannot pass stage/audience around it).
2. Agent cannot move any issue out of `proposed` (operator capability required).
3. `issue ready` / steward / pump ignore `proposed`.
4. Existing: `origin` derived from caller capability; sub-issue default internal;
   orphan-internal warning — all unchanged.

## 8. Out of scope / open questions

- Auto-expiry or digest of stale proposals (lane could itself grow unbounded — suggest
  revisiting after observing lane volume; archive-after-N-days is a candidate).
- Hub/federation: `proposed` must survive the upstream mirror (stage is already
  mirrored; verify CHECK constraint parity on hub).
- Whether Approve should let the human pick a parent (reparent-on-promote) in one step.
- Concierge/tray: should proposals surface as tray cards too, or only the lane? Default
  here: lane only, to keep the tray for questions/review.

## 9. Implementation cut (suggested issue tree)

1. Protocol + DB: `proposed` stage, `brief` field, migration + backfill.
2. Server rules: create-path rewrite (q6 replacement), promote/guard endpoints, ready/steward exclusion.
3. CLI: `promote`, `--brief`, help-text/pointer updates.
4. Board: Proposed lane + actions + TopBar count.
5. Sidebar: parentId nesting + internal-issue nested rows + status/attention roll-up + proposed filter.
6. Completion decay: stop-reason/stoppedAt wire fields, unread-reset on terminal transition, 24h sidebar grace, done-group in trees, janitor archive sweep (7d + parent-close cascade).
7. Docs/prompts: pointer, prime, delegating guide.

Status of the doc: DECIDED (Michael, 2026-07-18) — §2 concepts, §3 proposed stage +
brief field, §4 sidebar incl. 4.1 decay (24h grace), §5 lane, §6/§7. Open questions in
§8 remain open and are NOT part of the first implementation cut.
