# Updater epic: worker protocol (POD-2087)

Every sub-issue of the updater epic follows this protocol. It is part of your brief.

## Ground rules

- **Spec first.** Read `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`
  before writing code. Your plan file implements a slice of it; the spec wins over the plan
  if they disagree, and you note the disagreement in your issue state.
- **You are headless.** Never use AskUserQuestion and never wait on a human. Make the
  spec-conformant choice, record it in `podium issue state <your-id> --set "…"`. If you are
  genuinely blocked (cannot proceed on any spec-conformant path), write the blocker to your
  issue state and `podium issue mail send 2087 --body "…"` (plain prose, no backticks — mail
  bodies run through bash), then stop.
- **Naming:** this feature's noun is **operation** (not "run") — it will be reused for other
  long-running lifecycle work (e.g. server moves). Keep the generic layer free of
  update-specific assumptions.
- **Scope:** touch only the files your plan owns unless the plan says otherwise. If you
  discover adjacent work, file it (`podium issue create` + `dep-add … 2087 --type
  discovered-from --outside-scope`), do not do it.

## Before anything: check what your worktree is cut from

`issue start` does **not** inherit the epic's branch — if the issue was created without
`--parent-branch worktree-updater-spec`, your worktree comes off `main` and is missing every
landing in this epic. POD-2158 nearly gated the wrong code this way: HEAD sat 24 commits
behind the integration tip with none of the change it was sent to verify.

First command of your session:
`git log --oneline -1 && git merge-base --is-ancestor worktree-updater-spec HEAD && echo BASE-OK`.
If that does not print `BASE-OK`, repoint onto the integration tip before doing anything else,
and say so in your issue state.

A worktree with **no `node_modules`** is the same hazard in a different costume: bun resolves
`@podium/*` up the tree into the MAIN checkout, so a green describes main's packages, not
your branch. Two workers solved this two ways, both fine:

- **Hardlink-copy a sibling's tree (cheapest and simplest — try this first).**
  `cp -al <sibling-worktree>/node_modules node_modules` when that sibling's `bun.lock` blob
  is identical to yours. POD-2179 did it in **9 seconds with no measurable disk cost**, then
  proved resolution landed in its own worktree. Verify the lock blobs match first
  (`git rev-parse HEAD:bun.lock` on both) — a mismatched tree is worse than none.
- **Symlink farm (free, preferred at low disk).** In-checkout `@podium/*` symlinks plus a
  `.bin` symlink farm satisfies the workspace-link gate at zero bytes — POD-2155 did this
  rather than install against 2.8 GB free. **Do not mirror main blindly:** main still carries
  leftover directories for packages that no longer exist in git (`agent-bridge`, `core`,
  `domain`), and linking those re-creates the exact resolve-into-main hazard the farm exists
  to prevent. Drop them, then prove resolution (`Bun.resolveSync`, or a deliberate type error
  that must come back naming *your* worktree's file). **`node_modules/.vite-temp` must be a
  REAL local directory, never a link into main** — otherwise vite writes its temp config into
  the shared checkout and then fails to import it back, killing the run at config load. Same
  for `.vite`, `.cache`, `.vitest` (POD-2161).
- **Install (cheap, but measure).** `du` overstates badly because bun hardlinks: a sibling's
  2.0 GB tree cost ~0.1 GB beyond the shared cache (POD-2158). Measure before, respect the
  margin below.

Either way, say in your issue state which you did — a green from a worktree that silently
resolved into main is worse than no green at all.

## Branch and merge

- Your issue branch was created off the integration branch **`worktree-updater-spec`**. Work
  in your own issue worktree only.
- Commit messages end with the trailer `Podium-Issue: POD-<your id>`. Commit with
  `git commit -F <file>` (commit messages run through bash; backticks execute).
- When your plan's acceptance list is green, land on the integration branch:
  1. `git fetch` nothing — the integration branch is local. Rebase your branch onto the
     current `worktree-updater-spec`: `git rebase worktree-updater-spec`. If the rebase
     conflicts in files your plan does not own, stop and mail 2087.
  2. Re-run your gates after the rebase (typecheck + your focused tests, sequentially).
  3. `podium lock acquire updater-integration --ttl 10m --wait` — **read the output. Proceed
     only if it says `acquired`.** The lock can fail open on relay timeout; a timeout means
     you are still queued — wait and re-check, never proceed unlocked.
  4. `git -C /home/mgw/src/other/podium/.claude/worktrees/updater-spec merge --ff-only <your-branch>`
     (never cd there; never use any non-ff merge; if ff-only refuses, release the lock,
     rebase again, retry).
  5. `podium lock release updater-integration` immediately.
- Never touch `main`, never push anywhere, never merge the integration branch into your
  branch (rebase onto it instead).

## Testing

- **`test:related` DOES NOT COVER `apps/web`.** It runs only the `node` and
  `normalized-wire` projects, and `apps/web` has its own vitest config — so a web test file
  is never selected and the gate reports success having run nothing about your change
  (POD-2163 caught this: `use-update-state.test.tsx` was invisible to the prescribed gate).
  If your change touches `apps/web`, **run its suites directly** and say which ones —
  **with the working directory set to `apps/web`**, not `vitest --root apps/web` from the
  repo root, which fails at startup on the hermetic env import because the flag overrides
  the config root and with it the fs allow-list (POD-2184). Any
  brief of mine that says "gate on test:related" for web work is wrong; correct it and tell
  me.
- Repo gates, run **sequentially**, before merging: per-package typecheck (never repo-wide,
  see above), then `bun run test:related -- <your changed files>` for non-web code, plus the
  direct suites for anything web.
- No fixed sleeps in tests — inject clocks. A `setTimeout` before an assertion is a bug in
  this repo's unit lane.
- **Gate on the comparison when a shared lane is red.** Known: `apps/web` typecheck is red
  at the integration base itself (POD-2109, pre-existing on main), and the broad test lane
  carries pre-existing failures. A bare green is therefore not achievable repo-wide. The
  gate for landing is: your owned-scope tests green, plus the shared lane's failure set on
  your branch **byte-identical** to the failure set at your fork point (A/B against a
  detached worktree at that SHA — no `bun install` there, `--root` is the repo root). Any
  delta that plausibly touches your files must be resolved before merging; record the
  comparison (both failure sets, the SHA) in your issue state.
- **Rust: cargo DOES exist here.** The older specs and my earlier briefs claimed "no local
  cargo"; that is wrong — `cargo 1.96.1` is at `~/.cargo/bin` (verified 2026-08-16, POD-2142).
  There is no warm build cache, though, and disk is tight, so a full `cargo build` of the
  Tauri crate is expensive: prefer `cargo test` scoped to the pure functions you added, judge
  the cost against free space first, and let CI remain the authority for a full build. What
  you must not do is *claim* a build you did not run — say plainly which of the two you did.
- **Memory is scarcer than disk — take the heavy-lane lock (POD-2159).** The box has ~23 GB
  and the kernel has already OOM-killed 38 processes here; a session that runs `typecheck`
  or a broad suite while a sibling is doing the same is *killed mid-command with no error*,
  which looks exactly like a wedge and loses everything uncommitted. So:
  `podium lock acquire updater-heavy-lane --ttl 20m --wait` before **any** `typecheck`,
  broad `test`, or build — and release the moment it finishes.
  **Two words mean you hold it: `acquired` *and* `renewed`.** POD-2161 was told to gate on
  `acquired` alone, saw `queued at position 1` then `agent relay timed out`, and correctly
  refused to run — but the grant had landed *after* the relay gave up, and its retry then
  printed `already held: renewed`. So: a relay timeout is not a refusal, it is an unknown;
  re-run `acquire` and treat either word as ownership. `podium lock status <name>` tells you
  the holder and is worth checking when in doubt (it can be slow under load, so give it a
  timeout rather than assuming it hung).
  **What you may run, calibrated by measurement rather than fear:** a *scoped* typecheck
  (`--filter` + `--concurrency=1`) is cheap and safe — POD-2175 ran it twice at ~2.5 GB free,
  finishing in under a minute at 11/11 tasks, nothing killed. So: check `free -g`; at **≥2 GB
  available** with the lane free, take the lane and run it. Below that, or for a **build**,
  ask the coordinator. Focused single-file vitest needs no lock and no permission.
  **Do not run repo-wide `bun run typecheck` on this box at all** — see POD-2159. Use
  `turbo run typecheck --filter=@podium/<pkg> --concurrency=1`, and understand *why* it
  survives (POD-2161 measured this): **`--filter` does NOT run one package** — it runs that
  package plus its workspace deps, eleven tasks for `@podium/server`, the same eleven that
  killed three sessions. **`--concurrency=1` is what makes it survivable, not the filter.**
  The same fan-out hides in vitest: `PODIUM_TEST_WORKERS` unset defaults to CPU count (8
  forks here), each with its own Bun/Vite module graph — **pin it to 1**.
  **Never wrap `podium lock acquire` in `timeout`** — that kills your queue entry before the
  grant lands. Run it unbounded; a fresh "granted to you" notice in the issue mail inbox is
  the reliable cross-check.
  **Do not hold the lane across a whole session.** POD-2166 could not run a single test all
  session because a sibling held the lane continuously and renewed it past expiry with
  another queued ahead. Take it *immediately before* one command, release *immediately
  after*, and never renew to keep your turn — re-queue instead. **A single-file focused
  vitest run needs no lock at all**; the lane is for typecheck, broad suites and builds.
  If you have waited more than ~20 minutes, say so in your issue state so I can see the
  starvation. Focused vitest on your own files needs no lock. **Commit before you run a heavy
  lane**, so a kill costs you the run and not the work.
- **Disk is tight (98% as of 2026-08-14, POD-2111).** Check `df -h` before any build or
  full-suite run; below ~3 GB free, stop and mail 2087 instead of risking a silently
  truncated write. For A/B base runs prefer a detached in-place checkout of your own
  worktree over creating a second worktree (restore your branch immediately after), and
  remove any scratch directories you create as soon as the comparison is recorded.
- New gates/tests must be proven able to fire: make the assertion fail once (mutate the
  code or the fixture), see red, restore, see green. Say so in your issue state.
- UI changes additionally need a real drive per `docs/agents/driving-podium.md` and the
  cadence-1 checks in `docs/agents/updater-acceptance.md`.

## Done

- **Finish every gate and comparison BEFORE you close.** Closing triggers the system
  worktree cleanup, which deletes your checkout out from under anything still running —
  POD-2099 lost a broad lane this way and it failed *silently* (2 of 27 tasks done, the
  rest "unable to spawn child process", no error that looks like a deletion). Order is:
  gates → comparison recorded in issue state → merge → close.
- **Wire-golden fixtures: recapture only your own family.** An additive field on a wire
  type can still break `packages/protocol` wire-golden, because the corpus pins bytes.
  `fixtures:wire:update` rewrites *every* family, and five of them (feature-state, feed,
  issues, model, sync) are drift-red at the integration tip already — sweeping those in
  hides someone else's pending change behind yours. Recapture the one family your change
  touched and leave the rest red.
- **Adding a server test file? Regenerate the shard roster in the same commit:**
  `bun scripts/server-test-shards.ts --write`. This has now bitten twice (POD-2170 for
  `operations/trpc.test.ts`, POD-2175 for `reconciler.test.ts`). The failure is nasty
  because it is not a failing test: the exhaustiveness gate names your file unowned and
  `apps/server#test` **refuses to start at all**, so the whole lane reports red for a reason
  unrelated to anything you changed, and nobody's server green is honest until it is fixed.
- **Clean up your build outputs before you close.** POD-2103 removed `dist-bun`,
  `apps/web/dist`, retained sourcemaps and its harness state dir on the way out and put
  **1.3 GB** back on a box that was at 99%. If you built anything, delete it; say how much
  you freed.
- Update your issue: `podium issue state <id> --set "…"` (what landed, how verified),
  `podium issue close <id> --note "…"`.
- Mail the epic: `podium issue mail send 2087 --body "POD-<id> merged to integration:
  <one-line summary>. Gates: <what you ran>."`
