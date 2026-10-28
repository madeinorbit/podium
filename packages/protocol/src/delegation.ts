/** Delegation policy shared by the always-on pointer and issue prime.
 *  The coordinator tip and docs/agents/delegating.md use the same policy.
 *
 *  Why this text exists at all: Podium deliberately has no agent roles, no
 *  write-claim, and no activity-based auto-isolation [spec:SP-4ef9]. Placement
 *  rides the spawn decision and semantics ride the session title, so nothing about
 *  a delegate's behaviour is inferred by the system — the ONLY lever a coordinator
 *  has is what it TELLS the delegate. Guidance is therefore the feature.
 */

/** Podium is the default for both tasks and agents. [spec:SP-f7a5] */
export const DELEGATION_POLICY =
  'Instructions to use subtasks or subagents mean Podium sub-issues for task tracking and Podium sessions for delegated agents by default. ' +
  'Use native harness tools only when the user explicitly requests them for that work; that request permits both native task tracking and native subagents.'

/** Advisory named leases. Injected into the prime rules verbatim,
 *  next to the merge-lock rule.
 *
 *  `podium merge-lock` is only CLI sugar for the lock named `merge:<branch>`; the
 *  generic `podium lock` underneath takes any name. Agents were never told the
 *  generic form existed, so leases looked like a merging-only tool and sessions
 *  sharing a workspace had no coordination primitive they knew about. */
export const LOCK_RULE =
  'Locks are not just for merging: `podium lock acquire <name> [--ttl 10m] [--wait]` takes an advisory lease on ANY name ' +
  '(`release`/`renew`/`cancel`/`status`/`steal`; `podium merge-lock` is sugar for `merge:<branch>`). ' +
  'The `merge` namespace is RESERVED to that canonical name — `podium lock acquire merge` and near-misses are REFUSED. Take the merge mutex through `podium merge-lock`. ' +
  'Use a lock whenever two sessions could touch the same thing. ' +
  'Leases are ADVISORY: nothing enforces them, they expire (default 2m), and they only work if BOTH sides take them. ' +
  '`acquire` REFUSES when a sibling — another session on your issue, or any session sharing your worktree — already holds or is queued: coordinate, or pass `--allow-sibling`. Re-acquiring a lock you hold renews it.'

/** How an agent must delegate. Compact by design: this rides the prime, which is
 *  injected into every session, and most sessions never delegate — so this states
 *  the four things that are wrong-by-default and points at the full guide. */
export const DELEGATION_RULE =
  DELEGATION_POLICY +
  ' ' +
  'Delegating (`podium agent spawn --prompt "…" --issue <ref>`): the system infers nothing — no roles, no write-claim, no auto-isolation. Every spawn prompt must carry: ' +
  '(1) PLACEMENT — `--issue <ref>` adds a delegate to an issue, in its worktree, or the repository checkout if it was never started (right for a reviewer or read-only researcher). Concurrent implementation through Podium needs its own issue: `podium issue create --parent-id <id> --description "<human summary>" --brief "<task instructions>" --start` (branch+worktree and exactly one agent). Do NOT also `agent spawn --issue <sub>` after `--start`. `--worktree` does not isolate — it only asserts a worktree exists. ' +
  '(2) NAMING — `agent spawn --title "Reviewer: auth flow"` names the SESSION (`--new "title"` names an ISSUE). The isolated path has no title flag; tell that delegate to `podium session title` in the `--brief`. You cannot retitle a delegate later. ' +
  '(3) CONCURRENCY — if it may edit files another live session edits, say who owns which files or take a lease. The system does not serialize. ' +
  '(4) TEAM — who else is on the issue, which machine, and that `podium issue mail send <id>` reaches them. ' +
  'Guide: docs/agents/delegating.md'

/** How to coordinate work on the issue tree (POD-2062). An agent told "you are the
 *  coordinator of this epic, group the work in phases" ran its stages as a bash
 *  queue, never claimed the role, and lost three spawns to the budget behind a
 *  `| grep`: nothing it could read said phases are issues or what the limit is.
 *  POD-2178: coordinators then filed each task only as they launched it and
 *  drew waits between phases, so the deck showed nothing ahead and no edge said
 *  which task needs which. Phases only group (flight deck D1); edges join tasks.
 *  POD-2232: delegates moved to review and mailed, but nothing told the
 *  coordinator to accept and close, so tasks and phases sat in review forever.
 *  The spawn number must match SPAWN_BUDGET_PER_DAY on the server (tested there). */
export const COORDINATION_RULE =
  'Coordinating (with Podium task tracking): claim the role when the user names you coordinator or you orchestrate other agent sessions: `podium issue coordinator <id> --claim`. Creating a child under your own issue also claims its seat, but only an empty one. Solo work you do yourself stays flat: no claim, phases or child tasks; list its steps with `podium issue todo <id> --add`. ' +
  'Plan on the tree before you launch: the deck shows the user only what exists. Your first pass files every task you can already name, later stages included, WITHOUT `--start` (Not started; no spawn budget). Launch each in its turn: `podium issue start <task>` for its own worktree and agent, or `podium agent spawn --issue <task>` for read-only work, which runs in the repository checkout, so name it and forbid writes. A task whose split waits on an earlier result gets one task named for the outcome; split or retitle it then, and refresh its brief with `podium issue update --id <task> --brief`. ' +
  'Phases only group: use them when the work has two or more stages that run one after another and grouping them helps the user follow progress; then use them even if the user never said "phases". A stage may hold a single task. Never a phase per routine task, nor phases around one agent\'s ordinary steps. Create one with `podium issue create --type phase --parent-id <id> --title "…"`; a new sibling appears at the TOP of the deck, so run `podium issue move <new> --after <previous>`. Put its tasks under it with `--parent-id <phase>`; a phase is done when its tasks are. ' +
  "Edges go between tasks, never phases: `podium issue dep-add <later-task> <earlier-task>` when a task needs that task's output. It enforces nothing, so launch a task only once what it waits on is done. " +
  'Close what you accept: when a delegate reports review-ready, check its deliverable, then either close the task (`podium issue close <task> --reason done --note "<what you accepted>"`; this stops its sessions) or mail its session concrete reasons to send it back. Close research and design tasks once you have used their output. Your own issue stays open for the user to close. ' +
  "Budget: 10 agent spawns per target issue per UTC day, shared by every spawn onto that issue. Create tasks for real work, never to get around a refusal; a refusal started nothing, so mail a live session or ask your coordinator or the operator. Check each spawn's exit status and session id before the next: a failure exits 1 with the reason on stderr (`--json`: ok:false on stdout), and a pipe reports only its last command's status."

// These ride prime (not the always-on system pointer). Keep them operational and
// short: the "why" lives in the file comment and docs/agents/*.md.
