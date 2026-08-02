# Plane ports — implementation record (POD-387)

What ADR 7 (`docs/adr/0007-plane-inventory.md`) and its
[Amendment 1](adr/0007-plane-inventory-amendment-1.md) decided, and where each decision now
lives in code. This file records the implementation and the **re-derived inventory counts**; it
does not decide anything. Where this file and the ADRs differ, the ADRs win.

Everything lives in `packages/protocol/src/planes/` — ADR 8 D4 keeps "frames, codec, handshake,
versioning, **plane taxonomy**" in `protocol` (the future `packages/wire`).

## The three planes

| Plane · class | Port | Module |
|---|---|---|
| `control.entity` | durable, funnelled, per-principal routing, healed | `control-port.ts` |
| `control.command` | correlated request/reply, requires live peer | `control-port.ts` |
| `control.handshake` | once per connection, pre-auth (ADR 5) | classified in `inventory.ts` |
| `stream.live` | lossy, named routing set (connection / attach set / room) | `stream-port.ts` |
| `bulk.bulk` | paged, lazy, point-to-point | `bulk-port.ts` |

`command` is a **class inside the control port**, not a fourth plane (ADR 7 D1). Its distinct
delivery semantics are data (`CommandDeliverySemantics`), and `PLANE_CLASS_SEMANTICS` in
`plane.ts` carries D1's port-semantics table as amended by Amendment 1 D15.

## One routing primitive (Amendment 1 D13)

`routing.ts` holds **the** subscription registry (`SubscriptionRegistry`) and **the** fan-out
(`PlaneRouter`), parameterized by durability. Both ports are constructed over the same registry
instance and each port's constructor *refuses* a router built over a different one — the "one
routing table" rule is enforced by construction, not by review.

| | control · entity | stream · live |
|---|---|---|
| Routing key | `entity:<kind>:<id>` / `principal:<id>` | `room:<kind>:<id>` |
| Durability | durable | none |
| Coalescing | forbidden (constructor throws) | mandatory before dropping |
| Overflow | demote to resync (ADR 2 D9) | coalesce → drop → evict from room |
| Recovery | ADR 2 D7 ladder | rejoin ⇒ fresh snapshot |

`routing.test.ts` exercises both sides, including a 50-frame presence flood that leaves control
delivery untouched and the connection alive.

## Scoped feed on the control port

`scoped-feed.ts`: covered range on every frame (`fromSeq`/`seq`/`changes`), `isWatermarkFrame`,
`acceptsAtCursor`, range-extension-only coalescing, the `rescope` frame, and
`CHANGE_OP_SEMANTICS` — where `evict` is a **third** member of the delete family, distinct from
`remove` in scope, reversibility, tombstone and deleted-event. The `(feedId, epoch, seq)` triple
and the healing ladder are unchanged. The kernel itself is Phase 2 (POD-1077); the wire landing
of these fields on `metadataDelta` / `MetadataChangeOp` is POD-1077's, negotiated by capability.

## Rooms and presence on the stream port

`presence-rooms.ts`: closed room-kind set (`session`, `issue`; `document` reserved for ADR 1's
`op-stream`), `RoomRef` as a branded entity reference, six frames (subscribe / unsubscribe /
update / roomState / roomDelta / roomClosed), identity stamped from the transport, opaque bounded
payload, and today's `visible` bit as a **reserved field** rather than a parallel frame.
`StreamPlanePort` implements the visibility gate (default-closed, refusal indistinguishable from
nonexistence), the join snapshot, per-principal membership, and derived leaves.

## The named port rule

`port-rule.ts` — `PORT_RULE_HOST_EDGE_SEPARATION`, with the agent relay's exactly two peer frames
and the host-edge frame list. `routableOverAgentRelay` is the predicate; the test asserts the sets
are disjoint, that every host frame is refused on the relay, and that every host frame is itself
classified in the inventory.

The module-boundary half (ADR 7's POD-387 item 4: "agent-relay handler must not import host-hook
handlers or vice versa") is **rule 9** of `scripts/check-boundaries.ts` — the daemon's
`agent-relay.ts` and its host-edge handlers (`hook-ingest.ts`, `codex-hooks.ts`, `grok-hooks.ts`,
`browser-open.ts`) may not import each other. Composition roots that wire both are fine. Green
against the repo today; both crossing directions are covered by tests.

## Totality — counts re-derived at this baseline

ADR 7 D6 counted **122** post-auth WS types at baseline `ca361327`; Amendment 1 D16 requires the
implementer to re-derive rather than copy. Re-derived from `message-class.ts` and the zod unions
at this branch's implementation baseline (`6931d7f6`):

| Union | Types at `ca361327` (ADR 7 D6) | Types now |
|---|---:|---:|
| `ServerMessage` | 26 | **34** |
| `ClientMessage` | 15 | **19** |
| `ControlMessage` | 38 | **47** |
| `DaemonMessage` | 43 | **53** |
| **Post-auth WS total** | **122** | **153** |
| Daemon handshake (pre-auth) | 6 | 6 |
| Frames classified ahead of their wire landing (D16) | — | 1 |

The delta is drift the ADR's baseline predates, not reclassification: the scoped feed and presence-room families, credential export/install,
Draft Sync v2 (`draftEdit`, `draftTarget`, `nativeDraft`), the agent-observation family,
`sessionViewDelta`, `sessionGitActivity`, `agentModel`, and `browseDirs*`. Every one keeps the
class it had under `MessageSyncClass`, translated through D1's bridge. `inventory.test.ts`
re-derives these numbers from the code on every run, so they cannot drift the way a number in
prose can.

## Deliberately not built here

Presence/cursor UI (Phase 6, POD-293), the scoped-feed kernel (Phase 2, POD-1077), ownership and
grants policy (Phase 3, POD-290), collaborative text editing (reserved by ADR 1's amendment — the
control port is keyed by entity reference so a document op stream is not foreclosed), and the
gateway's socket wiring (POD-317, which consumes these ports and the one registry).

The presence-room family is now landed on the concrete client and server unions. The sole frame classified ahead of a concrete wire member is the control-port's abstract `rescope`; its wire representation is `feedRescope`. D16 keeps both classifications total without creating a second routing mechanism.
