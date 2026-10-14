# Flight deck v6: comparing the design with today's code

Source: Till's Claude Design handoff (claude.ai artifact GSfLtck157Vzm2jyb2pmBT), pulled 2026-10-12. The local copies are:
`FlightdeckV6.dc.html` (the mockup, which is the source of truth), `FlightdeckSpec.dc.html` (8 spec sections) and
`FlightdeckHandoff.html` (the handoff page with 8 notes). Code references are against dev/mw at 824c9aa53f.

## 1. Data: what exists and what is missing

| Design concept | Today | Gap |
|---|---|---|
| Epic / mission | Derived from the root issue + its subtree + the issues its sessions start (`client-graph/src/mission.ts`) | none |
| Parent/child tree, any depth | `issues.parent_id`, `childCount/childDoneCount` | none |
| Dependencies ("waits on" / "after") | `issue_deps(from,to,type)`, default type `blocks`; `blocked`/`ready` computed at the feed | `type` is a free string with no validation (`contracts.ts:476`). There is no "after" type; it can be derived as running + has `blocks` edges |
| Coordinator | `issues.coordinator_session_id`, set automatically on `claim` | none |
| **Phase** {id, name, order} | none. ("phase" today only means `agentState.phase`) | **Missing.** See §2 |
| **Phase lead** | `sessionRole()` already returns `phase-lead` for the coordinator of a non-root issue (`mission.ts:2046`) | No link to a phase |
| **Task role** (research/design/build/review/qa/security) | none | **Missing.** New column |
| Session seat: coordinator / phase_lead / worker / helper | Partly: coordinator, phase-lead, `spawned`, `peer` (`mission.ts:2027`) | Can be derived with no column: worker = the task's coordinator session, helper = any other session on the task |
| Session engine tile | `sessions.agent_kind`: claude-code, codex, grok, opencode, cursor, pi, shell | The design only has tiles for claude and codex |
| Session states | `agentState.phase` (working/idle/needs_user/errored/compacting/ended), `error.class` (usage_limit, rate_limit, host_death…), `exit_code`/`spawn_failure`/`oom`, `pending_interactions`, offers | Data is enough. The derivation must change (see §4) |
| Working timer / ✓ ∑ duration | `agentState.since`, `sessions.working_ms_total` | none |
| Native subagents | `agentState.nativeSubagents [{id,type}]`, live only | There is no per-subagent state, so the design's "waiting" word has no data |
| Mission brief GOAL / SCOPE / ACCEPTANCE | `description`, `acceptance` (column), `design`, `notes`, `brief` (agent-facing) | GOAL and SCOPE are missing. **Naming clash:** the design's "brief" is the HUMAN text, but `brief` is our AGENT-instructions field |
| Crew "33 agents" | `liveAgentCount` / `workingAgentCount` | Undefined what "33" counts (see §5) |
| Cost "≥$1,120" | `trpc.cost.task` with `floor: partial`, polled every 90s | none |
| Proposals + who proposed | stage `proposed`, `createdBy`, `startedBySession`, own-vs-mission placement | none for display. Actions need an operator verb (see §3) |
| Fold state "per user per issue" | Device-local `uiState` `podium.flightDeck.folds` | Account-wide storage needs a new `user_layout` key (closed vocabulary in `layout-state.ts`) |

## 2. The phase model: the main schema decision

**Option A (recommended): a phase is an issue.** Add a new `IssueType` `phase` as a direct child of the epic, with tasks as its children.
- The design's requirements come for free: order = `sort_key`; done/total = `childDoneCount`; "sub-issues inherit the phase" by structure; phase lead = `coordinator_session_id` of the phase issue, which `sessionRole` already calls `phase-lead`.
- A lead bound to the phase issue gets **write scope over exactly that phase's subtree** through the existing authz (`capabilityForSession`). Option B would have to build that.
- "Unphased" = direct children of the epic that are not phases.
- Moving a task between phases is `reparent`.
- No new replica collection and no new edge kind.
- Costs: every reader of issues must treat `type=phase` as a container, not work. That covers the `ready` lists, `prime`'s open children, the board, the gauge units, the task counts, and stage roll-up (a phase is done when its children are). A phase also gets a POD ref, which the design never shows.

**Option B: a `phases` table** (id, epic_id, name, position, lead_session_id) plus `issues.phase_id`.
- It is exactly the design's `{id, name, order}`, with no container special-casing.
- Costs: a new synced entity and its client relations; new authz for a lead that is not bound to an issue; and inheritance and reparent rules (what happens to `phase_id` when a task moves under another parent) must be enforced by hand.

## 3. New CLI mechanisms (so agents can build and steer this)

Agents build the structure the deck shows. Each concept needs a verb, a line in `prime`, and a rule in `ISSUE_SYSTEM_POINTER` (`packages/harness/src/issue-system-pointer.ts`). New issue verbs follow the 4-step contract → registry → `ISSUE_COMMANDS` → audit-gate path, and that path also produces the MCP tools.

These are Option A shapes. Option B would turn them into `podium issue phase …` sub-verbs.

```
# Phases
podium issue phase add <epic> "Build" [--before <phase>|--after <phase>]   # = create --type phase --parent-id <epic>
podium issue phase list <epic>
podium issue phase move <phase> --before <phase>                            # sort_key
podium issue phase lead <phase> --set <sessionId>|--claim|--clear           # = coordinator on the phase issue
podium issue create  --title … --phase <name|ref>                           # resolves to parent-id; refused if the phase is not in the caller's epic
podium issue update  --id … --phase <name|ref>|--no-phase                   # reparent under phase / back to the epic

# Role
podium issue create|update … --role research|design|build|review|qa|security   # closed enum, DB CHECK, shown in prime/show/tree

# Dependencies (exist; tighten)
podium issue dep-add <task> <waits-on>        # validate --type against ISSUE_DEP_TYPES (today any string is accepted)
podium issue create … --after <ref>[,<ref>]   # sugar: create + blocks edges, so decompositions arrive already wired

# Brief sections (if we add GOAL/SCOPE; ACCEPTANCE already exists as --acceptance)
podium issue update --id <epic> --goal "…" --scope "…" --acceptance "…"

# Reading the deck as text (the coordinator steers from the same picture the user sees)
podium issue deck <epic> [--json]             # phases, tasks, roll-up state words, seats, unmet deps, proposals
```

Supporting changes:
- **One state derivation for UI and CLI.** The roll-up (Error > Needs you > …) lives in `client-core` today. The CLI cannot show the coordinator the words the user sees. It should move to a shared module that the server's `deck` and `epic-status` can call.
- **Seats need no new verb.** The worker is the task's coordinator (`claim` sets it). A helper is any other session (`agent spawn --issue <task>`). A phase lead is `phase lead --set`, or `agent spawn --issue <phase>` followed by claim. Spawn could take a `--lead` shortcut.
- **Proposal actions** are operator-only (`promote`). "Backlog" = promote to backlog with mission placement. "Start" = promote + start, so we must pick its agent, model and machine defaults. An agent proposal could carry `--phase` as a placement hint, so it lands in the right phase.
- **Prime and system pointer text:** "on an epic: group work into phases only when order matters; give every task a role; wire waits-on with `--after`; a phase lead owns its phase subtree." Plus the new fields in `prime`/`show`/`tree`.

## 4. Conflicts with decisions already in the code

1. **Error above Working.** The design orders Error > Needs you > Working. POD-1601 (`mission.ts:1919`) deliberately ranks a running second agent above an errored one: "a mission with a second agent still computing genuinely IS working".
2. **Error is folded into Needs you today.** `SessionModel.asking` = needs_user OR errored OR offer (`models.ts:939`). The design splits them into red Error and amber Needs you. Does a pending **offer** (for example review-ready) count as Needs you? Today it does.
3. **The design has no word for retired, cancelled, moved, review or shipping.** Today `deckIssueState` has 11 states. The design has 7. Each must be mapped: a task whose sessions all ended but is not done (today "retired"); `stage=review` with an offer; cancelled, superseded or duplicate; handed off ("moved"); shipping.
4. **The design's expanded mode is wider than today's maximum.** It is "≥ 860px", but today's expanded width is capped at 760 (`AppShell.tsx:1052`) and exists only in Waterfall. Mockup board B (expanded) is about 700px wide. Is expanded a **mode toggle** or a **width threshold**?
5. **Removing Waterfall/Timeline.** They are dev-only behind `podium-development`, so dropping them is cheap, but this is your call.

## 5. Open questions for the design side (Till)

**States and numbers**
- **Gauge unit.** The mockup reads "20 done · 4 · 1 · 1" (26 units), yet the filter says All 37 and Done 23. What does the gauge count: top-level tasks, leaves, or every task? Today's gauge also has "in review" and "stalled" bands. Are those dropped?
- **Crew "33 agents".** Every session ever on the mission, or live ones? The simple variant says "1 working".
- **Session "Done".** Does it mean the session exited, or its task closed? What does a **hibernated** session show?
- **What clears Error?** Does it stay red until the session restarts, until the user opens it, or until the task closes?
- **Working timer.** Is it the current turn (`since`) or the total working time?
- **Native subagent state.** We only know that a subagent is live, not "waiting" or "running". Which word should show, or should there be none?

**Structure**
- **Phase gating.** Phases are ordered, but do they **gate**? The mockup derives "Starts when Build is done" from task dependencies only. Confirm that there is no phase-level dependency.
- **Where grafted issues land.** These are issues a session started outside the formal tree. Which phase do they belong to?
- **Dependencies on issues outside the epic.** The mockup counts them as unmet but draws no edge. How should they show?
- **Edge types.** Are only `blocks` edges drawn? Do `related` and `validates` show at all?
- **"Simple issue" switch.** The rule is "1 session and no phases". What exactly flips it, and how do we avoid the layout jumping when a second session or the first sub-issue arrives?
- **Role vocabulary.** Is it closed at six values? Who sets it (the coordinator, the operator), and can a parent have a role?

**Interactions the design drops or does not cover**
- **Task actions.** Today the ring is a status picker, and there is a ⋯/context menu with start, rename, reveal and stage. With "click strip = fold only", how does the user open an issue's detail or act on a task?
- **Inline offers and replies.** The coordinator card "has no action cards or inline replies". Is the same true for every session row? Today offers render inline.
- **Today's sections the design omits.** Archived sessions, "Where the work went" (departures), fold-all, and search (mentioned only in a note).
- **Declining a proposal.** Proposals offer only Backlog and Start, with no Dismiss. How does the user decline one?
- **"Open in sidebar"** in the expanded brief. What does it do? No such feature exists today.
- **Selection with split panes.** Is the selected session the focused pane's session?
- **Fold state per user per issue.** Synced across the user's devices (server), or per device as today?
- **Engine tiles.** Grok, OpenCode, Cursor, Pi and shell need tiles.
- **Mobile.** It shares `MissionScreen`. Does it adopt the new filters (All / Needs you / Active / Up next) and the new states?

## Decisions (with the user)

**D1 — Phase model (2026-10-12).** A phase is an ordinary parent issue with `type = phase`, placed under its parent like any issue (D2 lifted the "only under the epic" rule). It has no behaviour of its own:
- Order comes from `sort_key`, and gating from `blocks` edges.
- The phase lead is the phase issue's coordinator.
- A phase closes like any issue, with no enforcement.
- The marker only does two things: the deck draws the issue as a section, and the issue is never counted.
- Counting: the gauge, the done line and the filter totals count leaves. A row's counter (e.g. 1/3 on a parent, 7/9 on a phase) counts its direct children.
- Data migration: POD-279's 11 `milestone` issues ("Phase 0…9") become `phase`.
- Agents also need a small `move --before/--after` verb, because today they can only pass a raw `--sort-key`.

**D2 — Types, labels, roles (2026-10-14).**
- **`type`:** `task` (default), `phase`, `decision`.
  - `epic` is dropped: any issue with children is a parent, and the mission is the root.
  - `bug`, `feature`, `chore`, `story` and `spike` become labels.
  - `decision` = only the user can close it; it counts as Needs you and blocks whatever waits on it.
- **A phase can sit at any depth.** How the deck draws a nested phase is a question for Till.
- **Role is an agent template.** The session records the template it actually runs with; the issue holds a default that every session started on it inherits.
  - Open: whether it absorbs `default_agent/model/effort`, and what the template is called.
- **One coordinator marker per issue.** Deck labels such as coordinator, phase lead and helper are derived from it.
  - Open: when the marker is set.
- **The issue lint goes** → POD-6094.
- **Deferred to the end of the epic:**
  - agent-checkable gates → POD-6095
  - milestone markers in the deck → POD-6096

## Tooling gaps found while structuring this epic

1. **`issue create --parent-id` from a plain `git worktree` fails** with `repoPath: Required`, although the help says the path is inferred from the cwd. Passing `--repo-path <main checkout>` works.
2. **No way to say "deferred, decide at the end".** Every sub-issue starts in `backlog`, so a deferred one looks the same as a ready one. I had to write "Deferred:" into the description.
3. **No "later" bucket in the deck design** to hold deferred sub-issues (a design question for Till).

**D3 — Agent profiles, coordinator timing, labels (2026-10-14).**
- **`agent_profile`:** a table, renamed from the unused `execution_profiles` (0 rows).
  - Issues and sessions carry the agent fields plus an optional `agent_profile_id`. The effective values are the profile with the fields applied on top.
  - The mechanism is abstracted so every caller resolves it the same way.
  - A session records the values it actually started with, so editing a profile never rewrites history.
  - CLI `--profile <name>`; the UI says "Agent profile".
- **Coordinator:** set automatically when a session first creates a child under its *own* issue.
  - It is announced in that command's output, in the session's `prime`, and in the issue history.
  - `--claim` / `--set` / `--clear` remain for handovers.
  - This replaces "the first agent to claim becomes coordinator".
  - Every other session on the issue is labelled "helper". Any non-coordinator asks the nearest coordinator at or above its issue.
- **Labels:** a normalized label entity (names unique ignoring case) with create-or-pick for humans.
  - Agents may only apply existing labels (`--create-label` to add one), and `prime` lists them.
  - No label groups for now.
- **Stage model** (todo vs backlog, merging with proposed, categories): deferred → sub-issue.

**D4 — Agent profile contents and storage (2026-10-14).**
- **Storage:** profiles live in the database. Instructions are markdown, and import/export uses the Claude Code agent-file shape (`.podium/agents/<name>.md`, frontmatter plus body). Repo files that override by name stay possible later.
- **Fields:** description, an ordered list of (harness, model, effort) candidates, an optional machine, and instructions.
- **Candidates:** the first usable one is picked at start. A session never switches mid-run; a usage limit shows as Error.
- **Instructions are layered, never replaced:** issue rules → seat text → profile text, each a source in the existing session-instruction registry.
- **Who edits:** profiles are user-only. Agents can pick one but not edit it.
- **Seeds:** Till's six roles ship as starter profiles.
- **The profile UI is a later phase, possibly deferred** → POD-6098.
- **Gap:** I can't create real phases for this epic yet (`type = phase` doesn't exist), so "later phase" is only a sub-issue for now.
- **Addendum to D4:** a profile's instructions are optional. A profile can be just an agent setup with no instructions.

**D5 — Session states and who may talk to the user (2026-10-14).**
- **The five words:**
  - **Working:** working, compacting, starting or reconnecting. The timer shows the current turn.
  - **Idle:** the turn is finished and the process is alive or hibernated.
  - **Needs you:** a question, a permission request, or a pending offer.
  - **Error:** any agent error, a crash, out-of-memory, or a failed start.
  - **Done:** stopped by itself, its parent or the user, or its issue is closed. It shows ∑ total working time.
- **What clears Error:** a new turn, or closing the issue. Opening the session does not.
- **Native subagents:** they show "running" while they exist. The list holds live ones only.
- **Talking to the user:** only a session with no coordinator above it may (the top coordinator, or the session of a single-issue mission). Every other session is blocked from:
  - the harness's built-in ask-the-user tools: denied through hooks, with a message that says where to ask instead. Which harnesses expose such a tool must be checked by running each one.
  - `podium offer`: refused by the server, with the same kind of message.

  These sessions are told to ask their coordinator instead. So a pending offer is always Needs you; choice 1 is moot.
- **Question routing is deferred.** Blocked sessions ask with the existing `issue mail send <coordinator's issue> --expect-response`. The seat instructions and the refusal messages name that issue.

**D6 — Task roll-up (2026-10-14).**
- **Order:** Error > Needs you > Working > Idle > Blocked > Not started. Error ranks above Working, which overturns POD-1601; tasks in Error or Needs you open by default, so the crashed row is in view.
- **Done** only when the issue is closed. Cancelled, duplicate and superseded issues count as done and are hidden.
- **A started task with nothing running that isn't closed shows Idle.** No "Stalled" word.
- **Blocked:** an unmet `blocks` dependency and nothing running. A cancelled dependency counts as met.
- **A decision** shows Needs you until it is closed.

**D7 — Dependency types (2026-10-14).**
- **A fixed list:** `blocked-by`, `related`, `discovered-from`, `supersedes`, `duplicates`.
- **`blocked-by` replaces `blocks`.** It reads correctly in the stored direction (A blocked-by B = A waits for B), it matches the Blocked state, and it is the industry term.
- **Migration:** `blocks`, `blocked-by` and `waits-on` all become `blocked-by`. This fixes 24 edges that are ignored today.
- **The `dep-add` verb stays** as it is.
- **Cycle check** on `blocked-by`.
- **Dependencies may point outside the mission.**
- Filed as POD-6100.

**D8 — Issue text fields (2026-10-14).**
- **Three fields only:**
  - `description`, for humans. The summary comes first; optional sections such as Goal or Scope follow, and the deck expands them.
  - `brief`, for agents.
  - `acceptance`, shown to agents in `prime` and again when they move the issue to review or done.
- **`design` and `notes` fold into `brief`** and are removed.
- **The deck's link says "Read more"**, not "brief".
- Filed as POD-6101.
