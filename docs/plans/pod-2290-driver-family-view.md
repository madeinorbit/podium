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
