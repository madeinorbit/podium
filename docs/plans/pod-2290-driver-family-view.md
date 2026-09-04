# POD-2290 — The session view, keyed on driver family

Bug fix landed on the epic branch. The operator's report, from the POD-2245 test drive at
`35790f0ca` (after the POD-2261 default flip): opening an opencode or codex agent showed a
terminal pane stuck on "Starting OpenCode…" **forever**, and that broken pane was the default
view. Chat conversed fine the whole time.

## What was actually wrong

Nothing in the web panel could ask whether a session **has a terminal**. The panel's only
question was `chatCapable` — "does this harness produce a transcript" — and the answer to
"which view do we open on" came from `effectivePanelMode`, whose inputs were the persisted
per-session pick, the per-device default and the `startScreen` setting. Every one of those said
`native` on a desktop.

So a server-driven session opened the native pane, `useTerminalSession` issued a `hub.attach`
for a session no daemon will ever bind a PTY to, the attach was answered by nobody, `ready`
stayed `false`, and `startupOverlay` returned `starting` — permanently. **The infinite spinner
was not a rendering bug; it was an unresolvable wait rendered honestly.**

## Decisions

**1. The fact on the wire is the driver FAMILY, not a boolean, and not `resume.kind`.**
`SessionMeta` gains `driverFamily?: 'server' | 'embedded' | 'terminal'`, projected by the server
in `toMeta()` from the daemon-reported `driverId` via a new manifest lookup
(`driverFamilyForId`, which `driverIdIsServerFamily` is now implemented in terms of).

- *Not a boolean*, because `server` is only one of the two families that mean "no PTY" —
  `embedded` (the SDK loop in a runtime-owned worker) is the other, and a
  `isServerFamily`-shaped flag would need a second flag beside it the day the first embedded
  driver binds.
- *Not `resume.kind`*, although the brief pointed at it as the durable tell. It is durable, and
  it is also a **per-HARNESS** fact: `codex-thread` names PTY-driven codex rows too. The
  daemon's reap guard prefers it because there a wrong guess is cheap (a held park) and the
  right guess is expensive (a second credentialed child). For a **view** the asymmetry inverts:
  a wrong guess takes the terminal away from a session that has one, which the brief forbids.
  Reaps fail closed; views fail open.

**2. Absent means unknown, and unknown means "assume a terminal".** `driverFamily` is transient
exactly like the `driverId` it rides — missing on an older daemon, on a legacy session, before
bind, and on a parked row. `sessionHasTerminal` in client-core is the single place that turns
that absence into a decision, and it turns it into today's behaviour. This is what makes
"PTY sessions must be unchanged" true by construction rather than by inspection.

**3. A session with no terminal opens on chat, over every persisted preference.**
`effectivePanelMode` gains a `terminalCapable` input as **rule 0**, ahead of the saved
per-session pick and the per-device default. Rules 2–4 answer "which of two views did this
operator want"; rule 0 says there is only one view, so there is no preference to honour — a
`native` remembered from before the harness moved off the terminal would strand the operator
again. It is the mirror of the existing rule 1 (a shell has no transcript, so it is always
native), which has always overridden the same saved value for the opposite reason.

**4. The native pane is NOT OFFERED, rather than shown with an honest empty state.** The brief
allowed either. Not-offered wins because the alternative is a permanently dead control on every
server session: a disabled "Native" segment is a promise the product never keeps, and an
explicit "this agent has no terminal" pane is a screen whose only content is an apology for
existing. `panelGates` therefore withholds `modeSwitchOffered` **and** `terminalMounted` — the
mount gate matters on its own, because that is the attach that produced the spinner. The gate
is stated rather than inferred from the mode derivation: a gate that holds only because another
module happens to agree is not a gate.

  *Deferred, not rejected:* the contract's `AttachEndpoint` has a `client` arm for exactly this
  — a harness TUI (`opencode attach`) under abduco in a sibling scope — and the drivers already
  implement it. Wiring the web's native pane to that is a feature (attach v2 shaped), not a bug
  fix, and the epic's non-goals exclude UI work beyond what a flag-switched session needs.

**5. `starting` gets an exit: the new `stalled` overlay state.** Independent of driver family,
`starting` was the one overlay state that could run forever — a spawn that fails before its
session row reconciles has no elapsed time to show (nothing to date it by) and no view switch
to escape through (no row ⇒ nothing known to be chat-capable). That is the shape of the
operator's separate grok report. Past `ATTACH_STALLED_AFTER_MS` (45s, well beyond any attach
that has ever landed) the spinner is dropped and the wait is named, because a spinner is a claim
that something is happening. The clock measures **this mount's wait for its attach**, not the
session's age — opening a panel on an hour-old session starts a wait of zero.

## Where it lives

| Concern | File |
|---|---|
| family from a driver id | `packages/harness/src/registry.ts` — `driverFamilyForId` |
| the wire field | `packages/model/src/entities/session.ts` — `SessionMeta.driverFamily` |
| projection | `apps/server/src/modules/sessions/session.ts` — `toMeta()` |
| "does it have a terminal" | `packages/client-core/src/viewmodels/session-status.ts` — `sessionHasTerminal` |
| which view opens | `packages/client-core/src/ui-state.ts` — `effectivePanelMode` rule 0 |
| what is offered/mounted | `apps/web/src/features/terminal/panel-surface.ts` — `panelGates` |
| the spinner's exit | `apps/web/src/features/terminal/startup-overlay.ts` — `stalled` |

The two spellings of the taxonomy (`DriverFamily` in `@podium/harness`, the zod enum in
`@podium/model`, which may not import harness) are reconciled by exactly one thing: the
assignment in `toMeta()`, where a `DriverFamily` flows into the enum's type. A fourth family
added to the manifests fails there, at typecheck.

---

# Round two — what the operator's live retest found

Round one passed an adversarial code review and **broke within minutes of the operator touching
it**. Both of its findings are the same lesson from different ends: the fix was verified by
people reading code, and the failure was a thing you can only see by looking at a screen.

## What was still wrong

**1. The fix had nothing to read during the window that mattered.** `driverFamily` was projected
from `driverId`, and `driverId` arrives on the `bind` frame — the frame that marks a session
LIVE. Measured on this issue's own drive instance: an `opencode` session sat `starting` with **no
driver fact at all for twelve seconds** while `opencode serve` booted. Rule 2 above ("absent
means unknown, and unknown means assume a terminal") is correct for a legacy row and exactly
wrong for a session that has not started yet, so for twelve seconds the operator got the original
bug, unchanged.

**2. And then it moved under them.** When the fact finally landed, the view yanked from native to
chat and the switcher disappeared — the operator's words: *"the native and chat button
vanished?!"*. A control that vanishes under the cursor is not a state change a person can read as
anything but a fault.

## Decisions

**6. The daemon announces the driver it has DECIDED on, before it starts anything.** New
`driverSelected` daemon→server frame, emitted at each point where the decision exists and the
thing decided upon has not been started: after `resolveRuntimeDriver` returns, and — for a
harness that declares no server driver at all, so never reaches a probe — immediately. The server
records it as `selectedDriverId` and projects `driverFamily` from `driverId ?? selectedDriverId`;
the bind still wins, because a launch that failed and fell back must not be described by the plan
it abandoned.

  This is a DECISION, not a prediction. It is emitted after the policy has run against this
  machine's real probe and login state. Measured on the drive instance, before → after:

  | harness | family known at | binds |
  |---|---|---|
  | opencode | 12s → **0.07s** | `opencode-server` |
  | codex | — → **0.06s** | `codex-app-server` |
  | grok | — → **0.32s** | `grok-acp` |
  | claude-code | — → **0.03s** | `claude-pty` (legacy path, never reports a `driverId` at all) |

**7. A fifth panel state: `pending`.** Where the family is genuinely unknown AND the session is
still `starting`, the panel commits to nothing — one placeholder, no switcher, no PTY mount, no
chat mount. Scoped to `starting` deliberately: a LIVE session with no family is a legacy row, an
older daemon, or a daemon that has not reconnected since a server restart, and every one of those
has a terminal, so they fall through to `live` and behave exactly as before.

**8. The switcher is monotone per session.** Once offered, never withdrawn — even if a late fact
says the terminal is gone, which a re-spawn onto a different driver genuinely can do. What that
costs is a switch to a pane with no PTY, which is why decision 4's deferred "honest pane" is no
longer deferred: it is the landing place that makes stickiness safe, and it says the agent has no
terminal instead of spinning.

## Driven, not just tested

`docs/evidence/pod-2290/` is this issue's own isolated instance (`p2290`, ports 19807/46807/46808,
state `/tmp/pod-2290`), cut from POD-2245's recipe. `drive.ts` walks the operator's exact journey
— *Choose agent and repo → New OpenCode*, then look — in a real browser against real drivers, and
photographs the panel at ~1s (still starting) and at ~19s (live). Shots in
`docs/evidence/pod-2290/shots/`:

- **opencode / codex / grok**: neutral "Starting <Harness>…" with no switcher → the chat view with
  its composer, still no switcher. Nothing appears, nothing vanishes.
- **claude-code** (the control group): the live terminal with real CLI output and the
  **Chat | Native** switcher present, Native selected. The PTY family is untouched.

Deviations from the coordinator's suggested setup, both recorded rather than silent: the state
root is `/tmp/pod-2290` rather than `/tmp/pod-2290-drive` (abduco's socket path budget — the same
`sun_path` hazard POD-2245's env script calls out), and the drive builds the web bundle with
`build:dist` rather than `build` because the bundle-BUDGET check is red at the epic tip for
reasons unrelated to this instance.

---

# Round three — the seam the reviewer drove

Round two was verified live for the journey it was about and still had one window left, found by
re-driving it rather than re-reading it: **`reconnecting`**.

## What was wrong

A server restart rehydrates persisted `live`/`starting` rows as `reconnecting`
(`repository.ts` `sessionFromStoredRow`). Round two held the driver decision **in memory only**,
so after a restart a headless row came back family-unknown — and `pending` is scoped to
`starting`, so it fell through to `live`, where an unknown family reads as "assume a terminal".
The reviewer held the daemon down and photographed the original bug: an OpenCode session on
NATIVE, with the switcher, spinning.

The `stalled` exit could not rescue it, and the reason is worth recording: the attach **had**
confirmed — the server answers it without the daemon — so `ready` was true and the wait fell into
`silent`, which has no exit. The screen read *"Starting OpenCode… / no output yet · 4:35 / Still
attached — some CLIs update themselves…"*, and every clause of that was false at once.

## Decisions

**9. The decision is PERSISTED, not just held.** New `sessions.selected_driver_id` column
(one-line migration) written when the daemon announces its choice and restored on rehydration.
Deliberately not `driver_id`: that one names a *live handle* and must stay transient, or a
restored row would send W4's migrated callers down the receipt path for a driver that is gone.
A `bind` that reports a different driver overwrites the persisted value, because the durable fact
has to describe what actually ran rather than the plan it abandoned.

  *Not* widening `pending` to cover `reconnecting`, which was the other available lever: that
  would blank every PTY panel on every server restart. The reviewer recommended against it and
  the coordinator concurred.

**10. A fourth overlay state, `awaiting-machine`.** For the legacy tail — rows written before the
column, which have no family to restore — the overlay stops describing the harness and names the
actual cause: *"Waiting for &lt;machine&gt; · Podium hasn't heard from the machine running this
agent for M:SS."* No spinner, for the same reason `stalled` has none. Gated by the caller on
`reconnecting` **and** family-unknown, so every row that carries its family — PTY included — keeps
exactly the behaviour it had.

## Gates

Uncached whole-graph typecheck green (0/25 cached). Boundary lint at exactly the 6-line baseline.
Server store shard 377/378, boundary shard `relay.test.ts` 166/166 including two new pins driven
through the **real** rehydration path (a second registry over the same database file — a test that
hand-built the row would have passed against the broken code). Web terminal lanes 179, client-core
810, daemon integration 67, protocol golden 209 **unchanged** — this round adds a database column,
not a wire field.

Two failures are pre-existing and reproduce untouched at the branch point: `branded-ref.test.ts`
(the schema has carried its 8 `.references(` since before this issue) and a `closed database`
teardown flake in the shipping service, which the round-one reviewer disclosed independently.

**Disclosed workaround.** POD-2316's `e4440f600` evaluates `fileURLToPath(new URL(…,
import.meta.url))` eagerly in `test-hermetic-env.ts`; under `apps/web`'s vite transform that URL is
not a `file:` one, so every web lane dies at import before a test loads. The web numbers above were
taken with that single line made lazy **locally and uncommitted**; the file was restored
byte-identical (verified by `git hash-object`) before the commit, and POD-2316 was mailed the
diagnosis. Nothing of theirs is in this change.

## Decision 11 — round four: the arm had to be rendered, not just returned

The live re-review found `awaiting-machine` unreachable on screen: the overlay's headline was a
two-way ternary that knew `stalled` and nothing else, so past the threshold a machine-away session
fell through to `Starting <Harness>…` — no clock, no mention of the machine. The pure-function
tests were all green, because none of them render.

The headline now branches on the arm and carries a body line that names the cause. It is the one
overlay state that does name a cause, and it is entitled to: the row is `reconnecting` and no
driver fact has arrived, so the missing party is the machine, not the harness. `stalled` stays
deliberately silent on cause, because there it cannot tell a failed spawn from an absent machine.

The pin is a COMPONENT test that mounts the panel on a reconnecting family-unknown row, advances a
fake clock past the threshold, and asserts the rendered copy, the clock, and the absence of the
spinner — plus a control: a reconnecting row that HAS a family never mentions the machine. A unit
test on `startupOverlay` could not have caught this, and did not.

**Gates:** the component pin plus the web panel lanes (18 files, 182 tests — up three, on the
epic tip that carries `e0923ddac`, so the hermetic-env workaround of round three is gone).
Typecheck taken on trust: the diff is JSX and a test file.
