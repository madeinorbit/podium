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

/** Advisory named leases [spec:SP-85d1]. Injected into the prime rules verbatim,
 *  next to the merge-lock rule.
 *
 *  `podium merge-lock` is only CLI sugar for the lock named `merge:<branch>`; the
 *  generic `podium lock` underneath takes any name. Agents were never told the
 *  generic form existed, so leases looked like a merging-only tool and sessions
 *  sharing a workspace had no coordination primitive they knew about. */
export const LOCK_RULE =
  'Locks are not just for merging: `podium lock acquire <name> [--ttl 10m] [--wait]` takes an advisory lease on ANY name ' +
  '(`release`/`renew`/`cancel`/`status`/`steal`; `podium merge-lock` is only sugar for the lock named `merge:<branch>`). ' +
  'Use one whenever two sessions could touch the same thing — shared files, a migration number, a dev server, a deploy. ' +
  'Leases are ADVISORY: nothing enforces them, they expire (default 2m — pass `--ttl` or `renew`), and they only work if BOTH sides agree to take them.'

/** How an agent must delegate. Compact by design: this rides the prime, which is
 *  injected into every session, and most sessions never delegate — so this states
 *  the four things that are wrong-by-default and points at the full guide. */
export const DELEGATION_RULE =
  'Delegating (`podium agent spawn --prompt "…" --issue <ref>`): the system infers NOTHING about your delegate — no roles, no write-claim, no auto-isolation. ' +
  'What you TELL it is the only lever, so every spawn prompt must carry four things: ' +
  "(1) PLACEMENT — `agent spawn --issue <ref>` adds a delegate to an ALREADY-STARTED issue, sharing its workspace and files; that is the default and it is right for a reviewer or researcher. Issues own branches and sessions never do, so a delegate that must implement CONCURRENTLY needs its own issue — one command: `podium issue create --parent-id <id> --description \"<its brief>\" --start`, which creates the branch+worktree AND spawns exactly one agent with the description as its first prompt. Do NOT also `agent spawn --issue <sub>` after `--start`: that puts a SECOND agent in the same worktree and they clobber each other. `--worktree` does NOT isolate — it only asserts the issue has a worktree, so pass it to fail loudly instead of silently landing in the repo root. " +
  '(2) NAMING — name it at spawn with `agent spawn --title "Reviewer: auth flow"` (names the SESSION; `--new "title"` names an ISSUE) so the human\'s board reads like a team instead of a row of anonymous sessions. The isolated path has no such flag — `issue create --start` names the issue, so tell that delegate to self-title as its first action in the `--description`. You cannot retitle a delegate later: `podium session title` only renames the calling session. ' +
  '(3) CONCURRENCY — if it may edit files another live session edits, prescribe the arrangement: who owns which files, or a lease. Never assume the system serializes it; it does not. ' +
  '(4) TEAM — who else is on the issue, which machine they are on, and that `podium issue mail send <id>` is how to reach them. ' +
  'Full guide: docs/agents/delegating.md'

// No TERSE variant here, unlike ./titles: the prime is hook-injected into every
// session already, so a second compressed copy in the always-on system pointer would
// buy nothing and cost tokens in the sessions that never delegate — which is most.
