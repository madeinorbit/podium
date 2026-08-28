# Decisions waiting on the operator — POD-1761

One entry per decision only the human can make. Each says the date, the choice, and
what happens either way. This file exists because the coordinator's context is lost
between sessions and the human does not read every message.

---

## 1. A parked chat message is destroyed by a daemon restart — fix or ship with it?
**SCOPE WIDENED 2026-08-26 17:19 CEST: it is ANY viewer, not the sender.**
**Raised 2026-08-26. Status: OPEN. Blocking, on the release bar.**

Sending from chat while the CLI view is open returns `delivered`, the turn parks
invisibly, and a daemon restart **destroys the message**. The old terminal driver
delivers the same message normally — same commit, same rig, one variable apart.

**Why it is the operator's call:** this is the release bar failing on the family we are
switching *to*. Fixing it means making a parked turn durable, which is real work.

- **Fix it** — POD-2878 is on it. Cost: one fix-and-retest cycle, unknown size until the
  durability design is settled.
- **Ship with it** — an operator who has the CLI open on a desktop and sends from a phone
  is told delivered, and the message is gone after any restart. Nothing in the UI can
  tell it apart from a delivered message.

**Recommendation: fix.** Silent data loss is the one class that cannot be documented away.

---

## 2. Headless costs three extra processes per view switch; terminal costs zero.
**Raised 2026-08-26. Status: OPEN. Not a defect — this is how the new design works.**

Switching between chat and the CLI view spawns `abduco` + `codex resume` + `abduco -a`
on the server-driver path and tears them down on leaving. The terminal path spawns
nothing. The capability catalogue already declares server drivers non-parkable, so this
is the architecture rather than a bug, and **no amount of further testing changes it**.

- **Accept** — record it as a known cost of the new drivers in the release notes.
- **Design around it** — requires a parkable client-terminal, which is a design change
  nobody has scoped.

**Recommendation: accept and document.** But it is the operator's call because it is a
permanent difference, not a temporary one.

---

## 3. A queued chat message never reports its position to the caller.
**Raised 2026-08-26. Status: OPEN. Waiver candidate.**

The product computes the position and emits it on the message-receipt path; the chat
reply is narrowed to four pinned keys with a comment deferring the wire change. So the
row falls short of its own wording but nothing is lost or wrong.

- **Waive** — costs nothing; the row's criterion is not met and the matrix carries a
  documented exception.
- **Fix** — a wire change, possibly the same fix as decision 1.

**Recommendation: waive unless decision 1's fix delivers it for free.**

---

## 4. Two main-only defects found while driving — port to main, or leave?
**Raised 2026-08-26. Status: OPEN. Not this epic's regressions.**

- **POD-2868** — on the terminal path, a session whose model the provider rejects looks
  healthy: the agent's own screen says the model is invalid within four seconds, the
  product shows idle and running for three minutes, the prompt is never delivered, and it
  silently switches to a model nobody asked for.
- **POD-2871** — two sessions in one folder on the terminal path: one shows the *other's*
  conversation. Being fixed anyway, because it corrupts the acceptance drive itself.

Both exist on today's main. They do not block this release under the
better-or-no-worse bar, but shipping without saying so makes them look new.

**Recommendation: name both in the release notes as pre-existing.**

---

## 5. `lint:boundaries` is red on the branch and none of it is ours.
**Raised 2026-08-26. Status: OPEN, low. Informational.**

58 violations, attributed one by one: 41 of 47 files byte-identical to main, every
blame-able violation line tracing to a commit already on main, and no console calls,
browser storage or harness-name literals added by this epic.

- **Ship** — the gate was already red; we made it no worse.
- **Clean first** — unrelated work, would delay the release for hygiene.

**Recommendation: ship.** But the gate cannot be used as a green/red signal for this
branch while it stays red, and somebody should know that.

---

## 6. Long turns never finish on the new codex driver — fix before shipping.
**Raised 2026-08-26. Status: OPEN. Blocking, and it breaks ordinary work.**

Ask Codex for something that takes a while and it never finishes. Same request, same
machine, one variable changed:

| where | result |
| --- | --- |
| new driver (codex-app-server) | **wedges** — 400 seconds, no answer ever produced |
| old driver (generic-pty) | completes in 61s |
| Codex run directly, outside the product | completes in 83s |

So the work is fine and the harness is fine; the new driver is what breaks. The same
shape was already recorded for opencode, so it is probably one cause in shared code
rather than two driver bugs.

**Why it is the operator's call:** this is not an edge case reached by an unusual
setting — it is any long task. It also makes the interrupt check unmeasurable on that
driver, because nothing is observably in flight to interrupt.

- **Fix it** — POD-2885 is on it. The 20-second cliff (previews stop dead at 82 frames
  while the turn runs on) points at something bounded filling and not draining.
- **Ship with it** — long tasks silently never complete on the driver we are switching to.

**Recommendation: fix. This one is not waivable.**

---

## 7. Half of the logged-out check cannot be driven without touching your real credentials.
**Raised 2026-08-26. RESOLVED 2026-08-26 16:10 CEST — the operator logged Grok in, and the drive then
completed the half no agent could: A8 post-login PASSES on headless, binding a fresh
grok-acp server driver. No decision left; recorded because the resolution took a human
and that is worth knowing next time.**

The check has two halves. The first is driven: a logged-out opencode session takes the
old driver, and the product **does** record it — requested driver beside actual driver,
a typed `logged-out` condition on the session, `loginRequired` on the account, and
`login.state: out` on the machine. What is missing is a **login affordance**: nothing on
the session offers to log you in, and the capability catalogue already declares that gap.

The second half — *after logging in, does the next session land on the new driver* —
**cannot be driven by an agent.** A real OAuth login would either mint credentials the
rig must not mint, or rotate your own token in the middle of a release. The epic already
declined that trade once in writing, for claude, and the drive declined it again rather
than report an untested half as passing.

- **You drive it yourself, once** — a minute of your time settles the last unmeasured
  half of this row.
- **Waive it** — ship with the login path declared but never end-to-end verified.
- **Build a credential fixture** — real work, and it proves a fake path rather than the
  real one.

**Recommendation: you drive it once.** It is the only item on the entire matrix that a
human can settle faster than an agent can, and no amount of further automation changes
that.


---

## 10. Grok's quota exhaustion was captured, and headless reports it better than terminal.
**Recorded 2026-08-26 16:10 CEST. No decision needed — evidence for the release note.**

A real exhausted quota is a rare condition and it expires when the quota resets. It was
driven on both arms before that window closed:

| arm | what the user sees |
| --- | --- |
| headless (grok-acp) | `usage_limit`, `retryable:false`, **402 Payment Required: Grok Build usage balance exhausted** |
| terminal (generic-pty) | `Weekly limit left: 0%` |

Both surface it, so this is not a regression either way. But the headless reading is
**typed and structured** — a machine-readable class, an explicit non-retryable flag, and the
provider's own message — where the terminal reading is a line of prose the user has to
interpret. That is a third cell where the new drivers are *better*, and unlike the other two
it costs nothing to claim, because both arms pass.

Worth a line in the release note: quota exhaustion is now reported as a typed provider error
rather than only as screen text.


---

## 11. An existing session loses its history view when it upgrades — ANY agent, not just Codex.
**Raised 2026-08-26 16:57 CEST. Status: OPEN. This is the upgrade question you asked about, answered.**

You asked whether the transition would be seamless for people who already have sessions. It
is for three of the four agents. It is not for Codex.

**What was measured**, on a real upgrade: sessions created on the current release, then the
server repointed to the new build.

| agent | lists? | resumes? | history | which driver |
| --- | --- | --- | --- | --- |
| Claude terminal | yes | yes, same reference | intact, recalled its codeword | unchanged |
| Codex | yes | yes, but a **new** reference | **the old conversation disappeared from view** | switched to the new driver |
| OpenCode | yes | yes | stored text intact, model did not recall | fell back to the old driver — logged out |
| Grok | yes | auth-gated | none | fell back to the old driver — logged out |

**Codex is the only agent that actually switched drivers, and it is the one that lost its
history view.** The conversation is not destroyed — the drive got its planted codeword back by
reading the old transcript file directly — but Podium no longer shows it, because the new
driver started a fresh conversation rather than adopting the old one.

**Two honest limits on this, stated so it is not over-read:** the original scratch database was
gone, so the pre-cutover sessions were **recreated** rather than being the literal originals;
and OpenCode and Grok never exercised a rebind at all, because being logged out sent them to
the old driver. So this is *one clean rebind case*, and it failed.

- **Fix it** — teach the new driver to adopt an existing conversation on upgrade instead of
  starting a new one. Real work, and the design question of whether a session's driver should
  become durable sits underneath it.
- **Ship it and say so** — existing Codex users keep their sessions and lose the visible
  history in them. Recoverable from disk, not by them.
- **Ship it with a migration** — carry the old conversation forward once, at upgrade time.

**Recommendation: fix it, and treat the one-clean-case coverage as a reason to re-drive rather
than a reason to relax.** This is exactly the question you raised, and "three of four are fine"
is not the answer when the fourth is the only one that took the new path.


---

## 12. A hermetic Claude home cannot exercise the permission prompt at all.
**Raised 2026-08-26 17:17 CEST. Status: OPEN. Only your own machine can settle it.**

Two Tier-A checks on Claude — the permission card appearing, and answering it twice — cannot
be measured in an isolated test home. Not because the product fails them: **because
claude-code 2.1.231 rewrites `permissions.defaultMode` from `manual` back to `auto`, or opens
its own setup wizard regardless.** Both controls fired, so this is an instrument limit and was
correctly scored BLOCKED rather than as a defect.

The wizard also consumes typed text without echo, which is what produced an earlier run of
`bytes=0` on the main arm and cost most of an afternoon.

- **Drive it once on a real home** — yours, or any non-hermetic one. Ten minutes, and it
  closes two checks nothing else can reach.
- **Ship the two checks unmeasured**, with the reason stated in the release note: the
  permission path on Claude was not exercised, because an isolated home cannot hold the
  setting that would allow it.
- **Build a non-hermetic rig** — real work, and it weakens the isolation that keeps these
  drives from contaminating each other.

**Recommendation: drive it once on a real home if you are willing.** This is the second item
today that only a human can unblock — the first was the Grok login, which you did, and which
immediately closed a check that had been open on every column.

---

## 13. Some checks have NO main baseline, because main cannot run the configuration.
**Raised 2026-08-26 17:17 CEST. Status: OPEN. Not a decision so much as something the release note must not omit.**

Under the rig this epic mandates — a named instance with no path overrides — **today's release
cannot start a Claude session at all**. Both attempts died with `create-session: File name too
long`, the socket-path defect this epic fixed and main still has.

Three consequences, and the third is the one that could be quietly mis-stated:

1. **The Claude interrupt finding is neither reproduced nor cleared.** The failure on our
   branch stands as observed; the baseline is *unavailable*. **That is not the same as "no
   regression"** and must not be rounded to it.
2. **It is a fourth place where this epic is better than the current release** — a
   configuration you use cannot run at all today, and runs on ours.
3. **Any check whose baseline needs a named instance is unbaselineable by this route.** That
   is a structural limit on the comparison, not a gap in anyone's work, and the release note
   has to say so rather than let a reader assume those checks were compared against the
   current release and passed.


---

### Update to decision 1, 2026-08-26 17:19 CEST — the parked-message defect is worse than filed

It was filed as *"the sender has the CLI view open"*. Measured with two clients and one
variable — the **second** viewer's mode, sender always in chat:

    second viewer "chat"    -> delivered, nonce ARRIVED, 2 items
    second viewer "native"  -> delivered, nonce NEVER ARRIVED, 0 items, phase idle

**Any viewer on the native view parks the send.** The realistic case is you with the CLI open
on your desktop and chat open on your phone: **the phone shows a delivered tick for a message
that will never run, and the person holding it cannot see what is causing it.**

That moves this from *"a thing you can do to yourself"* to *"a thing another open window does
to you, invisibly"*. It is the same defect, not a new one, and its owner has the bounds:
undeclared passes, explicit-native-by-any-client parks — so a fix that only consults the
sender's own mode would leave it reachable.


---

## 14. The Claude column is gated by a credential risk nobody has characterised.
**Raised 2026-08-26 17:39 CEST. Status: OPEN — being investigated read-only, no decision needed from you yet.**

Claude is the driver people use today, so it is the one column where a regression definitively
blocks this release. It is currently the least-measured, and the reason is a risk to **your own
login**:

> *Claude authenticates by OAuth only, no API key exists on this box, and a refresh in either
> home rotates the token and invalidates the other holder — so re-seeding could log the
> operator out of their daily driver mid-release.*

That was recorded earlier and declined in writing. **It is still live, not historical:**
`~/.claude/.credentials.json` was modified at **15:47 today**, and the coordinator session
itself runs on that credential. A rig that triggers a refresh would log you out mid-release
and take this session with it.

**But one drive did complete a Claude column** — ten checks passing — so either a safe path
exists or that drive took the risk without knowing it was one. Nobody has established which.

A read-only investigation is now placed: how that drive authenticated, whether an *unexpired*
token actually triggers a refresh or only one near expiry, whether validity can be confirmed
without consuming it, and what exactly would rotate it.

- **If an unexpired token is safe** — the whole column opens up, including the two permission
  checks currently blocked on an instrument problem, and no decision from you is needed.
- **If any spawn rotates it** — then the named residual already in the ledger is the honest
  ceiling for Claude, and we should say so in the release note rather than keep trying.
- **If you are willing to accept one rotation at a chosen moment** — that is yours to offer,
  and it would close the column. It would log you out once, deliberately, at a time you pick.

**No action needed now.** Recorded because it is the largest measurement gap on the release and
its resolution may turn out to require you.


---

### Update to decision 11, 2026-08-26 17:46 CEST — SECOND CASE CONFIRMS IT IS THE REBIND PATH, NOT CODEX

I asked for a second clean rebind case, because *one case tells us Codex is broken; two tell
us whether the fault is in the rebind path or in the Codex driver* — the difference between a
targeted fix and a design change. **It ran, and the answer is the rebind path.**

OpenCode was logged in legitimately (its existing credential copied into the isolated home,
nothing minted), and **the product confirmed the login rather than the filesystem** — both the
harness detector and `machines.list` reported `state=in`, with the driver override unset.

    on the current release   session created on the OLD driver, native ref ses_fc14d404…,
                             codeword POD2858-REPLAY-OPENCODE-2A7M planted
    on the new build         listed and resumed it, REBOUND it to the server driver,
                             native ref CHANGED to ses_fc147aef…, exposed only a NEW
                             transcript, and never returned the planted codeword

**Same failure as Codex, different agent.** So this is not a Codex driver bug — **it is what
happens to any session that rebinds**, and the fix is therefore a design question rather than
a patch: either the driver becomes a durable property of the session, or the new driver adopts
the existing conversation instead of starting a fresh one.

**That raises the stakes on the recommendation.** With one case, "fix it" meant repairing one
driver. With two, it means deciding what a session's driver *is* — and that decision belongs to
you rather than to me. The options in decision 11 stand; the second and third now apply to
**every** agent a user has, not just Codex.


---

## 16. A hermetic rig cannot exercise the permission prompt on ANY of the three agents.
**Raised 2026-08-26 18:19 CEST. Status: OPEN. Three separate blocked checks with one underlying cause.**

Three different agents, three different reasons, same outcome — the permission prompt cannot be
driven in an isolated test home:

    claude     rewrites permissions.defaultMode from manual back to auto, or opens its own
               setup wizard regardless
    codex      raises no approval at all on this host — controlled against codex run OUTSIDE
               Podium with the same flag, so it is the harness and not us
    opencode   auto-approves under the terminal posture

Each was filed as its own BLOCKED cell, and each looks like an oversight in isolation. Together
they look like **a property of driving permission prompts in hermetic homes**, not three
accidents.

**What this costs:** the permission checks — the card appearing, and answering it twice — are
unmeasured on the terminal arm for every agent. The *server* arm is driven and passes.

- **Say it plainly in the release note** — the permission path was exercised on the server
  drivers and not on the terminal ones, with the reason, so a reader is not left assuming it was
  checked and passed.
- **Drive it once on a real, non-hermetic home** — yours. Closes all three at once, and is the
  same ask as decision 12.
- **Keep filing them separately** — I do not recommend this; three BLOCKED cells with three
  explanations hide a single pattern.

**Recommendation: name it as one residual, and if you are willing, one session on a real home
closes the whole class.**


---

## 17. Did we break interrupt on Claude? — as far as reading can settle it, NO.
**Answered 2026-08-26 19:31 CEST by a read-only audit. Status: OPEN only because it cannot be proven by driving.**

This was the last defect that could still have blocked the release on the agent people use
today, and it could not be driven at all: no baseline exists (today's release cannot start the
kind of instance the tests use) and Claude is quarantined. So it was traced statically instead,
file by file, against the current release.

**The audit refused the easy answer.** It found two places where *this epic* introduced an
acknowledge-without-stop mechanism — a server-driven interrupt branch that answers "requested"
once the request resolves, and a new SDK client whose interrupt is fire-and-forget with a
15-second kill timeout. Either could produce the reported symptom.

**But neither is on the path the failure actually took.** The observed failure went through the
terminal driver, returning "keystroke", and the write on that path is **unchanged from today's
release**. So the two new hazards are real and are *not* what was seen.

**And the acknowledge-without-stop shape is deliberate and documented**, not an oversight: the
code states plainly that `ok` means *the interrupt was requested*, never *the turn stopped*,
because nothing synchronous can honestly say the latter.

**Where that leaves it:** the failure is *most likely inherited*, and that cannot be proven
here. The honest verdict is what the audit gave — **possibly ours for the interrupt surface as
a whole, with A3-specific causation not demonstrated.**

- **Accept it as unproven-but-unlikely-ours**, and say so in the release note: interrupt on the
  incumbent driver was observed not stopping a turn within twenty seconds; the code path is
  unchanged from the current release; no comparison was obtainable.
- **Settle it with one session on a real Claude home** — the same ask as decisions 12 and 14,
  and it would close this too.

**Recommendation: accept and document, unless you are giving us a real home anyway.** The two
new hazards it found are worth their own attention regardless, and they are on the *server*
path where they CAN be driven.

## Decision 18 — the 80 red server tests are inherited, and that is now measured (2026-08-27 00:37 CEST)

**Supersedes the open half of Decision 15** (53 unattributed gate failures), which asked for one
lane run on the pre-merge parent and never got one.

**What I measured.** `PODIUM_TEST_WORKERS=1 bun run test:unit -- --filter @podium/server` on the
epic tip `0d00f6c34`, a tree that does **not** contain POD-2878's fix (`git cherry` confirms):

| package | epic tip (no fix) | POD-2878 reported (with fix) |
| --- | --- | --- |
| services | **34 failed** / 1822 passed | 34 |
| boundary | **45 failing** | 45 |
| normalized-wire | 8 passed | 8 passed |
| contracts | **1 failed** / 1303 passed | 1 |

**The counts match exactly in both failing packages, on a tree where the fix is absent.** So the
fix introduces no new failures there — if it had, its count would exceed the tip's. The failing
names are session-handoff and fleet-routing characterizations ("the row is re-homed onto the
target", "routes an explicit host id to the host daemon"), which is a different subsystem from
chat-send receipts.

**THE LIMIT OF THIS TEST, stated plainly:** it is ONE-SIDED. It can exonerate a change and cannot
convict one. It works here because the fix is absent from the tree I ran, so nothing in that run
can be its fault. It would NOT settle a case where the tip came back green.

**THE DECISION FOR THE OPERATOR.** These 79 tests have been red on this branch for days and every
session that meets them spends time deciding whether they are theirs. Three options:

1. **Accept and record them as a known baseline** — write the failing names into a checked-in
   file, and have the gate compare against it so a NEW failure is loud and these are silent.
   Cost: a session-day. Benefit: every future gate result becomes readable at a glance.
2. **Fix them.** Unknown cost — they are characterization tests over session handoff and fleet
   routing, subsystems this epic has been rewriting, so some fraction are *correctly* red and
   encode behaviour we deliberately changed.
3. **Leave as is.** Free, and it keeps costing every session that runs the gate the same hour it
   cost POD-2878 and then me.

**My recommendation is 1.** The value is not in the 79; it is in making the 80th visible. Right
now a real regression would arrive as "80 failures" against an expected "79" and nobody would see
it — which is exactly how this epic loses a defect. **I have not done it, because it is a
session-day of work and the epic's three open defects come first.**

## Decision 19 — this box cannot run four drive sessions and a neighbour's heavy gate (2026-08-27 01:52 CEST)

**Measured tonight, twice.** Root filesystem hit 100% at ~22:50 (375MB free) and again at 01:45
(1.5GB free). The first killed a live measurement mid-run with ENOSPC. The second was caught by
POD-2913 refusing to record a number through it.

**The arithmetic, which I got wrong once already tonight.** I reclaimed 38 finished worktrees and
took the disk to 17GB, then started three sessions and watched it fall back to 11GB — **a worktree
with its own `node_modules` costs 2–3GB.** Between 01:39 and 01:45 it went 12GB -> 1.5GB while
four of my sessions drove and a neighbour issue held `test:heavy` for memory-heavy cache work
(its caches ran 4.3GB each earlier in the night).

**So the ceiling is roughly three concurrent drive sessions, and fewer while a neighbour holds the
heavy lock.** Load and memory are NOT the constraint — both were comfortable at the moment the
disk filled. I reasoned from CPU headroom when I parallelised, and the headroom I was looking at
was the wrong resource.

**THE DECISION FOR THE OPERATOR.** Parallelism is what makes coverage move — 25 of 69 cells at 36%,
with 44 to go and grok's 16 unblocking at 11:03. Three options:

1. **Cap concurrency at three and accept the slower burn-down.** Free, immediate, and it is what I
   am doing tonight by default. Costs roughly a third of the throughput.
2. **Reclaim the 34 worktrees my sweep skipped for cause** — dirty trees and genuinely unlanded
   branches, some weeks old. Real space, but each needs three checks individually; it is a
   session's work, not a sweep, and some of that dirt is somebody's unlanded evidence.
3. **Give the box more disk**, if that is possible at all. The only option that raises the ceiling
   rather than rationing under it.

**My recommendation is 2 then 1**, in that order: recover the space first so that capping at three
is a choice rather than a floor. **I have not started it, because the epic's open defects and the
44 undriven cells come first and this is a session-day.**

**Related and not incidental:** POD-2916 (a queued message resurrects a stopped session and
recreates its worktree) means reclamation is not durable, so any space recovered under option 2
can quietly come back. That one should be fixed before a large reclamation, or the reclamation
gets done twice.

## Decision 20 — a possible claude A1a regression, not yet confirmed (2026-08-27 05:07 CEST)

**This is the first finding tonight shaped like "a driver is worse than it was", which is the epic's
entire bar. It is not confirmed and I am recording it before it is, because it outranks everything
else on the board if it holds.**

**What POD-2918 measured**, read from its worktree at 02:54:

    cell      A1a  (send while idle — reply arrives; bubble goes sent, never silent-settles)
    harness   claude
    verdict   FAIL      "one of the three idle sends did not land or reply"
    control   FIRED     "a prompt appearing as a durable user turn"
              detail    "1/2 user turns landed; last=fa..."

**The control fired**, so the rig was alive and a send still went missing. **And POD-2874 drove the
same cell to PASS** at pin `6c10b6643` — *"three idle sends landed and replied; the last send was
required to pass."*

**WHY I AM NOT CALLING IT A REGRESSION YET.** The same session recorded five BLOCKED attempts on
A1b with four distinct rig causes: `startup-race`, `source-drift`, `rig-refused` twice, and
`web-missing`. **A probe fighting startup timing is exactly the shape that manufactures a
real-looking lost send**, and *"1/2 user turns landed"* is consistent with both a product defect and
a send issued before the session was ready.

**The question that separates them, which I have put to it:** wait on the same readiness signal it
uses elsewhere before the first send, then re-run. **Send still missing with the session provably
ready → product. Send lands → the probe was racing and A1a is not a regression.**

**THE DECISION FOR THE OPERATOR, if it confirms:** claude A1a failing is a release blocker under the
stated bar — every driver at least as good as today's main — and it would be the only one. **If it
does not confirm, nothing changes.** Either way this should not be settled by argument: it is one
re-run with a readiness gate.

**A process note that is part of the finding.** That reading sat in an **untracked** directory for
two hours along with six others, the pins, and the drive script. **I only saw it because I read the
session's worktree directly instead of waiting for a report** — and this is the third time tonight
that has been how a result reached me. Told it to commit before anything else, and told it plainly
that a committed FAIL with an open question beats a fuller column I cannot trust.

## Decision 20 CLOSED — the claude A1a "regression" was a startup race (2026-08-27 05:33 CEST)

POD-2918 re-drove A1a with a readiness gate and it **PASSES with its control firing**. The earlier
FAIL — *"1/2 user turns landed"* — was its probe sending before the session was ready, exactly the
alternative I asked it to separate. **No regression. Nothing for the operator to decide.**

**The separation cost one re-run and would have cost a release decision if argued instead.** The
question that did it was concrete: *"can you distinguish 'the send was lost' from 'the send was made
before the session was ready'? Wait on the readiness signal and re-run."* **Neither of us had to be
right about which it was.**

## Decision 21 — claude A1c may be the new design rather than a regression (2026-08-27 05:33 CEST)

**POD-2918's A1c FAIL is the best-controlled reading in that column** — baseline prompt landed,
reply returned, exact child PID 1023334 identified and killed, then the send. Verdict:
**"dead-session send was accepted without a typed refusal."** POD-2874 had A1c **PASS** at the old
pin, so the shape is again a regression.

**BUT THE CRITERION PREDATES TONIGHT'S FIX.** A1c reads *"typed refusal or resume-and-send offered;
**never a lost message**"*. **`b1c725716` landed a few hours ago and deliberately changed exactly
this behaviour**: a send to a session that is not running now PERSISTS in a durable queue and
reports `queued` rather than being refused. POD-2878 drove it — parked nonce absent before, arriving
once after a real daemon restart.

**So "accepted without a typed refusal" may be the new design working.** A refusal loses nothing and
delivers nothing; an accepted-and-persisted send delivers when the session returns. **Against the
bar we are held to — every driver at least as good as main — the second is strictly better, and the
criterion's own final clause is satisfied by it.**

**THE ONE OBSERVATION THAT DECIDES IT, which I have asked for:** after the accepted send, resume the
session and look for the needle.
- **Needle arrives** → the product is better than the cell describes. Score PASS, and **the
  criterion needs changing** — that is the operator's call and I will bring it with evidence.
- **Needle never arrives** → it is a lost message, A1c is a genuine regression, and it is the
  release blocker I mistakenly thought A1a was.

**They are indistinguishable at the moment of the send and completely different a minute later.**

**THE STANDING QUESTION THIS RAISES, worth the operator's attention either way:** the acceptance
matrix was written before several of tonight's fixes. **A cell can now fail because the product
improved past its criterion.** A1c is the first clear instance; there may be others. **When a cell
and the product disagree, one of them is out of date, and it is not automatically the product.**

## Decision 22 — what the coverage number actually supports (2026-08-27 05:38 CEST)

**I have been reporting "38 of 69 cells current, 28 PASS" as though a PASS meant the criterion was
met. After POD-2919's scorer audit, that is not what it means, and the operator should have the
honest version before any release decision.**

**WHAT THE SCORERS DO CHECK, consistently and well:** the gross failure modes. Did the message
arrive at all. Did the session die. Did the badge move. Did the process tree survive a kill. Did
the conversation come back after a restart. **Every scorer audited has a real positive control and
refuses when it does not fire** — five sessions declined to record readings tonight rather than
report through a bad rig, and one withdrew a result it had already taken.

**WHAT THEY DO NOT CHECK, per cell, is now written down** in the SCORER AUDIT section of the ledger.
The pattern is that **the coarse clause is tested and the fine clause is not**:

    A1a  "reply arrives"          tested        "never silent-settles"        NOT tested
    A1b  "queued with position"   tested        "position visible after reload" NOT tested
    A1c  "not silently accepted"  tested        "never a lost message"        NOT tested
    A3   "phase stopped"          tested        "transcript shows interrupt"  IGNORED
    A6a  "bytes echoed"           tested        "resize refits, screens equal" NOT tested
    A9   "original PIDs gone"     tested        "no rebound, stamp proof"     NOT tested

**SO THE HONEST CLAIM IS: "no gross regression has been found in 38 of 69 cells."** It is NOT
"38 cells fully meet their criteria." **Those are different statements and only the first is
supported.**

**THIS DOES NOT INVALIDATE THE RELEASE BAR, and I want to be precise about why.** The bar is *every
driver at least as good as it is on today's main*. **A gross regression is exactly what that bar is
about**, and the scorers do detect those — the one product FAIL found tonight (opencode A9, an
orphaned process) was found by a scorer, and the claude A1a scare was correctly resolved to a
startup race. **The coarse clauses are the ones that carry the bar.** The fine clauses are the
difference between "as good as main" and "meets the acceptance criterion in full", which is a
higher standard the epic set for itself.

**THE DECISION FOR THE OPERATOR, when the columns finish:**

1. **Ship on "no gross regression", accept the fine clauses as untested, and record which.** Fast,
   honest if stated, and leaves a known gap list. **This is what the current evidence actually
   supports.**
2. **Tighten the scorers and re-drive.** POD-2919 is already doing this for A9 and it cost it
   under an hour for one cell. Across ~10 cells and 4 columns that is a session-day or two, and it
   would convert "no gross regression" into "criteria met".
3. **Tighten only where a fine clause protects something the operator cares about** — A1c's "never
   a lost message" and A9's rebound detection are the two I would pick, because both are silent
   failures a user would meet and neither is currently tested.

**My recommendation is 3, then 1.** The two clauses I named are the ones where the coarse test
passes and a user still loses something. Everything else on the list is a fidelity improvement
rather than a safety one, and can be recorded as a known gap without blocking.

## Decision 23 — THE release question: three claude FAILs with no main baseline (2026-08-27 06:32 CEST)

**Coverage is now 53/69 (77%) with three columns complete — claude 15/15, opencode 16/16, shell 6/6.
Eight cells are red. Five are instruments. Three are real, and all three are claude:**

    A1b  claude  FAIL   send while busy
    A1c  claude  FAIL   send to a dead session
    A3   claude  FAIL   interrupt mid-turn

**WHETHER THESE BLOCK THE RELEASE IS COMPLETELY UNDETERMINED, and one measurement would settle all
three.**

The bar is *every driver at least as good as it is on today's main*. **So a FAIL on the epic only
matters if the same cell PASSES on main.** And:

- **A1b on main: never attempted.**
- **A1c on main: never attempted.**
- **A3 on main: attempted three times, obtained zero times** — BLOCKED (bytes=0, no turn observed),
  UNOBTAINABLE (*"main cannot start a named instance"*), and REFUSED (control never produced an
  in-flight turn).

**POD-2874's readings are NOT a main baseline.** Its pin `6c10b6643` is on the epic branch, so its
matching A1b/A3 failures say these cells have failed consistently *on the epic*, not that they
failed before it.

### The baseline is obtainable and my own rule is why nobody has taken it

That `UNOBTAINABLE — main cannot start a named instance` is now fully explained: **main predates
`ab9d698ab`, so it cannot start a NAMED instance at all** — ~113 bytes of `sun_path` against a
108-byte limit. **The DEFAULT instance fits at 71 and works.**

**I told every session to run as a named instance, and that rule is what made a main baseline look
impossible.** It exists to stop sessions colliding, not for correctness, and it inverts on
pre-socket-fix commits. I believed the opposite for six hours and reported the claude column as
needing the operator on the strength of it.

### What this costs and what it decides

**Cost:** a main checkout, the default instance (exclusive, one at a time), a live claude
credential, and three cells. Perhaps ninety minutes.

**Decides:** whether the epic ships. If all three PASS on main, they are regressions and the epic
is blocked on three defects. If they FAIL on main too, they are inherited, the epic is *at least as
good as main* on every measured cell, and the release bar is met.

**There is no cheaper way to know**, and no amount of further driving on the epic branch answers it.

**MY RECOMMENDATION: this is the single highest-value work remaining and it should be next.** The
credential runs to 07:43 and the default instance is free. I am not starting it in the current
window — POD-2918's hard stop is 07:00 and a rushed baseline is worse than none — but it is first
in the queue after, ahead of grok's 11:03 cells, because grok adds coverage while this decides
whether the coverage means the epic can ship.

## Decision 21 RESOLVED — claude A1c is a genuine lost message (2026-08-27 06:52 CEST)

I asked whether the dead-session send being *"accepted without a typed refusal"* was a regression or
the new design working, since `b1c725716` deliberately made non-running sends persist and report
`queued` rather than refuse. **The separating observation was: does the needle arrive after resume?**

**POD-2918 ran it. It does not.**

    killed exact Claude child 1186968 (proved alive first)
    send returned queued=true
    session then: status=exited, resume=null
    no assistant needle for 120.036s

**The send was accepted, reported queued, and delivered nowhere — because the session had no resume
path.** That is not the persistence feature working; **it is a message queued against a session that
can never come back.**

**AND IT IS ARGUABLY WORSE THAN A REFUSAL.** A typed refusal loses the message but tells the user.
**This tells the user `queued` and then silently never delivers** — the exact "silent settle" shape
the matrix warns about in A1a's criterion. **A user cannot tell this apart from a slow reply.**

**So A1c is a real defect on the epic.** Whether it BLOCKS the release still depends on the main
baseline — POD-2921 is running it now — but this is no longer a question about the criterion being
out of date. **The criterion was right and the product is wrong.**

**What this changes for POD-2921: A1c is now the most important of its three cells.** A1b and A3
failed for POD-2874 too, so they have at least a consistency story. **A1c is a confirmed
user-visible loss, and only main tells us whether it is new.**

## Decision 23, first answer — A1b is INHERITED, not a regression (2026-08-27 07:32 CEST)

**claude A1b on MAIN: FAIL. The epic: FAIL. Same behaviour, so the epic is not worse than main on
this cell.** One of the three release questions is closed.

    main 0bd90092c   second send returned {ok:true, disposition:"delivered"}
                     no `queued` flag, no numeric position; terminal said only "queued messages"
    epic             same shape — PARTIAL/FAIL for the missing position, on codex and opencode too

**So the queue-position gap is not something this epic introduced.** POD-2920 is fixing it anyway
and that remains worth doing — but **it is an improvement over main, not a regression from it, and
it does not block the release.**

**THE MEASUREMENT IS TRUSTWORTHY FOR A REASON WORTH RECORDING.** The shared phase observer reported
`idle` throughout a long turn on main — the same unreliable field that has misled this epic all
night. POD-2921 did not use it. It built an **independent busy-proof**: terminal output growing
2,375 bytes in the one-second interval immediately before the second send, while the first turn was
visibly at numbers 156–159 of a count-to-160. **It then retained the observer's contradicting
reading as a blocked attempt rather than deleting it.**

**It also refused to touch the operator's live default state.** I told it to take the default
instance; it built an ISOLATED default-ID rig at `/tmp/pod-2921` with its own state, home and
loopback ports, because systemd has real operator sessions on the installed default daemon. **The
short socket path was what it needed, not the operator's daemon** — a distinction I did not draw and
should have.

**REMAINING: A1c and A3.** A1c is next and is the one that matters — the epic side is a confirmed
lost message, so if main loses it too, all three claude reds are inherited and the bar is met. A3
stays undriven for now: the credential expires at 07:43 and a rushed reading on the cell where haste
flatters the answer is worse than none.

## Decision 23 ANSWERED — two of three claude reds are INHERITED, one undriven (2026-08-27 07:50 CEST)

**The measurement the release was waiting on is done.** POD-2921 drove the three cells on main
`0bd90092c` from an isolated default-ID rig, leaving the operator's live default daemon untouched.

    cell   epic    MAIN    verdict
    A1b    FAIL    FAIL    INHERITED — no numeric queue position on either side
    A1c    FAIL    FAIL    INHERITED — dead-session send accepted, no typed refusal, on either side
    A3     FAIL    UNDRIVEN — the load gate was clear at 5.26, but the bounded probe hit the
                             07:35 credential cutoff before its positive control produced a reading

**SO: NO CONFIRMED REGRESSION EXISTS ANYWHERE IN THE MATRIX.** Fifty-three cells have current
readings across three complete columns, and every red is either an instrument or a behaviour main
shares.

**A1c is the important one.** It is a genuine user-visible defect — the send is accepted, reported
`queued`, and never delivered because the session has no resume path — and **main does exactly the
same thing.** Its control was as strong as the epic-side one: exact live child PID 1255774
SIGKILLed and confirmed gone before the send, positive baseline control fired. **The defect is real
and it is not ours.**

**A3 IS THE ONLY CELL THAT COULD STILL BE A REGRESSION**, and it is undriven rather than failing.
The session had good conditions — load 5.26, well under the ceiling — and stopped anyway because
the credential window closed before its control fired. **That was the correct trade and I told it
to make it: a rushed reading on the cell where haste flatters the answer is worse than none.**

**IT COSTS ONE MORE WINDOW, AND THE WINDOW IS FREE.** The token refreshes itself; a later session
takes a fresh copy and drives one cell. No operator action is needed.

**WHAT THIS MEANS FOR THE RELEASE.** Against the stated bar — every driver at least as good as it
is on today's main — **the epic currently meets it on every measured cell.** The qualification from
Decision 22 still applies: that is *no gross regression found*, not *every criterion met in full*.
The three claude reds are real defects that predate this work, and POD-2920's queue-position fix
will make one of them better than main rather than equal to it.

**TEARDOWN VERIFIED.** All rig processes, worktrees and credential copies removed; `instance:default`
free; the operator's credential mtime unchanged at 23:43:12 through the entire run.

## Decision 24 — A3 IS A CONFIRMED REGRESSION AND IT BLOCKS THE RELEASE (2026-08-27 08:54 CEST)

**This reverses the position I recorded an hour ago. There IS a confirmed regression, and it is the
one cell that was still open.**

    A3 interrupt mid-turn    MAIN 0bd90092c   PASS — stopped, and the transcript marked it
    A3 interrupt mid-turn    EPIC             FAIL — interrupt returned without a stopping record

**Main works. The epic does not. That is worse-than-main on a Tier-A cell, which is exactly the bar
this epic is held to.**

**THE MAIN READING IS AIRTIGHT AND THAT MATTERS, because A3 is the cell where a bad rig flatters
the answer.** POD-2921 established the turn was genuinely in flight before interrupting:

    load 5.92 — under the ceiling, so no starved-host artefact
    durable user control fired
    independent PTY growth 7,836 -> 16,023 bytes, with a VISIBLE count progressing 1 / 2 / 3
    sessions.interrupt returned ok:true
    one residual second of 2,903 bytes, then 19 CONSECUTIVE ZERO-GROWTH SAMPLES
    transcript contains "[Request interrupted by user]"
    typedRefusal false — so it was scored on the acted-on path: stop PLUS transcript marker

**It did not use the phase observer**, which reported `idle` through a live turn on main earlier
tonight. **Both clauses of the criterion were met independently.** This is not a marginal PASS.

**WHY THIS TOOK ALL NIGHT TO GET, and why the earlier attempts are not evidence against it:** three
prior attempts at this baseline recorded BLOCKED (`bytes=0`), UNOBTAINABLE (*"main cannot start a
named instance"*), and REFUSED (control never fired). **Every one of those was a rig failure, not a
reading** — and the UNOBTAINABLE was caused by my own standing rule, since main predates the socket
fix and cannot start a NAMED instance while the DEFAULT instance fits.

**WHAT IT MEANS.** A1b and A1c remain INHERITED — they fail identically on main. **A3 is the sole
blocker.** The epic cannot ship as *"every driver at least as good as today's main"* until interrupt
on claude stops the turn and records it, because on main it does both.

**IT IS FIXABLE, NOT A DESIGN CONSEQUENCE.** The epic-side reading is *"interrupt returned without a
stopping record"* — the call succeeds and the turn continues. That is a defect in the interrupt path
for the claude driver, not a property of the new runtime. **It needs an owner: one issue, a pre-fix
control that already exists on both sides, and a drive.**

**THE NEXT COORDINATOR SHOULD MAKE THIS THE FIRST THING THEY STAFF**, ahead of grok's fourteen
cells. Grok adds coverage; this decides whether the epic ships.

## Decision 25 — A3 PASSES ON THE CURRENT TIP; DECISION 24 NO LONGER BLOCKS (2026-08-27 10:22 CEST)

**The required current-tip reproduction did not reproduce Decision 24's blocker.** POD-2924 drove
Claude A3 on exact product tip `a010e6b88198bc8672e1c3292de554b35edcdcba` and obtained a PASS on
both acted-on clauses:

    load 8.66 — below the strict load1 < 12 ceiling
    durable user marker fired
    PTY grew 7,029 -> 11,569 bytes with visible line 1 before interrupt
    sessions.interrupt returned {ok:true, requested:"keystroke"}
    one residual 529-byte sample, then 19 consecutive zero-growth samples
    visible count did not advance after interrupt
    transcript contained "[Request interrupted by user]"
    typed refusal false — the turn stopped and the marker was present

The server and daemon spawn pins were both the full current SHA. The reused web bundle retained its
real `sourceSha=fb67ef2`; its `apps/web` tree was byte-identical to the runtime pin and the served
stamp matched the HTTP response. The named rig was isolated, `/` had 14 GB free, and its credential
copy and processes were removed after the reading. Evidence is committed and landed at
`c84ecdc7f`; the operator Claude credential mtime remained `2026-08-27 07:49:09.743996798 +0200`.

**This supersedes Decision 24's CURRENT blocker classification, not its historical measurement.**
The earlier epic FAIL at `40c198eae` remains a valid reading for that older pin, and main's PASS at
`0bd90092c` remains valid. Product code changed between `40c198eae` and `a010e6b88`, including
daemon/session lifecycle paths, so the older FAIL is stale for the current product tree. The issue
brief explicitly required the owner to stop if the pre-fix failure did not reproduce; no speculative
fix and no artificial second arm were made.

**Release consequence:** there is no current confirmed worse-than-main Tier-A cell. Coverage stays
56/69 because this replaces an older A3 reading rather than adding a cell. Decision 22 still limits
the supported claim to the clauses actually scored, and the queue-position, A1c/A9 scorer, and Grok
work still must finish before the final release decision.

## Decision 26 — Claude subscription OAuth on the Agent SDK is allowed (2026-08-28 11:44 CEST)

**Status: AUTHORIZED.** Operator ruling, recorded for the coordinator and future agents.
Canonical text: `docs/architecture/claude-subscription-oauth-policy.md`.

The persistent Claude Agent SDK path may use the managed subscription credential under an
explicit acknowledgement during rollout. Claude headless is first-class / high-priority.
PTY (`claude-pty`) is the permanent fallback. Anthropic subscription tokens in *third-party*
tools (opencode, etc.) remain ToS-prohibited.

This does **not** lift Decision 14's credential-safety boundary: do not mint, rotate, or
present a superseded refresh token from a rig home. Copying an existing unexpired credential
and confirming the product sees it is still the allowed setup.

**What happens either way is now settled:**
- Coordinator and later agents treat Claude SDK cells as in-scope high-priority work, not
  "terminal-only / no testing burden."
- Historical evidence, `results.tsv`, and audit-time SA4/LD8 classifications stay historical.
- The Claude manifest now declares subscription for the embedded auth list. Any stale source
  comment elsewhere is implementation drift, not a policy veto or an acceptance result.

## Decision 27 — the matrix had a silent parse fault, and A4 is an instrument story (2026-08-28 13:09 CEST)

**Two things, both of which change what the coverage number means.**

**1. Nineteen rows were shifted by one column and no validator could see it.**
They carried a ninth field — a `detail` column inserted after `verdict` —
pushing commit/control/alone/date/issue one place right. Any reader indexing
by position read the rig-notes column as the date. Mine did, and produced a
phantom `A3 claude FAIL` that contradicted Decision 25. **The validator I wrote
into the standing brief was `NF<8`, which can only catch too-few fields.** It
was structurally incapable of detecting the fault that actually occurred — a
check that could not fail in the direction that mattered. Now `NF!=8`.
Realigned without losing a character: 337 lines before and after, and a
separator-stripped diff is empty. Corrected position: **69/69 driven, 52 PASS,
17 not-PASS** — and A3/claude is correctly a PASS, as Decision 25 said.

**2. The six A4a/A4b BLOCKED cells are vendor-instrument blocks, not
regressions.** claude-code 2.1.231 rewrites `permissions.defaultMode`
manual-to-auto so an ask can never fire; opencode auto-approves; codex
auto-answers under `approvals_reviewer=auto_review`. **These cells are
undriveable on BOTH arms, so they cannot be worse than main** — but
undriveable is NOT a pass, and they must never be counted as one. They are a
declared measurement gap.

POD-3027 broke part of that open for codex by giving the probe a dummy
never-approved cwd and setting an isolated `approvals_reviewer=user` restored
on exit — the same posture A4 already uses for opencode's `permission.bash=ask`.
You cannot measure asking without configuring the agent to ask. Result:
**A4b codex PASS** (allow-once acted exactly once; the second answer was a
typed `already-answered` refusal, not a double action) and **A4a codex
PARTIAL** — the chat plane enumerated the ask, the terminal plane showed
0 native bytes before answering and still looked to be prompting after, so
"answering resolves both planes" is unmet.

*Note against myself:* I read A4a as a PASS from that session's bullet list and
was about to record it that way; its own verdict line said PARTIAL. **The
bullets described one plane, the verdict scored both.** Read to the verdict.

**The same dummy-cwd probe should now be pointed at grok, and the claude
`defaultMode` rewrite is worth one attempt at a version pin** — those are the
next A4 moves, not a rewrite of the harness.

## Decision 28 — a probe that prints PASS while a clause is unmeasured (2026-08-28 14:05 CEST)

POD-3038 re-drove the four stale pins. The headline is not any single cell, it
is this: **the A6b probe printed an aggregate `A6b PASS` for codex while its own
output said the no-scrollback-corruption clause was never measured.** The cell
had been sitting in the matrix as a PASS on that basis. It is now PARTIAL.

That is a *downgrade in recorded status and an upgrade in knowledge*, and it is
the same defect shape as the `NF<8` validator from Decision 27: **an instrument
that can only report success is not reporting.** Anywhere the A6b probe's
aggregate line was trusted, the cell is suspect until someone reads the clause
list underneath it. Score against every clause; never against the summary line.

Results, all four transcribed at the drive's own verdicts:

| cell | was | now |
| --- | --- | --- |
| A6b codex | PASS (aggregate) | **PARTIAL** — scrollback clause unmeasured |
| A6b opencode | UNMEASURED | **FAIL** — chat plane passed, CLI plane failed after the switches |
| A3 codex | REFUSED | **PARTIAL** — turn stopped, transcript marker absent |
| A8 opencode | PARTIAL | PARTIAL, better characterised |

**Neither the A6b/opencode FAIL nor the A3/codex PARTIAL is called a
regression**, because all four main comparators were discarded: every one died
with `abduco create-session: File name too long` before binding a driver. The
drive was right to discard them — a comparator whose control never fired is not
a baseline — and right to refuse a worse-than-main claim without one.

**That gap is mine.** It is the 108-byte `sun_path` limit: a named instance needs
~113 bytes, the default fits at 71. My own handover documents it under a heading
I wrote, *"A pre-fix parent arm may need the DEFAULT instance"*, and the brief I
then handed POD-3038 ended with **"Take the named instance, not the default."**
The brief's general no-override rule now carries the exception explicitly,
because the rule is right for an epic arm and wrong for a main arm and it never
said so. POD-3042 re-runs the two baselines on the default instance under the
`instance:default` lock.

## Decision 29 — the matrix conflated a new driver with the shipping one (2026-08-28 14:52 CEST)

**A column of this matrix is an AGENT, but an agent now has more than one
driver, and scoring "newest row wins" silently let a new driver overwrite the
shipping one.** `claude-sdk` is mid-bring-up under POD-3036. `claude-pty` is
what ships today. On A3 they disagree: claude-pty PASSES (2026-08-27, Decision
25), claude-sdk FAILS (2026-08-28). Taking the newest across both reported a
catastrophic Claude regression **that does not exist**, and would have
re-declared the blocker Decision 25 retired.

**Rule: the release bar is the SHIPPING drivers.** `claude-sdk` is scored as its
own separate bring-up (14 cells: 8 PASS, 3 FAIL, 3 BLOCKED) and is NOT part of
the "at least as good as main" number. Corrected position on the shipping
drivers: **70/70 driven, 55 PASS, 6 FAIL, 6 PARTIAL, 3 BLOCKED.**

The denominator also moved 69 → 70: **A10/claude is no longer n/a.** The SDK
driver gives claude a driver identity distinct from the PTY path, so the cell
became meaningful and POD-3036 drove it on both. A matrix's n/a set is not
constant — new work can make a dead cell live.

### And the A1c cluster is not what I said it was

I briefed POD-3044 that A1c fails on claude/codex/grok and passes on opencode,
so copy opencode. **That was wrong, and wrong the same way.** Newest row per
DRIVER:

| driver | A1c |
| --- | --- |
| codex-app-server, opencode-server, grok-acp | **FAIL** |
| codex-headless, opencode-headless, shell-native | **PASS** |
| claude-pty | FAIL |
| **claude-pty-on-main** | **FAIL** |

**The split is by driver FAMILY, not by agent.** Every server-family driver
fails; headless and native pass. I quoted the opencode-*headless* row as if it
were opencode's verdict — the same overclaim the A6b probe made in Decision 28,
committed by me, into a brief a session was already acting on.

**And a main baseline already existed and I missed it:** `claude-pty-on-main`
FAILS A1c. So on claude this is a longstanding gap, **not a regression**, and it
does not block on the "at least as good as main" bar. Whether the *server-family*
failure is a regression is genuinely open, because those drivers are new here and
main may have no comparable arm — and **absence of a main row is not a passing
main.** Both sessions corrected in flight.

**Three of my last four errors are one error:** a classifier looser than the
thing classified (`NF<8`), a summary trusted over its clauses (A6b), and now a
column that silently merged two drivers. **Before quoting a number, ask what it
is grouping and whether every member of that group is the same thing.**

## Decision 30 — the first worse-than-main candidate, and what "same as main" means (2026-08-28 14:59 CEST)

POD-3042 drove the two missing baselines on the DEFAULT instance and both
answers turn on the same fact: **main has neither an `opencode-server` nor a
`codex-app-server` driver.** Those drivers are new in this epic, so an exact
same-driver comparator cannot exist. The drive was right to say so rather than
manufacture one.

**A3 / codex — SETTLED, NOT A REGRESSION.** Main's legacy generic-PTY route
accepts the interrupt, stops output, ends at `idle.interrupted`, and shows **no
`event:'interrupt'` transcript marker** — the identical gap the epic shows. The
epic's PARTIAL is pre-existing behaviour, not something we broke.

**A6b / opencode — THE FIRST GENUINE WORSE-THAN-MAIN CANDIDATE.** Main's legacy
PTY route PASSED chat-CLI switching, no-restart, correct size, and both
post-switch actions. The epic's `opencode-server` FAILS the CLI plane after the
switches. Not an exact same-driver regression — but that framing is the trap.

**A user does not experience a driver, they experience OpenCode.** On main,
switching between chat and CLI on OpenCode worked. On the epic it does not.
That the two runs went through different drivers is an implementation detail of
ours, and "we replaced the driver underneath you" is not a defence a user can
use. **The whole point of this epic is to REPLACE the headed drivers; if the
replacement is worse at the provider level, it has failed at exactly the thing
it exists to do.**

**So I am scoring this as a release blocker on the provider-level reading**, and
POD-3045 owns the fix (I originally filed a duplicate, POD-3046, and closed it). If the operator wants the stricter same-driver reading
instead — under which this is not a blocker because main has no comparator —
that is their call to make and it flips this one cell. I am flagging it rather
than deciding it silently, but I am not going to sit on it in the meantime.

**A caution for every remaining server-family cell:** the same "main has no such
driver" answer will recur for codex-app-server, opencode-server and grok-acp.
The comparator that matters there is **what the provider did on main by whatever
route it took**, not what the identical driver did — because the identical
driver never existed.

## Decision 31 — A6b/OpenCode is per-harness, and my evidence pairing was not a control (2026-08-28 16:13 CEST)

**Two corrections, both mine, both from POD-3045, both verified against our own
files before acceptance.**

**1. There is no shared server-family switch bug.** I claimed one because
POD-3045's diff touches `codex.ts` and `grok.ts`. It touches them because the
new declaration is **required** on `ClientTerminalSpec`, so every harness must
answer it — codex and grok answer `false`, which is today's behaviour, byte-for-
byte unchanged. And our own `docs/evidence/pod-3038/README.md` scores A6b/codex
**`CLI still echoes after switching | true, +11109 bytes | PASS`**. Codex
cold-starts its TUI on the same shared path and echoes fine. That is the control
that kills the theory, and it was already in the matrix when I asserted the
opposite.

**The actual defect: `opencode` 1.18.16 discards stdin part-way through its own
startup** — echo at 0/300/800ms, none at 1200/1500/2000ms, back at 6000ms. The
shared close/recreate is the **amplifier**, re-entering that window on every
switch; it is not the cause. Hence a per-harness declaration rather than a change
to the shared mechanism. POD-3045 also ruled out the attach-readiness discard
branch POD-3046 proposed: an abduco client PTY is up in 40–71ms and echoes
immediately, so at the probe's 1500ms it is never reached. Whether codex's or
grok's TUIs eat early stdin is **unmeasured and not claimed**.

**2. Epic-FAIL vs main-PASS is NOT a patch-level control, and I offered it as
one.** I handed POD-3045 our epic failure and main baseline as its
failing-without / passing-with pairing. Main has no `opencode-server` driver at
all, so that pairing shows **the feature is new-and-broken** — it says nothing
about whether *this commit* fixes it. Those are different claims and only the
second reviews the patch. **I substituted a cell-level regression argument for a
patch-level control, which is exactly what the bar exists to prevent.** POD-3045
refused the substitution and asked for the instance drive instead. Authorised:
named instance, pinned to `b5a3aa870`, canonical A6b, control fired, every clause
scored, PARTIAL if scrollback stays unmeasured.

**The recurring error, now four for four today:** I reasoned from a proxy — the
files a diff touched — instead of the mechanism, while the per-clause reading
that refuted me sat in the matrix I maintain. `NF<8`; the A6b aggregate; the
merged claude column; and now a diff's file list. **Every one produced a
confident wrong claim rather than an error.**

POD-3044 corrected too: its A1c pattern stands on its own evidence, but A6b is
**not** corroboration for it and must not be used as such.

## Decision 31a — the blocker fix landed before its verification, by accident (2026-08-28 16:15 CEST)

`b5a3aa870` — POD-3045's park fix — **is the parent of the current epic tip.**
It committed onto the shared epic branch and I committed Decision 31 on top of
it without noticing. Nobody merged it deliberately. POD-3045 believed it was
unlanded and said so in good faith; from its side that was true.

**Consequence: the drive I authorised is now a post-landing verification, and
the stakes invert.** A failing drive no longer means "do not land" — it means
**revert `b5a3aa870`**. I have told POD-3045 exactly that, including the warning
that a fix already in the tree exerts pressure to turn verification into a
rubber stamp.

**The matrix still records A6b/opencode as FAIL at pin 5fe951f2f**, which is the
last real reading and a pre-fix one. **I will not record a PASS on the strength
of a landed diff.** Until the drive reports, the epic carries a fix whose only
evidence is at the boundary — an honest state, and better than pretending
otherwise.

**Standing risk on this epic:** sessions commit directly to the shared epic
branch, so "unlanded" as reported by a child is not reliable, and my own commits
can silently ratify someone else's. Before believing anything is unlanded:
`git log --oneline -4 issue/1761-agent-runtime` and look at what your own tip's
parent actually is.

## Decision 32 — a transcript-read bug may have manufactured our "no marker" cells (2026-08-28 17:09 CEST)

POD-3059 landed `ccdea1f93`. Its own completion note says **"post-fix Claude
acceptance re-drive remains required before release evidence is final"**, and it
is right, but the implication is wider than Claude.

**The bug:** on a **named instance**, the headless child wrote its JSONL under
the operator account home while the transcript reader resolved it under
`<state>/<instance>/agent-home`, so **every `sessions.read` came back empty**.
Fixed in `durable-headless.ts` and `headless-drivers.ts` — the shared headless
path (`claude-sdk`, `codex-json`, `resume-exec`).

**Why this matters to the matrix: every acceptance drive on this epic uses a
NAMED instance. That is my own standing rule.** So any cell scored on "was the
marker in the transcript" before `ccdea1f93` was asking a reader that may have
been structurally incapable of returning anything.

**The suspect cells all share one sentence — "turn stopped, but no transcript
interrupt marker":**

| cell | driver | pin | issue |
| --- | --- | --- | --- |
| A3 | codex-app-server | `5fe951f2f` | POD-3038 |
| A3 | opencode-server | — | POD-2919 |
| A3 | claude-sdk | `c71b896a9` | POD-3036 |

**THE DIRECTION IS ONE-WAY AND THAT IS THE SAVING GRACE.** An empty read can
only make a cell look WORSE — a false FAIL or PARTIAL. It cannot manufacture a
PASS. **So no passing cell is at risk and the release bar cannot be flattered by
this.** Only the reds need re-reading.

**WHAT I AM NOT CLAIMING.** I do not know that `codex-app-server` travels the
patched path. The fix names the headless family, and `codex-app-server` is a
*server* driver; the A3/codex PARTIAL may be a genuine product gap that survives
the re-drive. **This is a hypothesis with a clear test, not a finding**, and the
re-drive is how it gets settled. POD-3065 owns it (I first wrote POD-3064 here, which is an unrelated mobile bootstrap issue -- my third wrong ref today).

Also worth noting against myself: POD-3042's main baseline saw the same missing
marker on the DEFAULT instance, which is *not* obviously affected. If the
re-drive clears the epic cells but main still shows no marker, that inverts the
A3 story rather than closing it.

## Decision 33 — the release blocker is cleared (2026-08-28 17:12 CEST)

POD-3060 drove A6b/opencode-server live on a named instance at pin
`22ac634ec`, as a **post-landing verification** of `b5a3aa870`, with the
positive control fired before any switch.

**The defining clause passes.** *CLI still echoes after switching* — nonce
echoed, **+87,847 terminal bytes** — against a pre-fix reading at `5fe951f2f`
that FAILED after both switches. Every other measurable clause also passes:
both directions twice, no restart (epoch `0`, agent-process census unchanged),
correct size (`120x40` throughout), chat still answers.

**`b5a3aa870` stays. No revert.**

**The cell is PARTIAL, not PASS**, for exactly one reason: no-scrollback-
corruption is not measurable by the probe. **The session refused the probe's
aggregate `A6b PASS` rather than promote it** — Decision 28 applied by the
session itself, unprompted, on the cell where promoting it would have been most
convenient for everyone including me.

**Why PARTIAL still clears the blocker.** Main's own baseline for this cell is
**also PARTIAL, with the SAME clause unmeasured** and everything else passing
(POD-3042, default instance, fired control). The bar is *"at least as good as
main"*, not *"green"*. **Epic and main are now at parity on A6b/opencode, so it
is no longer worse than main.**

**There is now no Tier-A cell known to be worse than main on the shipping
drivers.** That is the condition this epic exists to reach. It is not the same
as "done" — six cells still FAIL, six are PARTIAL, three are BLOCKED, and
Decision 32's re-read of the no-marker cells is still in flight — but none of
them is a regression against the thing they would replace.

**The interpretation question from Decision 30 is now moot in practice.** I
scored this cell a blocker on the provider-level reading; under the stricter
same-driver reading it was never a blocker because main has no
`opencode-server`. Both readings now agree it is not one. **The provider-level
reading is what caused it to be fixed**, and I would make the same call again.

### Decision 33a — correcting my own clean bill (2026-08-28 17:14 CEST)

I wrote in Decision 33 that **"there is now no Tier-A cell known to be worse
than main on the shipping drivers."** I was one command from announcing that
with an unexamined FAIL sitting in the table.

**A1a/claude-pty had gone PASS (2026-08-27, credentialed) → FAIL (2026-08-28,
POD-3036), with no main arm at all** — and absence of a main row is not a
passing main, which is my own rule from earlier today. Reading the row instead
of the summary: `isolatedCred=absent`, `no-copy`, control `user=1 assistant=0`.
The send landed; no assistant reply. POD-3047's evidence states outright that
**the isolated home is logged out by design**, so every PTY cell needing a model
reply is blocked on authentication. **A condition never validly created, not a
product failure** — the identical correction I had already taken from POD-3047
over POD-3036 on A8, now applied consistently instead of only where I noticed.

**Corrected position: 70/70 — 55 PASS, 7 PARTIAL, 4 FAIL, 4 BLOCKED.**

**The four FAILs are one defect**, A1c *send to a dead session*, on claude,
codex, grok and opencode. POD-3044 owns it. And the honest status of the
"worse than main" claim, cell by cell:

- **A1c/claude — NOT a regression.** `claude-pty-on-main` also FAILs: *accepted
  after child death*. Longstanding gap.
- **A1c/codex, grok, opencode — UNESTABLISHED.** These are server-family drivers
  main does not have, so there is no exact comparator, and per Decision 30 the
  comparison that matters is what the **provider** did on main by whatever route
  it took. **Nobody has measured that.** Absence of a main row is not a passing
  main.

**So the correct claim is narrower than Decision 33's:** the A6b blocker is
cleared and epic/main are at parity there; no cell is *known* to be worse than
main; and **three cells have no main comparison at all and cannot yet be called
either way.** That is a materially weaker statement and it is the true one.

## Decision 34 — POD-3059's fix does not fix it, and my passing cell proved it (2026-08-28 17:42 CEST)

POD-3047 pinned down the question I asked it and the answer is worse than the
question. **`ccdea1f93` does NOT fix the home split for `claude-sdk`.**

**First, why its A3 PASS was never evidence of immunity.** The durability clause
does not use `sessions.read` at all — it opens a **fresh websocket attach** and
scores the replayed items on `chat.items`
(`docs/evidence/pod-3047/drive.ts:848-851`). `sessions.read` is fetched in the
same function but only **reported alongside, never scored**. So *"present in a
viewer opened after the first was dropped"* means **the server replayed it to a
new subscriber**, not that the workdir-keyed JSONL resolver found it.

**The same measurement carries both numbers**, from `readings/claude-sdk.a3.json`:

| quantity | value |
| --- | --- |
| stream stop records via the fresh Chat | **1** |
| `sessions.read` items at that same moment | **0** |
| durable clause | true |

**One record on the stream and zero on the read, within one function call,
milliseconds apart.** (POD-3047's own correction to my first wording: `interruptRecords`
reads `chat.items` synchronously from memory and then *awaits* `transcript(sid)` over the
network, so the two numbers are adjacent, not simultaneous. Nothing writes a record in that
gap and the stream count was already 1 before the read returned 0 — but "same instant" is a
stronger word than the instrument earns.) The
SDK path *was* affected — the bug is visible **inside a passing cell**, on the
plane I predicted, at the same instant.

**So do not read its ten PASSes as evidence the SDK path escaped.** Read them as
evidence that the interrupt record lives on a plane the resolver never touches.
Different claims; only the second is supported.

**And the fix has not reached it.** POD-3047 re-drove at `90ebca7d9`, which I
confirmed **contains `ccdea1f93`** (one docs commit ahead). `sessions.read` is
**still empty**. Three measurements: the `claude-sdk-host` child runs with
`HOME=/home/mgw` read from `/proc` on a named instance; the JSONL lands in the
operator home while the instance agent home has **no `projects` directory at
all**; and `sessions.read` returns `items: []` on a session whose reply had just
arrived on the stream.

**POD-3059's fix does not reach this path, which is narrower than saying it
failed.** What it closed is the DURABLE HEADLESS spawn, and it closed it. The
in-process `claude-sdk` child is a SECOND spawn site — `claude-sdk-client.ts`
`spawnDefaultHost`, over the two-argument `headlessChildEnv` with the
interactive frame's `env`, which names no home — so POD-3059's overlay builder
is never reached from there. Two spawn sites, one class of defect, one of them
fixed. **POD-3057 owns this one** (see Decision 36). This does not move the
release bar — `claude-sdk` is not on it — but it does mean Decision 32's
re-read premise is wrong for the SDK column, and POD-3065 has been told
directly.

*Wrong refs of the day, all mine:* Decision 32 said POD-3064 owned the re-read
(**POD-3064 is an unrelated mobile bootstrap issue**; the right one is
POD-3065), and this decision first said POD-3066 owned the SDK home split
(**POD-3066 is 'Bug: NUL byte hides a script from grep'**; the right one is
POD-3057, which raised the correction — and it was lost once already, in a
rebase that resolved this file in favour of the other side). Both corrected in
place. Four times now I have written a ref that pointed at a real, unrelated,
active issue — the failure mode where nothing looks broken from either end.

## Decision 35 — my Decision 32 hypothesis is REFUTED, and that is the useful answer (2026-08-28 17:44 CEST)

POD-3065 re-drove all three suspect cells at `f76f698ce` on named instance
`p3065x` with fired positive controls. **Every prior verdict stands:** A3/codex
PARTIAL, A3/opencode PARTIAL, A5/grok FAIL. *"Same substantive result as the old
PARTIAL; no improvement."*

**The refutation is clean because of HOW it read.** I feared the cells were
scored against a reader structurally incapable of answering. They were not:
**items were enumerated and none carried `event:'interrupt'`**, and grok's
transcript was explicitly *non-empty* with a tool item present. A reader that
returns content is not the empty reader of Decision 32. **The home-split bug did
not manufacture these cells.**

**What is actually true is narrower and more useful.** On both server-family
drivers the interrupt genuinely works — accepted with
`{ok:true,requested:"protocol"}`, turn leaves `working` in 524ms and 14ms, zero
terminal bytes at the call and none after 6s and 12s. **Four of five clauses
pass. The product stops the turn and never writes a transcript record of having
done so.** That is a real, narrow gap, not a broken interrupt.

**And it is not a regression.** POD-3042's main baseline shows main's legacy PTY
route with the *same* missing marker. Longstanding on both sides.

**Two lessons I am keeping.** First, a hypothesis that would have excused four
red cells was worth testing precisely *because* it was convenient — and it was
wrong. Second, the reason it was refutable at all is that POD-3065 recorded
**which plane it read and what it found there**, not just a verdict. Decision 34
showed the opposite case: POD-3047's cell passed on the stream while the read
returned zero, and only reporting both numbers exposed it. **Say which plane you
read.**

## Decision 36 — the divergence, and a credential rule that must not be got wrong (2026-08-28 17:45 CEST)

**Why `ccdea1f93` never took, found by reading and verified by me:**

    apps/daemon/src/headless-drivers.ts:111   headlessChildEnv(agent, explicit)
        { ...process.env, ...explicit, ...harnessInstanceEnv(agent, explicit?.HOME) }
    apps/daemon/src/claude-sdk-client.ts:322  spawnDefaultHost
        env: { ...headlessChildEnv(spec.agent, spec.env), ...launch.env }

The embedded `claude-sdk` child calls the **old two-argument** `headlessChildEnv`
directly. HOME comes from `process.env` — the daemon's — unless `spec.env`
carries one, and `harnessInstanceEnv` then receives `explicit?.HOME` as
`undefined`. **POD-3059's overlay builder, the thing its unit test exercises, is
never reached from this site.**

POD-3047's framing is the part worth keeping: the comment above that spawn says
*"what it inherits here is the daemon's environment plus the same per-turn
overrides."* **Inheriting is INTENDED at this site.** It is not a mistake — it is
a site whose design predates the instance-home rule. That is why nobody caught
it, and it is the seventh instrument of the day: **a test that passes for the
case it names while the live path never arrives there.**

**POD-3057 already owns the fix** — `0f0c7a295` (was `96f53857e` before the
branch was rebased onto this root; same patch-id `e655a3e9`), *"Keep the SDK child in the home
its transcript is read from"*, 166 lines across the same three files, with a
before/after showing `sessions.read` going from empty to the real conversation.
Not landed. **POD-3067 was my third duplicate of the day** (after POD-3046 and
POD-3048) and is closed. **I keep filing fix issues without first checking
whether the seam is owned; the check is cheap and I keep skipping it.**

### The credential consequence — OPERATOR DECISION, and one option is unsafe

Once the child really runs in the instance agent home, a **no-copy** rig has a
credential-free home, so **every SDK cell needing a model reply becomes
BLOCKED-on-auth**. Two rigs currently disagree: POD-3047 keeps the isolated
credential absent by brief; POD-3057 **symlinks** the agent home to the operator
credential so the arms differ in the home and not the account.

**If we go that way, it must be the SYMLINK, never a copy.** POD-3047's reason,
and it is right: a copy can go **stale**, and presenting a superseded refresh
token can be treated as **replay and revoke the whole family — logging the
operator out of their own tool.** A symlink cannot diverge. This matches the
credential rule already standing on this epic: never copy, never print, and
delete every copy at teardown.

I am not deciding the rig posture under a green. Flagging it for the operator
with the safety asymmetry stated.

## Decision 37 — the home split is actually fixed this time (2026-08-28 17:57 CEST)

POD-3057 landed `350da768e`, verified on the epic. **Real named-instance A/B:
`sessions.read` went from 0 items to 2 items.** Focused 26-test gate and
typecheck 25/25 green, only the documented inherited daemon failures.

**Why I believe this one where I did not believe `ccdea1f93`.** POD-3059's fix
was pinned by a unit test that asserted the env-merge expression, and the live
`claude-sdk` spawn never reached the code that test covered — it passed for the
case it named while the product stayed broken. POD-3057 fixed the test as well
as the code. It extracted and exported `claudeSdkHostEnv` explicitly *"so a test
can spawn a real process with it and read back the `HOME` that process actually
ran under — rather than re-asserting this merge expression against itself."* The
test now spawns `process.execPath` with `-e` printing `process.env.HOME` and
reads what the **process itself** printed.

**That is the correction to the seventh instrument, made by the session that had
to live with it.** An assertion about a value the code computes is not an
assertion about the value a process receives.

**Chain, both halves:** the driver puts the instance's agent home on the turn
spec; the spawn carries it to the process. Either half alone leaves the child on
the daemon's HOME — which the driver's own comment notes is also the
credential-isolation leak POD-2247 names.

**What this does and does not change.** It does **not** move the release bar —
`claude-sdk` is not on it. It does mean transcript-scored cells are trustworthy
from here. And it does **not** retroactively invalidate Decision 35: POD-3065
re-read the three no-marker cells *before* this landed and found **items
enumerated**, so those readings were never against an empty reader. Decision 35
stands on its own evidence.


## Decision 38 — Claude SDK is first-class, with posture and red cells kept explicit (2026-08-28 19:15 CEST)

The operator's subscription-policy ruling is now reflected by a complete current-pin
drive, not only by a document change. POD-3047's accepted evidence landed at
`d8048399d`, pin `ad02520c22a9cba42db7fc1dd8c44620f29f4509`: 27 readings,
25 exact eight-field rows, one named rig, and both Claude driver forms where the
cell was safe to compare. The Agent SDK is therefore a first-class headless
driver under the authorised Claude subscription posture.

The drive needs two postures because POD-3057 moved the SDK child into the instance
agent home. The supported posture symlinks that home to the operator's existing
subscription credential; it never copies or prints a token, and the credential
mtime stayed unchanged across the drive. The credential-free posture is required
for a genuine logged-out measurement. A posture must be written on every row:
results from those postures are not silently interchangeable.

The measured matrix is **15 PASS, 1 PARTIAL, 2 FAIL, 7 BLOCKED**. A3 passes
with a fired SIGSTOP negative control and exactly one durable confirmed receipt;
A5 passes with the tool call/result pair live and after reload; A7a/A7b now record
idle only after bounded settling. A1b is PARTIAL, not PASS or FAIL: the busy send
survives reload and has `position:1`, but reports `queued:false` and
`disposition:delivered`, an internally contradictory queue contract sent to
POD-2920. A8 and B auth are genuine controlled FAILs in the absent posture:
the product reports logged out, the SDK offers no login path, and the same-rig PTY
control does show one. A4a/A4b are measured auto-approval blocks; A6a/A6b and
A1c are not applicable to this SDK topology; PTY B quota was a real late
`usage_limit` block. No BLOCKED reading is a pass.

This evidence closes the Claude current-acceptance subtask but does not erase its
two real limitations: the refused-interrupt clause and after-login clause were
not driven, and credential rotation was intentionally not attempted. Final release
judgement still requires reconciling this row set with the broader table and
running the single coordinator gate after integration refresh.

## Decision 39 — the matrix expired at 445a52315 (2026-08-28 20:07 CEST)

**POD-3070 merged `origin/dev/mw` into the epic branch: `445a52315`, with
`2d70e8725` and `9c1cc3621` closing type seams and fixtures behind it.
`origin/main` is now an ancestor of the epic tip.** I did not do this and was
not asked; the standing operator ruling I was holding was *do not merge main
into the epic branch*. I am recording that it happened rather than arguing with
it — if the operator ordered the reconciliation, it is their call to make.

**The consequence is the one that matters. 1,175 files changed, 141,466
insertions, and 60 of them under `apps/daemon`, `packages/harness`,
`packages/agent-runtime`, `modules/sessions` and `modules/messages` — the exact
paths the acceptance cells exercise.**

**Every reading in the matrix predates this merge.** Today's result — 70/70
driven, 60 PASS, 7 PARTIAL, 3 BLOCKED, 0 FAIL — **remains true of the pins it
was measured at and is no longer a statement about this branch.**

This is Decision 25 arriving from the other direction. There, a FAIL was valid
for its pin and stale for the tree, and it cost a day as a phantom blocker. Here
**60 passes are valid for their pins and stale for the tree** — and a stale PASS
is far more dangerous than a stale FAIL, because nobody goes looking for it.

**What I am NOT doing:** re-driving all 70 cells reflexively, or letting the old
numbers stand as current. **What is needed** is the smallest honest re-drive set,
chosen from what the 60 files actually touch — and until that runs, the correct
answer to "is the epic clean" is **"it was, at 4110ccee6; nobody knows yet at
9c1cc3621."**

*Note for whoever plans the re-drive:* the merge also has to be gated in its own
right. 141k insertions with hand-fixed type seams is a landing that deserves a
whole-graph typecheck and the daemon/server suites before anyone reads a cell
verdict off this tree at all.

## Decision 40 — the podium CLI is bricked by a marker upgrade; OPERATOR ACTION (2026-08-28 20:08 CEST)

**Every `podium` command now fails:**

    podium: invalid Podium instance marker at /home/mgw/.podium/instance.json

**Diagnosis, verified rather than guessed:**

| fact | value |
| --- | --- |
| `~/.podium/instance.json` | `{version: 2, instanceId: "default", instanceUuid: ...}`, **rewritten 19:55** |
| installed `podium-cli` bundle | 112 MB, **built 18:11** — one hour BEFORE the marker changed |
| does that bundle know v2? | **no** — it carries the marker check (6 sites) but not the `version 2 requires instanceUuid` message |
| does the merged source know v2? | **yes** — `packages/runtime/src/instance.ts:429` |

So something running the **newly merged source** upgraded the operator's instance
marker to v2, and the **installed CLI predates the merge** and refuses it. The
code comment at that very site predicts this: *"An UNKNOWN version is a marker
written by a NEWER Podium. Refusing is the only safe reading."* **The refusal is
correct behaviour; the sequencing is what broke.** This is a direct consequence
of `445a52315` — the same merge that expired the matrix in Decision 39.

**I have NOT fixed it, deliberately.** The two available fixes are (a) rebuild and
reinstall the operator's `podium-cli` from the merged source, or (b) hand-edit
`instance.json` back to v1. **(b) is unsafe** — that file is, in the source's own
words, *"the address of every process we own"*, and a v2-aware daemon may already
be running against it; dropping the newer field on the next write is exactly what
the guard exists to prevent. **(a) is a reinstall of the operator's own tool.**
Neither is mine to do unasked.

**Blast radius while it stands: total loss of coordination.** No `issue state`,
no mail, no `issue start`, no artifact attach. Git still works, which is why this
is written here rather than into the issue panel — **the issue panel cannot be
updated, so the panel the operator reads is stale and will stay stale.**

**Recommended order when someone picks this up:** reinstall the CLI from the
merged source first, confirm `podium issue show 1761` answers, and only then look
at the marker. If the reinstall makes it work, nothing was wrong with the marker
at all.

## Decision 41 — source CLI restored coordination without marker edits (2026-08-28 20:24 CEST)

Decision 40 remains accurate for the installed `/home/mgw/.local/bin/podium`: it
is a pre-v2 bundle and still refuses the current v2 marker. Coordination itself
was restored without touching `/home/mgw/.podium/instance.json` and without
reinstalling that global bundle. I started the current host daemon from this
checkout with the source condition, and the source CLI
(`NODE_OPTIONS=--conditions=@podium/source node --import tsx scripts/cli.ts`) now
answers issue, lock, and mail commands through the live relay. The operator
should still rebuild/reinstall the global CLI before relying on the bare `podium`
command; the source path is a coordinator recovery, not a replacement install.

The acceptance worker is using that source path and the operator sandbox remains
stopped.

*Podium-Issue: POD-1761*

## Decision 42 — no cell is promoted; unconfirmed is not passed (2026-08-28 20:31 CEST)

POD-2777's post-integration audit asked me a question in writing rather than
answering it for itself, and it was right to. **The answer is no.**

**Its finding:** the stale set is **every cell**. No row's exercised code is
unchanged across the `dev/mw` integration — it audited per row, excluding docs
and tests, and looked for a surviving subset *specifically so it could report
one.* There isn't a defensible one. It also recorded the whole-repo number
(1,247–1,422 files) as **useless** and kept it only so nobody re-derives it
hoping for comfort — that count cannot tell a driver rewrite from a lockfile
bump, which is why the audit is per row.

**Its distinction:** some cells are stale *in substance* — the four largest
driver diffs are **one change wearing four hats** (`fdfbe9343`, each driver
dropping its own replay reader for the shared trim-safe one), so anything reading
replay or streaming continuity is directly affected: **A3, the streaming-delta
cells and the long-turn cells on codex and opencode.** The rest are stale only in
the weaker sense of having run on different bytes of nominally the same
behaviour.

**MY DECISION, and it is mine: the weaker sense is NOT promoted to "still
valid."** A cell driven against code that has since changed is a cell whose
verdict is **unconfirmed**, not a cell that passed. Every one of today's
corrections ran the same way — a stale FAIL cost a day as a phantom blocker
(Decision 25), and a stale PASS is worse because nobody goes looking for it
(Decision 39). Promoting on the strength of "probably fine" is exactly the crack
POD-2777 names, and I am not going to open it to make a number look better.

**So the matrix currently reads: 70/70 driven, 0 confirmed at the current tip.**
The readings stand as taken, at their pins, and the report is APPENDED not
overwritten — that was POD-2777's call and it is the right one.

**Re-drive order, from its own analysis:**
1. **Substance-stale first** — A3, streaming-delta and long-turn on codex and
   opencode. These read the code that actually changed.
2. Everything else, which is bulk work and can be batched.
3. **The integration itself needs gating before any verdict is read off this
   tree** — 141k insertions with hand-fixed type seams deserves a whole-graph
   typecheck and the daemon/server suites first.

*Host at the time of the audit: 18.6 GiB available, 79 GiB free on `/`, swap-in
0, load 1.46 — all above the floor. The "root filesystem 100% full" report still
in circulation is two nights old and no longer true.*
