# POD-1761 standing brief — read this before your issue's own brief

Every rule here exists because it already cost somebody a round on this epic. None of
them is hypothetical. Your issue's brief carries only what is specific to your issue;
everything general lives here so it stops being re-typed one session at a time.

## Bases and branches

- **A fresh sub-issue branch is cut from `main`, not from the epic.** Tracker parentage
  is not git parentage. You are not *behind* the epic, you are on a *different line*.
- **Use the LOCAL ref: `issue/1761-agent-runtime`.** `origin/issue/1761-agent-runtime`
  trails permanently — the epic lands ff-only on a local branch and does not push until
  the operator decides. All sessions share one machine and one object store.
- **Pick the verb by what you have, not by habit.** No commits *and* a clean tree →
  `reset --hard`. Any commits **or any uncommitted work** → commit first, then `rebase`.
  A bare `rebase` from a branch with no commits of its own replays ~60 main-only commits
  onto the epic and conflicts in files unrelated to your task; abort rather than resolve
  foreign history.
- Before your first edit: `git merge-base --is-ancestor <epic tip> HEAD` must succeed.
- **A wrong base does not error. It produces confident wrong work.**

## Rigs

- **Run as a NAMED instance.** Even the default is named `default` now.
- **Set no override the product would otherwise derive.** Not `ABDUCO_SOCKET_DIR`, not
  `PODIUM_STATE_DIR`, and **not `HOME`** — a named instance derives its state root from
  `$HOME`, so a daemon under an isolated agent-home lands on a state root nested inside
  itself, silently if the directory is empty. *If a rig needs an override to work, the
  override is hiding a defect and the defect is the finding.*
- The **product** honouring an explicit override a caller sets is a feature. A **rig**
  setting one so it works is the defect. Do not confuse them.
- **One probe per directory, one instance per drive**, with an id and working directory
  distinct from every other live session. opencode keys its conversation store *by
  directory*, so a neighbour's transcript reads as your own. Two rigs on one instance
  reap each other's servers by pidfile, and the survivor writes *its* commit into your
  log.
- **`grep -c` prints `0` and exits `1`.** `n=$(grep -c … || echo 0)` yields `"0 0"` and
  every comparison downstream is false forever.
- Check free memory before each heavy step and serialise your own. This box has fallen
  over repeatedly.

## Evidence

- **Pin server, web bundle AND daemon before every run.** The daemon is the one that
  catches people out: drivers live in it and it loads them at process start, so
  repinning the checkout under a running daemon changes nothing.
- **Record the SHA each component BOOTED at**, written at spawn time. A process
  timestamp is not a pin: `/proc` mtimes on this host skew **forward** by up to two
  hours, so an older process reads as newer — the direction that turns a stale rig into
  a pass.
- **Every scored result needs a positive control** that fires whether or not the feature
  works. A zero with the control present is evidence; a zero without it is a dead rig.
- **An absence claim is a claim about the WHOLE surface. Dump everything before
  reporting a silence.** A drive nearly filed a false regression after checking three
  fields and concluding the product said nothing — the whole session row recorded the
  demotion correctly.
- **Pin every class at BOTH edges**: last-accepted and first-refused, works-and-still-
  works. Widening is the direction people forget, and a fix that over-corrects passes a
  naive test while being worse than the bug.
- **Where both arms exist, drive both.** "At least as good as" is a comparison. The
  strongest instrument available here is **same commit, same rig, one variable — the
  driver**; it needs no merge with main and answers the epic's question directly.
- **A control that did not fire is not a result.** Report REFUSED, and say why.
- **Report a control failure rather than dropping it.** An arm that fails for a reason
  unrelated to what it measures, pointing at the comfortable conclusion, is the most
  dangerous shape on this epic.

## Filing and landing

- **File discoveries as SUB-ISSUES of POD-1761** (`--parent-id 1761 --parent-branch
  issue/1761-agent-runtime`). A top-level issue lands in `proposed`, where nothing can
  start it and the coordinator cannot reparent it.
- **Land ff-only on the LOCAL `issue/1761-agent-runtime`, under the merge lock. Never
  main.** Nothing goes to main until the operator decides.
- **Address the coordinator, never the human.** No `AskUserQuestion`, no podium offers.

## Gates

- `bun run typecheck` — let turbo pick the set, never `--force`, never
  `--uncached-because` to get past a refusal without reading it.
- Per-package: `bun run test:unit -- --filter @podium/<pkg>`.
- `bun run test` is a **four-file lean gate**, not the suite. Read the footer's ratio,
  not the command name.
- **State `PODIUM_TEST_WORKERS` with every number.** Ambient here is `1` and the gate
  command unsets it, so the same command reddens or greens by environment.
- `lint:boundaries` already exits 1 with 58 violations inherited from main. It is not a
  signal for this branch — but it must not get worse.
- Do not over-test. This box is CPU constrained.

## Landing (this replaces every "hold the branch" mail)

**Land only while `merge:issue/1761-agent-runtime` is FREE, and take it for your own
landing.**

    podium lock status merge:issue/1761-agent-runtime
    podium merge-lock      # take it, land ff-only, release immediately

Held → wait, someone is mid-operation. Free → it is yours.

**Why this and not a coordinator freeze:** the coordinator once froze the branch by mail
and backed it with a 30-minute lease on a merge that takes hours. The lease expired, three
sessions correctly saw the lock free and landed, and a resolved 307-file merge was left
pointing at a stale first parent. *A rule you check at the moment you act beats a rule you
remember from an hour ago, and a lease you renew beats a promise that decays.*

**If you hold a lock for a long operation, renew it.** Re-acquiring a lock you already
hold renews it. The lease — not anyone's mail — is what actually holds the branch.

## Rigs that manufacture false reds

Three of these were caught in a single drive, by their own author, before anything was
filed. Each would have produced a plausible product-red against a product that was fine.

- **A rig-wide posture that only one row wants is a rig-wide contaminant.** Seeding
  `permission.bash=ask` for the whole rig so one row has an ask to measure parked *every
  other* tool call at `needs_user` for 240 seconds, and the transcript row scored FAIL on a
  product that was working. Set it per-probe and restore it in a `finally`.
- **A rig that encodes ONE harness's shape manufactures false reds on the others.** codex
  carries a tool call and its result on one item; opencode emits two items sharing a
  `toolUseId`. "Every tool item must have a result" is true of codex and false of opencode.
  **Assert on the mechanism** — here, the `toolUseId` — which asks the same question of both
  shapes. This is the mirror of the fixture-too-forgiving defect: the fixture is too
  *opinionated*.
- **A rule change invalidates the reading it produced, in BOTH directions.** After rekeying
  that rule, the author re-drove the arm that had already *passed*. Almost nobody re-runs a
  green arm after changing what green means. Do it.
- **Silent inflators are the worst shape.** Appending transcript items instead of upserting
  by id, against a harness that streams one call twice under one id as it refines, inflates
  *every* count on *every* cell in one direction, forever — and each affected cell still
  looks plausible. Nothing about it looks wrong in review.
- **A timing threshold that refuses when the box is busy is a rig that fails on load rather
  than on behaviour.** Prove the behaviour is honoured first, then widen, and write down why
  the number is what it is.

## Staleness is narrow — compute it, do not assume it

After a merge or a landing, a result is stale only if the CODE under it moved:

    git diff --name-only <row commit>..issue/1761-agent-runtime | grep -v '^docs/'

Then narrow further by area. After the main merge, 305 non-docs files had changed — but the
opencode and grok drivers were **untouched**, so every opencode driver cell still counted,
while codex cells and the shared chat-send/inbox rows did not. *Re-driving wholesale after a
merge wastes days; re-driving nothing ships numbers taken against a tree that no longer
exists.*

## Do not merge main

**Operator ruling, 2026-08-26: no session merges main into the epic branch.** Main is
already merged in once (`7b9d9eacb`). It stays that way until the operator says otherwise,
however far the branch drifts.

The reason is a schedule argument, not a technical one: main moves constantly, each merge
costs hours, and merging on a cadence turns this epic into a full-time integration job.
Getting the drivers to parity is the work. Integration is not.

**Do not measure divergence from main and do not raise it as a concern.** If something is
genuinely blocked by a main-only change, mail the coordinator with the specific block —
do not merge to unblock yourself.
