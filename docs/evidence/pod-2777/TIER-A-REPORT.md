# Tier-A release matrix — driven on a rig with no overrides

Instance `p2777`; server + daemon + web bundle verified at the same commit before
every run. Last updated **2026-08-26 16:07 CEST**.

**When each block of readings was taken, and against what.** Every reading
post-dates the commit it is pinned to, so these commit times are a verifiable
lower bound on each block — the ordering of a reading against a landing is what
decides whether it still counts.

| pin | committed | what was driven against it |
|---|---|---|
| `15cdfa0ea` | 2026-08-26 01:50 CEST | first drive on the un-overridden rig; A1a, A7a, A4a/A4b, A9; A6a/A6b BLOCKED on POD-2853 |
| `6685c5956` | 2026-08-26 12:50 CEST | after POD-2853 landed: A6a/A6b green on both arms, the long-turn wedge found on codex **and** opencode, the opencode column |
| `7b9d9eacb` | 2026-08-26 15:10 CEST | main merged into the epic — *nothing driven*, the web bundle would not build (POD-2895) |
| `aad84ec21` | 2026-08-26 15:28 CEST | the queued-bubble restore; unblocked the rig |
| `372ae4de2` | 2026-08-26 15:36 CEST | the wedge **re-confirmed after the main merge**: 426s at `working`, previews frozen at 80, zero transcript |

Readings taken before `7b9d9eacb` predate the main merge. Per POD-1761's
file-level analysis the opencode *driver* cells and the terminal-arm attach rows
are unaffected (neither driver moved); the codex headless column and A1a/A1b/A5
on both columns are stale and are queued for re-drive.

---

## The headline

**Two cells where the new drivers are WORSE, both P1, and one of them is
ordinary work.**

**POD-2885 — long turns wedge on `codex-app-server`** (filed by me as POD-2884,
top-level; POD-1761 re-filed it under the epic as POD-2885, which carries the
work). **Re-confirmed on the merged tip `372ae4d`, after main was merged in: 426
seconds at `working`, previews frozen at 80, zero transcript characters, never
completes — so it is present on the branch that would actually ship, not only on
the pre-merge epic.** One prompt, three arms:
headless runs 422 seconds at `working`, freezes its preview plane after ~20s,
writes *zero* transcript characters and never completes. The terminal driver
completes the same prompt in 61s with 12,291 characters. Codex run directly,
outside Podium, completes it in 83s. So the work finishes outside Podium and on
the old driver, and wedges only on the new one.

**POD-2875 — a delivered message is destroyed.** Under a declared CLI view a chat
send returns `{"ok":true,"disposition":"delivered"}` and parks; restart the daemon
and it is gone for good, while the session stays healthy. The same probe on
`generic-pty` delivers it normally.

Two cells say headless is **better** — A1a at 4.1s against 6.4s, and the
provider-error row where headless surfaces a failure in 12.2s that terminal never
surfaces at all. Two say it is worse, both in expensive ways.

**And removing the rig's path overrides was worth it on its own.** With them gone
this rig runs the way an ordinary named installation runs, and that immediately
blocked the whole terminal column — POD-2853's socket path composed to 121 bytes
against a 107-byte limit, and no named instance could fit *regardless of its
name*. Fixed and landed; my measurements are why the fix moved the socket root
instead of trimming it, and why its budget takes the attach label rather than the
session label.

---

## What changed in the rig

| removed | what the product picks instead |
|---|---|
| `PODIUM_STATE_DIR=/tmp/pod-2777/state` | `~/.local/state/podium/p2777` (`instanceStateDir`) |
| `ABDUCO_SOCKET_DIR=/tmp/pod-2777/abduco` | `<state>/runtime/abduco` (`applyInstanceRuntimeEnv`) |
| `TMUX_TMPDIR=/tmp/pod-2777/tmux` | `<state>/runtime/tmux` |
| `HOME=<agent-home>` on the daemon | the real `HOME`; a named instance already isolates the agent home by itself (`resolveAgentHomeDir`, config.ts:550) |

The daemon's `HOME` override was the subtlest of the four and only became visible
once `PODIUM_STATE_DIR` was gone: for a named instance the state root is *derived
from `$HOME`*, so a daemon under a different `HOME` lands on a **different state
root than the server** — here `…/p2777/agent-home/.local/state/podium/p2777`, the
path nested inside itself. It failed loudly only because that directory already
had files in it. On an empty one the daemon would have booted happily onto a
private state root while the rig believed it shared the server's.
`PODIUM_STATE_DIR` had been papering over that the whole time.

Two guards were added so this cannot silently come back:

- `state-root-check.ts` refuses the run if any of the three variables is set, or
  if the rig's computed state root disagrees with `instanceStateDir()`. Verified
  both ways: passes clean, exits 2 under an injected override and under an
  injected path drift.
- The daemon-identification in `drive-verify.sh` and the teardown in
  `drive-down.sh` now match on `PODIUM_INSTANCE`, not on a state path. The old
  spelling would have matched *nothing* once the variable was gone — a verify
  that fails every daemon, and a teardown that silently stops tearing down.

---

## The matrix as it stands

**33 cells driven.** Claude and shell are POD-2874's columns; grok unassigned.
H = headless arm, T = terminal arm.

| # | drive | codex H | codex T | opencode H | opencode T |
|---|---|---|---|---|---|
| A1a | send while idle | **PASS** 4.1s | **PASS** 6.4s | ☐ | **PASS** 7.8s |
| A1b | send while busy | **PARTIAL** | ☐ | **PARTIAL** | ☐ |
| A1c | send to a dead session | **PASS** | ☐ | **PASS** | ☐ |
| A2a | status while working | **PASS** | ☐ | ☐ | ☐ |
| A2b | status at boot | **PASS** | ☐ | **PASS** | ☐ |
| A3 | interrupt mid-turn | **REFUSED** | ☐ | ☐ | ☐ |
| A4a | permission ask | **BLOCKED** | ☐ | **PARTIAL — now STALE** | ☐ |
| A4b | answer twice | **BLOCKED** | ☐ | **PASS — now STALE** | ☐ |
| A5 | transcript | **PASS** | ☐ | **PASS** | ☐ |
| A6a | terminal attach + type | **PASS** | **PASS** | **PASS** | **PASS** |
| A6b | chat↔CLI twice | **PASS\*** | **PASS\*** | **PASS\*** | **PASS\*** |
| A7a | daemon restart | **PASS** | ☐ | ☐ | ☐ |
| A7b | hibernate + wake | **PASS** | ☐ | ☐ | ☐ |
| A8 | logged-out spawn | ☐ | ☐ | **PARTIAL** | ☐ |
| A9 | kill session | **PASS** | ☐ | ☐ | ☐ |
| A10 | driver identity | **PASS** | **PASS** | **PASS** | ☐ |
| — | long turn completes | **FAIL** | **PASS** 61s | **FAIL** | **PASS** 92s |
| — | parked turn survives restart | **FAIL** | **n/a** | ☐ | ☐ |

**FIVE DISTINCT DEFECTS IN THE PRODUCT**, appearing in more cells than that:

| | defect | where |
|---|---|---|
| P1 | POD-2885 — long turns wedge | codex H **and** opencode H; both terminal arms fine |
| P1 | POD-2875 — delivered message destroyed by a restart | codex H; reproduces on opencode H |
| | POD-2862 — one permission opens two asks | opencode H |
| | POD-2870 — no queue position for a chat caller | codex H **and** opencode H |
| | A3 unmeasurable until POD-2885 is fixed | codex H |

Plus **POD-2895**, which was the *merge* rather than the product: the main merge
left `TranscriptFeed.tsx:621` unparseable, so no rig on the epic could pin its
three components. The same hunk had also deleted the queued bubble's body, so a
syntax-only fix would have compiled and rendered an empty bubble — the compiler
points at the last thing the splice broke, the parents show what it deleted.
Fixed at `aad84ec21`; I corroborated it with an independent full build (exit 0)
and a parse sweep that went to zero broken files across all 236 changed files.

**How to read the two columns — and this is weaker than I first stated it.**
Every defect found on codex and re-driven on opencode replicated, and for a while
nothing distinguished them. Then codex **A8** produced a counter-example: removing
`.codex/auth.json` never reached the product at all (`loginRequired` stayed
`false`), where the identical step on opencode flipped it to `true`. The columns
differ in whether a setup step *lands*, which is not the kind of difference the
overlapping cells would ever have shown.

So the two directions are **not symmetric**, and I had been treating them as if
they were:

- **A red found in one column is assumed present in the others until driven.**
  This keeps its full force — every defect so far has replicated.
- **A pass in one column only *suggests* a pass in the others.** This is weaker.
  A8 is a live counter-example, and a pass can be vacuous in a way a red rarely
  is: it can rest on a setup step that silently did nothing.

The practical consequence for anyone reading the ☐ cells: absence of a red is
not evidence of a pass, and a pass driven on one harness is not a licence to skip
the other.

## What is left, exactly

My scope is codex + opencode: 16 rows x 2 columns = **32 cells**.

| | cells | |
|---|---|---|
| driven | **26** | codex 15/16, opencode 11/16 |
| never driven | **6** | codex A8; opencode A2a, A3, A7a, A7b, A9 |

Of the driven cells, **A3 is REFUSED** rather than scored — its control needs the
turn observed in flight, and both planes are frozen by then, so it is
unmeasurable until POD-2885 is fixed. **A4a/A4b are BLOCKED on codex**: that
harness raises no approval on this host, controlled against codex run *outside*
Podium with the same flag, so it is the harness and not the product.

Applying POD-1761's file-level analysis of the main merge rather than re-running
everything:

| | what | why |
|---|---|---|
| re-drive | codex column, headless cells | `codex-app-server.ts` moved |
| re-drive | A1a, A1b, A5 on both columns | ten session-module files moved |
| leave | opencode driver cells | `opencode-server.ts` did not move |
| leave | A6a, A6b terminal arm | `generic-pty` did not move |
| done | the POD-2885 wedge | already re-confirmed at the merged tip |

New *defects* can now only come from those six never-driven cells. A re-drive
turning red would be a regression the merge introduced — a different and more
alarming finding than a new defect, and worth reporting as such.

---

## The six undriven cells — three driven, three still blocked

Driven **2026-08-26 16:21–16:35 CEST** under POD-1761's stale-bundle exception
(ruling 16:20 CEST): rig pinned at `372ae4de2`, HEAD at `f92a8891d`, drift
confined to `apps/web/.../TranscriptFeed.tsx` and `TurnPreview.test.tsx` — every
runtime path byte-identical, and none of these cells involves a browser.
Host at drive time: load 33–42, swap-out 0, 2.8–3.6 GB available (CPU
contention, not memory starvation). All three are presence/absence cells, not
latency ones.

| cell | verdict | |
|---|---|---|
| codex **A8** logged-out spawn | **REFUSED** | prediction was PARTIAL — **wrong**, see below |
| opencode **A7a** daemon restart | **PASS** | as predicted |
| opencode **A9** kill session | **PASS** | as predicted |
| opencode **A7b** hibernate + wake | **PASS** | as predicted |
| opencode **A2a** status while working | **FAIL** | prediction was PASS — **wrong**; filed POD-2902 |
| codex **A2a** re-measured | **PASS** | the original PASS used the wrong instrument |
| opencode A3 | **not driven** | needs `drive.ts` **and** POD-2885's fix, which has not landed |

### An exception that expired, which is not the same as a fix that landed

POD-1761 ruled at **16:20 CEST** that these cells could be driven at pin
`372ae4de2` despite a stale bundle, because the drift was *"confined to two
`apps/web` files, every runtime path byte-identical"*. That was true when granted.

Recomputing the same diff at **18:20** — two hours later:

```
git diff --name-only 372ae4de2..HEAD -- apps packages scripts
  apps/server/src/modules/interactions/service.ts     <- the permission/ask path
  apps/server/src/relay.ts                            <- the socket plane every probe drives
  … plus test files and the two apps/web files
```

`interactions/service.ts` is **A4a and A4b territory** — the ask being raised,
enumerated, answered, and answered twice. So the exception's own basis is gone,
and the readings taken under it are stale. **A4a (PARTIAL) and A4b (PASS) on
opencode are marked stale rather than left looking current.**

**The check has to be "is the exception still true", not "was it true when
granted."** A ruling is a statement about a tree at a moment; the tree keeps
moving. This is the mirror of the blocked-cell trap — there, a *blocker landed*
and made a cell drivable; here, *drift accumulated* and made a permission expire.
Both are invisible unless something recomputes, which is why `blocked-cells.sh`
now carries the exception as a row.

The other cells driven under the exception — A7a, A7b, A8, A9, A2a — sit on paths
that have **not** moved, so by POD-1761's own file-level method they still count
and are not being re-run.

---

### A6b\* — three clauses measured, one I cannot measure

I went back to A6b because it passed comfortably on all four columns and the
coordinator's rule is that **comfort is the signal**. The row asks for four
things; I had been scoring **no scrollback corruption** with
`screen.includes(marker)` — a single substring presence test.

**That check is blind to the defect the row cites.** POD-2761 is *"the new
interface paints into the old one's scrollback"* — corruption that **adds**
content. A presence test cannot see an addition, a duplication or an interleave;
every one of those leaves the marker exactly where it was. The check could not
fail.

So I built a stronger one, and it was wrong in the other direction:

| instrument | verdict | why it is unsound |
|---|---|---|
| v1 `includes(marker)` | PASS | cannot fail — blind to additions |
| v2 marker count `=== 1` + line-order subsequence | FAIL | the baseline screen already contains the marker **twice**, and a TUI legitimately **repaints and reflows** |

Between them they bracket the problem without solving it: **v1 cannot fail, v2
cannot pass.**

*And v2's first run nearly became a filed regression.* It showed marker counts of
2 → 6 → 6 → 10 and line counts of 20 → 34 → 48 — every CLI switch adding content,
which is exactly POD-2761's signature. It was **my own buffer**: `Chat.screen`
only ever appended, while the server replays its whole output log on every
attach, so each re-attach concatenated another copy. A non-resumed attach means
*rebuild your screen*, not *append to it* — the transcript side had always
honoured that (`reset` clears `items`), and the terminal side never did. The
asymmetry is what hid it: one plane accounted correctly, the other silently
accumulating.

**The clause is now reported UNMEASURED rather than scored**, with both failed
instruments named. Distinguishing "the old client's scrollback is still underneath
the new paint" from "the TUI repainted, as TUIs do" needs a terminal emulator's
screen model — the real client renders into xterm.js and compares *screens*; this
rig concatenates *bytes*. Reporting v2's FAIL would be reporting my instrument;
reporting v1's PASS would be reporting a check that cannot fail.

The other three clauses — **no restart** (epoch stable, agent pids unchanged),
**correct size**, and **both views work afterwards** — are measured and pass. That
is what the `*` means.

---

### Four times I mis-scoped my own tooling

Written down together because the pattern is the finding, not any one instance.

| I believed | actually |
|---|---|
| A7b needs `drive.ts` | self-contained; needed nothing but a session |
| A2a needs `drive.ts` | self-contained; the badge is a session-row field |
| switching arms needs a bundle rebuild (and so the lock) | the arm is **daemon-level**; a daemon restart flips it |
| A3 needs `drive.ts` and the lock | the `interrupt` probe reads exactly one field off the context — `ctx.sid` — and builds its own socket and its own turn |

Every one was an assumption about **my own rig**, not about the product, which is
the harder kind to catch because I wrote the thing I was assuming about. Three of
the four cost a cell real waiting time.

The generalisation: **grouping by FILE is not grouping by DEPENDENCY.** Three
probes living in `drive.ts` does not make them need `drive.ts`. The check is
cheap — read what the thing actually reads — and I did not do it until the third
repeat.

`a3.ts` now exists as a standalone probe, so when POD-2885 lands A3 needs neither
`drive.ts` nor the heavy lock. And the cell has a built-in signal: **while the
wedge is unfixed it must REFUSE**, because its control is the turn observed in
flight and both planes freeze within ~20s. The refusal turning into a score is
itself the evidence that the wedge fix reached this path.

---

### A10 half 2 — a second expired blocker, found by my own checker

A4a taught me that a BLOCKED cell is the reading nobody revisits, because a
documented cause makes it look settled when it is only deferred. So I wrote
`blocked-cells.sh` to turn POD-1761's "when the blocker lands, re-check the cell"
rule into a command rather than a memory — it checks for the **runtime change**
in the paths that would carry each fix, never for a ledger row.

**Its first run exposed a blind spot in itself.** It asked only "has the fix
landed *since my HEAD*", which finds a blocker that lands in future and misses one
that landed *before* my HEAD and whose cell I never went back to. It listed A10
half 2 as "still blocked" by POD-2853 — a fix already in my own tree. That is the
exact A4a situation the rule was written for, reproduced by the tool meant to
catch it.

Fixed, and the cell driven. The arm is a **daemon-level** setting, so flipping it
needs a daemon restart, not a bundle rebuild — no lock required:

```
daemon restarted with PODIUM_RUNTIME_DRIVER=generic-pty
  driverId           generic-pty
  driverFamily       terminal
  status             live      spawnFailure (none)
  demoted: true   and reports its identity while alive: true
```

**A10 is now fully PASS.** Its second half had been PARTIAL since the first drive
because POD-2853 killed the demoted session before it could report anything — the
escape hatch demonstrably worked, but what it demoted *to* could not be read.

---

### A4a — a blocked cell whose blocker expired, and swapped for another

A PASS is the reading nobody revisits. **A BLOCKED cell is the same trap in the
other direction**: it costs nothing to leave alone and it quietly stops being
true. A4a was PARTIAL because POD-2853 meant no client terminal was ever hosted;
that landed hours ago and A6a/A6b now pass on both arms, so I extended the probe
to drive the terminal half.

It refused at once — the turn never ran. **Opening a second viewer on the native
view parks the chat send**, which is POD-2875. So A4a has swapped one blocker for
another and still cannot be completed.

**The refusal was the finding, and it widened POD-2875 materially.** I had filed
that defect as *the sender has the CLI view open*. Two clients, one variable —
the **second** viewer's mode, with the sender in chat both times:

| second viewer declares | send returned | nonce arrived |
|---|---|---|
| `chat` | `{"ok":true,"disposition":"delivered"}` | **yes** — 2 items, 2 deltas |
| `native` | `{"ok":true,"disposition":"delivered"}` | **no** — 0 items, 0 deltas |

It is **any viewer**, not the sender. The real case is an operator with the CLI
open on their desktop and chat open on their phone: the phone shows a delivered
tick for a message that will never run, and the person holding it cannot see what
is causing it. The narrow end still holds — a client that never declares a view
does *not* park, despite the server defaulting `viewModes` to `native` — so the
bounds for a regression test are: undeclared passes, explicit-native-by-**any**
client parks.

---

### A2a — the cell I had scored with the wrong instrument

The row asks for the **status badge**: "`working` within 2s of turn start, `idle`
after end; no flicker-idle mid-turn". codex A2a was originally PASSed off the
`stream` probe — 51 preview frames, monotonic, fine watch acquired. All true, and
none of it is what the row asks. A session can stream perfectly while its badge
sits at `idle`; this rig has recorded exactly that on the terminal arm (13,250
characters produced while `phase` read `idle` at all 60 polls). Re-measured
against the phase itself:

| harness | load | send round-trip | first `working` |
|---|---|---|---|
| opencode | 17.25 | 484 ms | **2744 ms** |
| opencode | 21.04 | 43 ms | **3033 ms** |
| opencode | 21.44 | 222 ms | **3201 ms** |
| opencode | 17.84 | 505 ms | **3568 ms** |
| codex | 20.77 | 156 ms | 398 ms |
| codex | 19.84 | 144 ms | 365 ms |
| codex | 18.34 | 337 ms | 205 ms |

**The host does not explain it, and the round-trip column is how that is
checkable.** The round-trip is a proxy for how responsive the box was at that
instant; it varies **12×** across these runs while opencode's badge latency stays
in a tight 2744–3568 ms band and codex's in a tight 205–398 ms band. The run with
the *fastest* round-trip (43 ms) still took 3033 ms to show `working`. Both
harnesses ran at load 18–21 on the same machine within minutes of each other.

opencode's other two clauses pass: no flicker-idle mid-turn, and it does return
to `idle`. Filed as **POD-2902**.

*And the clock started in the wrong place first.* The original probe set `t0`
before `sessions.sendText`; on a loaded box that call took ~3.2 s to return, so
the reading was *round-trip + badge latency* scored against a bar covering only
the second half, and opencode came out at 7927 ms. The clock now starts when the
send is **accepted**, with the round-trip reported separately — which is also
what makes the host-independence argument above checkable rather than asserted.

**A7b** turned out not to need `drive.ts` at all — it is self-contained, so it
was driven standalone like A7a/A8/A9, with the pin verified by hand and the
exception printed. Parked in 217ms, woke live in 7.0s, conversation pointer
`conv_40b14e16-…` identical either side, the word recalled, transcript kept.
Three controls: context planted, *really* parked (read from the row's own
`hibernated` status, not from the call returning ok), and the post-wake turn
answered.

*Host at that drive:* load 16.7, 3.3 GB available, but **swap-out 7,320 KB/s** —
the box was under memory pressure again. The verdict is presence/absence (did it
come back, is the pointer the same) and holds; the timings in it (11.9s plant,
8.2s recall) are inflated by that pressure and should not be quoted as
performance.

### codex A8 — a vacuous PASS I caught, then a refusal

The first run scored **PASS**. It was worthless. With `.codex/auth.json` moved
aside the session *still* bound `codex-app-server`, `loginRequired` stayed
`false` and `condition` was empty — so the product was not demoting because
nothing had been taken away as far as it could tell. "It did not silently take
the old path" was a true sentence about a measurement that never happened.

The probe had one control — *with* the credential, the harness binds its server
driver — and needed a second: **the credential's absence must actually reach the
product.** Moving a file is an action on the disk; being logged out is a state of
the product, and only the product can report it. `loginRequired` is its own
readout and it *did* flip for opencode, so this is not a bar nothing can clear.
With that control added the cell correctly **REFUSES**.

Not a product defect on its face — the likeliest cause is that the running
app-server child had already authenticated and was reused. That would be worth
its own cell; it is not this row's question.

*And a bug I wrote and fixed within a minute:* `process.exit()` does not run
`finally`, so the first refusal path left the credential **parked**. The next
codex drive would have run against a half-logged-out agent home with nothing
saying so. Every exit path restores it now. The refusal was the safest-looking
path in the file and the only one that leaked.

### A7a and A9 on opencode

```
A7a  plant "CODEWORD-085OMA" -> "OK" in 18.2s
     conversation conv_6afaa729-…  daemon pid 2724322 -> 2928216, reconnected
     after restart: same pointer, transcript kept the exchange
     recall -> "CODEWORD-085OMA" in 5.0s      C1, C2, C3 all fired

A9   2 processes owned by the session (incl. `opencode serve`, 511 MB)
     sessions.kill -> row gone entirely; 0 of 2 alive after 15s
     0 orphans after the full 300s; rig infrastructure 2/2 intact
```

*A pin detail worth recording because it looks broken and is not:* A7a restarts
the daemon, and `restart-daemon.sh` spawns it at HEAD. So from that point the
components name **two shas** — server/bundle `372ae4de2`, daemon `f92a8891d`.
The diff between them is the same two `apps/web` files, so all three still run
identical runtime code.

### Why the last three are still blocked

A7b, A2a and A3 are driven through `drive.ts`, which shells out to
`drive-verify.sh` — and that refuses, correctly, because its leg 2 requires the
worktree to sit at the commit the processes were spawned at. I started building a
runner to carry the exception through, and **deleted it**: it could only work by
adding a bypass flag to `drive.ts`, which is the same weakening the ruling
rejected, moved into the caller. The honest route is a rebuild at a frozen HEAD,
which needs `test:heavy`.

---

## Predictions for the six undriven cells, recorded BEFORE driving them

Written down while blocked on the heavy-work lock, so that when these run the
results are falsifiable rather than rationalised afterwards. Where a prediction
is wrong, that is the interesting outcome and it will be reported as one.

| cell | prediction | why |
|---|---|---|
| opencode **A3** interrupt | **REFUSES**, same as codex | its control needs the turn observed in flight; opencode wedges the same way (POD-2885), so both planes are frozen by the time the control samples. If it instead SCORES, the wedge is not identical across harnesses and that matters to POD-2885. |
| opencode **A2a** status while working | **PASS** | codex passed with 51 preview frames; opencode's preview plane demonstrably works for its first ~20s before the wedge. A2a and the wedge are the same behaviour at different timescales. |
| opencode **A7a** daemon restart | **PASS** | codex passed; opencode's resume path is exercised by A7b already. |
| opencode **A7b** hibernate + wake | **PASS** | it passed on codex and POD-2775 fixed opencode's adopt path specifically. |
| opencode **A9** kill session | **PASS** | codex passed; the kill path is shared, not per-driver. |
| codex **A8** logged-out spawn | **PARTIAL**, same as opencode | the demotion should be declared (`condition`, `requestedDriverId`, `loginRequired`) with no login affordance on the session, because the missing affordance is a contract-level gap the catalogue already declares absent — not a per-driver one. |

Five of six predict the columns keep agreeing. **The one I would most like to be
wrong about is opencode A3**: if it scores where codex refuses, the two wedges
differ in a way POD-2885 needs to know.

Two of these six are timing-sensitive (A2a, A3) and will be driven **last**, with
host load and swap stated alongside the result.

### How a re-drive result will be classified

The stale re-drives are a different kind of measurement from the six above, and
the two must not land in the same bucket:

- A cell that has **never been driven** coming back red is a **new defect**.
- A cell that **passed before the merge** and fails after it is a **regression the
  merge introduced** — a different finding with a louder headline, and it goes to
  POD-2876 rather than into the defect count.

Two waves of merge fallout have already landed (a syntax error that also deleted
an element body, then type-level plumbing), so a third is not unthinkable. Any
re-drive that turns red will say which of the two it is, and name the commit
range it regressed across.

---

## The cells that were driven

### A1a — send while idle · codex · headless · **PASS**

```
BOUND DRIVER   codex-app-server (family server)
SENT           Reply with exactly this word and nothing else: PODIUM-UWDA2E.
SEND ACCEPTED  {"ok":true,"disposition":"delivered"}
REPLY          arrived after 9132ms
ASSISTANT TEXT 13 chars: "PODIUM-UWDA2E"
control        FIRED — 2 transcriptDelta frames; prompt echoed on transcript
```

A blank session cannot produce that nonce by luck.

### A7a — daemon restart · codex · headless · **PASS**

```
PLANT          "CODEWORD-BJQX4N" → replied "OK" in 5608ms
conversation   conv_0974dda8-be5e-4994-9abc-eae861126edc
RESTART        daemon pid 1772726 → 1783873, reconnected
AFTER          status live, driver codex-app-server
conversation   conv_0974dda8-be5e-4994-9abc-eae861126edc   ← identical
transcript     kept the pre-restart exchange
RECALL         "CODEWORD-BJQX4N" in 5096ms
```

Three controls, all fired: the codeword was planted, **the daemon pid actually
changed**, and the recall turn was delivered. Both the codeword *and* the
conversation pointer are checked — POD-2775's reviewer found that mutating a
resume to a stranger's thread id left 269 tests green, so a codeword alone is
too weak a signal.

**Mutation-checked, both restored byte-identical:**

| mutation | result |
|---|---|
| recall checks a codeword that was never planted | **FAIL** (was PASS) |
| restart script reports the same pid — nothing restarted | **REFUSED**, control C2 |

### A4a — permission ask · opencode · headless · **PARTIAL**

Chat half **PASS**: the ask is enumerable via `interactions.list` while open (not
only on the stream), carries a typed payload (`toolName=bash`,
`canAlwaysAllow=true`), is answerable with `allow-once`, and answering resolves
it and lets the tool run exactly once.

Terminal half **BLOCKED**: the row requires the same ask in the terminal and
answering to resolve *both*. The native terminal is never hosted on this rig.
**A chat-only pass is not an A4a pass**, so the cell is PARTIAL, not PASS.

One blemish, filed as **POD-2862**: a single permission opens **two** asks — the
protocol's structured one, and a `screen-classifier` copy that has no screen to
classify on a server driver and carries the whole shell command line in its
`toolName` field. Answering the real one does not clear the copy.

### A4b — answer twice · opencode · headless · **PASS**

Second answer returns `{"ok":false,"reason":"already-answered"}`; the tool did
not run again (1 file before, 1 after).

*A correction I made against myself:* the probe originally demanded a **thrown**
error and scored this as FAIL. The row asks for "a typed error, not a double
action" — a discriminated result carrying a machine-readable reason is typed, and
requiring a particular transport for the typing is a requirement the row never
made. The widening is fenced: the classifier is run against the **first** answer
too and must call it *not* a refusal, so it cannot degrade into "anything
counts". That control fired (`the FIRST answer classifies as: not a refusal`).

### A4a/A4b — codex · **BLOCKED**, with a control

Codex raises no approval at all: its app-server child runs with
`sandbox_mode="workspace-write"` and wrote to `$HOME` without asking.
**Control:** codex does exactly the same *outside Podium*, same flag, same host —
so this is the harness on this box, not Podium's ask plane. Reported BLOCKED, not
FAIL.

(Also cost a run: the first target was under `/tmp`, which codex's
`workspace-write` sandbox already permits. Outside the cwd is not the same as
outside the sandbox.)

### A6a — terminal attach and type · codex · **BLOCKED on both arms**

**Terminal arm** — loud:

```
status        exited        exitCode -1
spawnFailure  /home/mgw/.local/state/podium/p2777/bin/abduco exited 1:
              create-session: File name too long
label         podium-p2777-2591ded6-bfe5-42d7-965b-80d99fd9916f
```

**Headless arm** — silent, and this is the worse shape:

```
status        live          driverId codex-app-server
spawnFailure  null          exitCode null
attached      {"resumed":false,"outputSeen":false,"epoch":0,
               "geometry":{"cols":120,"rows":40}}
terminal bytes in 25s: 0
```

The client is told the attach **succeeded**. The cause reaches no client surface
at all — only the daemon log has it:

```
[warn] pty:abduco     systemd scope unavailable; session will NOT survive a podium restart
                      label=podium-cx-attach-28651e0a-…  (53 chars)
                      err=systemd-run exited 1: create-session: File name too long
[warn] daemon:host    could not host a Codex client terminal
[warn] daemon:session could not attach the native client terminal
```

The probe **refuses** rather than reporting "keystrokes did not echo": a silent
screen and a session that never had a terminal are different findings, and the
control cannot tell them apart. `outputSeen=false` is the product's own agreement
that the terminal has printed nothing since spawn — the exact signal the
catalogue (`driver-capability-catalog.md:278`) says is needed to distinguish
"attached but silent" from "lost the replay window".

*A correction I made against myself:* the first version of this probe never sent
the `viewState` frame the browser sends, so the server was never told any view
was open. Reporting a blank terminal without it would have been a rig bug wearing
a finding's clothes. Adding it changed nothing about the verdict — but it had to
be added before the verdict could be trusted.

---

### A1b — send while busy · codex · headless · **PARTIAL**

```
CONTROL        phase reached 'working' in 587ms  (the probe refuses otherwise)
second send    {"ok":true,"queued":true,"disposition":"queued"}
position       ABSENT from the return AND from every frame on the socket
               (turnPreview=15 sessionAgentStateChanged=2 transcriptDelta=2
                attached=1 welcome=1 machinesChanged=1 approvalsChanged=1
                hostMetricsChanged=2 presenceRoomState=1 presenceRoomDelta=1)
reload         websocket closed and reopened — the message survived
delivered      the queued turn ran and answered with its nonce
```

*A correction I made against myself:* the first scoring was `delivered &&
saysQueued → PASS`, which silently dropped the two words "with position" from the
row. Not losing a message and being able to say **where in the queue** it is are
different promises. Filed as POD-2870 — and the position is not missing by
accident: `command-plane.ts:459` narrows the chat reply to four pinned keys, with
a comment deferring the wire change.

### A1c — send to a dead session · codex · headless · **PASS**

```
CONTROL        a send to this session WHILE ALIVE was answered
after kill     the row is gone entirely
send to dead   {"ok":false,"reason":"dead-lettered: session no longer exists",
                "disposition":"dead_letter"}
```

A typed refusal naming the situation, and the forbidden outcome — silent
acceptance into a black hole — did not occur.

### A2b — status at boot · codex · headless · **PASS**

Sampled from the moment of creation rather than once at the end, because the row
is a claim about the whole window and a late sample cannot see a session that
spent its first seconds saying `working`:

```
t+   253ms  status=starting  phase=(blank)  driver=(none)
t+  2406ms  status=live      phase=idle     driver=codex-app-server
```

Never `working` before use; never blank once a driver was bound.

### A5 — transcript · codex · headless · **PASS**

```
tool Bash    toolUseId: true   result: true   "TRANSCRIPT-BF81OQ\n"
reload       live had 4 items; a fresh socket was served 4; 0 missing
             the nonce is still in the reloaded history
```

*A correction I made against myself, and the one that would have done the most
damage.* The first version looked for a following item with role `tool_result`,
found none, and scored **A5 FAIL — "tool calls paired to results: false"**. That
would have gone into this report as a product defect. The real shape carries the
call and its output on the **same** item (`toolInput` + `toolResult` +
`toolUseId`, with `text` empty). I dumped the raw items rather than trusting my
own verdict. The item shape is now declared in `rig.ts` so the next probe reads
it instead of guessing. `toolUseId` is checked too — a result with no id to tie
it to a call satisfies "a result is present" while pairing nothing.

### A9 — kill session · codex · headless · **PASS**

```
CONTROL   2 processes appeared for this session, attributed by /proc environment:
            codex app-server …            141MB
            /bin/sh /usr/bin/lsb_release  (a grandchild the agent spawned)
KILL      sessions.kill → row gone entirely
          0 of 2 alive after 15s
          0 orphans after 300s
          2/2 rig infrastructure processes still alive
```

Every number from `/proc`, attributed by environment — never by command-line
pattern, since other instances on this box run identically-named binaries and a
`pkill -f codex` would take the operator's own sessions down while reporting a
clean sweep. The session row's opinion is recorded but never the verdict, because
the row says "check the process table, not the UI".

*A correction I made against myself:* the first run drove `sessions.stop` and
reported PASS. The tree was gone, so the observation was true — but stop came
back `status=hibernated stopReason=parent`, which is a **park, not a kill**. A
park that tidies its processes says nothing about whether a kill does. Re-driven
against `sessions.kill`; the verb is now a parameter and the report names it.

### A10 — driver identity · codex · **PASS / PARTIAL**

Half one **PASS**: `driverId=codex-app-server`, `driverFamily=server`.

Half two **PARTIAL**: under `PODIUM_RUNTIME_DRIVER=generic-pty` — read back out
of the *running* daemon's `/proc/<pid>/environ`, so it is the daemon's arm and
not a script's intention — the session did **not** bind a server driver. It took
the abduco path and died there. The escape hatch demonstrably demoted; what
cannot be read is the demoted session's reported identity, because POD-2853 stops
it surviving long enough to report one.

---

### The headline cell — a parked turn is lost, and only on headless

```
HEADLESS (codex-app-server)
  sent under a declared native view -> {"ok":true,"disposition":"delivered"}
  after 45s     0 transcript items, 0 deltas, nonce absent, phase idle    C1 parked
  daemon restart  pid 2156779 -> 2163850, reconnected                     C2 real restart
  afterwards, chat view declared:  parked turn arrived = FALSE, 0 items
  a FRESH turn on the SAME session: answers fine                          C3 session healthy

TERMINAL (generic-pty), one variable changed
  sent under a declared native view -> {"ok":true,"disposition":"delivered"}
  after 45s     2 transcript items, 2 deltas, nonce PRESENT, phase idle
```

The probe **refuses** to score the terminal arm — with nothing parked there is
nothing whose survival could be measured — and that refusal is the finding:
`generic-pty` does the right thing under exactly the conditions where
`codex-app-server` parks and then loses the message. Three outcomes are reported
separately (LOST / SURVIVED / INCONCLUSIVE) so "the session died" can never be
read as "the message was lost".

*A correction I made against myself:* I first filed this as a reporting defect
and offered it as waivable, because I had watched the parked turn drain when a
chat view was declared. That drain only works if nothing restarts in between.
The restart question — which POD-1761 asked for — turned a reporting defect into
data loss.

### A6a and A6b — the two cells that were blocked, now green on both arms

```
A6a codex/headless   3998 bytes on attach; echo; resize repaint 1854B each way;
                     second viewer 3264B, 10/11 shared tail lines incl. the typed mark
A6a codex/terminal   5812 bytes; 12/12 shared lines
A6b both arms        epoch stable at 0 across four switches; scrollback marker
                     survived every one; geometry stable; chat AND CLI both work after
```

The arms differ in one recorded way: the **headless** arm adds three processes per
CLI switch (`abduco -n podium-cx-attach…`, `codex resume …`, `abduco -a …`) and
tears them down again; the **terminal** arm adds none. That is the client
cold-start the catalogue already declares absent for server drivers — recorded,
not scored.

*Two more corrections against myself, both on A6b.* I counted the attach client
as the agent and reported "no restart: false"; two attempts to separate them by
command-line pattern both failed, because the client runs the same binary with
the same `--listen` shape. The census is now taken while **chat** is declared,
when no view process exists at all — behaviour, not pattern-matching. And neither
terminal-view probe primed the TUI: on headless there is no TUI in the way so the
omission never showed, and the first terminal run reported "chat stopped
answering" over 599,437 bytes of a dialog repainting.

---

### The long-turn wedge — three arms, one prompt

```
A. HEADLESS (codex-app-server)                 WEDGES
   t+11s  working  previews=29  transcriptChars=0
   t+21s  working  previews=77  transcriptChars=0    <- preview plane freezes here
   t+31s..t+422s   previews=82  transcriptChars=0    <- 400s, not one more frame
   FINAL  working  items=1 (the user message only). Never completes.

B. TERMINAL (generic-pty), one variable changed  COMPLETES in 61s
   screenBytes 30468 -> 90393 growing throughout, then idle, transcriptChars=12291

C. CODEX DIRECTLY, OUTSIDE PODIUM, same binary   COMPLETES in 83s
   exit 0, 31,065 bytes, runs to "400 — The number 400 is an integer."
```

*A control failure worth recording rather than dropping:* my first attempt at arm
C was invalid — `codex exec` was waiting on stdin and timed out at 420s having
produced 39 bytes. Had I not read the output I would have concluded "codex stalls
outside Podium too" and closed the finding. The 83s figure is the re-run with
stdin closed.

This also explains **A3**. The interrupt probe's control requires the turn
observed in flight immediately before the interrupt — previews growing or
transcript growing. On headless both are frozen by then, so the control cannot
fire and A3 correctly refuses. Re-driven alone on a clean session to rule out the
shared streaming turn; it refused identically.

### A8 — logged-out spawn, and a wrong FAIL I had to take back

The probe first reported **FAIL**: "a logged-out opencode SILENTLY became a
generic-pty session", i.e. a POD-2772 regression. **It is not silent.** I had
checked `agentState.error`, `spawnFailure` and `status`, found nothing, and
concluded the product said nothing. Dumping the *whole* row showed it says it
plainly:

```
condition:          "logged-out"
requestedDriverId:  "opencode-server"   beside   driverId: "generic-pty"
accounts.list:      loginRequired: true
machines.list:      login.state: "out"
```

"The product says nothing" is a claim about *every* surface, and it cannot be
made from the two you happened to read. Corrected to **PARTIAL**: the demotion is
declared as requested-versus-actual and the account readout asks for a login, but
`interactions.list` is empty — nothing on the session offers to log you in. The
catalogue already declares that gap (`login(harness, method)` absent). The second
half of the row — "after login, the next session lands on the server driver" — is
**not driven**, because a real OAuth login would either mint credentials this rig
must not mint or rotate the operator's own token mid-release.

---

## Three measurements sent to POD-2853

1. **No named instance can fit, regardless of its name.** Measured by running the
   vendored abduco directly at the product's own default paths:

   | id | composed path | bytes | abduco |
   |---|---|---|---|
   | `a` (shortest legal) | `…/podium/a/runtime/abduco/abduco/mgw/podium-a-<uuid>@flatblock` | 113 | File name too long |
   | `p2777` | … | 121 | File name too long |
   | `operator` | … | 127 | File name too long |
   | `default` | `~/.abduco/podium-<uuid>@flatblock` | 71 | **exit 0** |

   The budget, derived and then matched against all three measurements exactly:
   the constant part is 90 bytes, so `HOME + 2·len(id) + len(user) + len(host)`
   must be ≤ 17. With `mgw`+`flatblock` that leaves `HOME + 2·len(id) ≤ 5` — a
   one-character id needs a `HOME` of 3 bytes. `len(id)` appears **twice**: once
   in the directory, once again in the label prefix.

2. **The headless path has the same defect with less rope.** `codex-app-server`'s
   socket is `…/podium/<id>/runtime/codex-app-server-sockets/<12hex>-<12hex>.sock`
   — 94 constant bytes. Measured by binding real unix sockets: **107 binds, 108
   fails**. So any instance id longer than 13 characters loses the codex headless
   driver too, and `INSTANCE_ID_PATTERN` allows 32.

3. **On the headless arm it is completely silent**, and the client-terminal label
   (`podium-cx-attach-<uuid>`, 53 chars) is *longer* than the session label (49),
   so the native view overflows by 4 more bytes than the spawn does. Whatever
   budget lands has to clear the longer one. The first warning also blames the
   wrong thing — a hard start failure reported as a durability warning about
   restarts.

---

## What this drive does and does not show

**Does:** the chat plane holds up on the headless drivers on an ordinary named
installation. A turn answers with its nonce; a conversation survives a real
daemon restart with its pointer intact; a fresh session reports idle from
2.4 seconds; a send to a dead session is refused in words rather than swallowed;
a busy session queues and then delivers; the transcript pairs tool calls to their
results and a reload serves the same history; a kill leaves no process behind
after five minutes; and a permission ask is enumerable, typed, answerable and
idempotent.

**Does not:** answer the operator's question. Sixty-six of eighty cells are
undriven, the terminal column cannot be driven at all until POD-2853 lands, and
without that column there is no A/B — and "better" is a comparison. The previous
run's side-by-side stands only for the configuration it was taken on, which is
not one anybody ships.

**The release rule is "zero Tier-A fails".** Nothing here has FAILED. But three
cells are *blocked* and three are *partial*, and under a rule with no waiver row
neither is a pass. Two of the partials are filed (POD-2862, POD-2870); all three
blocked cells are one issue (POD-2853).

**Four self-corrections, listed together because the pattern matters more than
any one of them.** Each was a verdict this drive was about to publish, caught by
checking the mechanism instead of the number: the probe that asked for a terminal
without telling the server a view was open; the one that demanded a thrown error
where the row asked only for a typed one; the one that scored a park as a kill;
and the one that scored a correct transcript as FAIL because it guessed the item
shape. Three of the four would have been reported as product defects.

---

## Post-integration staleness audit — 2026-08-28 20:30 CEST, pin `9c1cc3621`

APPENDED, NOT OVERWRITTEN. Every reading above stands exactly as taken. This
section says only which of them still describe the product, and the answer is
none of them.

**What was audited.** `git diff --name-only <row-pin>..9c1cc3621`, excluding
`docs/` and excluding `*.test.ts`, narrowed to the code each row actually
exercises rather than to the repository as a whole. The row pins are the ones in
the ledger at the top of this file; the widest is `15cdfa0ea` and the most
common is `372ae4de2`.

**The whole-repo number is useless and is recorded only so nobody re-derives it
hoping for comfort:** 1,247–1,422 non-doc files changed depending on the row
pin. That number cannot distinguish a driver rewrite from a lockfile bump, which
is the entire reason the audit is done per row instead.

**The per-group result, from `372ae4de2`:**

| path group | changed non-doc, non-test files |
|---|---|
| agent-runtime drivers | 9 |
| agent-runtime core (`events.ts`, `runtime.ts`, `index.ts`) | 3 |
| daemon runtime | 13 |
| server sessions module | 22 |
| server interactions module | 1 |
| protocol | 37 |
| pty | 10 |
| transcript | 1 |

**THE STALE SET IS EVERY CELL.** There is no row in this matrix whose exercised
code is unchanged: every group above moved, and every row reads at least one of
them. I looked for a surviving subset specifically so I could report one, and
there isn't a defensible one to report.

**But the shape is narrower than the count, and that matters for what to
re-drive first.** The four largest driver diffs are one change wearing four
hats — `fdfbe9343`, each driver dropping its own replay reader for the shared
trim-safe one:

```
codex/runtime.ts      +13 -32
opencode/runtime.ts   +13 -32
terminal-driver.ts     +7 -34
events.ts             +66  -0
```

Genuinely additional on top of that: `opencode-driver.ts` +29 −13 and
`pty/session.ts` +12 −6.

So the cells whose verdict *depends on the thing that changed* — anything
reading replay or streaming continuity: interrupt (A3), the streaming-delta
cells, the long-turn cells, on both codex and opencode — are stale in substance.
The rest are stale in the weaker sense of having run on different bytes of
nominally the same behaviour.

**I am not promoting the weaker sense to "still valid" on my own authority.**
That distinction is exactly the crack the two uncheckable drives in this epic's
history fell through, and the honest statement is that a cell driven against code
that has since changed is a cell whose verdict is unconfirmed — not a cell that
passed. The coordinator has the choice in writing; whichever way it goes, it goes
in here as a decision with a name on it and not as a silent promotion.

**Gates at the time of writing:** 18.6 GiB available, 79 GiB free on `/` (73%
used — the "root filesystem 100% full" report in circulation is two nights old
and no longer true), swap-in 0 across a 20s sample, load 1.46. All above the
coordinator's 5 GiB/no-swap floor. The only closed gate is `test:heavy`, held by
POD-3026 with ~22m remaining; not queued with `--wait`, per instruction and per
the orphaned-queue-slot failure recorded earlier in this file.

### A4 approval fixture, prepared 2026-08-28 20:32 CEST (not yet driven)

The codex A4a/A4b cells were blocked by the harness rather than by the product:
codex only raises the approval prompt in a directory tree it has never approved,
and re-using an approved tree silently exercises nothing. The operator supplied
the recipe; this is it, built and preserved:

```
/home/mgw/pod2777-a4-approval-fixture-9c1cc3621/never-approved-root/dummy-repo-a4
```

A `git init` with one commit, to be used as the session cwd, with the harmless
command run inside it.

**Why it is genuinely never-approved, stated as a mechanism rather than a
search.** The obvious check — grepping codex's state for the path — proves
nothing, because it depends on whether approvals are recorded per path or per
parent root, and a negative grep would look identical either way. The airtight
argument is simpler: this directory was created at 20:32 with a name unique to
this pin, so no approval record written before 20:32 can name it, whatever the
format. The fixture is single-use in spirit — once codex approves it, it is
spent, and a re-drive needs a fresh uniquely-named tree.

Controls for these cells are unchanged: positive-turn, structured-ask,
native-view, ordering, and the first-answer/second-answer pair. No result will be
claimed unless the live control fires.

### Decision 42, and the derived substantive set — 2026-08-28 20:40 CEST

**Decision 42 (coordinator, recorded):** after the integration, every cell is
UNCONFIRMED. No stale-by-bytes row is promoted to valid. The replay/streaming
cells are driven first; the rest only when justified. This supersedes any reading
of the audit above that treated the weaker class as still-good — it was left
open there deliberately, and this is the answer.

**What "substantive" means mechanically.** The integration's substantive change
to driver behaviour is the trim-safe replay reader: buffers read by monotonic
event sequence instead of array position, so a live stream cannot sleep forever
when the oldest entry is trimmed. A cell is therefore substantively stale if its
verdict depends on reading a live or replayed stream. That is a property of the
probe, not a matter of taste, so it is derived rather than judged:

| probe | reads previews / screen bytes / transcript items | substantive |
|---|---|---|
| `reply` | yes | YES |
| `interrupt` | yes | YES |
| `attach` | yes | YES |
| `interaction` | yes | YES |
| `stop` | no | no |
| `modelSwitch` | no | no |
| `a1`, `a2a`, `a2-a5-a10`, `a4`, `a6a`, `a6b`, `a7a`, `a7b`, `a9` | yes | YES |
| `a8` | no | no |
| `a3` | **no, at file level — and that reading is WRONG** | YES |

**THE FILE-LEVEL GREP GOT `a3` BACKWARDS, AND a3 IS THE MOST STREAM-DEPENDENT
CELL IN THE MATRIX.** `a3.ts` contains none of the stream tokens because it
delegates to the `interrupt` probe in `probes.ts`, and that probe is where every
preview frame and transcript character is counted. A grep over the file that
*runs* the cell says "no"; the import edge says "yes, more than any other row".

This is the same defect class this issue has hit repeatedly and it is worth
naming again: a check that matches on a name rather than on the thing itself.
The correct classification follows the import graph, not the file. Recorded
because the wrong answer here would have dropped the one cell the wedge fix was
made for from the re-drive set — the comfortable answer again.

**So the substantive set is nearly the whole matrix**: everything except A2b,
A8, and the stop/model-switch cells. "Smallest substantive set" turns out not to
be small. That is a fact about how much of this product is a streaming product,
not a scoping failure.

**Commits confirmed on the coordinator tip.** `46f08ca8f` is an ancestor of
`5972db7f2`; `a64d5b86c` is not — because `5972db7f2` IS its rebased twin. Checked
by content rather than by matching subject lines: identical patch-id
(`18f689288938f7fd11a75abae642c525729803ac`) and a byte-identical
`TIER-A-REPORT.md`. Nothing of mine is missing from the coordinator branch.
