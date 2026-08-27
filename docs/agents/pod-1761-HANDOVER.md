# POD-1761 COORDINATOR HANDOVER

You are taking over as coordinator of POD-1761, the Headless Agent Runtime epic. The previous
coordinator ran from 2026-08-26 morning through 2026-08-27 08:40 CEST and is out of quota.

**Read this whole file before doing anything. Then read, in order:**
1. `docs/agents/pod-1761-standing-brief.md` — the accumulated rules for every session on this epic
2. `docs/plans/pod-1761-decisions.md` — 10 numbered decisions, several still open for the operator
3. `docs/plans/pod-1761-release-ledger.md` — the running record; long, but the recent sections matter
4. `docs/plans/pod-1761-results.tsv` — 242 measurement rows, the source of every coverage number

Your worktree is `/home/mgw/src/podium/.worktrees/issue-1761-agent-runtime` on branch
`issue/1761-agent-runtime`.

---

# 1. THE CRON PROMPT — VERBATIM

This fires hourly at :13. It is your standing instruction. Reproduced exactly:

> EPIC DRIVE (POD-1761). Your main goal is getting this epic to a state where it can REPLACE the headed drivers in use today. For that, each driver in the epic — headless AND headed — must be better or at least as good as it is on today's main. Features that do not exist on main at all, such as streaming, are LOWER priority and come only once the rest is rock solid.
>
> DO NOT MERGE MAIN INTO THE EPIC BRANCH. Operator ruling, 2026-08-26: main moves constantly, each merge costs hours, and merging on a cadence turns the epic into a full-time integration job. Main is merged in ONCE ALREADY (7b9d9eacb). Do not do it again until the operator explicitly says so, no matter how far behind the branch drifts. Do not measure divergence, do not raise it as a concern, do not let any session merge main. Getting the drivers to parity is the job; integration is not.
>
> TIMESTAMP EVERYTHING YOU WRITE DOWN. Operator instruction, 2026-08-26 16:05 CEST. Every item added to any doc carries the DATE AND TIME, not just the date — "2026-08-26 14:32 CEST", not "2026-08-26". Ledger entries, results rows, decisions entries, brief additions. This epic moves in hours: a dozen entries sharing one date cannot be ordered afterwards, and ordering is what says whether a reading predates a fix, whether two agents saw the same tree, and which of two contradictory notes is current. Run `date` and use the real time; never guess it.
>
> MODELS FOR EVERY NEW SESSION (operator's instruction, 2026-08-26). Implementers: --agent codex --model gpt-5.6-luna --effort max. Reviewers: --agent codex --model gpt-5.6-sol --effort high. Claude sessions already running were allowed to finish; do not start new claude ones.
>
> Be relentless. You are the only one responsible and must NEVER defer to the human — they are not around, and waiting stalls everything. Do not stop for tick after tick with no work running; if that happens you are relying on something you could change yourself or work around.
>
> Driving forward means CONFIRMING BY HANDS-ON DRIVING that the new drivers and the old claude one work in every scenario a user would hit. For the scenario list use docs/plans/pod-1761-release-ledger.md in this worktree — it is exhaustive. Keep it updated as you go.
>
> EVERY TICK, IN THIS ORDER:
> 1. Check each session you dispatched — is it actually DOING anything? Signals: new commits, recently written dirty files, and above all READ ITS LAST TURN and look at the timestamp. A drive session writes to its state root, not its worktree, so an empty worktree is not a stall — check for its server/daemon processes instead. Before escalating "this session looks dead", CHECK THE CHECK: in a linked worktree .git is a FILE, so use `git rev-parse --git-path <x>`, not a path test. `live/idle` and `live/working` are different words — an idle session with a dirty tree is the shape most likely to lose work. Do not replace a session that is merely waiting on an answer you owe it; answer it.
> 2. Verify every agent you start or restart is on the EXACT right commit — some get cut from main by accident, and a session that keeps its worktree may need updating. Wrong base wastes the whole round.
> 3. Then pick the next thing. Every known defect should have an owner. File new SUBISSUES (never top-level — those land in proposed and cannot be started) and start them yourself when the box has room.
>
> STAY ON THE FOREST, NOT THE TREES:
> 4. Every tick, say how much of the release check is done, what is failing, and how many fix-and-retest rounds that predicts before every driver is at least as good as today's. The unit is DISTINCT DEFECTS, not failed checks — one defect costs one round however many checks it breaks. Also say how many PRODUCT FIXES have landed, so progress is visible as well as measurement.
> 5. For each failure, say whether it can be fixed or is just how the new design works — the second kind never gets better by testing more. Keep both in files, not messages, since your context gets lost and the human will not read every message: results in docs/plans/pod-1761-release-ledger.md, anything needing the human's decision in docs/plans/pod-1761-decisions.md with the date, time, the choice, and what happens either way.
>    Record each check as one line in docs/plans/pod-1761-results.tsv, columns fixed: what | driver | pass/fail | commit it ran on | control fired? | anything else running? | date+time | issue. A line missing any field does not count as a result. A row is stale only if CODE changed since its commit (`git diff --name-only <row commit>..issue/1761-agent-runtime | grep -v '^docs/'`), not merely because commits landed — and narrow it by area before re-driving anything.
> 6. If you have given two agents the same correction, put it in docs/agents/pod-1761-standing-brief.md and point new sessions at it, instead of repeating it. Your own rules apply to you too.
>
> A DELIVERABLE IS DRIVEN BY WHOEVER HANDS IT OVER — including you. A fix is not review-ready until it has been shown FAILING without the change and PASSING with it, on a real instance. A unit test is how you keep it fixed; the pre-fix control is how you prove it was ever broken. A pin check proves the right code is loaded; it proves nothing about whether anything works.
>
> HYGIENE: no reviewer round for nitpicks — reviews are for true defects and real hygiene. Tell every agent exactly how to typecheck and test so they USE THE CACHE, and do not over-test: flatblock is CPU constrained. Heavy gates and rig web builds take the test:heavy lock — heavy means memory-heavy, not a command name. No agent may use AskUserQuestion, podium offers, or any other way of asking the human — if they need something they address YOU.

**CURRENT MODEL OVERRIDE, operator instruction 2026-08-27 09:32 CEST:** for every worker
started or restarted from this point onward, use `--agent codex --model gpt-5.6-sol --effort
high`. This supersedes the historical Luna/max implementer rule inside the verbatim cron prompt
above. Let workers already in flight finish rather than discard their live rigs or evidence solely
to change models.

**The cron job is session-only and dies when the coordinator session exits.** You will need to
recreate it: `CronCreate` with schedule `13 * * * *`, recurring, the prompt above verbatim.
The previous one was `9140772c`; it will not survive.

---

# 2. OPERATOR RULES BEYOND THE CRON

- **The operator is not around.** Never block waiting for them. File decisions in
  `pod-1761-decisions.md` and keep going.
- **No agent may use AskUserQuestion or podium offers.** If a session needs something, it addresses
  you. Put that in every brief.
- **Issue and session titles: 3–5 words naming the thing, not the activity.** No
  "Implement"/"Complete"/"Investigate" openers. Only bugs may lead with "Bug:".
- **`--description` is 1–3 plain, context-free sentences for a human** who has no context. Technical
  detail goes in `--brief`.
- The operator reads the issue **state paragraph** and **todo list** in the sidebar. Keep both
  current — `podium issue state 1761 --set "…"` and `podium issue todo 1761 --add/--done/--remove`.
  Write them in plain language with no jargon; they are the only thing the operator sees at a glance.

---

# 3. WHERE WE ARE (as of 2026-08-27 08:40 CEST)

## The acceptance matrix

69 real cells (16 rows x 5 columns, minus `n/a`). **53 have current readings — 77%.**

    claude    15/15  COMPLETE
    opencode  16/16  COMPLETE
    shell      6/ 6  COMPLETE
    codex     14/16  POD-2923 driving the last three
    grok       2/16  quota returns 2026-08-27 11:03 CEST

## Reds

**ONE CONFIRMED REGRESSION — A3 — AND IT BLOCKS THE RELEASE.** (Established 2026-08-27 08:47,
after the body of this file was written. See Decision 24.) The others are instruments or
behaviours main shares:

    A1b  claude  FAIL      INHERITED — fails identically on main (POD-2921 measured it)
    A1c  claude  FAIL      INHERITED — fails identically on main
    A3   claude  FAIL      *** REGRESSION *** main PASSES it — stopped and transcript-marked.
                            THE SOLE RELEASE BLOCKER. Fixable, needs an owner. Decision 24.
    A3   codex   REFUSED   control never produced an in-flight turn
    A4a  codex   BLOCKED   STALE — see POD-2923
    A4a  claude  BLOCKED   claude-code 2.1.231 rewrites permissions.defaultMode; real instrument limit
    A4b  claude  BLOCKED   same wizard limit
    A8   claude  BLOCKED

## What was accomplished overnight

**Five defects closed by measurement:**
- POD-2878 parked send lost across a restart → `b1c725716`
- POD-2902 opencode badge 2752ms → 365ms → `ffa2fadcd`
- POD-2801 busy terminal shows idle (found already fixed and parked in review)
- POD-2914 hermetic env reached 3 of 9 launch sites → `04b637b31`
- POD-2691 orphaned agents survive their issue → reaper landed and verified

**Nine "unknown" issues audited** (fix merged, never checked against the defect): eight resolved,
six were already fine, two were genuinely broken and both are now fixed. POD-2773's grok half waits
for 11:03.

**Four defects filed that surfaced sideways:** POD-2910 (cleanup verb can never succeed on an epic),
POD-2911 (mail inbox cannot reach today's messages), POD-2916 (queued mail resurrects a stopped
session), POD-2922 (rig teardown leaves credentials behind).

**29 product fixes landed on the epic.**

---

# 4. LIVE SESSIONS RIGHT NOW

| issue | what it is doing | notes |
|---|---|---|
| POD-2921 | main baseline for claude A3 — **the last open cell in the matrix** | on its 5th probe iteration; its branch is cut from MAIN and must NEVER merge into the epic |
| POD-2920 | queue position never reaches the caller (A1b) | will make A1b BETTER than main rather than equal |
| POD-2923 | codex's last three cells (A4a stale-blocked, A4b, A8) | would make codex the 4th complete column |

**Check them with:**

    podium issue show <id> --json | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; [print(s['sessionId'], s.get('status'), (s.get('agentState') or {}).get('phase')) for s in d.get('sessions',[])]"

---

# 5. WHAT TO DO NEXT, IN PRIORITY ORDER

1. **Recreate the cron** (see §1). Without it you get no ticks.
2. **FIX A3 ON CLAUDE — THIS IS THE RELEASE BLOCKER.** The baseline is DONE: main PASSES, the epic
   FAILS, so it is a genuine regression. The epic-side symptom is *"interrupt returned without a
   stopping record"* — the call succeeds and the turn keeps running. **Both arms already exist as
   controls**, so whoever fixes it has a pre-fix reading on the epic and a passing reference on
   main. Staff this before grok.
3. **Grok at 11:03 CEST — 14 cells unblock at once**, the largest single coverage jump left. Nobody
   is staffed. File a subissue and start it then. Grok has protocol-level turn receipts and is
   predicted to score BETTER than the others. **POD-2877's earlier grok pass bound `generic-pty`
   because the credential was absent — those readings measure the wrong driver and must not be
   reused.**
4. **POD-2920's queue-position fix**, then re-drive A1b on codex and opencode to turn three cells
   green.
5. **Decision 22** (operator): the scorers test the coarse clause and miss the fine one. The
   supported claim is *"no gross regression found"*, NOT *"criteria met in full"*. Recommendation is
   to tighten only A1c's lost-message clause and A9's rebound detection.
6. **Decision 18** (operator): 80 known-red server tests are inherited and their names are in
   `docs/evidence/pod-1761/known-red-server-tests.txt`. Recommendation is to check them into a
   baseline the gate compares against, so the 81st is visible.
7. **POD-2870 and POD-2879** are stuck at stage `proposed` and describe the same defect POD-2920 is
   fixing. **Only the operator can reparent a proposed issue.** They should be closed as duplicates.

---

# 6. HOW THE JOB ACTUALLY WORKS

## Landing a session's work

    podium lock acquire "merge:issue/1761-agent-runtime" --ttl 10m
    git cherry-pick <sha>            # ff-only usually refuses; branches lag
    # on conflict in results.tsv / ledger: KEEP BOTH SIDES, they are append-only logs
    podium lock release "merge:issue/1761-agent-runtime"

**`podium merge-lock` defaults to `merge:main` — that is the WRONG lock.** Use
`podium lock acquire "merge:issue/1761-agent-runtime"` explicitly.

## Freeing disk

    podium issue stop <id> --outside-scope    # frees the worktree, keeps branch + transcripts

**`podium issue cleanup` can NEVER succeed on this epic** — it checks the branch against `main`,
hard-coded, and this epic never merges to main (POD-2910). A worktree with `node_modules` costs
**2–3GB**. The box has ~15GB free and hit 100% twice overnight.

## Starting a session

    podium issue create --title "3–5 words" --parent-id 1761 --parent-branch issue/1761-agent-runtime \
      --priority 1 --description "plain sentences" --brief "$(cat brieffile)" \
      --agent codex --model gpt-5.6-sol --effort high --start

**Then ALWAYS verify the base** — `--parent-branch` is required or sub-issues get cut from main:

    git -C <its worktree> rev-parse --short HEAD    # must equal the epic tip

**`podium agent spawn --issue <existing>` REUSES that issue's old branch.** One session was spawned
onto a branch 259 commits stale. Check every time.

## Reading a session

**Mail is broken (POD-2911) — the inbox shows the OLDEST messages and truncates everything
recent.** You will get hook notifications for messages you cannot read. Read the session instead:

    podium session read <FULL-uuid> --turns 1     # a prefix returns "no session found"

Or read its worktree directly — `git -C <wt> status --porcelain`, its evidence dir, its
`results.tsv`. **Three times overnight a result reached me that way rather than through a report.**

---

# 7. THE TRAPS — everything learned the hard way

**These are in `pod-1761-standing-brief.md` in full. This is the index.**

## Instruments lie confidently, and the failure is always silent

- **A command that did not run looks like a null result.** `bun` is NOT on PATH here — it is at
  `/home/mgw/.bun/bin/bun`. A wrapper printing `exit=$?` reports the echo's status, not the
  command's. **Check the log's SIZE before its contents**: a 12-minute suite with a 1-line log did
  not run.
- **A wait condition can match a line the run prints on its way past.** Mine matched turbo's
  `command finished with error, but continuing` mid-run. **Wait on a marker you emit yourself.**
- **`>>> FULL TURBO` means everything was cached and nothing compiled.** Say so when you report a
  green. For a landing decision, force an uncached run with a stated reason.
- **A completion notification says a process ended, not that work happened.**

## Ancestry vs content vs artefact

- **`git rev-list --count` over-reports unlanded work** — two issues showed "1 commit ahead" whose
  patch-id was already on the epic.
- **`git cherry` over-reports too** — a conflict resolution rewrites the patch and destroys
  patch-id equality without changing the result.
- **The blob is the authority**: `git rev-parse <rev>:<path>` compares what will actually be there.
  **When a landing decision matters, compare the artefact, not the history.**
- **Use the graph, not the dates.** A parent commit dated a day AFTER its child is rebase-normal.

## Staleness

- **A row is stale only if CODE changed in its area** —
  `git diff --name-only <pin>..issue/1761-agent-runtime | grep -v '^docs/'`. Empty means current
  however many commits landed. The coordinator commits docs every few minutes; a session that
  treats "the branch moved" as "my rig is stale" rebuilds forever.
- **FOUR STALE BLOCKERS were found overnight.** "Nobody drove shell" (21 cells sat in an evidence
  README), "claude needs the operator" (the token was valid), "inherited apps/web errors" (a missing
  workspace symlink), "codex A4a is blocked" (the interactions service had changed).
  **A blocker recorded once gets treated as a property of the world. Most of them expire.**

## Rigs and instances

- **A commit older than `ab9d698ab` CANNOT start a NAMED instance** — ~113 bytes of `sun_path`
  against a 108-byte kernel limit. **The DEFAULT instance fits at 71.** So a pre-fix parent arm or a
  MAIN baseline needs the default instance. **The "always use a named instance" rule is about
  session collision, NOT correctness, and it inverts on pre-fix commits.** This cost six hours and
  made a whole column look impossible.
- **There is only ONE default instance.** Take `podium lock acquire instance:default` and fence
  the others.
- **Do not touch the operator's live default daemon** at `/home/mgw/.podium` — systemd has real
  sessions there. Build an isolated default-ID rig with its own state, home and loopback ports.
- **Pin server, web bundle AND daemon before every cell.** The daemon is the one that catches people
  out: agent drivers load at process start, so repointing a checkout changes nothing for a running
  daemon. **Write `git rev-parse HEAD` at spawn time** — a process timestamp is not a pin and skews
  FORWARD on this host, the direction that turns a stale rig into a pass.
- **Before queueing for `test:heavy` to build, ask whether the ARMS DIFFER in what you would build.**
  A daemon-side fix needs one bundle, not two, and often none. This removed a lock queue slot three
  times overnight.

## Controls

- **Every cell needs a positive control that fires whether or not the feature works.** A zero with
  the control present is evidence; a zero without it is a dead rig.
- **Make the control INDEPENDENT of the thing you are testing.** Reading a store to check the store
  ran is circular. POD-2871 spent six hours on a control and then measured in twenty minutes; three
  other sessions produced numbers that could not be used.
- **The shared phase observer LIES.** It reported `idle` through a live long turn on main, and
  `working` for a session dead 101 minutes. Build an independent in-flight proof — PTY byte growth
  in a one-second window, or a visible countdown position.
- **To test a dead session, KILL THE EXACT CHILD PID you just proved alive.** A session that died on
  its own died for a reason you did not choose.
- **Distinct markers per arm**, so a marker found in the wrong arm is visible as contamination.
- **A1b/A3 note: a loaded box flatters the interrupt answer.** Drive A3 only when the 1-minute load
  average is **BELOW 12** — a ceiling, not a target. On a MAIN baseline that error is the expensive
  one: it makes main look broken and lets a real regression pass as inherited.

## The results file

- **Cell id at the FRONT of the `what` column** or the row is invisible to coverage.
- **`[parent]` / `[fix]` / `[single]` arm prefix.** A parent-arm FAIL is EVIDENCE, not a verdict —
  any query taking "the latest row per cell" reads a passing cell as failing. That happened twice.
- **Verify the row parsed**:
  `awk -F'\t' '!/^#/ && NF>0 && NF<8 {print NR}' docs/plans/pod-1761-results.tsv` — empty is good.
  Nine rows were written with literal `\t` instead of tabs and were invisible until repaired.
- **A query is an instrument.** Check any aggregate against a case whose answer you already know.

## Shell hazards that cause SILENT loss

- **Never use an unquoted heredoc for prose.** `<<MARKER` interprets backticks as command
  substitution — a ledger line containing `done` in backticks truncated and the commit still
  succeeded. **Always `<<'MARKER'` and substitute timestamps afterwards with `sed`.**
- **Backticks in a `--body` argument** are eaten the same way.
- **`echo "a\tb"` without `-e` writes a literal backslash-t.**
- **`grep -c` prints 0 AND exits non-zero** — `|| echo 0` produces "0\n0".
- **`grep | head` lies** — never conclude "nothing uses this" from a truncated search.
- **Every one of these produced silent loss rather than an error, and every one was found by
  reading back what landed.**

## Credentials — READ THIS BEFORE ANY CLAUDE WORK

- The operator's real login is `~/.claude/.credentials.json`. **It refreshed at 07:49 and expires
  15:49.**
- **The mechanism:** claude refreshes a token ONLY when it is ALREADY EXPIRED, and a refresh
  ROTATES it, invalidating every other copy including the operator's.
- **So a fresh copy is harmless and a STALE copy is the danger.** An expired copy read by any
  process logs the operator out of their own sessions.
- **Thirteen copies were found on disk overnight**, twelve expired, one with three live claude
  processes sleeping under it. They were removed six minutes before the token expired. **Filed as
  POD-2922: rig teardown removes processes and leaves credentials.**
- **Check every tick:** `stat -c %y ~/.claude/.credentials.json` and
  `find /tmp -maxdepth 5 -name '.credentials.json'`.
- **Never print, log, echo or commit a token value.** Report expiry times and mtimes only.

## Concurrency

- **The box ceiling is about 5–6 sessions**, bounded by DISK not CPU. Load and memory were
  comfortable both times the disk hit 100%.
- **Free a finished worktree BEFORE starting a new session**, not after.
- **An announcement of spare capacity, sent to everyone, consumes the capacity it announces.** Name
  an ORDER, not an opening.
- **A hold and its lift can cross.** State absolute conditions with timestamps —
  *"root has 15GB free at 08:31, that is admissible"* — never *"the hold is lifted"*.
- **Two implementers on the same daemon file collided overnight** because I briefed them
  independently. **Say who owns which files when sessions may collide.**
- **Use a LOCK, not a promise.** A lock is queryable at the moment of use; a message is only as
  current as its delivery.

## Judgement

- **Withdrawing a correct correction is worse than never making it.** I told a session its A3 was
  PARTIAL (right), then "verified" against a DIFFERENT session's scorer and withdrew (wrong), and it
  had to re-establish what it already knew.
- **When you think a scorer is wrong, READ THE SCORER** — and make sure it is the one that session
  actually uses.
- **An unchecked blocker is more expensive than a wrong measurement.** A wrong number gets corrected
  by the next drive; an imagined wall just stops work.
- **A "MISSING" from a check you wrote is not evidence of a missing fix.**
- **Sessions who refuse to report a reading are doing the job right.** Five refused overnight rather
  than record through a bad rig, and one withdrew a result it had already taken. **That is why any
  of the numbers can be trusted.** Say so when they do it.

---

# 8. FILE MAP

    docs/plans/pod-1761-release-ledger.md     the running record, ~4500 lines
    docs/plans/pod-1761-decisions.md          10 decisions, several open for the operator
    docs/plans/pod-1761-results.tsv           242 rows; the source of every coverage number
    docs/agents/pod-1761-standing-brief.md    the rules; point every new session at it
    docs/agents/pod-1761-HANDOVER.md          this file
    docs/evidence/pod-1761/known-red-server-tests.txt   80 inherited failures, by name
    docs/evidence/pod-28xx/, pod-29xx/        per-issue drive evidence, pins and readings

## The coverage query

The canonical one is embedded in the ledger's FOREST sections. It must:
- skip `[parent]` rows
- take the LATEST row per (cell, column) by timestamp
- treat rows pinned at `6c10b66…` as stale (POD-2874's pre-rewrite drive)
- exclude `n/a` cells from the denominator (69 real cells, not 80)

---

# 9. THE ONE THING THAT MATTERS MOST

**The bar is: every driver at least as good as it is on today's main.** Not perfect — *as good as
main*. That distinction has decided three separate questions overnight, and it is why the A3 main
baseline matters more than any amount of further driving on the epic branch.

**A cell failing on the epic means nothing until you know what main does.** Two of the three claude
reds turned out to be behaviours main shares — and **the third, A3, turned out to be a real
regression once main was finally measured.** That baseline took four attempts across two days and
three of them were rig failures rather than readings. **It was worth every one of them: without it,
this epic would have shipped with a broken interrupt believing it had none.**
