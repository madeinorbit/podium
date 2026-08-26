# POD-1761's acceptance drive

*Are the new headless agents better than the old terminal ones, and are the
harnesses still on the old path any worse?*

The epic cannot close until an operator confirms that BY DRIVING it. Doing that
by hand is an evening of clicking, so it never happens. This is that evening,
scripted:

```bash
bash docs/evidence/pod-2777/drive-all.sh          # the whole matrix, unattended
bun  docs/evidence/pod-2777/report.ts             # the table
bun  docs/evidence/pod-2777/report.ts --evidence  # the table with every reading under it
```

Nine behaviours from `docs/architecture/driver-capability-catalog.md`, driven on
four harnesses, each on BOTH drivers where the harness can run both ways.



## A sequencing rule the pin guard taught me

**Do not rebase while the rig is building.** I started `drive-up.sh` in the
background, then committed and rebased onto the merged tip while it ran. The rig
came up pinned to the pre-rebase commit, and `drive-verify.sh` refused the very
next drive:

```
VERIFY FAILED: server (pid 2475410) was SPAWNED AT 53be0c55d…,
you named 9f0b12308… (HEAD) — restart it with drive-up.sh
```

Which is the guard working. The build reads the worktree continuously — the web
bundle stamp, the source the server and daemon import under
`--conditions=@podium/source` — so moving HEAD underneath it produces a rig whose
components disagree about which commit they are. The order is: **commit, rebase,
THEN build.** Never overlap the last two.


## Two rig defects the sweep found in itself

**An unknown probe name in `P2777_ONLY` used to be an empty selection, not an
error.** `P2777_ONLY=streaming,interrupt,resume` ran TWO probes: the streaming
one is called `stream`, `streaming` matched nothing, and the runner printed a
results table with two rows and exited 0. Nothing said a cell had been dropped.
Row A2a was nearly recorded as driven on the strength of a run that never touched
it. `drive.ts` now DERIVES the known set from the probes themselves — so a
rename cannot drift away from the check — and refuses with exit 6, naming the
unknown ids and listing the real ones.

**Committing invalidates the running rig, and that is correct.** `drive-verify.sh`
requires the WORKTREE to be at the named commit, not just the processes: the
server and daemon run with `--conditions=@podium/source`, so anything they import
lazily comes off the current checkout. A docs-only commit still moves HEAD, so
the guard refuses until the rig is brought up again. Naming the older commit with
`P2777_PIN` does not get around it and should not — the worktree really has
changed. The working rule during a sweep is therefore: **drive first, commit
second**, and expect a rebuild after every commit.


## The three things that make it real

**1. A positive control in every measurement.** Every probe declares a signal
that must arrive whether or not the behaviour under test works, and `score()`
turns a probe whose control did not fire into REFUSED — never a FAIL, never a
PASS. A zero from a dead rig and a zero from a broken feature are different
findings and this drive will not print them in the same words.

The controls are not decoration; three of them are the probe's whole design:

| probe | its control | what the control rules out |
|---|---|---|
| reply | our own prompt landing as a durable transcript item | "the agent did not answer" vs "nothing here is alive" |
| stream | `transcriptDelta` on the same socket and subscription | a preview count of 0 from a socket that was delivering nothing |
| **interrupt** | **the turn observed IN FLIGHT immediately before the interrupt** | interrupting nothing, which always looks like success |
| stop | the session present and readable immediately before the stop | stopping something that had already gone |
| resume | the pre-kill turn having answered with the secret | a resume with no conversation to bring back |
| attach | a plain send on the same session having already worked (probe 1) | blaming attachments for a session that could not send |
| interaction | the turn producing durable transcript items at all | "no ask appeared" vs "no turn ran" |
| provider-error | this harness answering a normal question on this arm (probe 1) | an error arm that was never a working arm |
| model-switch | the session readable, reporting the model it was asked for | an empty reading from an unreadable session |

Two probes carry a **negative** control as well, built into the measurement
rather than bolted on: the attachment's secret word exists only in the file's
bytes, and the resume secret exists only in the pre-kill conversation. An agent
can agree that it sees a file without reading one; it cannot produce those bytes
without having read them. A blank session cannot guess either.

**2. An A/B against the terminal driver.** "Better" is a comparison, so every
harness that can run both ways runs both — same rig, same commit, same probes,
same prompts — and `report.ts` puts the columns side by side and counts the
cells where they differ, **in both directions**. A row where headless is WORSE
is printed first, because that is the finding this drive exists to be able to
report. claude runs the terminal arm only: it has no headless driver, and giving
it a headless column would invent a comparison that does not exist.

**3. The pin is verified before every run — server, daemon AND web bundle.**
`drive.ts` shells out to `drive-verify.sh` itself and exits 4 on a mismatch,
rather than leaving that to a human's discipline.

- **server and daemon**: alive, running out of this worktree, and *started after
  the commit was made*. A process that predates the commit cannot be running it
  however clean the tree looks now, and the drivers are loaded at the DAEMON's
  process start — repinning a checkout underneath a running bun process changes
  precisely nothing.
- **web bundle**: `podium-build.json` is fetched **back out of the server** and
  its `sourceSha` compared to the commit. Read over HTTP rather than off disk on
  purpose: a server pointed at a different `PODIUM_WEB_DIR` would pass a disk
  check and fail this one, which is the whole difference between "a correct dist
  exists" and "the correct dist is what is being served".
- **the arm itself**, read out of `/proc/<pid>/environ` of the running
  processes, because the arm a shell intended and the arm a long-lived process
  is actually in are different facts.

Both legs were mutation-tested rather than assumed: naming `HEAD~1` fails on the
worktree leg, and editing the served stamp's `sourceSha` to `deadbee` fails on
the bundle leg. Restoring it passes again.

There is deliberately **no** "is the fix loaded" probe against `/proc`. A JS
module is `read()` and closed, never left mmapped, so `/proc/<pid>/map_files`
cannot see it and a check written that way passes vacuously — POD-2753 shipped
one and had to withdraw it.

## The fourth guard: the binding

An isolated agent home missing a credential does not fail loudly. The server
driver declines, the session degrades to a generic PTY, and every headless probe
then measures the terminal path while reporting it in the headless column. That
is a perfect false negative and POD-2773's rig hit it twice. So `drive.ts` reads
the bound `driverId` off the session and **refuses the entire run** when it is
not the driver the arm asked for.

## What is driven, and where the ordering matters

The streaming probe opens its chat **8.5 s into a turn already in flight**, and
that ordering is the experiment rather than a detail. Reaching the fine watch
used to be a reconnect, a reconnect abandons an in-flight turn, so the upgrade
could only land in an idle gap and the turn a viewer walked in on was always the
turn that streamed nothing. A drive that subscribes first and then sends
measures the easy ordering and would have passed on the broken build. The delay
is 8.5 s because that is what POD-2745's codex drive and POD-2773's used, kept
identical so three drives' numbers stay comparable.

## THE CLAUDE CLAIM, DECOMPOSED — what is driven and what is not

The epic's central promise is that harnesses staying on the terminal path are no
worse. That promise cannot rest on an untouched diff: **against main this epic
adds `packages/agent-runtime/src/drivers/terminal` ENTIRELY** — 1,554 lines
across `index.ts`, `injection.ts` (571 lines), `paste.ts`, `capabilities.ts`,
`envelope.ts`, `permitted-failures.ts`. Claude runs on brand-new code.

**THE SHARED SUBSTRATE IS DRIVEN.** `codex/generic-pty` and `grok/generic-pty`
exercise the same `injection.ts`, `paste.ts` and `index.ts` that `claude-pty`
uses. Every cell scored on a terminal harness is coverage of the code claude
depends on, which is why finishing the codex terminal column matters beyond
codex.

**THE CLAUDE COLUMN ITSELF IS DRIVEN** — reply, stop and resume PASS, attach
FAIL. See the matrix.

**THE UNTESTED DELTA, named precisely.** What remains claude-specific and is NOT
covered by any terminal-harness cell:

| file | lines changed | what it does |
|---|---|---|
| `packages/harness/src/manifests/claude-code.ts` | +56 | claude's launch/probe manifest |
| `packages/harness/src/agent-state/claude-screen.ts` | +83 (new) | screen classification for claude's TUI |
| `packages/harness/src/agent-state/claude-code.ts` | +15 | claude's agent-state folding |

A named residual is a releasable risk. An unmeasured column is not — which is
why the list is here rather than a sentence saying "claude is mostly fine".

### Why claude cannot simply be driven harder

Recorded so nobody tries to fix this by copying credentials more carefully.
**claude authenticates by OAuth only** — no `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`
or `ANTHROPIC_AUTH_TOKEN` exists on this box. The rig's isolated agent home holds
a COPY of the operator's token, and **a refresh in either home ROTATES the
refresh token and invalidates the other holder**. That is how the rig's copy came
back `401 OAuth access token has been revoked`.

Re-seeding is safe only inside the access token's validity window (a refresh
fires near expiry, not on use), and this column was driven with 439 minutes
remaining — verified afterwards: the rig's copy stayed byte-identical to the
live one, so the rig never refreshed and never rotated the operator's token, and
their sessions stayed up. Outside such a window the honest answer is a second
account, not a more careful copy: the failure mode is logging the operator out of
their daily driver to obtain a test result.

## resurrect: RETRACTED — it does not reproduce at the tip

My opencode `resume` FAIL reported `resurrect` returning ok and leaving the row
`exited`. Re-driven on the current tip with the three artefacts POD-1761 asked
for — status series, daemon log, binding journal — it is **`starting` → `live`**,
the healthy path:

```
resurrect returned in 27ms: {"ok":true}
  + 0s status=starting   + 5s status=starting
  + 1s status=starting   +10s status=live
  + 2s status=starting   +15s status=live
```

The binding journal is unchanged across the cycle
(`ses_fc4b7e9fcffejD5kXy66zATxkK`, `conv_ee8a183a…`), and the daemon log names
what happened: *"resumed a parked server-family session from its binding
journal", driver opencode-server*.

**Closed as fixed-in-flight, with both readings recorded.** The earlier reading
was real for the build it was taken on; the difference between the two rigs was
TIME, not environment.

What made this settleable was a fact from POD-2775 rather than more sampling: **a
healthy wake never passes through `exited`** — `starting` is the intermediate
state and `exited` is terminal. Without it, `starting` at +2s and `exited` at +2s
are the same "read it too early" story and the dispute is unresolvable. With it,
a drive that read `exited` read a genuine failure, and a drive that reads
`starting` is watching a healthy wake. Two hypotheses died on the way — mine
(resumeAndSend blocks, resurrect does not: false, both settle asynchronously) and
the stale-build one (false, `f3691cf95` contained the fix).

## THE MATRIX

Rendered by `report.ts` from the results files, per-cell pinned. Full output in
`readings/FINAL-REPORT.txt`.

```
                                  codex         opencode      claude
behaviour                         H     T       H     T       H     T
send a turn, get a reply          PASS  PASS    PASS  PASS    —     PASS
streaming deltas arrive           PASS  FAIL    PASS  n/a     —     n/a
interrupt a running turn          REF   FAIL    REF   FAIL    —     REF
stop                              PASS  PASS    PASS  PASS    —     PASS
resume after a kill               PASS  REF     PASS  FAIL    —     PASS
attach a file                     FAIL  PASS    PASS  FAIL    —     FAIL
pending interaction               n/a   n/a     n/a   n/a     —     REF
provider error surfaced honestly  n/a   n/a     n/a   FAIL    —     n/a
model / effort switch             n/a   n/a     n/a   n/a     —     n/a
```

**Headless better in 3 scored cells, worse in 1.** Better: codex streams to a
late joiner where its PTY cannot; opencode resumes a parked session where its PTY
does not; opencode's attachments reach the agent where the PTY's do not. Worse:
**codex attach** — the headless driver declares image-only and refuses a text
file (correctly, per its declaration), and then the image it DOES declare was not
read back either, while codex on the PTY read the text file fine.

**claude runs ONE path** and it is the path the epic promises not to make worse.
It binds `claude-pty` whatever the driver preference says: forcing
`generic-pty` produced NO BINDING AT ALL in 91 seconds, because that preference
names a driver claude does not have. Its column: **reply, stop and resume PASS**;
**attach FAIL**; streaming n/a (coarse-only family); interrupt, interaction and
provider-error REFUSED for want of a control.

### What REF means here, and why there are so many

`REF` is a withheld number, not a failure. Every one of them is a cell where the
probe's positive control did not fire, so a reading could not be told apart from
a dead rig. Interrupt is REF on both headless arms for the same reason: the
control requires the turn to be observed IN FLIGHT immediately before the call —
because interrupting nothing always looks like success — and on opencode a long
turn now stalls under Podium (23 preview frames, then `phase=working` with zero
durable chars, while the identical prompt completes 200 lines OUTSIDE Podium).

The rig refused far more often than it failed, and every refusal traced to
something real: a stalled turn, a modal nobody had cleared, a driver that never
bound, an arm that named a driver the harness does not have. That is the
machinery working. It is also why each refusal needed a diagnosis before it could
become a report — a guard cannot tell the rig's fault from the product's.

## THE FIRST MEASURED COLUMN — opencode, headless driver

Driven at commit **e28013a8526ee454ca6b49296b9902daa6bbe1e2**, bound driver
`opencode-server` (family `server`), against instance `p2777` on port 19847.
Every cell below had its positive control fire; `score()` withheld nothing here.
Raw output per probe is in `readings/`.

| behaviour | verdict | the control that fired | the reading |
|---|---|---|---|
| **send a turn, get a reply** | **PASS** | our own prompt echoed on the durable transcript (2 `transcriptDelta` frames) | nonce back in 7.2s, `disposition:'delivered'` — not queued |
| **streaming deltas arrive** | **PASS** | `transcriptDelta` on the same socket + `phase=working` AT THE MOMENT OF JOINING | joined **8643ms into a live turn**; 26 preview frames, seq 145→512, 562→2105 chars, **25/25 transitions grew**, monotonic per row; daemon logged `fine watch acquired` |
| **interrupt a running turn** | **FAIL** | the turn observed IN FLIGHT immediately before the call | `sessions.interrupt` returned `{ok:true}`; phase never left `working` in 120s; no transcript item carries `event:'interrupt'` |
| **stop** | **PASS** | the session present and readable immediately before | left its running state in **153ms**, `status=hibernated` |
| **resume after a park** | **FAIL** | the pre-park turn answered with the secret, AND the park itself succeeded | `hibernate {ok:true}`, `status=hibernated` after 42ms — a real park. Then `resurrect {ok:true}` → **`status=exited`**; `resumeAndSend {ok:true}` → **still `exited`**; the secret never came back |
| **attach a file** | **PASS** | a plain send on the same session had already worked (probe 1) | staged a text file and the agent echoed `FILESECRET-7VT24I` — a secret present in those bytes and nowhere else |
| **pending interaction** | n/a | the turn produced durable transcript items | no ask raised: this harness ran the tool without asking. The product was never handed an ask to surface — a fact about the posture, not the ask plane |
| **provider error surfaced honestly** | n/a | probe 1 PASSED, so a failure would be attributable to the injected fault | the bad model was **ignored** — the harness answered *"Hello!"*. The fault never fired, so nothing about error surfacing was measured |
| **model / effort switch** | n/a | the session readable, reporting its model | no product surface exists on either arm (see below) |

### What the three `n/a` cells mean, so they are not read as "untested"

An `n/a` is a measured statement about why a behaviour could not be driven, not a
cell nobody looked at. Each has a different reason.

**`interaction` — the posture, not the ask plane.** The probe asked the agent to
write to a path OUTSIDE its working directory, the case that normally raises a
permission ask, and the harness **ran the tool without asking anyone**. The
product was never handed an ask to surface. That is a fact about this rig's
permission posture, not about the product's ask plane, and a FAIL here would
blame the product for a decision the harness made. When an ask IS raised the
probe drives it fully — and caught a real defect doing so: one permission
arriving as TWO open asks, a protocol-structured one and a screen-classifier copy
carrying the path glob in its `toolName`, where answering one leaves the session
blocked on the other.

**`model / effort switch` — nothing to drive on either arm.** `capabilities.ts`
declares configure unsupported for codex, opencode and terminal; grok declares
`permissionMode` only; and no server or daemon code calls `handle.configure()`.
Declaration and behaviour agree. (This corrected the capability catalogue, which
had the row as `declared` on all four drivers.)

**`provider-error` — a fault that did not fire.** The first version named a
nonsense model; opencode ignored it and answered "Hello!", so nothing about error
surfacing was measured. Scored `n/a` rather than FAIL, because a fault that never
fires measures nothing. The real one is `opencode/laguna-s-2.1-free`, retired
from opencode's gateway — binds, marked live, send ACCEPTED with a turnEpoch,
then never settles (POD-2604) — and that is what the probe now uses on opencode.
Where no equivalent is known for a harness, the cell stays `n/a` with that
reason.

### The two reds, and what they are worth

**`interrupt` is a product defect.** The call answers `{ok:true}` and the turn
keeps running. Its control is the one that makes the row mean anything —
interrupting nothing always looks like success, so the turn is observed IN
FLIGHT (phase `working`, previews arriving) in the moment before the call. The
catalogue lists this row `wired` on all four drivers: declared everywhere,
conformance-tested nowhere. **Now POD-2792**, whose first question is whether the
terminal arm interrupts correctly — if it does, this is a straight regression
against the epic's bar.

**`resume` independently confirms POD-2775's F1.** A parked opencode session
cannot come back: `adopt()` needs `probeHealth` against a server the park killed.
A code-reading reviewer reached the same defect the same evening from the
opposite direction, with no contact between the two methods. Two methods, one
defect — that agreement is worth more than either finding alone.

### Model / effort switch: the catalogue overstates this row

The catalogue marks `configure` **declared** on all four drivers — "the
capability is announced and nothing checks the announcement is true". The
announcement is not there. `capabilities.ts` declares configure **unsupported**
for codex ("model and effort are set at thread start and per turn"),
**unsupported** for opencode, **unsupported** for terminal ("a TUI takes its
model at launch"); grok declares `supported({fields:['permissionMode']})` —
explicitly not model or effort. And **no server or daemon code calls
`handle.configure()` at all**; `sessions.sendText` carries no per-turn override
either.

So declaration and behaviour agree, and there is no product surface to drive on
EITHER arm. Scored `n/a` with the declarations quoted rather than red: nothing is
broken, nothing is proven, and it is not a way in which headless is better or
worse.

## THE A/B — opencode on both drivers, same rig, same probes, same commit

Terminal arm bound `generic-pty` (family `terminal`), verified live in the
daemon's own `/proc/<pid>/environ`. Both columns at **e28013a**.

| behaviour | headless (`opencode-server`) | terminal (`generic-pty`) | which is better |
|---|---|---|---|
| send a turn, get a reply | PASS — 7.2s | PASS — 11.7s | same |
| streaming to a late joiner | **PASS** — 26 frames, seq 145→512, monotonic | **cannot** — declares `coarse` only | **headless** |
| interrupt a running turn | **FAIL** | **FAIL** | **same — see below** |
| stop | PASS — 153ms | PASS — 261ms | same |
| resume after a park | **FAIL** | **FAIL** | same |
| attach a file | **PASS** | **FAIL** — staged and sent, contents never came back | **headless** |
| pending interaction | n/a — permissive posture | n/a — permissive posture | same |
| provider error surfaced | n/a — fault never fired | FAIL — no error surfaced in 180s | — |
| model / effort switch | n/a — no product surface | n/a — no product surface | same |

**Headless is better in two cells and worse in none.** The terminal driver
cannot stream to a late joiner at all — that is its declaration (`watchLevels:
['coarse']`), not a defect, and it is exactly the gap the headless work exists to
close. Attachments reach the agent on the headless path and do not on the
terminal one.

### interrupt fails on BOTH arms — so it is not this epic's regression

This is POD-2792's release question and the answer is not the one that blocks a
release. On the terminal arm, with the control fired (PTY output bytes growing
before the call):

```
INTERRUPT SENT    {"ok":true}
TERMINAL BYTES    257 at the call -> +44049 after 6s -> +72080 after 12s
TRANSCRIPT MARK   no item carries event:'interrupt'
```

The agent kept generating — 72KB of output after a call that reported success.
The headless arm fails the same way. So `interrupt` is a **pre-existing gap on
the old path that the headless work inherited, not one it introduced**. The
catalogue's `wired` on all four drivers was right that the code exists and wrong
that it works, equally on both paths.

### `phase: working` is missing on TWO harnesses, not on "the terminal driver"

**CORRECTED — my original claim here was too broad.** I wrote this section as
"the terminal driver never reports `phase: working`" on the strength of driving
ONE harness on it. POD-2801 then drove the others: **codex/generic-pty and
grok/generic-pty both report `working` correctly.** It was never a property of
the terminal family.

What is true is narrower and has two unrelated causes:

- **opencode on generic-pty** — the mechanism I measured below. Since fixed.
- **claude on `claude-pty`** — a different cause entirely (POD-2810): claude's
  phase comes from HTTP hooks folded by the causal observer rather than from a
  poller. The harness DOES fire the hooks, and the checkpoint names the real
  provider session id, but its cursor sits at `components {transcript: 0,
  hook: 0}`. Measured at 79,242 bytes across 49 of 59 one-second intervals and
  12,267 transcript chars, with `phase=idle` at all 60 polls.

The generalisation was mine and it was wrong: one harness is not a family. The
measurement below stands for the harness it was taken on; the sentence it was
wrapped in did not.

### What I measured on opencode/generic-pty

Found while trying to score the cell above, and a finding in its own right.
Measured twice on `generic-pty`: a session produced **13,250 characters of
output while `agentState.phase` read `idle` at all 60 polls across 60 seconds**.
`working` never appeared once.

```
+45ms     phase=idle transcriptChars=0
+12902ms  phase=idle transcriptChars=0
+26605ms  phase=idle transcriptChars=13250
+53717ms  phase=idle transcriptChars=13250
phases seen: idle=60      EVER working: false
```

The catalogue lists "working vs idle" as `wired` for terminal. Driven, it fails:
a busy terminal session renders as **idle on the home board for the whole turn**.

It also forced a change to HOW the interrupt control is established — announced
to POD-1761 before it was made, because they own that row now. The control's
PURPOSE is untouched: prove tokens are being produced right now, immediately
before the call, because interrupting nothing always looks like success. What
differs is the signal each arm actually publishes — headless uses `phase=working`
plus arriving preview frames, terminal uses the PTY's own output bytes growing.
Both are direct evidence of live token production; neither is the weaker claim.
Every cell reports which signal fired.

The success reading had to change with it. On an arm that never says `working`,
"it left `working`" is vacuously TRUE, so the terminal cell is scored on whether
output actually stopped, sampled 6s and 12s after the call.

## A TUI REPAINT IS ALSO BYTES — read this before building a drive

The single most useful thing this rig learned, and the next person will reach for
byte growth exactly as I did.

The terminal arm cannot use `phase: 'working'` to prove a turn is running: two
harnesses never publish it (POD-2801). The obvious substitute is the PTY's own
output — bytes are arriving, so something is generating. **It is wrong.** A
session sitting on a modal REDRAWS. codex stuck on `hooks-need-review` produced
**+8108 bytes** of pure repaint, indistinguishable from generation by any
byte-counting control.

What it cost: the interrupt cell scored codex/terminal **PASS** while the product
had refused the call in the same breath —

```
INTERRUPT SENT  {"ok":false,"reason":"Codex only takes an interrupt while it is
                 working, and it is not working right now"}
PASS  turn stopped 29ms after interrupt
```

Output "stopped" because it had never started. That is precisely the failure the
control was written to prevent — *interrupting nothing always looks like success*
— arriving through the control itself.

**The repair: flight must be proven by TOKEN-SHAPED evidence.** Preview
fragments, or the durable transcript growing. Screen bytes are supporting detail
and never sufficient alone. And the product's own verdict on its own call is
consulted first: `ok:false` can never score PASS.

The same modal explains the opposite symptom elsewhere — six of nine
codex/terminal cells REFUSED, because a session on a dialog produces no
transcript and no control can fire. One cause, two presentations: a false PASS on
the row that could read repaint, refusals everywhere that needed real tokens.

## Where this drive was WRONG, and how it found out

A drive that records where it was wrong is worth more than one that only records
results. Both of these were caught by the rig's own controls, and both had
already been stated aloud before they were corrected.

**A streaming regression that was not one — retracted.** One run of the stream
cell returned a single preview frame and scored FAIL, and against POD-2745's 119
frames and POD-2773's 12 that read as a regression from one of the evening's
landings. It was not. The re-drive at the same commit returned **26 frames**, and
the lone frame in the failed run carried **`seq=512` — the same final seq the
passing run ends on**. The viewer had joined at the tail of the preview stream,
after the turn's last frame. The probe now reports that case BLOCKED with the seq
printed, so the claim is checkable rather than a guess.

**A resume PASS that was vacuous — and the corrected answer is a true red.** The
cell first scored PASS under the hardened three-part identity check: secret
recalled, original exchange intact, conversation pointer unchanged. All three
were true and meaningless. The evidence line that gave it away was printed but
not gated on:

```
HIBERNATE  {"ok":false,"reason":"agent is working — let it reach idle first"}
           parked after 60280ms (status=live)
```

The session was **never parked**. Of course the conversation was intact — it had
never gone anywhere. Two fixes: the probe now `settle()`s before parking
(`untilText` returns on the TEXT, not on the turn's fence, so hibernate was being
fired from inside the turn that produced the secret), and **the park is now
itself a control** — hibernate must be accepted AND the row must actually leave
`live`, or the cell refuses. With that in place the same cell is a clean red.

This is the exact class of green lie the whole rig exists to prevent, and it got
past me once. It is recorded here rather than quietly fixed.

## What the rig caught about itself

Kept rather than quietly fixed, because each one is a way a drive can lie and
three of them would have produced a confident wrong number.

**The web build was bundling another branch.** This worktree had no
`node_modules`, so `@podium/client-core` resolved by walking UP the filesystem
into the main checkout — which was sitting on `issue/2417`. It failed on three
missing exports, and failing was the lucky outcome: a build that had *succeeded*
would have produced a dist stamped with OUR commit and built from someone else's
code, and `drive-verify.sh` would have certified it. `link-node-modules.sh`
repoints `@podium/*` at this worktree; the third-party tree stays shared, because
this box has fallen over for memory before.

**The rig raced its own previous turn.** `sessions.sendText` into a busy session
answers `{ok:true, queued:true, disposition:'queued'}` — the product doing
exactly what the catalogue's pinned row says it should. The attachment probe then
spent its whole patience window waiting for an answer to a turn that had not
started, and reported *"the file was staged and sent, but its contents never came
back"*. A FAIL invented entirely by the drive's own impatience. `settle()` now
runs between probes.

**A probe waited on a dialog instead of answering it.** opencode asked to read
outside its cwd — the attachment staging dir IS outside the repo — and the probe
waited blindly. A person at the keyboard clicks Allow. `untilText` now answers
permission asks while it waits, always `allow-once` and never a synthesized
`allow-always`, and reports how many it cleared.

**A probe arranged its own failure.** The resume probe called `sessions.kill` and
then asked `sessions.resurrect` to bring the session back, and got
`{ok:false, reason:'unknown session'}`. Killing REMOVES the row; after it there
is nothing left to restore. It now drives `hibernate` → `resurrect`, the round
trip a person actually performs.

**A fault that never fired scored as a defect.** The provider-error probe created
a session with a nonsense model and called it a FAIL when no error appeared — but
"the harness ignored the model string and answered normally" produces exactly
that reading, and it says nothing at all about error reporting. The probe now
watches the chat for a real answer as well, and reports BLOCKED when the fault
did not land.

**The rig's own PATH decided a whole column, and nearly got the product blamed
for it.** The first matrix refused all nine codex/headless probes: the session
bound `generic-pty` instead of `codex-app-server`. The daemon said exactly why —

```
codex 0.146.0 is outside the range this driver was exercised against
(0.147.x – 0.149.x; fixtures recorded from 0.147.0)
```

— and that is the version gate doing precisely what the catalogue's row promises:
refusing loudly, with a machine-readable diagnostic and the observed version,
rather than hanging on the first tool call. The finding writes itself as "codex
cannot run headless".

It would have been wrong. This box has **two** codex binaries:
`~/.bun/bin/codex` is the npm wrapper pinned at **0.146.0**, and
`~/.local/bin/codex` is the standalone at **0.149.1** — inside the supported
range. `drive-env.sh` listed `~/.bun/bin` first, so the daemon resolved the old
one. The gate was right about the version it was handed; the rig handed it the
wrong binary.

`~/.local/bin` now comes first (`codex` is the only name that overlaps between
the two directories, so nothing else moves), and `drive-up.sh` now PRINTS the
resolved path and version of every harness binary before the arm runs, into
`harness-versions.txt`. A drive that does not write down which binary it ran
cannot tell a product finding from a PATH accident.

**A ring buffer made continuing output look like stopped output.** The terminal
interrupt cell first scored FAIL with this line in its evidence:

```
TERMINAL BYTES  7697 at the call -> +-68017 after 6s -> +-30926 after 12s
```

Negative deltas. `Chat.screen` is a ring that truncates past 200KB so a long turn
cannot exhaust memory, and I was measuring "did output stop" as a difference in
its LENGTH — which goes negative once truncation starts, and a negative delta
trivially satisfies "did not grow". A turn that was still streaming would have
scored as one that had stopped. `Chat` now keeps a monotonic `screenBytes`
counter that never truncates, separate from the display ring. The corrected run
reads `+44049 after 6s -> +72080 after 12s` — the opposite conclusion, from the
same session doing the same thing.

**A verdict that contradicted its own evidence.** With the counter fixed the
cell scored FAIL correctly, and then printed *"generation STOPPED (nothing
arrived after the call)"* directly beneath the bytes proving 105KB had arrived.
The verdict was right and the explanation was wrong — the narrative branch was
keyed on preview frames and transcript growth, neither of which moves on a
coarse-only, batch-tailed terminal arm. Left alone it would have been read by
someone as the finding. Fixed and re-driven rather than hand-corrected in prose.

**`pkill -f <path>` kills the shell that runs it** when that shell's own command
line contains the path. It happened repeatedly here: exit 144, no output, and the
drive it was meant to protect gone with it. The reaping is `pgrep` plus an
explicit self filter.

## Pin leg 1 was defeated, and the fix is a recorded fact

The first version of leg 1 asked whether a process had STARTED AFTER the commit,
reading `stat -c %Y /proc/<pid>`. POD-2775's reviewer defeated it and the defeat
reproduces here — measured on this host, comparing that value against the real
start time from `/proc/<pid>/stat` field 22:

```
pids sampled        256
skewing FORWARD >5s 113
worst               7751.1s
```

It is the INODE's mtime, not a process start time. And the second defect is worse
because no clock fixes it: `started >= committed` is ALSO true for the commit's
PARENT, so the leg could not distinguish the build under test from the one
immediately before it — the only distinction a pin exists to make.

`drive-up.sh` now writes `git rev-parse HEAD` beside each pidfile **as it spawns
the process**, and `drive-verify.sh` compares that recorded sha. Mutation-tested
at both edges: correct commit → exit 0; **parent commit → exit 1** (`was SPAWNED
AT 26f99a8ad…, you named d71398329…`); `daemon.sha` removed → exit 1, because an
instance left by an older `drive-up.sh` must not silently skip the leg; restored
→ exit 0.

A recorded fact beats a derived one. That is why leg 3 was always the strongest —
`/podium-build.json` fetched back OUT OF THE SERVER is a fact about the bytes
being served — and leg 1 now has the same shape.

**What was and was not at risk.** The COMMIT IDENTITY was never in doubt: leg 2
checked the worktree was at that sha and clean, and leg 3 checked the served
bundle was built from it. What leg 1 failed to establish is that the running
server and daemon were started FROM that checkout rather than an earlier one.

## Two daemons on one state root — asked for, added, and the product got there first

POD-1761 asked for a fourth pin leg: exactly ONE daemon on the instance's state
root, because a second one serves sessions from code the pidfile never named and
every number it touches is a false negative.

It is in `drive-verify.sh` now, matched on `PODIUM_STATE_DIR` read out of each
`scripts/daemon.ts` process's environ rather than on the script name alone —
other instances on this box legitimately run their own daemons, and counting
those would refuse a healthy rig. (One does: a daemon on `~/.pod-op-state` is
correctly ignored.)

Testing it turned up something worth recording: **the product already prevents
this.** Starting a second daemon on the same state root dies immediately with

```
hook ingest socket already in use: /tmp/pod-2777/state/runtime/codex-hooks.sock
```

The hook-ingest socket is the mutex. So the plain double-start cannot produce
the condition, and the guard had to be mutation-tested against a decoy process
carrying the right cmdline and `PODIUM_STATE_DIR` instead — two seen, refused,
exit 1; decoy removed, exit 0. The leg still earns its place, because the socket
protects against a double *start* and not against a stale socket or a daemon
from another worktree adopting the root.

## Files## Files

| file | what it is |
|---|---|
| `drive-env.sh` | isolation: instance `p2777`, port 19847, state `/tmp/pod-2777`. **Source it, never execute it.** |
| `link-node-modules.sh` | points `@podium/*` at THIS worktree so the bundle is this branch's |
| `drive-up.sh` | server + daemon + web bundle, split and detached; re-running IS how the arm is switched |
| `drive-verify.sh` | the three-component pin, and the arm read back out of `/proc` |
| `drive.ts` | one harness, one arm, nine probes; verifies the pin itself and exits 4 on a mismatch |
| `probes.ts` | the nine probes and their controls |
| `rig.ts` | session/socket plumbing and `score()`, which is where a missing control becomes REFUSED |
| `report.ts` | the table, the A/B, and the refusals |
| `drive-all.sh` | the whole matrix unattended, with a memory floor and reaping between harnesses |
| `drive-down.sh` | stops the pair and reaps the harness servers each arm leaves behind |
