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

/**
 * How an issue branch lands on a shared branch (usually `main`) [spec:SP-85d1].
 *
 * Injected into the prime rules verbatim. The failure this text exists to prevent
 * is the one agents invent under load: cherry-pick the unique commit onto
 * `origin/main` and push a temp tip. That ships the blobs but leaves the ISSUE
 * BRANCH tip out of main's history, so the sidebar keeps "ready to merge"
 * forever (`issueAwaitingMerge`). Content-on-main is not enough; ancestry of
 * the issue branch is the contract.
 *
 * Integration target is LOCAL `main` under the merge lock (refresh it from
 * origin first, merge into it, then push). `origin/main` alone is not a
 * substitute for that path.
 *
 * Two clauses here are paid for in lost commits rather than reasoning [POD-672].
 * `reset --hard origin/main` is banned outright because local main legitimately
 * runs ahead of origin between landings, so a reset is indistinguishable from
 * "discard whoever landed last" — and unlike `--ff-only` it SUCCEEDS, which is
 * what makes it silent. The untracked-file clause is the same shape one level
 * quieter: the merge abort is git being correct, and every quick way past it
 * (`merge -f`, `checkout --force`, `rm`) destroys content that has no reflog to
 * recover it from.
 *
 * Done criterion is the git fact the UI proxies for [POD-576]: the issue tip
 * is an ancestor of the landing base. `gitState.ahead === 0` is only a proxy
 * measured against `parentBranch` (where the branch was cut from); for a
 * stacked issue whose cut parent has itself landed, that proxy can stay > 0
 * forever even when the tip is already on main. Prefer
 * `git merge-base --is-ancestor <issue-tip> origin/main` (or `gitState.merged`).
 * Caveat: merge-base reads the LOCAL `origin/main` ref — authoritative right
 * after your own push (the push moved it), stale later until you fetch.
 */
export const MERGE_LANDING_RULE =
  'Landing on a shared branch (e.g. main) — HARD procedure: ' +
  '(1) `podium merge-lock acquire --wait`. ' +
  '(2) Refresh LOCAL `main` (`git fetch` then `git merge --ff-only origin/main` on the main checkout via `git -C <main-checkout>`; never `cd` into it). ' +
  'NEVER `git reset --hard origin/main` (or any reset on main): local main may already carry landings origin does not, and a reset discards them SILENTLY, whereas `--ff-only` refuses. ' +
  '(3) On the ISSUE branch, `git rebase` onto that local `main`. If rebase fails or foreign commits appear, STOP and ask. ' +
  '(4) On LOCAL `main`, `git merge --ff-only <issue-branch>`. If untracked files would be overwritten, do NOT `merge -f`/`checkout --force`/`rm` — an untracked file has no reflog. Compare bytes (`git hash-object <path>` vs `git rev-parse HEAD:<path>`); identical = back up and remove; different = STOP and ask. ' +
  '(5) `git push origin main`, then `podium merge-lock release` IMMEDIATELY. ' +
  'NEVER cherry-pick onto main. NEVER push a temp branch tip. NEVER land unique content under a new SHA and leave the issue branch behind. ' +
  'Done when `git -C <main-checkout> merge-base --is-ancestor <issue-tip> origin/main` (or `gitState.merged`) — not when `gitState.ahead` is 0: ahead is measured against parentBranch, and a stacked sibling can keep "ready to merge" in the sidebar forever. merge-base reads the LOCAL origin/main ref (fetch first if checking later). Guide: docs/agents/podium-issues.md#landing-on-main.'

/** Advisory named leases [spec:SP-85d1]. Injected into the prime rules verbatim,
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
