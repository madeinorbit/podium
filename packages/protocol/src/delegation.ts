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
 *  The spawn number must match SPAWN_BUDGET_PER_DAY on the server (tested there). */
export const COORDINATION_RULE =
  'Coordinating (with Podium task tracking): claim the role when the user names you coordinator or you orchestrate other agent sessions: `podium issue coordinator <id> --claim`. Creating a child under your own issue also claims its seat, but only an empty one. Solo edit/test/review work needs neither a claim nor phases. ' +
  'Phases: use them when the work has two or more stages that run one after another and grouping them helps the user follow progress on the deck; then use them even if the user never said "phases". A stage may hold a single task. Never a phase per routine task, nor phases around one agent\'s ordinary steps. ' +
  'Create one with `podium issue create --type phase --parent-id <id> --title "…"`. A new sibling appears at the TOP of the deck, so after each later phase run `podium issue move <new> --after <previous>`. `podium issue dep-add <later> <earlier>` records the wait but enforces nothing: the later phase\'s tasks are not blocked and start/spawn do not refuse, so launch them only once the earlier phase is done. ' +
  'Put each delegated task under its phase (`--parent-id <phase>`). Work that needs its own worktree: create the task with `--start` (one agent; do not also spawn). Read-only work: create it without `--start`, then `agent spawn --issue <task>` once; with no task worktree it runs in the repository checkout, so name the checkout to read and forbid writes. ' +
  "Budget: 10 agent spawns per target issue per UTC day, shared by every spawn onto that issue. Create tasks for real work, never to get around a refusal; a refusal started nothing, so mail a live session or ask your coordinator or the operator. Check each spawn's exit status and session id before the next: a failure exits 1 with the reason on stderr (`--json`: ok:false on stdout), and a pipe reports only its last command's status."

// These ride prime (not the always-on system pointer). Keep them operational and
// short: the "why" lives in the file comment and docs/agents/*.md.
