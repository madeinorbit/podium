# POD-1148 — one attribution vocabulary

**Status:** decided and applied
**Issue:** POD-1148 (Two attribution pairs, one vocabulary)
**Found by:** POD-368 audit item 2 — the one real drift that audit found
**Depends on:** POD-1164 (`Capability.actorSessionId` id-space decision)
**Date:** 2026-08-03

## The question the brief left open

> Does the actor's agent arm name the AGENT IDENTITY or the SESSION it acted in?

**It is not a choice. They are the same string.** POD-1164 measured the live mint
and recorded it in `docs/agents/pod-1164-actor-session-id-space.md`: for a Podium
agent session, `AgentIdentityId` and `SessionId` are one minted value, produced
once as a session id and re-branded by `asAgentIdentityId(sessionId)` at every
spawn and receipt path in `apps/daemon/src/binding-store.ts`. The brands separate
ROLE — axis-2 actor versus axis-1 work, per `docs/session-binding-identity.md` —
not id space.

So the premise behind "two pairs, pick one" dissolves. ADR 9 D1's principal
taxonomy and ADR 9 D5 A3's `Capability.actorSessionId` seam are not in tension;
they are two spellings of one id. Neither arm is deleted and neither is a loser.

This is the POD-367 trap read correctly in the other direction. POD-367's rule is
that a shared NAME does not imply a shared fact. Here the names differed and the
types differed, and the fact was still shared — which is why the answer had to
come from the production mint rather than from either type.

## What was decided

**The model's `ActorRef` / `Attribution` is the one field schema. The Outbox is a
narrowing of it, expressed in the type system rather than in a comment.**

```ts
// packages/sync/src/outbox/records.ts
export type OutboxActor = Extract<ActorRef, { kind: 'user' | 'agent' }>

export interface OutboxAttribution extends Attribution {
  readonly actor: OutboxActor
  readonly onBehalfOf: NonNullable<Attribution['onBehalfOf']>
}
```

Three properties follow, and each is the reason the shape is written this way:

1. **`Extract`, not a copy of two members.** A fifth principal kind added to
   `ActorRef` propagates here. A copy would have shadowed it silently — which is
   exactly how the two pairs diverged the first time.
2. **`extends Attribution`, not a parallel interface.** An `OutboxAttribution` is
   an `Attribution` by construction. A change to the field schema that this
   narrowing cannot satisfy is a compile error in `@podium/sync`, not a drift
   nobody notices.
3. **The narrowing is a POLICY, stated.** The Outbox is a client-side queue of a
   principal's own intent, so only the two arms with a human behind them can
   author an entry; `machine` and `system` never queue client work. That is also
   why `onBehalfOf` is non-nullable here while it is nullable on the durable
   field. `inbox.ts` already sets this precedent — a narrower pair that refuses
   an arm is a policy, not a second encoding.

The agent arm converts through named helpers, never a cast:

```ts
actorSessionIdOf(actor)      // OutboxActor -> SessionId | null
agentActorOfSession(session) // SessionId -> AgentActor
```

POD-1164's rule is that the reclassification is always NAMED, so no call site can
invent a second agent id space by accident.

## What was NOT done, and why

**`UserRef` is still `string`.** The old comment on it ("a plain string until
POD-1075 lands the model's `UserId` brand … this module must not mint a second
brand for the same identity") stated a rule and a precondition. The rule is now
satisfied — by IMPORTING the brand rather than waiting for it — and both halves
of the pair are branded `UserId`. But `UserRef` also names the user on surfaces
that are not the pair: `FeedPrincipal`, the grant tables, the bounded send
queues, and the principal an Outbox is bound to. **POD-1075 owns sweeping those
in one pass** (`docs/multi-user-readiness.md` §3.2: a schema is not swept twice),
and branding them as a side effect of an attribution change would be that second
sweep. A `UserId` reads as a `UserRef` on the way out, so the two coexist without
a cast until then.

`WorkflowUserRef` in `packages/commands/src/workflows/ownership.ts` is likewise
untouched: it is a port type on the workflow authority, not a definition of this
pair.

## The one behavioural coupling

`sessionRenameReducer` (`packages/commands/src/sessions/rename.ts`) matches on
the stored actor's kind, and moved from `'agent-session'` to `'agent'`. It cannot
import the type — the reducer is handed `authored` as `unknown` on purpose, and
the direction lint keeps the Replica out of the Outbox module — so the coupling
is a string literal. `rename.test.ts` now builds its fixtures with the model's
`actorAgent` / `actorUser` constructors instead of hand-written literals, so a
rename of the arm reddens the test rather than passing quietly.

`PendingAttribution.actor` in `packages/sync/src/replica/overlay.ts` stays
`unknown`. Its doc used to justify the opacity by "the Outbox owns a union we may
not import"; it now says the value flowing through is the model's, and names the
one consumer that knows the literal.

## Pins, and evidence they can fire

`packages/sync/src/outbox/records.test.ts` — 6 tests. It deliberately does NOT
assert the type relationship (a `satisfies` in the source already makes that a
compile error; re-asserting it at runtime would be mechanism presence). It pins
the runtime edge:

- an Outbox-produced pair PARSES as the durable `Attribution`, for both arms —
  structural assignability does not imply this, since the halves are `.min(1)`
  branded Zod strings;
- a pair carrying the retired `agent-session` spelling FAILS to parse;
- the session ↔ actor conversion round-trips the value unchanged.

**Mutation run (POD-1164's stated bar).** Prefixing the minted id inside
`agentActorOfSession` (`agentIdentityFromSessionId(('agent-' + sessionId) as …)`)
turns 2 of the 6 red — "parses a delegated pair …" and "round-trips the session
id …". Reverted atomically; restored run is 6/6 green.

## Adjacent

- **POD-1075** — owns the `UserId` brand and the principal module; the `UserRef`
  flip described above is its sweep.
- **POD-414** — SessionBinding taxonomy; the axis-1/axis-2 split this decision
  rests on is recorded there and in `docs/session-binding-identity.md`.
- **POD-1164** — the id-space decision this one consumes.
