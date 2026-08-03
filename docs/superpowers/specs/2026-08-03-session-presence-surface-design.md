# Session presence surface — POD-1535

**Date:** 2026-08-03 · **Base:** integration `5ff0514e` · **Issue:** POD-1535
(Phase 6 exit-gate hold #3, `docs/gates/pod-427-phase-6-exit-gate.md` item 9)

## Why this exists

The presence/rooms mechanism landed and was mutation-proved by POD-427; **no product code
consumes it**. At `f1b7cbb1` there were zero hits for `subscribeRoom` / `presenceSubscribe` /
`presenceUpdate` / `PresencePayload` anywhere in `apps/web/src` or `apps/mobile/src`, and
`subscribeRoom` was not exposed through `packages/client-core/src/react/`, `index.ts` or
`store.ts`. No user can see who else is present.

POD-427 refused to pick between (a) land the surface and (b) re-scope to mechanism-only, on the
grounds that it is a product decision. The POD-279 coordinator ruled **(a)**, citing
`docs/multi-user-readiness.md` §5 line 516 — *"Phase 6 (POD-293) | Scoped replica-side views;
presence/cursor UI"* — as the human's already-recorded assignment, so building it executes a
decision rather than making one. This design implements that ruling. The design-approval gate of
the brainstorming skill is satisfied by that written ruling plus the issue brief; the human is
asleep and `AskUserQuestion` is forbidden for this session.

## Scope

**In:** a person can SEE who else is present on a **session**, in the web app, with identity.
**Out (explicitly):** concurrent typing / co-editing cursors — `docs/multi-user-readiness.md`
line 31 says that part need not ship, and ADR 7 reserves the `document` room kind for it.
**Out (follow-up):** the `issue` room kind; the mobile app (`apps/mobile` has its own UX concept
and is not governed by `apps/web/DESIGN.md`). Both filed as separate issues.

Session rooms first because `docs/multi-user-readiness.md` §2 names shared terminals the cheapest
collaboration deliverable in the product — `Session.controllerId` / `clientCount` is already a
working one-driver/N-watchers substrate, and what it lacks is identity, not mechanism.

## The one invariant the surface must carry

Presence is stream-plane: ephemeral and lossy by design. **"Nobody else is here" and "we do not
know who is here" must never render the same.** This is made structural rather than a rule to
remember, by the view type:

```ts
export type PresenceRoomView =
  | { readonly status: 'unknown'; readonly members?: undefined }
  | { readonly status: 'present'; readonly members: readonly PresenceMember[] }
```

There is no member array to read while the answer is unknown, so a component cannot accidentally
map over an empty list and paint "alone". `status: 'unknown'` covers all four causes the protocol
deliberately does not distinguish (join refused, entity nonexistent, visibility lost, evicted —
`PresenceRoomClosedMessage` carries no reason code, by D14.3) plus not-yet-joined and
disconnected. `status: 'present'` with `members: []` is the genuinely-known "only you".

## Architecture — three layers

### 1. `packages/client-core/src/presence/room-presence.ts` (non-React)

`PresenceRooms` — one instance per `SocketHub`, held in a `WeakMap` keyed on the hub, so it dies
with the runtime and therefore with the principal (same discipline as `use-slice`'s publisher).
Nothing here is persisted, memoized into an entity slice, or entered into the oplog.

- `view(room): PresenceRoomView` — current fold.
- `subscribe(room, listener): () => void` — refcounted. The **first** subscriber calls
  `hub.subscribeRoom(room, payload)`; the **last** unsubscribe releases the hub subscription and
  drops the fold. Two components watching the same session cause one room join.
- `publish(room, payload)` — `hub.publishPresence`, for this connection's own payload.
- Folds `presenceRoomState` (full snapshot, replaces), `presenceRoomDelta`
  (`joined`/`updated` upsert, `left` remove) and `presenceRoomClosed` (→ `unknown`), keyed by a
  canonical identity key.
- Listens to `connectionHealth`; while `hub.connected` is false every joined room reverts to
  `unknown`. The hub already restores room membership on reconnect by re-sending presence frames,
  so the server answers with a fresh `presenceRoomState` and the view returns to `present`.

### 2. `packages/client-core/src/react/use-presence-room.ts` (the seam)

- `usePresenceRoom(room: RoomRef | null): PresenceRoomView` — `useSyncExternalStore` over the
  registry for the hub behind `useStoreHandle()`. `null` room ⇒ `{ status: 'unknown' }` and no
  join.
- `usePublishPresence(room: RoomRef | null, payload: PresencePayload): void` — publishes on
  change; the payload is compared by JSON identity so a re-render does not re-send.

Exported from `react/index.ts`, which `index.ts` already re-exports. Apps reach rooms **only**
through this seam — no app code touches `hub.subscribeRoom` directly.

### 3. `apps/web/src/features/terminal/SessionWatchers.tsx` (the surface)

Rendered in the `agent-panel-header` right cluster, before the model token.

- Container always renders with `data-testid="session-watchers"` and
  `data-presence-status={status}`, so the two states are distinguishable in the DOM and in tests.
- `status === 'unknown'` → a dimmed `Users` glyph, `title="Presence unavailable"`, `aria-label`
  the same. Never a count, never "0".
- `status === 'present'` → chips for every member **other than this connection's own identity**,
  each a small round token with initials derived from the identity (user id, or the agent
  identity with an on-behalf-of user), a deterministic hue from the id, and a tooltip naming who
  they are and what they are looking at. More than three others collapse to `+N`.
- `status === 'present'` with no others → the glyph is rendered at low emphasis with
  `title="Only you"`. Known-alone is stated, not implied by absence.

**The payload** ("cursor", minimally and honestly): `{ view: 'chat' | 'native' }` — which pane of
the session this watcher is reading, published by `AgentPanel` from `effectiveMode`, plus the
`visible` bit the hub already tracks. That is the room kind's business per D9.3, is far inside
the 4 KiB budget, and carries no durable truth. A text cursor inside a shared document is the
`document` room kind and is out of scope.

Identity display uses the id itself, not a directory: per-user authentication is Phase 3
(POD-315) and there is no user name to resolve yet. The chip is honest about that — it shows a
short id token, and "You" for the current principal.

## Data flow

```
AgentPanel(sessionId)
  └─ usePresenceRoom({kind:'session', id:sessionId})   ── join / fold / leave
  └─ usePublishPresence(room, {view: effectiveMode})   ── own payload
        │
        ▼  (client-core seam)
  PresenceRooms(hub)  ── hub.subscribeRoom / publishPresence / on(presenceRoom*)
        │
        ▼  (already built and mutation-proved — not touched by this issue)
  SocketHub ── ClientSubscriptionRegistry ── ws ── gateway presence-routing ── StreamPlanePort
```

## Error handling

There is no error path to design: the protocol answers every failure with the same
`presenceRoomClosed` frame and no reason code, deliberately (D14.3 — a subscribe frame that
answers differently is an existence oracle). The client's whole response is "the answer is
unknown", which is the invariant above. An over-budget payload is refused by
`presencePayloadWithinBudget` at the hub and returns `false`; the surface does not retry or
truncate, because a dropped presence update is corrected by the next one.

## Testing

Per CLAUDE.md, scoped to the regression risk of new behaviour:

1. `presence/room-presence.test.ts` — the fold (state / delta joined-updated-left / closed),
   refcounting (two subscribers ⇒ one `subscribeRoom`; last release ⇒ `unsubscribeRoom`), and
   revert-to-`unknown` on disconnect and on `presenceRoomClosed`.
2. `react/use-presence-room.test.tsx` — the hook joins on mount, leaves on unmount, re-renders on
   a delta, and returns `unknown` for a `null` room.
3. `features/terminal/session-watchers.test.tsx` — the three rendered states, that self is
   excluded from the chips, and that `unknown` never renders a count.

**Mutation proof (the gate's acceptance bar).** The gate's finding was "no product caller", so
the planted violation is the removal of the caller. Two mutants, each expected RED naming the
site, then reverted from a byte-verified pristine snapshot:

- M1 — delete the `usePresenceRoom` call from `AgentPanel` (break the substring; do not extend
  it): the web surface test must go RED.
- M2 — make `PresenceRooms.view` return `{ status: 'present', members: [] }` instead of
  `{ status: 'unknown' }` when a room is closed: the invariant test must go RED. This is the
  exact "absence reads as nobody" defect the ruling names.

A silent mutant is diagnosed with a `throw` on the same line before it is believed equivalent.

Runtime verification of the rendered surface is required by CLAUDE.md and is done against the
component with a driven fake hub plus a real-app check; the Playwright browser lane is known-red
(POD-1532) and is not a usable instrument tonight.

## Follow-ups filed, not built

- Issue-room presence (who else is looking at this issue) — same seam, new caller.
- Mobile presence surface — `apps/mobile`, its own UX concept.
- Co-editing cursors — blocked on ADR 1's `op-stream` conflict class and the `document` room kind.
