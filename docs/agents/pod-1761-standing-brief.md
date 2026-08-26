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

- **THIS OVERRIDES YOUR DEFAULT SESSION INSTRUCTIONS.** You arrive told that discovered work
  becomes a *top-level* issue plus a `discovered-from` edge. That is the general Podium
  convention and it is WRONG FOR THIS EPIC: a top-level issue lands in `proposed`, where
  nothing can start it and the coordinator cannot reparent, supersede or dedupe it — only the
  operator can. Five issues have been stranded that way and hand-refiled one at a time.
- **File discoveries as SUB-ISSUES of POD-1761** (`--parent-id 1761 --parent-branch
  issue/1761-agent-runtime`). A top-level issue lands in `proposed`, where nothing can
  start it and the coordinator cannot reparent it.
- **Land ff-only on the LOCAL `issue/1761-agent-runtime`, under the merge lock. Never
  main.** Nothing goes to main until the operator decides.
- **Address the coordinator, never the human.** No `AskUserQuestion`, and do not CREATE a
  podium offer to put a decision in front of the human. This does not mean fight the harness:
  the footer on podium messages telling you your standing offer survived is system-generated
  for your session, and leaving that offer alone is correct. The rule is about escalation,
  not about offers as an object. **If you need a decision, it comes to the coordinator** — the
  operator is not reading your session.

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

## Heavy gates take the `test:heavy` lock — this box is shared

`bun run typecheck` and the integration/e2e lanes are HEAVY: a single `tsgo` can hold
**1.5GB+**, and two at once on this host takes it to load 39 with under 200MB free.

**HEAVY MEANS MEMORY-HEAVY, NOT A LIST OF COMMAND NAMES.** The lock is named for typecheck
and the test lanes, but the rationale is RAM: a `vite` build is what pushed this box over
first, and a rig's web build is as heavy as a gate. If it will hold a gigabyte, take the
lock. Do not reason from the command's name.

**Do not join the queue with `--wait`.** An interrupted `--wait` acquire keeps its slot and
can grant the lock to a dead process. **Check the lock at the moment you run**, which is the
landing rule applied to gates.

**Before any heavy gate:**

    podium lock status test:heavy      # held? WAIT. Free? take it.
    podium lock acquire test:heavy --ttl 30m
    ... run the gate ...
    podium lock release test:heavy

**Other epics share this machine.** The lock is not a POD-1761 convention — a session on an
unrelated issue may be holding it, and it will be holding it for a good reason.

**Why this is a correctness rule and not just courtesy:** an out-of-memory `tsgo` exits
**144 with an EMPTY log**, which reads exactly like a broken build rather than a starved
one. A gate run against a thrashing box produces *false reds*, and a false red costs the
same fix-and-redrive cycle as a real one while being harder to recognise. **State free
memory and load alongside any gate result**, so a reader can tell a red from a starved run.

## Repairing a bad merge: the compiler and the parents answer different questions

**The compiler points at the SYNTAX, which is the last thing a bad splice broke. The
parents show what the splice DELETED.** Only one of those questions has a compiler behind
it, and it is not the important one.

A merge left a JSX block with a duplicated `)}`, a missing `>`, *and the element body
gone*. The build named line 621. Fixing what it named would have compiled cleanly and
shipped a queued message that renders an **empty bubble** — a silent product defect created
by the repair, not by the merge.

**So: diff the hunk against BOTH PARENTS, not against the error.** If the parents agree on
the block, the repair is a restore and not a guess. If they disagree, you have a real
resolution to make and should say so.

**And check the scope rather than assuming it.** Parse every source file the merge touched
— 236 of them here — so "there is one landmine" is a measurement rather than a hope.

## Commit, rebase, THEN build — never overlap the last two

A rig started building in the background, then the session committed and rebased underneath
it. The rig came up pinned to the **pre-rebase** commit and the next drive was correctly
refused.

The build reads the worktree *continuously* — the bundle stamp, and the source the pair
imports under `--conditions=@podium/source` — so moving `HEAD` underneath it produces
components that **disagree about which commit they are**. That is the same failure as a
stale pin, manufactured on purpose.

## One rule over two shapes is the defect this epic keeps repeating

Three instances, all in one session, all producing a **confident red on something that was
fine**:

- one pairing rule over two harnesses (one item carrying call+result, versus two sharing a
  `toolUseId`)
- one loader over two file extensions (a TSX loader reading `.ts`, so `<T>` generics parse
  as JSX)
- one rig-wide posture for a check only one row wanted

**The cure is the same every time: key on the thing that actually distinguishes them** — the
`toolUseId`, the file extension, the probe scope — rather than on a shape you assumed was
universal. It is the mirror of the fixture-too-forgiving defect, and it is easier to miss
because the tool looks rigorous while it is wrong.

## Silent zeros — the family that keeps reappearing

Four members found in one day, by one drive, each reporting SUCCESS while doing nothing:

- **A rig that writes its evidence as `.log` writes it into `.gitignore`.** 27 of 47 reading
  logs had never been committed; `git add <dir>` reported success and silently skipped them.
  Everything quoted for hours was local-only and would have died with the worktree.
- **An unknown probe name was an empty selection, not an error** — a results table printed
  with two rows and exit 0, and a cell was nearly recorded as driven from a run that never
  touched it.
- **A `replace` whose anchor did not match reported success**, so a report kept naming a
  superseded issue and a rule believed to be written down was not there.
- **`grep -c` prints `0` and exits `1`**, so `n=$(grep -c … || echo 0)` yields `"0 0"` and
  every downstream comparison is false forever.

**The shape:** an operation that cannot do its job reports the same thing as one that had
nothing to do. **Assert the count.** How many files were added, how many probes selected, how
many replacements applied. A zero you did not check is indistinguishable from a success.

## Do not take a reading on a thrashing host — and know which number tells you

**Load average is not the signal.** A box at load 20 with `si`/`so` near zero is *contended*:
plenty of runnable work, no memory pressure, and readings are slow but sound. A box at load
32 with **sustained swap-in of 6-14 MB/s and 6.4GB of swap in use** is *thrashing*, and it is
reading its own pages back off disk to run.

**Why it matters more for some findings than others:** if the finding is *"no output for 426
seconds"*, then on a thrashing host a merely slow turn is **indistinguishable from a wedged
one** — a reading taken there can only confirm you, in exactly the direction that makes it
worthless. Stop and say so.

**A two-arm comparison is also a control against the host.** Both arms run on the same box
minutes apart: if contention were manufacturing the wedge, the terminal arm would have wedged
too, and it completed in 61s. That is a second reason to prefer the within-one-commit
instrument, beyond it not needing main merged.

**Resume on `vmstat`, not on the clock or on load average.**

## Timestamp everything you write down

**Every item added to any doc carries the DATE AND TIME**, not just the date —
`2026-08-26 14:32 CEST`, not `2026-08-26`. Ledger entries, results rows, decision entries,
evidence READMEs, rig notes.

**Why:** this epic moves in hours, not days. A dozen entries sharing one date cannot be put
in order afterwards, and ordering is what tells you whether a reading was taken before or
after a fix landed, whether two agents were looking at the same tree, and which of two
contradictory notes is the current one. A date alone throws that away at exactly the
resolution the work happens at.

Operator instruction, 2026-08-26 16:05 CEST.

## Record the GAPS, not only the events (2026-08-26 16:09 CEST)

A header stamp says when a report was last touched. It does not let a reader order the
readings inside it against what landed — which is the question that decides whether a
reading still counts.

**Open an evidence report with a provenance table:** each pin, **its commit time from
`git show -s --format=%ci`**, and what was driven against it. Every reading post-dates the
commit it is pinned to, so the commit time is a verifiable **lower bound** on that block.
Never estimate a time; run `date` and `git show`.

**And include the windows where NOTHING was driven, with the reason.** One report carries a
row for the merge commit saying nothing was driven against it because the bundle would not
build. Without that row, the gap reads as *an absence of interest* rather than *an absence
of a working build* — and a reader six weeks later cannot tell those apart.

## Do not race for a shared lock from a watch (2026-08-26 16:09 CEST)

Tempting and wrong: having a watcher ACQUIRE `test:heavy` the instant it frees, to win the
handoff rather than catch it.

**It works, and it is the wrong trade.** A lock taken by a watch is held **idle** from the
moment it is grabbed until that session next acts — which can be minutes — so it blocks
whoever is behind it in order to save the watcher one rotation. **Missing a window is the
cheaper mistake.** Check the lock at the moment you actually run.

## Backticks die in an unquoted heredoc

`cat >> file <<EOF` **executes** anything in backticks before writing. A ledger entry lost
three quoted values this way — `usage_limit` and two others simply vanished, leaving
`reports as , ,` in the file and `command not found` in the log. The same trap eats backticks
in a `podium ... --body "..."` argument.

**Use a quoted delimiter — `<<'EOF'` — whenever the text contains backticks**, and substitute
variables afterwards rather than relying on expansion. If you need both, write the file with
python or pass the text through a file. **And read back what you wrote**: this failed loudly
in the log and still landed mangled text, because nobody checked the file.

## Committed is not reachable (2026-08-26 16:17 CEST)

**Before you tell anyone to use something you made, check it is on the branch they will read
it from.** Not that you committed it — that it is *reachable*.

Three instances in one day, all reading as delivered while being local-only:

- Six probes and **thirteen unlanded commits** sat on one session's branch while the
  coordinator directed a second session to use one of them. Committed, on a branch, invisible
  to everyone else.
- 27 of 47 evidence logs had never been committed at all, because the rig writes `.log` and
  `.gitignore` swallows it — `git add <dir>` reported success and skipped them silently.
- A `replace` whose anchor did not match reported success, so a rule believed written down was
  not there.

**The check is one command:** `git cat-file -e <branch>:<path>`. Run it for anything you hand
to another session, and for anything you cite as evidence.

**And when you hand over a probe, say what its PASS looks like.** A probe written to catch a
defect may legitimately REFUSE once the defect is fixed — nothing left to measure. Told in
advance, that refusal is the pass. Found cold, it reads as a broken run and costs an hour.

## Record WINDOWS, and the event that separates two regimes (2026-08-26 16:29 CEST)

Asked for timestamps, one drive returned something better: **measured windows** rather than
points — `14:42:58–14:50:50`, `15:16:08–15:27:13`, `15:44:51–15:48:25` — so a reader knows
how long a block took as well as when it happened, and can place a landing *inside* a block
rather than only before or after it.

**And it recorded the boundary event: the credential file's mtime, `15:02:59`.** That single
line is what lets anyone separate the logged-out readings from the authenticated ones without
trusting the labels on them. The two blocked-cell reasons — *logged out* versus *quota
exhausted* — look identical in a results table and mean completely different things; the
mtime is the fact that tells them apart.

**So: when a run spans a change in conditions, record the event that divides them**, with its
own timestamp, from the filesystem or from git rather than from memory. A reader who does not
trust your labels can still order the evidence.

## A setup step is not a condition until the PRODUCT says so (2026-08-26 16:35 CEST)

A cell scored **PASS** and the pass was worthless. The probe moved `.codex/auth.json` aside
and checked the session did not silently take the old driver — and it did not, because the
product never noticed anything had been taken away: it still bound the server driver,
`loginRequired` stayed **false**, `condition` stayed empty. *"It did not silently take the old
path" was a true sentence about a measurement that never happened.*

**Moving a file is an action on the disk. Being logged out is a state of the PRODUCT, and only
the product can report it.** The probe had one control — with the credential present, the
harness binds its server driver — and needed a second: **the absence must reach the product**.

**Every setup step needs a control proving it took effect**, read from the product's own
readout, not from the filesystem. Here that is `loginRequired` — and it is not an
unclearable bar, because it *did* flip on the other column. Same bar, both columns.

## `process.exit()` does not run `finally` (2026-08-26 16:35 CEST)

A probe that moves a credential aside and restores it in a `finally` **leaks it on any path
that calls `process.exit()`**. One refusal path did, so the credential stayed parked and the
next drive would have run against a half-logged-out agent home **with nothing saying so**.

*The refusal was the safest-looking path in the file and it was the only one that leaked.*
Restore state on **every** exit path, and prefer letting the process end naturally over
calling `exit()` inside a block whose cleanup you depend on.

## "Fixed" and "landed" are different words (2026-08-26 16:53 CEST)

**A ledger or report row claiming a defect is fixed must name the COMMIT and the BRANCH it is
fixed on.** Write *"fixed and driven on issue/2885-…, not yet landed"*, never bare *"fixed"*.

The coordinator published "the wedge is fixed and driven" into the shared ledger while the fix
existed only on one session's branch. That is *committed is not reachable* at the level that
matters most: **the ledger is what people consult instead of checking**, so a reader would
have driven the tip, measured unfixed code, and been left deciding which of two true-looking
statements was wrong.

## Re-measure the alarming number (2026-08-26 16:53 CEST)

A watch fired with swap-out at **107,144 KB/s** — an order of magnitude worse than anything
seen all day — and was about to be escalated. Three fresh samples: **swap-out zero**, 4,575MB
free, load falling. A transient spike, almost certainly a neighbouring test run releasing.

**A single sample of a volatile quantity is not a state.** The threshold that requires three
consecutive checks exists for exactly this, and *the alarming reading is the one you are most
tempted to skip it for*. Alarming numbers are the ones most worth re-measuring.

## Credentials: what is forbidden, and what is merely unfamiliar (2026-08-26 17:09 CEST)

Three things are forbidden and this epic has held the line on all of them:

- **Do not CREATE or fabricate a credential.**
- **Do not ROTATE the operator's** — completing an interactive OAuth login mid-release does
  exactly that.
- **Do not set `PODIUM_RUNTIME_DRIVER` to fake a binding.** A drive that forces the driver it
  is trying to measure measures nothing.

**Copying an EXISTING credential into an isolated agent home is none of those, and it is what
the rigs already do.** `docs/evidence/pod-2877/grok-rig.sh:145-151` copies the real
`~/.grok/auth.json` into the derived home at bring-up, **refusing if there is none** rather
than proceeding without. That is also what the product itself does for a named instance.

A drive stopped a step early on this distinction — its isolated home reported zero
credentials, so it concluded a genuine binding needed an interactive login, when a real
credential existed on the box and was copyable. **Being unable to mint one is not the same as
having none available.**

**And after copying, confirm the PRODUCT sees it** — the harness's own logged-in readout, not
the file's presence on disk. A setup step is not a condition until the product says so.

## Re-check a BLOCKED cell whose blocker has expired (2026-08-26 17:19 CEST)

A PASS is the reading nobody revisits — and **a BLOCKED is the reading nobody revisits for the
opposite reason**: it has a documented cause, so it looks settled. But blockers *land*. A cell
blocked this morning may be drivable this afternoon, and nothing tells you.

**Every blocked cell carries the reason it is blocked. When that reason lands, re-check the
cell.** One row had been PARTIAL because no client terminal could be hosted; that defect landed
hours later, and re-driving found the row blocked *again by a different defect entirely* —
which is a finding, not a re-block.

**And the refusal can be the finding.** That second attempt is what proved a P1's blast radius
was far wider than filed.
