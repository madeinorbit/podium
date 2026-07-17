# Agent-to-agent messaging: honest assessment after launch (#237)

Written 2026-07-14, after a day of the unified messaging substrate running live and
generating a cascade of its own bugs. The question that prompted this: *the feature
as launched is spammy and error-prone compared to the simple thing the steward did,
which was robust — except it couldn't reach a stopped agent. Where should we go?*

## What the substrate got right (keep these)

- **Attribution.** Server-stamped sender + envelope. This fixed the original bug
  (an agent's text arriving as if the human typed it) and it held — the invariant
  "unwrapped = operator" is sound.
- **The ledger.** Every bug in this saga was diagnosable from `messages` +
  `podium_events` without reading a transcript. That is the single most valuable
  thing built. It is what made the failures legible.
- **Waking a stopped agent.** The one thing the old steward genuinely could not do.
  Resume-and-deliver-at-first-turn is safe (it's a boundary event) and worth keeping.

## What went wrong — and the pattern

Nearly every defect was in the **delivery mechanism**, not the architecture:

- #468 steward settle-notice **storm** (no once-guard; fyi demanded acks) — spam.
- #471 next-turn injected **mid-turn** instead of at the boundary.
- #473 / #495 a delivered message **auto-answered an on-screen menu** — three rounds
  (decision-layer guard → primitive guard → afterEsc bypass → timing race).
- #463 replying to a migrated message **crashed** on a foreign key.
- Defect B: **"delivered" doesn't mean "typed"** — messages marked delivered that the
  agent never saw (silent loss), because delivery bookkeeping fires when a message
  *enters a queue*, not when bytes reach the agent.
- Ack semantics: **structural ack vs semantic reply** mismatch → the steward nagged
  a sender whose message had in fact been answered, on every settle.

The common root: **the substrate types into a live, stateful PTY** — a terminal that
might be mid-turn, sitting on a menu, draining a queue, or reporting a stale phase.
Injecting into that surface is inherently racy. Every guard was a patch over the same
fragile primitive, and each patch missed a path the next one found.

## Why the steward was robust

The old steward did **less**. It left durable state (comments/beads) and let agents
**pull** it at natural boundaries (prime, stop-hook). It never typed into a live
terminal at an unsafe moment, so there was no menu to answer, no turn to derail, no
"delivered but not typed" gap. Its one real limitation was reach: a stopped agent
never pulls, so it never sees the message.

The launched substrate inverted this: it made **push into live PTYs the default**,
and push is where all the fragility lives.

## Where to go

**Make pull the default; make push the rare, explicit exception.**

1. **Durable + attributed + ledgered core** (keep). A message is a row with a
   server-stamped sender. This is the steward's robustness *plus* attribution.

2. **Delivery is pull-at-boundary by default.** Surface messages via the stop-hook /
   prime / idle — exactly what the steward did well. No typing into a running turn.
   This alone removes #471, #473/#495, and most of #468 by construction: if you never
   type into a live terminal, you can't answer its menu or derail its turn.

3. **Redefine "delivered."** It must mean *the agent consumed it* (surfaced at a
   boundary / read the inbox), not *it entered a PTY queue*. This closes Defect B —
   the silent-loss ghosts — which is arguably the worst defect because it is invisible.

4. **Wake stays** (the steward's gap): resume a stopped agent and deliver at its first
   turn. Safe because it's a boundary.

5. **Push / interrupt is a deliberate, best-effort, rare exception.** Mid-turn
   injection and menu interaction are the genuinely dangerous operations. They should
   be: operator/parent-only, explicitly opt-in per message, and understood to be
   best-effort (they can fail if the terminal state is wrong). They must never be the
   default path, and nothing routine (a courtesy note, a status update, a steward
   fallback) should ever use them.

6. **Cut the notification spam.** The steward fallback should be last-resort,
   coalesced, once-per-message, never for fyi, and it should accept a *semantic*
   reply (a message back to the sender within the thread) as satisfying the ack — not
   only a structural `podium mail reply`. An ack should mean "the thing you asked for
   is done," never "receipt acknowledged."

## The meta-lesson

The substrate's ambition — one mechanism unifying mail, nudge, notification,
session-send, wake, spawn, and interrupt, all pushing into live terminals — created a
large fragile surface that generated more work than it saved in its first day of life
(agents testing agents, steward nagging, runaway spawns, invisible messages). The
steward's restraint was its robustness. The right synthesis is not "revert to the
steward" and not "keep pushing into PTYs" — it is: **keep the durable, attributed,
ledgered core and the wake capability; make delivery pull-first at boundaries; and
treat live-terminal injection as a rare, explicit, best-effort exception rather than
the default.**

Do less into the live terminal. That is where the robustness was.
