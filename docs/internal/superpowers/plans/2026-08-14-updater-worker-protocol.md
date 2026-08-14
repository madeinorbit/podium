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

- Repo gates, run **sequentially**, before merging: `bun run typecheck`, then
  `bun run test:related -- <your changed files>`, then `bun run test` if your plan says so.
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

- Update your issue: `podium issue state <id> --set "…"` (what landed, how verified),
  `podium issue close <id> --note "…"`.
- Mail the epic: `podium issue mail send 2087 --body "POD-<id> merged to integration:
  <one-line summary>. Gates: <what you ran>."`
