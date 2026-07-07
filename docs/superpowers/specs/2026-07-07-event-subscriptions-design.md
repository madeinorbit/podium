# Event Subscriptions — agent-subscribable triggers + configurable Automations

Status: design (approved 2026-07-07). Parent epic: #10 Orchestrator Agents.

## Problem

The steward today reacts to a **fixed, hard-coded** set of relationships: a child
closing nudges its parent; a blocker closing nudges the newly-unblocked dependent.
That is all. Two gaps surfaced in live use:

1. **No signal short of "closed."** An orchestrator that spawned three child agents
   (observed: issue #101 → children #123/#124/#125) got no notification when those
   agents **finished and went idle** (`session.phase = idle, verdict = done`) — because
   nothing auto-transitions an issue to `review`, and there is no idle→notify trigger.
   The children hadn't `closed`, so the parent-nudge never fired. The orchestrator was
   blind to work that was, in fact, done.
2. **No way to ask.** An agent cannot say "tell me when *this* session stops" or "when
   any child in my subtree errors." The only notifications are the two built-ins, and
   they are neither extensible nor configurable.

## Goal

Replace the hard-coded trigger rules with one **subscription** model:

- Everything is a subscription — the current parent-nudge/unblock ship as **default
  subscriptions** (so nothing regresses), and new behaviors (child→review, child
  finished, session lifecycle) are just more subscriptions.
- Agents can **explicitly subscribe** to specific events via a tool belt.
- The user can **toggle** any subscription on/off per relationship and **author custom**
  ones from a menu, out-of-the-box defaults being on.
- The event namespace is **open** so future built-in sources (git) and user-wired
  external sources (Sentry, CI) feed the same system.

## The primitive

```
Subscription {
  id
  subscriber:  { kind: 'session', id } | { kind: 'issue', id } | { kind: 'user' }
  event:       a kind from the open event taxonomy (e.g. 'issue.stage_changed:review',
               'session.finished', 'ext.sentry.issue')
  source:      { kind: 'relationship', rel: 'my-children'|'my-blockers'|'my-parent'|'my-subtree' }
             | { kind: 'issue', id }
             | { kind: 'session', id }
             | { kind: 'any' }                    // e.g. an operator-wide watch
  delivery:    { nudge?: boolean, notify?: boolean }   // per-subscription, not tied to origin
  message?:    optional template for the nudge/notify text (defaults per event)
  origin:      'default' | 'custom'
  enabled:     boolean
}
```

- **subscriber** — who is notified. `session`/`issue` deliver as an in-session nudge
  (reusing the steward's `sendTextWhenReady`, same live/non-shell/no-resurrect rules).
  `user` (and any `notify: true`) surfaces user-facing (NEEDS ATTENTION / toast).
- **source** — *what is watched.* A **relationship** resolves dynamically against the
  subscriber's issue graph at match time (so a newly-created child is covered with no
  re-subscribe); an **explicit id** watches exactly that issue/session.
- **delivery** — configurable on every subscription, defaults included. Today's NEEDS
  ATTENTION notifications become a future consumer of this same delivery path.

## Event taxonomy (open namespace)

Already flowing in `podium_events` today, so Phase A needs no new emitters:

- **issue.\*** — `created`, `stage_changed` (incl. `:review`, `:verifying`), `closed`,
  `ready`, `needs_human`.
- **session.\*** — semantic events derived from the existing `session.phase` + status
  stream, so subscriptions stay filter-free:
  - `started` (idle→active), `finished` (idle & verdict=done), `waiting` (needs_user),
    `errored`, `stopped` (exited).

Roadmapped (own follow-up issues, Phase D):

- **git.\*** — commit / push / branch / PR (built-in emitter).
- **ext.\*** — a generic authenticated **ingestion endpoint** writes an external event
  into the log under a namespaced kind (`ext.sentry.issue`, `ext.ci.failed`, …), which
  subscriptions target like any other. This is how a user wires Sentry / CI in
  themselves — no filter engine, just more event kinds.

## Mechanism — the steward becomes a subscription dispatcher

The poll loop, durable cursor, coalescing, dedup, drop-don't-wedge, and
never-resurrect guarantees are unchanged. Only the middle changes: instead of the
fixed `TRIGGER_RULES` map, each polled event is matched against **enabled
subscriptions** whose `event` matches and whose `source` resolves to the event's
subject; each match delivers per its `delivery`. The current unblock/parent-nudge
handlers become the seeded defaults, preserving today's exact behavior (including
`causedBySessionId` self-nudge suppression, #116).

Delivery keeps the existing safety envelope: nudges reach only live/starting,
non-shell sessions; comments/audit remain the durable record; coalescing collapses
same-subscriber bursts into one nudge with the latest state.

## Default subscriptions (seeded, all enabled, all toggleable)

| subscriber | event | source | delivery |
|---|---|---|---|
| issue (parent) | `issue.closed` | my-children | nudge |
| issue (parent) | `issue.stage_changed:review` | my-children | nudge |
| issue (parent) | `session.finished` | my-children | nudge |
| issue (parent) | `issue.needs_human` | my-children | nudge |
| issue (dependent) | `issue.ready` (blocker closed) | my-blockers | nudge |

The first row is today's parent-nudge; the last is today's unblock. Rows 2–4 are new
and directly close the gaps above.

## Agent tools

- `subscription_add { event, source, delivery?, message? }` — subscriber defaults to the
  caller's bound issue/session.
- `subscription_remove { id }`
- `subscription_list {}` — the caller's active subscriptions.

Authz: gated by the existing issue-authz capability. A subtree-scoped agent may only
subscribe itself / sources within its subtree; the operator is unconstrained. Custom
subscriptions an agent creates are `origin: custom`.

## Config UI — the Automations view

Lives in the existing **Automations** sidebar view (the stub from #99). Subscriptions
grouped by relationship (Parent↔Child · Blocker↔Blocked · Session lifecycle · Custom).
Each row is a toggle with its delivery (nudge / notify) editable. **"＋ New trigger"**
opens a builder: pick **event → source → delivery → message template** → a `custom`
subscription. Per-relationship on/off is toggling the default rows.

## Phasing

- **Phase A** — Subscription store + dispatcher refactor of the steward; seed the five
  defaults incl. child→review, child finished, child needs_human. Behavior-preserving
  for the two existing built-ins. *(Addresses ask #2 + the idle gap.)*
- **Phase B** — Semantic `session.*` events + the agent tool belt
  (`subscription_add/remove/list`) with authz. *(Ask #3.)*
- **Phase C** — Automations UI: per-relationship toggles, per-subscription delivery,
  custom-trigger builder. *(Ask #4.)*
- **Phase D (separate follow-ups)** — `git.*` built-in source; the `ext.*` ingestion
  seam for user-wired external sources (Sentry/CI).

## Testing

- Dispatcher: table-driven — event × subscriptions → expected deliveries; the five
  seeded defaults reproduce today's steward tests exactly (regression guard).
- Coalescing/dedup/no-resurrect/self-nudge-suppression carried over unchanged.
- Relationship source resolution: dynamic (new child covered), explicit id (exact).
- Agent tools: authz (subtree-only vs operator), add/remove/list round-trip.
- Semantic session events: phase stream → `finished`/`errored`/`waiting` derivation.

## Non-goals (for now)

- Condition/filter language (YAGNI — semantic event kinds do the work instead).
- Migrating existing NEEDS ATTENTION notifications onto this (future; the delivery seam
  is designed to allow it).
