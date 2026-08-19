/** Delegation doctrine, stated once and reused by every surface that instructs a
 *  delegating agent: the issue prime (server) and the committed guide
 *  (docs/agents/delegating.md). Same single-source rule as ./titles — copies drift.
 *
 *  Why this text exists at all: Podium deliberately has no agent roles, no
 *  write-claim, and no activity-based auto-isolation [spec:SP-4ef9]. Placement
 *  rides the spawn decision and semantics ride the session title, so nothing about
 *  a delegate's behaviour is inferred by the system — the ONLY lever a coordinator
 *  has is what it TELLS the delegate. Guidance is therefore the feature.
 */

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
  'Delegating (`podium agent spawn --prompt "…" --issue <ref>`): the system infers nothing — no roles, no write-claim, no auto-isolation. Every spawn prompt must carry: ' +
  '(1) PLACEMENT — `--issue <ref>` adds a delegate to an already-started issue (right for a reviewer). Concurrent implementation needs its own issue: `podium issue create --parent-id <id> --description "<its brief>" --start` (branch+worktree and exactly one agent). Do NOT also `agent spawn --issue <sub>` after `--start`. `--worktree` does not isolate — it only asserts a worktree exists. ' +
  '(2) NAMING — `agent spawn --title "Reviewer: auth flow"` names the SESSION (`--new "title"` names an ISSUE). The isolated path has no title flag; tell that delegate to `podium session title` in the `--description`. You cannot retitle a delegate later. ' +
  '(3) CONCURRENCY — if it may edit files another live session edits, say who owns which files or take a lease. The system does not serialize. ' +
  '(4) TEAM — who else is on the issue, which machine, and that `podium issue mail send <id>` reaches them. ' +
  'Guide: docs/agents/delegating.md'

// These ride prime (not the always-on system pointer). Keep them operational and
// short: the "why" lives in the file comment and docs/agents/*.md.
