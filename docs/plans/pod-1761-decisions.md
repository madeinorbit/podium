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
