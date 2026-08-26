# Decisions waiting on the operator — POD-1761

One entry per decision only the human can make. Each says the date, the choice, and
what happens either way. This file exists because the coordinator's context is lost
between sessions and the human does not read every message.

---

## 1. A parked chat message is destroyed by a daemon restart — fix or ship with it?
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

## 11. An existing Codex session loses its history view when it upgrades.
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
