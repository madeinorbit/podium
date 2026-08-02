# POD-1164 — Capability.actorSessionId id-space decision

**Status:** decided  
**Issue:** POD-1164 (Capability.actorSessionId id-space conflict)  
**Discovered by:** POD-362 (branded ids across server + daemon)  
**Date:** 2026-08-02

## Decision

**For a Podium agent session, `AgentIdentityId` and `SessionId` share one minted
string.** The brands distinguish *role* (axis-2 actor vs axis-1 work identity), not
a second mint namespace.

- `Capability.actorSessionId` stays branded `SessionId` (POD-362 was correct).
- `Principal.agentIdentity` stays branded `AgentIdentityId`.
- Conversion is a pure reclassification via
  `agentIdentityFromSessionId` / `sessionIdFromAgentIdentity` in
  `packages/model/src/ids/brands.ts`.
- Do **not** widen `actorSessionId` back to `string`.
- Do **not** add a second capability field for agent identity.
- Do **not** treat harness-native hook `agent_id` (`NativeSubagent.id`) as
  either brand.

## Facts measured (not inferred)

| Site | What it holds | Evidence |
|---|---|---|
| Live capability producer | `SessionId` | `sessions/lifecycle.ts#capabilityForSession(sessionId)` keys `this.sessions` and stamps `actorSessionId: sessionId` |
| Every capability consumer | podium session | `command-principal.ts` walks `parentSessionOf`; issues registry stamps `started_by_session`; `session:` provenance keys |
| Sole production mint of agent identity | `asAgentIdentityId(sessionId)` | `apps/daemon/src/binding-store.ts` spawn paths (~1321, ~1338) and receipt paths (~1909, ~2079) |
| Unwired seam | was a cast | `gateway/principal-capability.ts` — no production caller outside its test (grep) |
| `brands.ts` pre-decision claim | wrong | claimed `AgentIdentityId` was harness hook `agent_id` and that `Capability.actorSessionId` carried it "on the relay path" |

## Why not "two fields / map between namespaces"

That option is only right if agent identity is a *different* string from the session
id. Production minting proves it is not: every binding-store spawn writes
`actor: asAgentIdentityId(input.sessionId)`. Mapping would invent a second id
that nothing stores and that every consumer would fail to match against sessions.

## Why not collapse the brands

`SessionId` answers "which work / which pane". `AgentIdentityId` answers "who
acted" on the actor half of ADR 9 D5 A3's pair (`ActorRef.agent`). They share a
value for agent sessions because SessionBinding *is* the agent principal's
lifecycle (`docs/session-binding-identity.md` P1 / P2: actor = "this session as
an actor"; `Capability.actorSessionId` is the existing seam). Keeping two brands
forces an explicit conversion at the transport→command seam instead of silent
assignment across roles.

## What was corrected

1. `packages/model/src/ids/brands.ts` — `AgentIdentityId` doc; named conversion
   helpers; retired the harness-hook claim.
2. `packages/model/src/entities/session.ts` — `NativeSubagent.id` is unbranded
   harness evidence, not `AgentIdentityId`.
3. `packages/model/src/identity/delegation.ts` — agentIdentity field comment.
4. `packages/model/src/authz/issue-authz.ts` — Capability.actorSessionId comment
   records the decision.
5. `apps/server/src/gateway/principal-capability.ts` — uses
   `sessionIdFromAgentIdentity` as intentional reclassification.
6. Pins in `brands.test.ts` and `principal-capability.test.ts`.

## Adjacent issues (not this change)

- **POD-1143** — same finding, same decision; treat as duplicate of this issue.
- **POD-1148** — two attribution pairs (model `ActorRef.agent` vs outbox
  agent-session). This decision says both arms name the same string under
  different brands; reconciliation can convert rather than pick a loser.
- **POD-1156 / POD-1196** — vocabulary shape work; independent of this id-space
  verdict.

## Mutation bar for the pins

The conversion helpers must fail a named test if either invents a second id
(prefix, suffix, hash, or constant substitution). Report both the red mutant run
and the restored green run.
