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

## Landing — USE docs/evidence/pod-2777/land.sh (2026-08-26 18:02 CEST)

**Do not hand-roll the landing sequence.** It is on the branch, it landed itself, and it
carries five guards each of which exists because someone got it wrong first:

    grant vs queue      queued is NOT granted — that distinction was the original bug
    cancel the slot     never strand a queue entry; this box grants stranded slots to dead processes
    --ff-only           refuse rather than quietly create a merge commit
    trap on release     an error between acquire and release cannot leave the branch locked
    clean tree          reset --hard discards the working tree, not just commits
    + rebase recovery   it REBASES a moved tip rather than advising you to

**Known untested path, stated by its author rather than discovered by you:** a rebase that
genuinely CONFLICTS. That branch aborts and refuses by construction and by reading, but no
conflict has occurred to prove it. *If it misbehaves, that is the branch to look at first.*
Five verified guards do not imply a sixth.

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

## Grouping by file is not grouping by dependency (2026-08-26 17:33 CEST)

**Four times in one day**, one drive mis-scoped its own tooling — and three of the four cost a
cell real waiting time:

    believed                                          actually
    A7b needs drive.ts                                self-contained
    A2a needs drive.ts                                self-contained
    switching arms needs a bundle rebuild + the lock  the arm is DAEMON-LEVEL; restart the daemon
    A3 needs drive.ts and the lock                    needs only the upstream fix

Every one was an assumption about **its own rig**, not about the product. *That is the harder
kind to catch, because you wrote the thing you are assuming about and nothing contradicts you.*
Three probes living in one file does not make them need that file.

**The check is cheap: read what the thing actually reads.** One of those probes consumed a
single field from the shared context and built its own socket and its own turn.

## A checker can fall into the trap it was built for (2026-08-26 17:33 CEST)

Asked to make "re-check a blocked cell when its blocker lands" mechanical, a drive wrote a tool
that lists every blocked cell with its blocking issue and the **runtime paths** that would
carry the fix — checking the paths, never a ledger row.

**Its first run reproduced the exact bug it existed to catch.** It asked only *"has the fix
landed since my HEAD"*, which finds a blocker landing in future and **misses one that landed
before your HEAD and whose cell you never went back to** — which is the case the rule was
written for. It reported a cell as still blocked by a fix already sitting in its own tree.

**When you automate a rule, check the automation against the case that motivated it**, not
against the next case.

## If a probe's PASS is a REFUSAL, say that loudest (2026-08-26 17:35 CEST)

Two probes on this epic both **refuse** once the defect they were built for is gone, because
there is nothing left to measure:

- the parked-turn probe refuses on its first control once nothing parks any more
- the interrupt probe refuses while a freeze is present, because its control watches for the
  turn **in flight** and the freeze stops exactly what it watches

**Found cold, either reads as a broken run and costs an hour** of debugging a working fix.
`REFUSED` is the verdict that looks most like failure while meaning least like it.

**So: when you hand over a probe, say what its pass looks like — and publish the baseline of
what the refusal itself looks like**, field by field, so someone meeting it cold recognises it:

    control watched: <what must be moving>
    control saw:     <the frozen values>
    verdict:         REFUSED — control did not fire, refusing to report this measurement

## A completion test cannot prove a freeze is gone (2026-08-26 17:35 CEST)

A fix to a freeze can **restore completion while the plane still stops early** — the turn
finishes, and anyone watching mid-flight still sees a dead session. A count taken at the end
cannot tell *"frames arrived steadily for four hundred seconds"* from *"frames arrived for
twenty seconds, stopped, and the turn completed anyway"*.

**Sample the moving quantity at intervals across the whole run**, and show it climbing. Then
have an *independent* probe — one whose control needs mid-flight motion — confirm it.

## A CHECK THAT PRINTS IS NOT A CHECK THAT GATES (2026-08-26 17:53 CEST)

A session ran `merge-lock acquire` and then ran the ff-merge **unconditionally**, without
testing whether the acquire had succeeded. It had not — the lock was held and that session was
queued at position 1. **The merge ran anyway.**

*"Check the lock at the moment you act" is only worth something if the action is GATED on the
check.* A step that prints an answer and carries on regardless is not a guard; it is a log
line. **Make it a script that exits non-zero, not a step you read.**

    podium merge-lock acquire ... || exit 1     # fail closed
    ... land ...
    podium lock release ...

**And when you land out of turn, say so immediately and precisely** — what landed, whether it
was a true fast-forward, whether any product code was touched, and whose base may now be
stale. The session that hit this reported it in full, said it was its own error rather than a
tooling one, and cancelled its queue slot. That turned a silent corruption risk into a
two-minute check.

## Rig credentials are quarantined, not seeded (2026-08-26 17:53 CEST)

**18 stale Claude credential files were quarantined out of rig agent homes.** Every one held an
expired access token *and* a refresh token the operator's live credential had already
superseded — and **presenting a superseded refresh token can be treated as replay and revoke
the whole family**, logging the operator out of their own tool.

**A rig must not carry a Claude credential it did not check.** The read-only check is a file
read: `claudeAiOauth.expiresAt` against now. An expired access token in a rig home makes that
home **dangerous**, not merely stale.

Failing loudly with no credential is strictly better than revoking silently with a stale one.

### Why this one rule carries the others (2026-08-26 17:54 CEST)

**Every rule on this epic that survived contact did so because something exits non-zero** —
`drive-verify` refusing a stale pin, a probe refusing on a missing control, the blocked-cells
checker exiting 10. The landing rule was the last one still relying on a person reading output
and choosing correctly, and it failed exactly there.

### Refusals are the most valuable output a rig produces (2026-08-26 17:54 CEST)

A **result** tells you about the product. A **refusal** tells you the instrument noticed
something it was not built to handle — *which is precisely the case where a result would have
been fabricated.*

Four today: the terminal arm of the parked-turn cell, A4a's terminal half, a vacuous
credential-removal pass, and a landing that ran against a lock it had not been granted. **Every
one would have been a plausible number if the refusal had not fired.**

The corollary: **a refusal is only valuable if whoever meets it recognises it as information
rather than as breakage.** Hence — say what a probe's pass looks like, and if its pass is a
refusal, say that loudest.

## Release your locks before you go idle (2026-08-26 17:56 CEST)

**A session that stands down while holding a shared lease blocks everyone behind it and saves
nobody anything.** The lease is held from the grab until that session acts again — and a
parked session does not act again.

Measured 2026-08-26 17:56 CEST: a session held `test:heavy` for **2h18m**, renewing it, with **zero writes in
ten minutes and no gate process of any kind** — while two sessions waited behind it, one from a
different epic, the first of them for **three hours**.

**When you are told to stand down, or you decide to go idle: release every lock you hold
first.** And whoever issues a stand-down must say so — this one did not, which is why it is
written here rather than sent as a correction.

**Check before you assume a hold is legitimate**, in either direction: a lease naming a gate is
not evidence a gate is running. Look for the process.

## A gate that refuses but leaves no way forward is half a guard (2026-08-26 18:01 CEST)

`land.sh` gated correctly — refused, non-zero, exactly as designed — and then produced a
refusal **no caller could act on**. Its retry loop waited out a held lock; while it waited the
tip moved; and from then on every attempt failed with *"behind by 3 — rebase first"* instead of
failing on the lock. It could never recover, **because nothing in the loop rebased**. The
script was telling a shell script to go and read its advice.

**Both failures are the same missing question.** The first version *printed instead of gating*;
the second *gated instead of resolving*. Ask: **what is the caller supposed to DO with this
refusal?**

- If the unsafe state is **recoverable**, the guard should recover it — here, rebase rather
  than advise a rebase, with the recovery itself guarded (a conflicting rebase is **aborted**
  and refused, never left half-applied for someone to find later).
- If it is **not** recoverable, the refusal must name what a human has to do.

**A landing script that refuses a moving tip is a landing script for a branch nobody else is
committing to** — and that is not this branch.

## Stealing a lease (2026-08-26 18:01 CEST)

Locks are advisory and a parked holder can block work for hours. Before taking one:

1. **List every process whose cwd is that worktree.** A lease naming a gate is not evidence a
   gate is running.
2. **Check writes over a real window** — thirty minutes, not five.
3. **Weigh it out loud**: one possibly-interrupted operation against the measured cost of
   waiting, including sessions from other epics.
4. **Take it, release it to the queue immediately**, and **tell the holder what you did, what
   you checked, and that you will own it if you were wrong.**

## Every guard here was written AFTER something got through it (2026-08-26 18:02 CEST)

Five, in order, each added because a result was already wrong:

    drive-verify        after a stale pin was nearly measured
    A8 logged-out ctrl  after a vacuous PASS that measured nothing
    the park control    after another vacuous PASS on a resume cell
    land.sh gate        after a lock was bypassed by a check that only printed
    land.sh rebase      after that gate produced a refusal no caller could act on

**Not one was designed in advance.** The tempting lesson is *"ask what would let this pass
while nothing happened"* — and the author who wrote all five says plainly that **they could not
answer that question in advance in any of the five cases.** So do not treat it as a checklist
that would have prevented them.

**What actually worked: measure, notice the result was TOO COMFORTABLE, and go back.** A cell
that passes first time, a control that fires exactly as hoped, a gate that never refuses —
those are the readings to distrust. Comfort is the signal.

## "Concentrated in" is a characterisation, not an attribution (2026-08-26 18:05 CEST)

A validation reported **79 failures** as *"concentrated in the inherited machine-probe /
handoff / headless / audit fixtures"* — and separately proved that **26** of them reproduce on
the pre-merge parent.

**Twenty-six is attributed. The other fifty-three are not.** Saying where failures *cluster*
says nothing about whether they pre-date your change. *A plausible grouping is a hypothesis
wearing a conclusion's clothes*, and this epic has paid for that before: four reds once
attributed to one commit from one bisect turned out to be four bugs with four causes.

**The method, which is cheap once the lane exists: run the SAME lane on the parent and diff the
failure sets BY TEST NAME.** Every failure then lands in exactly one bucket:

    INHERITED  fails on the parent too — not yours; the release note names it
    NEW        passes on the parent, fails after — a REGRESSION YOUR CHANGE INTRODUCED,
               which is a different and much louder finding than a new defect
    FIXED      fails on the parent, passes now — worth knowing and easy to miss

**If the lane is too expensive to run twice, label the remainder
`UNATTRIBUTED-INHERITED-LIKELY` and say so.** Never write "inherited" next to a number nobody
measured.

## A check that CANNOT FAIL is not a check (2026-08-26 18:21 CEST)

A row asks for *"no scrollback corruption"*. It was scored with `screen.includes(marker)` — a
substring presence test. **The defect the row cites is corruption that ADDS content**:
repainting the new interface into the old one's scrollback. *A presence test cannot see an
addition, a duplication or an interleave — every one of those leaves the marker exactly where
it was.* **It could not fail, and four PASSes across four columns rested on it.**

**Ask of every check: what reading would make this FAIL?** If you cannot construct one, the
check is decoration. This is the same family as the vacuous pass where a credential was removed
and the product never noticed — *a true sentence about a measurement that never happened.*

**And the replacement can be wrong in the other direction.** Counting the marker and demanding
exactly one FAILED, because the baseline screen legitimately contains it twice and a TUI
repaints and reflows by design. Between them: **v1 cannot fail, v2 cannot pass.** Bracketing the
problem is progress; report the clause **UNMEASURED** rather than scoring it on either
instrument.

## The accumulating buffer, and why asymmetry hides it (2026-08-26 18:21 CEST)

That replacement's first run showed marker counts **2 → 6 → 6 → 10** and line counts
**20 → 34 → 48** — every view switch adding content, *exactly* the signature of the defect it
was hunting. The issue number was in hand.

**It was the rig's own buffer.** Its screen accessor only ever *appended*, while the server
replays its whole output log on every attach — so each re-attach concatenated another copy.
**A non-resumed attach means REBUILD your screen, not APPEND to it.**

**The asymmetry is what hid it:** the transcript side of the same object had always cleared its
items on reset; the terminal side never did. One plane accounting correctly and the other
silently accumulating, *in the same object*, is much harder to see than either being wrong
alone — the correct half makes the object look maintained.

## An exception expires — check whether it is STILL true, not whether it WAS (2026-08-26 18:23 CEST)

The coordinator granted a drive permission to run at a stale pin, on a measured basis: *the
drift is confined to two `apps/web` files, every runtime path byte-identical*. That was true
when granted.

**Two hours later it was false.** `apps/server/src/modules/interactions/service.ts` — the ask
being raised, enumerated, answered, answered twice — and `relay.ts`, the socket plane every
probe drives over, had both landed. The exception's entire basis had evaporated while the
ruling itself still read as current.

**The check is "is the exception still true", not "was it true when granted".** Recompute the
condition; do not remember the verdict. It was caught only because the diff was recomputed
rather than the ruling recalled.

**And scope the consequence by the same file-level method.** Cells on paths that moved are
stale; cells on paths that did not are still good. Here: the permission cells went stale, while
the daemon runtime, control, `packages/runtime` and `packages/harness` paths had **zero**
changes, so those readings stand and were correctly not re-run.

**This applies to the coordinator's rulings as much as to anyone's.** A permission granted on a
measured condition carries that condition with it, and whoever holds the permission is the one
positioned to notice it lapse.

## Never ask "is my process running?" with `pgrep -f` (2026-08-26 18:28 CEST)

**Two reasons it cannot discriminate on this box, and every session has both:**

1. **Every Podium agent carries the whole developer-instructions prompt in its command line.**
   That blob mentions `docs/evidence`, `drive`, issue refs and much else — so `pgrep -f` on
   almost any project string matches **every agent session on the machine**, none of them
   yours.
2. **`pgrep -f` matches the grepping shell itself**, because the pattern sits in its own argv.
   You find your own check and count it as a hit.

So a session can answer *"yes, mid-drive"* while running nothing and abandon a turn it never
had — or answer *"no"* with a probe still live.

**Identity plus location, never a substring:**

    for pid in $(pgrep -x bun); do
      [ "$(readlink /proc/$pid/cwd)" = "$PWD" ] && echo "$pid"
    done

`pgrep -x` matches the **executable** exactly; the cwd check confines it to your worktree.

**This is the same family as everything else that has bitten this epic:** a check that matches
on a NAME rather than on the THING. One pairing rule over two harnesses, one loader over two
file extensions, a lease naming a gate that was not running, a ledger row claiming a fix had
landed — and now a substring matching every agent alive. **Assert on the mechanism.**

## An announcement of spare capacity consumes the capacity it announces (2026-08-26 18:28 CEST)

The coordinator measured a quiet box and a free lock, and told **five sessions at once**. All
five acted, correctly. The box went from load 9.87 to **65,156 KB/s of swap-in** — the worst
reading of the day.

**The reading was true when taken and false because it was shared.** This is not a fact about
the box; it is a property of broadcasting a shared resource.

**So: name an ORDER, not an opening.** One session at a time, each taking its turn after the
one before reports. A queue costs a little latency; a stampede costs everyone's readings, and
readings taken on a starved host cannot be distinguished from findings.

### The false positives are your NEIGHBOURS answering for you (2026-08-26 18:31 CEST)

The dangerous half. A session running the bad check does not get noise — it gets a **confident
YES sourced from other sessions' agents**, whose ids are legible in their abduco labels. And
because every agent on the box carries the same prompt blob, **the check is MOST wrong exactly
when the box is busiest**, which is when you are most likely to be asking.

**Consequence for an ordered queue:** if session N reports *"still driving"* from a neighbour
match, everyone behind it waits on a drive that is not running. **The failure mode is a stalled
queue, not a collision** — quieter and much harder to notice than the thing the order was
written to prevent.

**So the coordinator verifies rather than takes a session's word for being done.** Same check,
run from outside: `pgrep -x bun` filtered by `/proc/<pid>/cwd` against that session's worktree.
A queue built on self-report inherits every reporting bug in it.

### CORRECTED — the reap did NOT kill neighbours; a GENERIC pattern would have (2026-08-26 18:37 CEST)

Worse than a wrong report. A rig's `reap()` matched its own state root **in the command line**
and then **SIGKILLed every hit** — and the false positives were measured to be *other
sessions' agents*, ids legible in their abduco labels. A substring that matches every agent on
the box, wired to `kill`.

It now reaps by **environ** — instance *and* agent home, both required — which a process cannot
borrow from a prompt blob.

**Its self-skip was broken too:** `$$` inside a `( … )` subshell is the **parent** pid in bash,
so the guard never protected the shell it was written for.

## Put the cheapest, most invalidating guard FIRST (2026-08-26 18:37 CEST)

A drive preflight now refuses if another probe is already driving the same rig — by executable
identity and working directory. It was placed **ahead of the pin checks**, for two reasons:

1. **A concurrent probe invalidates every reading whatever the pin says.** Two probes on one
   instance interleave their sessions and neither reading is attributable afterwards.
2. **Behind the pin legs it was UNTESTABLE.** On a stale rig the pin check refused first, so the
   new guard could never be reached — noticed only by trying to test it and failing. *A guard
   you cannot exercise is a guard you do not know works.*

Tested both directions: silent on the rig's own server and daemon, refusing with pids when a
probe is live — and its first clean run caught a leftover process nobody had noticed.

### Liveness can be verified from outside; "am I done" cannot (2026-08-26 18:37 CEST)

The coordinator can now check whether a session is running anything. It still cannot check
whether a session has *finished* — a session that believes it is done while a probe is still
draining will hand the turn on early. **Self-report remains load-bearing for completion**, so
a handover should say what was observed, not just that it ended.

### Knowing the trap is not a control (2026-08-26 18:38 CEST)

The coordinator wrote the backtick rule into this brief at 17:57, after it silently ate three
values out of a ledger entry — **and hit it again at 18:37**, in a message about a guard that
had never protected the thing it was written for.

**A rule you have written down and not enforced is the same class as that broken guard: a
protection that exists in intent and not in mechanism.** Quote the delimiter (`<<'EOF'`), or
write the text through a file. Do not rely on remembering.

### Correction to the entry above, 2026-08-26 18:40 CEST — verified independently

**The alarm was overstated by its author, who then measured it properly and retracted it. I
verified both halves before changing this brief:**

    agent processes matching a GENERIC string ("docs/evidence"):        6
    matching a SPECIFIC instance agent-home path (p2777/agent-home):    1   <- its own
    matching another instance's agent-home path:                        0

**So the distinction is the pattern, not the technique.** A generic project string matches every
agent on the box, because they all carry the developer-instructions blob. **An absolute path
unique to one instance does not** — that blob contains no other instance's agent-home. The reap
matched the specific path, so it would not have hit a neighbour, and there is no record of it
running at all today.

**What remains true, and is why the fix was kept:** matching an absolute path in a command line
*happened* to be safe rather than being *designed* to be. Reaping by **environ** — instance and
agent home, both required — is safe by construction.

**And the broken self-skip was a real bug with a real victim, just not the one claimed:** a
subshell pid variable resolves to the parent, so the loop could kill **its own subshell**.
Self-destruction, not neighbour-destruction — which fits *"the reap sometimes did not finish"*
rather than anything else going idle.

**The coordinator had begun re-attributing a day of idle and hibernated sessions to this.** That
re-attribution is withdrawn. The earlier explanations — park instructions, the documented
inventory window, memory pressure — stand.

**The lesson is the one this epic keeps finding, arriving from the other direction:** *a
plausible cause you did not check*. Here the plausible cause was supplied by the person best
placed to check it, believed on their authority, and propagated into a shared document before
anyone measured it. **An alarming claim deserves the same verification as a comfortable one —
more, because it travels faster.**

## A timeout and a threshold are not the same knob (2026-08-26 22:01 CEST)

A probe was refusing on a slow box. Its author loosened the **spin-up window** and left the
**bar** exactly where it was — 3 preview frames or 200 new transcript characters — and the
reasoning is the general rule:

**Waiting longer cannot make a non-producing plane look like a producing one.** So the window is
safe to loosen; the bar is not. *One bounds patience, the other bounds what counts as evidence.*

They look like the same knob when a reading is slow, and loosening the wrong one silently
converts "we saw nothing" into "we saw enough".

**Keep the refusal self-distinguishing**: that probe prints frames, chars and terminal bytes on
its WATCHED line, so `0/0/0` — a frozen plane — stays legible apart from a slow crawl.

## Ask which direction a starved host pushes the ANSWER (2026-08-26 22:01 CEST)

Not just *"is this reading reliable"* but **"if the host corrupts it, which way?"**

The coordinator ordered a claude drive with the interrupt baseline FIRST, because it is the
release-deciding cell. On a thrashing box that was exactly wrong:

    the cell asks whether interrupt STOPS the turn. A starved host makes a turn that WOULD
    have stopped appear not to -> a FAIL on the MAIN arm -> "main is broken too" ->
    "INHERITED" -> a P1 stops blocking the release.

**The starved host produces the COMFORTABLE answer.** Presence/absence cells were reordered
ahead of it, and the instruction was made explicit: *if the box does not quieten, do not drive
that cell at all.* **An undriven cell is honest; a cell driven into a starved host and labelled
INHERITED is worse than nothing**, because it removes a blocker on false evidence.

### A sequential A/B on this box measures the box (2026-08-26 22:43 CEST)

The previous section says a starved host pushes the ANSWER in a particular direction. There is
a second, quieter version of it that applies to any **before/after measurement**, and it does
not need the host to be starved — only to be *changing*.

**Measure pre-fix, then measure with-fix, and you have attributed an hour of host drift to your
change.** This box moved from load 7.99 to load 65 and back inside one evening. Two readings
taken forty minutes apart differ for reasons that have nothing to do with the diff between them,
and the sign of that difference is not predictable in advance — so it is not even conservative.

**INTERLEAVE THE ARMS: pre, post, pre, post, pre, post — five pairs minimum.** Drift then hits
both arms equally and subtracts out. Report every individual reading, not only the means, and
report the load average at the start and the end of the run. **If the two arms overlap, say so.**
A fix that cannot be separated from the noise is a finding worth having; a clean mean that is not
true is worse than no number, because it closes the issue.

This applies with full force to LATENCY defects, which is where it came up (POD-2902: the badge
was reported slow by a pair of numbers, and the handover was a unit test asserting event order).
**A defect found by a measurement is closed by the same measurement.** The mechanism you believe
explains the latency is not the latency: if the badge is still slow for a second reason, an
ordering test stays green and the user still waits.

**And re-pin BETWEEN arms.** Switching the checkout under a running daemon measures the same
driver twice and returns two near-identical numbers, which reads exactly like an honest null
result. See the three-part pin rule above; the daemon is the part that catches people out.

### "I rebased it" is not "the patch is unchanged" (2026-08-26 23:30 CEST)

A session reported a drive result and added that it had rebased the fix onto the current epic
tip, so **"the pre-rebase exact drives remain."** They did not. `git range-diff <oldbase>..<old>
<newbase>..<new>` was not empty: the condition under test had been narrowed from
`renderers > 0` to `serverDriven(session) && renderers > 0`, and a helper had been lifted out of
its lambda. No conflict forced it — the commits rebased over were docs-only — so the patch was
amended during the rebase, deliberately and probably correctly. But amended.

**`git log` cannot tell those two apart.** Both show one tidy commit with the same subject on a
new base. The only instrument that separates them is **`git range-diff`**, and it costs one
command.

**The consequence is not all-or-nothing, so do not treat it that way.** Work out which arm of
your evidence the amendment actually touches:

- The arm whose behaviour the change alters is **invalidated** — here the terminal arm, because
  the new conjunction flips `nativeViewActive` to false for exactly that family.
- The arm where the change reduces to the old expression is **probably** still good, and
  *probably is not a verdict*. Either show it by reading and label the row as an argument rather
  than a measurement, or re-drive it.

**So: after any rebase of a driven fix, run `range-diff` before you repeat the reading.** If it
is non-empty, name which arms survive and which do not, rather than declaring the whole set
either dead or alive.

### The mail reader cannot show you new mail — read the session instead (2026-08-26 23:35 CEST)

`podium issue mail inbox` lists the **oldest** messages and truncates the recent ones. Measured
on the coordinator's mailbox: 186 headers spanning 2026-08-13 to 2026-08-20, on 2026-08-26.
`podium mail inbox` tails out at 2026-08-14. `podium issue mail pending` prints a bare count with
no id, so `mail claim` and `mail show` have nothing to take. Filed as POD-2911; there is no
`--limit` to work around it with.

**So a stop hook telling you about a message is not something you can act on through the inbox.**
Do not conclude the hook is noisy — the message is real and the reader cannot reach it.

**The reliable path is the session itself:** `podium session read <full-uuid> --turns 1`. Note it
needs the FULL uuid; a prefix returns "no session found", which reads like the session is gone.
Resolve ids with `podium issue show <id> --json` and read `data.sessions[].sessionId`.

**Corollary for senders:** a send reports "queued for delivery" and the ledger records it, so
silence from the recipient does not distinguish "read it and disagreed" from "never saw it". If
something is gating, put it where the recipient will trip over it — a session send, or a comment
on the issue — not only in mail.

### Before queueing for test:heavy, ask whether the arms differ (2026-08-26 23:58 CEST)

A session reported itself blocked: its pre-fix control needed a web build, and `test:heavy` was
held with a queue forming. It was right not to bypass the lock and wrong about being blocked.

**Check what the fix commit actually touches before you build anything.** Of the nine landed fixes
that session was sent to drive, **eight change zero files under `apps/web`**. For those, the two
arms are **byte-identical in web**, so the arms cannot differ in a bundle — you need ONE, and you
swap only the daemon between arms. That halves the lock time. Only one of the nine changed web
files at all.

**Two questions, and they are not the same:**
1. *Do the arms differ in what I would build?* Only if the fix touches that layer. A daemon-side
   fix needs one bundle for both arms, never two.
2. *Do I need a bundle at all?* Only if the SYMPTOM is visible on screen. Five of those nine had
   symptoms observable from the daemon or server, so they need no bundle and no lock — they can be
   driven while the lock is contended by someone else.

**So a contended lock is a reason to reorder your work, not to stop.** Drive the cells that do not
need it, and queue for the ones that do when their turn comes. `test:heavy` is the most contended
resource on this box, and a meaningful share of the builds taken under it are for arms that are
identical to each other.

### I guessed a timestamp twice in one evening (corrected 2026-08-27 00:00 CEST)

The heading above originally read **00:02 CEST**. Thu Aug 27 00:00:15 CEST 2026 said **23:58**. Earlier tonight I made
the identical error on a ledger section — wrote 22:52 when it was 22:44 — and corrected it with a
note saying *"knowing the trap is not a control; running `date` is."* I then did it again, four
hours later, in the very file where the rules live.

**Both errors ran the same direction: forward.** That is not random. I write the timestamp when I
start composing and the write lands minutes later, so guessing always dates a note LATER than the
observation it records. On an epic where ordering decides whether a reading predates a fix, a
systematic forward skew is the worst-shaped error available — it makes stale readings look fresh.

**The control is mechanical, not attentional:** capture `date` into a shell variable in the same
command that writes the file, and interpolate it. Do not type a time you have not just read.

### "Only formatting" is a claim, and `-w` tests it in one command (2026-08-27 00:11 CEST)

A session inspected the fix commit it was sent to drive, saw parenthesisation changes, concluded
**"its effective diff is only formatting"**, and was about to record the issue as UNDRIVEN with an
invalid pre-fix boundary. The commit was 13 files, 191 insertions, 38 deletions, and it contained
the actual defect fix.

**THE TEST IS `git show <sha> -w --stat`.** A formatting-only commit collapses to nothing under
ignore-all-whitespace. That one still read 191/38, which settles it before any reasoning starts.

**How the mistake happens:** a mixed commit puts its cosmetic hunks and its substantive hunks in
DIFFERENT FILES. Here the biome noise (a `spawnSync(...)` wrapped in parens, a `??` chain
re-parenthesised) was in one file, and the fix — a bare `cmd: 'opencode'` replaced by
`resolveOpencodeBin(undefined, opts.env)`, which is exactly "the child ignored the scrubbed
env" — was two files further down. Reading the first hunks and generalising to the commit is the
whole failure. **Read the non-test source files specifically, not the stat and not the first
screenful.**

**And the wider point, which is worth more than the git trick: UNDRIVEN WITH A WRONG REASON IS THE
SAFEST-LOOKING WRONG ANSWER.** It reads as caution, it survives review because nobody argues with
someone declining to claim too much, and it retires the question permanently. A false PASS gets
challenged; a false "cannot be measured" does not. **So when a control looks unavailable, spend
one more command testing THAT conclusion before you record it.**

**Related, same shape:** "the substantive change is already in the parent ancestry" needs the
specific CALL SITES checked, not the topic. Three commits over two days can be a sequence — env
propagation, then the two manifests still bypassing it, then keeping probes package-local — rather
than a duplicate. Earlier work on the same subject is not the same work.

### A background command that cannot find its interpreter reports success (2026-08-27 00:27 CEST)

I launched the server suite in the background, wrapped as `bun run … > log; echo "exit=$?"`. The
task notification came back **"completed (exit code 0)"**. The log was **one line**:

    /bin/bash: line 4: bun: command not found

The suite never ran. The notification's exit code was the WRAPPER's — my `echo` succeeded, so the
shell exited 0 while the thing I cared about exited **127**. Had I trusted the notification I would
have recorded "the gate ran on the epic tip" for a command that never started, which is precisely
the defect I have been correcting other sessions for all evening.

**`bun` IS NOT ON PATH in this harness's shell** — not in a plain shell and not under `bash -lc`.
It lives at `/home/mgw/.bun/bin/bun`. Export
`PATH="/home/mgw/.bun/bin:$PATH"` before any `bun` invocation, or use the absolute path.

**THREE RULES, and the third is the general one:**
1. Capture the exit code OF THE COMMAND, not of the wrapper: `cmd > log 2>&1; rc=$?` and print
   `rc` as the first thing, before any other statement can overwrite `$?`.
2. **Check the log's SIZE before its contents.** A 12-minute suite that produces a 1-line log did
   not run. A line count is a positive control you get for free.
3. A completion notification reports that the PROCESS ended, not that the WORK happened. Same
   family as: a badge is not the event; a check that prints is not a check that gates; a pin proves
   the right code is loaded and nothing about whether it works.

### A wait condition can match a line the run prints on its way past (2026-08-27 00:33 CEST)

I armed a wait on the attribution suite with
`until grep -qE 'Tasks:.*successful|ELIFECYCLE|command finished|SUITE_EXIT' log`. It fired while
the run was still going, and the notification said the wait had **completed**. What it matched was
line 909:

    @podium/server#test:services:  WARNING  command finished with error, but continuing...

**"command finished" is a substring turbo prints mid-run**, once per failing task, on its way to
the next one. My pattern was written to be generous about how completion might be spelled, and
generosity in a wait condition is not caution — it converts "still running" into "done".

**Wait on a marker YOU emit, not one the tool might print.** The wrapper appends `SUITE_EXIT=<rc>`
after the command returns; that string exists nowhere else and cannot appear early. If you must
match the tool's own output, anchor it (`^`) and use its terminal line, not a phrase that reads
like one.

**This is the same failure as a check that cannot fail, inverted:** a condition so easy to satisfy
that it is satisfied by the wrong thing. Both give you a confident answer at the wrong moment. Ask
of any wait: *what else in this output could match, and would I notice?*

### The server gate is red with 80 INHERITED failures — the names are written down (2026-08-27 00:55 CEST)

`bun run test:unit -- --filter @podium/server` on this branch returns **80 failures that are not
yours**: 45 boundary, 34 services, 1 contracts. They have been red for days.

**The names are in `docs/evidence/pod-1761/known-red-server-tests.txt`.** Diff your failing names
against that file rather than re-running anything. **A name in the file is inherited. A name NOT in
the file is yours, and it is the only kind that blocks a landing.**

**Compare by NAME, never by COUNT.** A count that moves by one or two on this host is flake. The
question is never "how many failed" — it is "did anything fail that is not on the list".

**`PODIUM_TEST_WORKERS=1` must match.** That variable decides whether this gate is red at all, so
a run without it is not comparable to the file and not comparable to anyone else's run either.
State whether you set it whenever you report a gate result.

**How this was established, because the method generalises.** The suite was run on the epic tip —
a tree that did NOT contain the fix under test. Every task's count came back identical to the run
WITH the fix, including turbo's own "2 successful, 5 total". Since the fix is absent from that
tree, nothing in that run can be its fault. **The test is ONE-SIDED: it exonerates a change and
cannot convict one.** It only works when the tip genuinely lacks the change — check that with
`git cherry` first, and if the tip comes back green you still owe the two-arm run.

**It is a snapshot, not a gate.** Nothing compares against it automatically. If you land something
that legitimately changes this set, update the file in the same commit and say so.

### Put the CELL ID in the row, or your result does not count (2026-08-27 01:39 CEST)

Coverage against the Tier-A matrix is computed by matching the cell id (`A1a`, `A2a`, `A6b`…)
inside the `what` column of `docs/plans/pod-1761-results.tsv`. **A row without one is invisible.**

I did this to myself tonight. POD-2902 reported *"A2a re-drive complete"* with five interleaved
pairs and a clean result; the two rows **I** wrote for it said "badge working within 2s" and named
no cell. The PASS could not be counted, and the cell went on reading FAIL from a superseded row
hours after the fix had landed. **Work that is done and unlabelled is indistinguishable from work
that was never done** — the same shape as POD-2801, which sat finished in `review` for hours.

**So: if your drive measures a matrix cell, the cell id goes at the FRONT of the `what` column.**
If it measures a defect rather than a cell, say so plainly and it will not be counted against
coverage — that is correct, not a loss.

**Two related traps in the same file:**
- **The verdict for a cell is its LATEST row, not its first.** results.tsv is append-only, so a
  cell that failed and was later fixed has both rows. Anything reading it must sort by the
  timestamp column and take the last. My first attempt at the grid took the first and reported a
  fixed cell as failing.
- **Never reference another row by position** ("the row above"). Four sessions append to this file
  and land in different orders, so positions drift. Name the row by its timestamp and issue.

### The cheap checks can only produce a FAIL, never a PASS (2026-08-27 01:45 CEST)

Two checks have each settled an issue in seconds tonight without standing anything up:

- **Is there a consumer?** `grep -rn '<symbol>' --include='*.ts' apps packages`, then the same for
  the module path. POD-2691's instance UUID appeared in its own definition and one test, and **no
  file anywhere imported the module** — a feature with no caller passes every test it has, so that
  was the FAIL, found in thirty seconds.
- **Is the boundary real?** `git show <fix>^:<file>` and `git show <fix>:<file>`. POD-2622 had
  `cmd: 'agent'` at the parent and a resolver after it, which settled a question a session had
  answered wrongly three times from ancestry.

**BUT PASSING THEM PROVES NOTHING.** A session reported *"static audit complete: all three fixes
have production consumers and each parent boundary is real"* — and that sentence reads like
progress toward a verdict when it is progress toward the **starting line**. It means only: *none
of these can be settled from a terminal, so all of them now need a real drive.*

**So state the result that way.** "The cheap checks did not settle it" is the honest phrasing.
"The audit is complete" invites a reader — including you, later, with less context — to treat a
screened-in issue as a cleared one.

**This is the general shape of a screening test** and it is worth carrying beyond these two: a
check tuned to catch a specific failure cheaply tells you a great deal when it fires and almost
nothing when it does not. Asymmetric evidence is still evidence; it is just evidence in one
direction, and the direction has to be said out loud every time.

### A hold and its lift can cross — state the numbers, not the verdict (2026-08-27 02:10 CEST)

I sent a hold at 01:47 ("root is at 100%, stop reading") and a lift at 02:02 ("hold lifted, 20GB
free"). A session **acknowledged the hold at 02:08** — six minutes after the lift — and stopped
work it could have been doing.

**A message phrased relative to another message assumes an ordering the queue does not
guarantee.** "The hold is lifted" is meaningless to a reader that has not yet processed the hold,
and worse, it is *ambiguous* to one that processes them out of order: it cannot tell which is
current from the words alone.

**So state the absolute condition, always, with its timestamp:** *"root has 15GB free at 93%,
load 12.1, swap-out zero, as of 02:14 — that is admissible."* A reader holding two such messages
picks the later timestamp and is right without knowing anything about the first.

**Same rule applies to anything you send me.** "Still blocked" tells me nothing if I do not know
what you were blocked on or when; "root at 1.6GB and I did not take the reading, 02:06" tells me
everything and survives arriving out of order.

**And the corollary for the sender: never assume your correction landed before the thing it
corrects.** If a message matters, put the fact in it rather than a pointer to a fact.

### "The branch moved" is not "my rig is stale" (2026-08-27 02:45 CEST)

The coordinator commits ledger, brief and results updates every few minutes. **A session that
treats every advance of the branch as invalidating its rig will rebuild forever on this epic.**

**The check is one line and it is in the cron:**

    git diff --name-only <your pin>..issue/1761-agent-runtime | grep -v '^docs/'

**Empty means your rig is current, however many commits landed.** Non-empty means look at WHICH
files — a change in an area your cell does not touch does not invalidate your reading either.

Two live cases tonight, and the same line separates them:

- A session's base was **3 commits behind the tip, all docs-only** → its bundle was byte-identical
  in code to one built at the tip, valid for its whole six-cell column, no rebuild needed.
- POD-2874's shell and claude evidence sits at `6c10b6643` with **336 non-docs files changed
  since, 34 of them in terminal / session / socket / pty paths** → genuinely stale, and refusing to
  claim from it was correct.

**So the number of commits is never the answer.** "Your base is 259 commits behind" mattered
because those commits carried code; "your base is 3 commits behind" did not, because they carried
prose. Run the line.

**And say which case you are in when you report.** "My pin is N commits behind but the non-docs
diff is empty" is a complete statement; "the branch has moved since my pin" is not, and invites
the reader to guess.

### To test a dead session, kill the exact child PID — do not wait for one to die (2026-08-27 02:51 CEST)

POD-2913's second run of the POD-2298 parent cell is the model for any **A1c / send-to-a-dead-
session** measurement, in any column. Instead of finding a session that happened to be dead, it:

1. spawned a named instance with server and daemon **spawn-pinned to the arm's commit**,
2. fired a positive control that proves the session was alive and working (the Claude Code startup
   readout),
3. **killed the exact agent child PID — 436109, named in the report — immediately before the
   send**,
4. sent a unique marker (`P2298_LATE_REFUSAL_PARENT_DRIVEN_T5L9TK`) and read the persisted
   receipt.

**Why this beats waiting for a dead session.** A session that died on its own died for a reason you
did not choose and cannot describe — it may have crashed, been OOM-killed, or never started. Each
of those exercises a different path, and none of them is the one the cell is about. **Killing a
child you just proved alive makes the dead-session condition deterministic and the control
airtight**: the marker cannot be lost to a rig that was never working, because step 2 showed it
working.

**Use a distinct marker per arm.** Its parent and fix markers differ
(`..._PARENT_DRIVEN_T5L9TK` vs `..._FIX_GFO43L`), so a marker found in the wrong arm's store is
immediately visible as contamination rather than being silently counted.

**And it re-took the cell rather than defending the first reading.** Its first run was inside the
100%-disk window; the control had fired, so the reading was probably fine — and it re-ran anyway on
18GB free and 5.3GB memory, and got the same answer. **A result you re-took under clean conditions
costs one run and ends the argument.**
