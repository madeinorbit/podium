# ADR 7 — Amendment 1: identity-carrying presence and rooms on the stream plane

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-29
- **Deciders:** architecture rewrite ADR pack (POD-359); human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md` (§3.4 governs this amendment, §3.1 explains why
  the primitive is shared); human sign-off before Phase 4
- **Issue:** POD-1074 (owns this file, and the single "Amended by" line in
  `docs/adr/0007-plane-inventory.md`)
- **Consumers:** POD-387 (plane-port interfaces), POD-317 (gateway routing + framing),
  POD-1078 (4.10 presence rooms and subscriptions), POD-1077 (2.8 watermarked scoped feed —
  the *other* consumer of the same primitive), POD-308 (wire cutover), POD-293 (presence /
  cursor UI)
- **Related ADRs:** ADR 1 (ownership matrix; instance identity; the `op-stream` conflict class
  its amendment adds), ADR 2 + its Amendment 1 (scoped feed, watermarks, rescope/evict,
  bootstrap), ADR 3 (principal from authenticated transport; resource/action policy), ADR 4 +
  its Amendment 1 (reader-independent projections; attribution as a branded pair), ADR 5
  (framing, role-specific auth), ADR 9 (identity, ownership, sharing — D1 principal taxonomy,
  D3 visibility classes, D4 default-closed totality, D6 machine `see`/`use`/`manage`)
- **Specs:** [spec:SP-b85a], [spec:SP-fccf], [spec:SP-a43e] (host↔server ≠ agent relay — D2,
  untouched); [spec:SP-15aa] (instance isolation); [spec:SP-eb60] (curated name vs live title)
- **Base tip verified:** `2ddfec21` (issue/279-integration), 2026-07-29. ADR 7's own inventory
  baseline `ca361327` is **not** restated or moved by this amendment.
- **File discipline:** this amendment owns **only** this file plus a single "Amended by" line
  in `docs/adr/0007-plane-inventory.md`. No index edits (POD-359 owns `docs/adr/README.md`),
  no ledger edits, no edits to ADR 1/2/3/4/9.

---

## 1. Context

`docs/multi-user-readiness.md` §3.4 records the finding this amendment answers:

> ADR 7's **stream** plane is exactly the right port for presence: ephemeral, lossy on
> disconnect, blank offline, best-effort fan-out. **The plane is right; the inventory is thin.**

The plane stays. The inventory grows. Nothing in ADR 7's D1–D8 is overturned: three planes,
command as a class inside control, host↔server separate from the agent relay, the D3–D5
dual-delivery resolutions, D6's totality obligation, D7's handoff message types (**ten** as of
2026-08-03; this amendment said “eight” before POD-644 added the binding-finalize pair) and
D8's browser-open classification all stand exactly as written. Rooms are a **subscription
concept inside the stream port**, not a fourth plane (D10).

**Multi-user is not multi-tenancy.** Multi-user in one tenant lives **inside** one Authority.
**ADR 1 D5 is unaffected**: `InstanceId` remains a deployment partition, not a row-level
discriminator. Nothing here authorises an `instance_id` column, an `instance_id` room kind, or
a tenant dimension on any frame. An implementer who reads "rooms" and reaches for tenant
routing has misread this document.

### What is true today (verified on tip `2ddfec21`)

- **Presence is one boolean, with no identity, no room and no fan-out.**
  `packages/protocol/src/messages/terminal.ts:208` declares
  `PresenceMessage = z.object({ type: z.literal('presence'), visible: z.boolean() })`, commented
  *"User presence (page visibility) — the smart-notification router skips mobile push while some
  Podium window is visibly open."* It is classified `live` in
  `packages/protocol/src/messages/message-class.ts:109` (D6.2 lists it as **S**).
- **Its only consumer is an anonymous OR across connections.** The server stores it as
  `client.visible = msg.visible` (`apps/server/src/modules/sessions/service.ts:2585`, the sole
  assignment) and the notification router reads
  `const someoneWatching = [...this.deps.clients()].some((c) => c.visible)`
  (`apps/server/src/modules/notify/service.ts:201`). No client is ever told that another client
  is present. Presence today answers *"is anybody there?"*, never *"who, and where?"*.
- **There are exactly two fan-out modes — and a third has already been hand-rolled.**
  Entity deltas go to **every** connection: `sendMetadataDelta` and `fanOutSnapshot` both loop
  `for (const c of this.clients.values())` (`apps/server/src/modules/sessions/service.ts:3272`
  and `:3254`), as does `broadcastToClients` (`:3133`, documented *"Raw fan-out to every
  connected client"*). PTY frames go to the **per-session attach set**:
  `Session.broadcast()` loops `this.clients` (`apps/server/src/modules/sessions/session.ts:885–886`),
  populated by `attachClient()` (`:338–339`). And browser-open already picks recipients with a
  bespoke rule computed inline at the send site — `focused` → `viewVisible` → all clients
  (`service.ts:2460–2464`). The routing primitive is *already* being invented per feature,
  which is precisely the retrofit shape §3.4 warns about.
- **A per-entity subscription set already exists, on the wrong plane for presence.**
  `transcriptSubscribe` / `transcriptUnsubscribe` maintain `client.transcriptSubs`
  (`service.ts:2576–2582`) and are classified **B** in D6.2 — a standing paged channel, not a
  lossy fan-out. It is a precedent for per-entity subscription state on a connection, not a
  primitive presence can reuse.
- **`attach` is C/c but `attached` is S** (`message-class.ts:102` `attach: 'command'`,
  `:53` `attached: 'live'`). The pack already tolerates a request on one class answered on
  another; D10.4 uses that precedent rather than inventing one.
- **Backpressure is a single shared budget per socket, and exceeding it kills the connection.**
  `safeSend` terminates a socket whose `bufferedAmount` exceeds
  `SEND_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024` (`apps/server/src/wsServer.ts:98`, `:129`,
  comment *"a client this far behind is effectively dead, so terminating it … protects everyone
  else"*). Heartbeat sweeps are `CLIENT_HEARTBEAT_INTERVAL_MS = 15_000` and
  `DAEMON_HEARTBEAT_INTERVAL_MS = 10_000` (`wsServer.ts:81`, `:89`) — the "10s/15s sweeps" of
  D1's table, assigned. **This is the starvation mechanism**: a cursor-rate stream sharing that
  budget does not merely delay control frames, it terminates the connection and forces a full
  reconnect and heal (D11).
- **There is no room, subscription or occupancy vocabulary anywhere.** `CLIENT_MESSAGE_CLASS`'s
  live entries are exactly `ping`, `presence`, `viewState` (`message-class.ts:108–110`).

---

## 2. Decisions

Numbering continues ADR 7's sequence; D1–D8 are the base document's and are unchanged.

### D9 — Presence carries identity, room and payload; today's `visible` bit is the degenerate case

**Decision.** A presence record is a triple — **who**, **where**, **what** — and stays on
**stream · live**:

1. **Who — the principal, from the authenticated transport only.** Per ADR 3 D7, presence
   identity is derived from the connection's principal and is **never** read from the frame
   payload. A payload-supplied identity is inert here for the same reason it is inert on
   commands: it is a spoofing surface. Where the principal is an agent, the record carries the
   attribution **pair** (actor, on-behalf-of) defined by ADR 4 Amendment 1 D9.3, so *"your agent
   is watching this session"* is representable without a second identity concept.
2. **Where — a room reference** (D10), never a free string.
3. **What — an opaque per-room payload.** Cursor, selection, viewport, "typing". ADR 7 does not
   define its contents: the payload is the room kind's business, and the port must not interpret
   it. Its only normative properties are that it is **bounded in size**, **idempotent full
   state** (not a delta), and carries **no durable truth** — anything a reader must still know
   after a reconnect belongs on control · entity, not here.
4. **Membership is per *principal*, not per connection.** Two tabs are one member with two
   connections. A member leaves the room when its **last** subscribed connection leaves.
5. **Today's `visible` boolean maps forward as a reserved field of the connection-level presence
   record, not as its own frame.** It is the room-less, identity-less, fan-out-less degenerate
   case of this decision: one bit, aggregated by an anonymous OR for push suppression. At the
   POD-308 cutover it becomes a reserved field on the presence update, still consumed by the
   notification router — which under multi-user must ask *"is **this user** watching?"*, not
   *"is anybody watching?"*, and cannot do so today because the bit has no owner. The `presence`
   frame is retained through the cutover window as a compatibility alias and deleted at cutover.
   **No fan-out changes in that migration**, because the bit is not fanned out today.

**Rationale.** The notification router's OR is the exact shape of the single-operator
assumption: with one human, "somebody is watching" and "you are watching" are the same
statement; with several they are different, and the *server* currently cannot tell them apart.
Giving presence an identity is therefore not only the precondition for co-presence UI — it is a
correctness fix for a feature already shipped. Deriving the identity from the transport rather
than the payload costs nothing now (ADR 3 D7 is already decided and tested for) and is
unaffordable to retrofit onto a frame that clients have learned to self-report on.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Add `userId` to the existing `presence` frame and keep it connection-scoped | Reintroduces payload identity on a frame that fans out to other people — ADR 3 D7's precise prohibition, arriving at the one place where a spoofed identity is directly visible to other users ("Alice is watching this"). |
| Keep `visible` as its own frame and add a separate room-presence frame beside it | Two presence concepts on one connection, with two lifecycles and two liveness rules, and the notification router still unable to ask a per-user question. §3.4 asks for identity-carrying presence, not a second channel next to the old one. |
| Let the payload be a typed union defined in this ADR (cursor / selection / viewport) | ADR 7 classifies transport, it does not own feature vocabulary (D1: "the gateway routes frames to feature-owned ports and owns no feature logic"). A typed union here would make every new presence affordance an ADR amendment. |
| Make the payload a delta (movement since last) | Deltas require ordering and loss-detection — exactly the guarantees the stream plane does not provide (D1: loss on disconnect is OK). Idempotent full state is what makes D11's coalescing legal. |

---

### D10 — Rooms are a subscription concept **inside** the stream port; a room id is an entity reference

**Decision.**

**D10.1 — Not a fourth plane.** A room is a *routing set* on the existing stream port. D1's
three planes are unchanged, and the rejected-alternatives row "Four planes" in D1 applies here
verbatim: a room is delivery scope, not a backpressure domain of its own — its backpressure
policy is stream's, tightened by D11.

**D10.2 — A room identifier is an entity reference `(kind, id)`, with a branded id.** Never a
free string. `kind` comes from a **closed set** of room-bearing entity kinds — extended only by
amending this ADR, the same discipline ADR 1 D3 applies to the LWW set and ADR 3 D2 to resource
kinds. The intended initial set is **session**, **issue**, and — when ADR 1's amendment lands
the `op-stream` conflict class (readiness §4) — the collaborative **document**. Which classes
are room-bearing is declared on ADR 1's matrix alongside their visibility class, so a new entity
class cannot acquire a room without acquiring a visibility classification — the declaration and
its totality test are ADR 9 D4's, not a second mechanism here (readiness §3.1.1).

**D10.3 — Frames.** Four new stream frames plus one server notification family:

| Frame | Direction | plane·class | Meaning |
|---|---|---|---|
| `presenceSubscribe` | client→server | **S** | Join room `(kind, id)`. Visibility-gated (D14). |
| `presenceUnsubscribe` | client→server | **S** | Leave a room this connection joined. |
| `presenceUpdate` | client→server | **S** | Publish this connection's payload into a joined room; carries the reserved `visible` field (D9.5). |
| `presenceRoomState` | server→client | **S** | Full occupancy snapshot for one room. |
| `presenceRoomDelta` | server→client | **S** | Member joined / left / updated in one room. |
| `presenceRoomClosed` | server→client | **S** | This connection is no longer subscribed: join refused, visibility lost, entity gone, or evicted under D11. |

**D10.4 — Join answers on the stream plane, not as a control command.** `presenceSubscribe` is
**stream · live** in both directions: its answer is `presenceRoomState` (accepted) or
`presenceRoomClosed` (refused). This mirrors the existing asymmetric `attach` (C/c) →
`attached` (S) pair, but places *both* halves on stream because a room subscription **dies with
the connection** and must never be queued, replayed, retried from an outbox, or treated as
offline-class (ADR 3 D4). Correlation, if an implementation wants it, is a per-frame token
inside the stream port — not promotion to control · command.

**D10.5 — On join, the server sends a full occupancy snapshot; it does not wait for the next
tick.** `presenceRoomState` is one frame carrying every current member and its last payload.

**D10.6 — Leaves are derived, and there is exactly one leave notification.** A member leaves on
explicit `presenceUnsubscribe`, on connection close, or on heartbeat reap (the existing 15s
client sweep — no second timer). All three produce the identical `presenceRoomDelta` leave. The
last connection of a principal leaving produces the member leave; earlier ones produce nothing.

**Rationale.** Every clause exists to stop a later "obvious" shortcut.

- *Entity reference, not string*: a free-string room namespace has no owner, no totality test,
  and — decisively — **nothing to check a permission against**. D14's gate is a lookup on an
  entity that ADR 9 has classified; `room:"issue-42-sidebar"` is not.
- *Join-time snapshot*: presence is exactly the state where nothing may tick for minutes — a
  reviewer reading a session moves no cursor. Without the snapshot, an idle room is
  indistinguishable from an empty one, which is the failure mode co-presence exists to prevent.
  D1 already grants stream "blank or re-seeded on attach"; this is that clause, specified.
- *Derived leave*: a leave that must be *sent* is a leave that is lost when the tab is killed,
  and a lost leave is a ghost occupant — the presence bug every implementation ships once. Under
  D12 the room has no durable state to reconcile, so deriving the leave from connection
  lifecycle is the only mechanism that cannot leak one.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Rooms as a fourth plane | Overturned in principle by D1: the plane count is a port/backpressure decision (POD-387 plane-count correction), and a room shares stream's delivery contract exactly. A fourth plane would also need its own offline and recovery semantics, of which it has none. |
| Free-string room names ("channel" style) | Unauthorizable and untestable: no entity to gate on, no closed set to check for totality, and every feature inventing its own naming scheme — the ad-hoc routing already visible at `service.ts:2460–2464`, formalised. |
| Reuse `transcriptSubscribe`'s subscription mechanism | It is **B** (a standing paged channel with ordered, recoverable content). Presence is lossy and unordered; sharing the mechanism would either make presence recoverable (D12 forbids it) or transcripts lossy (a data bug). |
| `presenceSubscribe` as control · command | Makes a connection-scoped, discardable subscription eligible for outbox queuing and offline classification (ADR 3 D4/D9), so a room join could be replayed minutes later against a room whose visibility has since changed. Commands are for things that must happen; a room join is only meaningful while the socket is open. |
| No join snapshot — "you'll see them on their next update" | An idle watcher is invisible, so the feature silently under-reports exactly the case (someone quietly reading your session) that motivates it. |
| Replay a bounded recent history on join | Durability creeping onto the lossy plane. It would also make the room's history an existence-leak surface with no policy owner (§3.1.2). |
| Room per *view* rather than per entity (e.g. one room per sidebar panel) | Views are client concerns and unbounded in kind; the visibility gate would have nothing to resolve, and the room set could not be inventoried. |

---

### D11 — Per-room fan-out is cursor-rate, funnel-free and oplog-free; and it may not starve control

**Decision.** Normative port properties for room fan-out, binding on POD-387/POD-317:

1. **Never the funnel, never the oplog.** A presence frame **must not** enter the durable write
   funnel and **must not** append a change row. It therefore never moves ADR 2 D1's `seq`, never
   appears in `changesSince`, and never participates in ADR 2 D7's healing ladder. A presence
   write that reaches the funnel is a bug, not a design choice — it would put cursor-rate traffic
   into the one ordered pipe whose contiguity is load-bearing.
2. **Design point ≈ 30–60 Hz per member per room** (readiness §3.4), enforced as a **server-side
   publish cap**: updates above the cap for a `(connection, room)` are discarded, not buffered.
   The rate is a design point, not a delivery guarantee.
3. **Coalescing is legal and mandatory before dropping.** Because payloads are idempotent full
   state (D9.3), the port **may** discard any queued update superseded by a newer one for the
   same `(room, member)`. Latest-wins per member is the fan-out's only ordering obligation.
4. **Presence gets its own budget and may never drive the shared socket budget to the terminate
   threshold.** Today a socket over `SEND_BUFFER_LIMIT_BYTES` is **terminated** (`safeSend`,
   `wsServer.ts:129`). Since control · entity, control · command and stream share one socket
   buffer, an uncapped presence stream would not merely delay entity delivery — it would kill the
   connection and force a reconnect plus heal. Presence must be capped *below* that threshold so
   that the escalation in (5) always fires first.
5. **Escalation order: coalesce → drop → evict from the room → (never) terminate.** A subscriber
   that cannot keep up receives `presenceRoomClosed` and is removed from the room; the connection
   survives, and its control-plane delivery is unaffected. This is presence's analogue of ADR 2
   D9 ("a slow replica is demoted to resync"), with the difference that presence has **nothing to
   resync**: the client simply rejoins and gets a fresh snapshot (D10.5).
6. **Heartbeats are unchanged.** Room membership is derived from connection liveness, so the
   existing 15s client / 10s daemon sweeps (`wsServer.ts:81`, `:89`) are already the room's
   liveness mechanism. No presence-specific timer is introduced.

**Rationale.** §3.4 requires fan-out "at cursor rates that never touches the funnel or the
oplog". The non-obvious half is the *starvation* direction, and the code makes it concrete: the
shared 16MB budget with a terminate-on-exceed policy converts a cosmetic overload (a colleague
dragging a selection) into a full reconnect and a D7-ladder heal for that client. A rule that
only said "presence is best-effort" would leave that inversion in place, because dropping
presence frames is not the same as preventing presence from consuming the budget. Making
eviction-from-room the terminal escalation keeps the failure proportional: the worst outcome of
presence overload is that you stop seeing cursors, not that your entity sync restarts.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Reuse the single 16MB socket budget unchanged for presence | The verified policy is *terminate*, so presence overload becomes a control-plane outage plus a heal storm. The one thing a lossy plane must never do is take the durable plane down with it. |
| Buffer presence and deliver it in order | Unbounded memory for data that is stale on arrival, and it would give presence the ordering guarantees D13 explicitly denies it. |
| Put presence on a separate socket to isolate the budget | Doubles connection count and handshake/auth surface (ADR 5 D3/D5) for a problem solvable with a per-plane budget on one socket. It also splits liveness across two sockets, so a member could be "present" on a dead control socket. |
| Sample/throttle client-side only | The server would still be obliged to fan out whatever arrives; a single misbehaving or malicious client sets the fan-out rate for everyone in the room. The cap must be server-side to be a port property. |
| Terminate the connection on presence overload, as today | Punishes the wrong failure with the most expensive recovery in the system (reconnect + bootstrap or heal), for traffic that is by construction discardable. |

---

### D12 — Presence is strictly derived from live connections; a durable presence row is a bug

**Decision.** Presence has **no durable representation anywhere**: no table, no oplog row, no
entity field, no tombstone, no replica cache that survives disconnect. It is a pure function of
the set of live subscribed connections and their last payload, held in server memory. Offline
behaviour is **blank**, never "last known". Consequences that are ADR 7's to state:

1. **No tombstones.** A member's disappearance is the absence of a connection, not a recorded
   event. Since there is no durable row, ADR 2 D5's tombstone/retention machinery does not apply
   and must not be extended to cover presence.
2. **Presence never rides an entity projection.** It is not a field on `SessionMeta`,
   `IssueWire`, or any other R4 projection — that would make the projection reader-dependent and
   time-varying at cursor rates, which ADR 4 Amendment 1 D10.1 forbids and D7.2 makes a testable
   violation.
3. **"Who is here" is never persisted for history.** If the product ever wants *"Alice viewed
   this issue"* as a durable fact, that is a **different feature** — an entity write with an
   owner, an ownership-matrix row and a visibility class — and it must not be implemented by
   persisting presence.
4. **`clientCount` and `controllerId` are not presence.** `Session` already publishes
   `clientCount: this.clients.size` (`session.ts:840`) and broadcasts `controllerChanged`; those
   are session-control facts on their existing classifications (D6.1) and stay there. Presence
   does not absorb them, and they do not become the presence mechanism.

**Rationale.** §3.4 states it as a requirement ("presence as strictly derived from live
connections — no durable rows, no tombstones"), and it needs to be normative rather than
descriptive because the convenience argument for persisting is always available and always
locally reasonable ("just cache last-seen so the UI doesn't flicker on reconnect"). The cost is
paid globally: a durable presence row acquires an owner question, a visibility class, a
retention policy, a tombstone, a heal path, and a per-change oplog append at cursor rates — it
converts the cheapest thing in the system into the most expensive one. Blank-offline is also the
only honest rendering: a stale "Alice is here" is worse than no presence at all, because
collaborators act on it.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Persist last-seen presence "so the UI doesn't flicker on reconnect" | The flicker is the truth: after a disconnect you genuinely do not know who is there. D10.5's join snapshot re-establishes it in one round trip. Persistence buys milliseconds and costs a durable, ownable, retainable, healable row. |
| Store presence in the replica so it survives a page reload | Same defect on the other side, plus it puts unowned state into ADR 6's transactional replica store, where every row is expected to have a home authority and a cursor. |
| Model presence as an entity with a short TTL | A TTL is a retention policy, and ADR 2 D5 is explicit that retention is a liveness parameter of a *correctness*-bearing feed. Presence is not correctness-bearing, so it must not be in that feed at all. |
| Append presence to the oplog "for debugging" | Cursor-rate appends to the one globally ordered log, permanently, for a diagnostic. Telemetry, if wanted, is a separate sink (POD-678 opt-in rules), not the feed. |

---

### D13 — One subscription primitive, two guarantee sets; POD-387 and POD-317 build it **once**

**Decision.** The mechanism that routes **per-room presence fan-out** and the mechanism that
routes the **per-principal scoped feed** (ADR 2 Amendment 1, implemented by POD-1077) are **the
same primitive**: a subscription registry mapping a *routing key* to a set of connections, plus
a resolver that decides which keys a principal may hold. **POD-387 defines it as a port
interface parameterized by durability; POD-317 implements exactly one routing table.**
POD-1077 (scoped feed) and POD-1078 (presence rooms) are its two **consumers** and must not each
build one.

What is shared: the subscription registry, the subscribe/unsubscribe lifecycle, the
principal→visible-entity resolution the visibility gate consults, and the rule that routing is a
**set lookup, not a per-reader projection** — one wire value, many destinations (ADR 4 Amendment
1 D10.1; ADR 4 D7.2).

What differs is **durability, not routing**:

| Property | control · entity — scoped feed (ADR 2 Amd 1) | stream · live — presence rooms (this amendment) |
|---|---|---|
| Routing key | principal → visible entity set | `(room, principal)` subscription |
| Durability | durable; funnel-appended, oplog-backed | none; nothing is stored (D12) |
| Ordering | total order on `seq`; contiguity checked (ADR 2 D1) | none; latest-wins per member (D11.3) |
| Loss | never — a gap enters ADR 2 D7's healing ladder | expected; invisible after the next update |
| Recovery | watermark / `changesSince` / scoped bootstrap | rejoin ⇒ fresh occupancy snapshot (D10.5) |
| Membership change | ordered rescope/evict frame, C/e (D16) | unordered join/leave notification, S |
| Rate | change rate of the world | cursor rate, 30–60 Hz per member (D11.2) |
| Backpressure | demote to resync (ADR 2 D9) | coalesce → drop → evict from room (D11.5) |

**Rationale.** §3.1 and §3.4 both land on this: the scoped feed needs per-principal routing and
presence needs per-room routing, and they are the same question asked with different
durabilities. The gateway today has **two** fan-out modes — global (`sendMetadataDelta`,
`fanOutSnapshot`) and per-session-attach (`Session.broadcast`) — and a **third** already
hand-rolled inline for browser-open (`service.ts:2460–2464`). Building a fourth and a fifth,
separately, in two different phases, is the retrofit class POD-279 exists to end; and adding
rooms *afterwards* to a gateway built for exactly two modes is how the current codebase acquired
the five bespoke replication paths this rewrite is deleting.

**Sequencing hazard, stated because it is real.** Readiness §5 puts the scoped feed in **Phase 2**
(POD-1077, which must land before POD-308's wire cutover) and gateway rooms/subscriptions in
**Phase 4** (POD-387/POD-317/POD-1078). The consumer therefore arrives **two phases before** the
mechanism's owner. "One primitive" is consequently a *sequencing obligation*, not a free
consequence: either POD-387's port interface is pulled forward far enough for POD-1077 to
implement against it, or POD-1077 ships a routing path POD-317 later replaces — which is a second
mechanism with extra steps. This ADR states the requirement; the phase plan is POD-359's and
POD-387's to settle (recorded as open item **O6**).

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Build presence rooms independently in Phase 4 and leave the scoped feed's routing alone | Two subscription registries, two visibility-resolution paths, two eviction policies, and two places to forget a revocation. The visibility gate is a *security* boundary; duplicating it duplicates its bugs. |
| One primitive with one guarantee set (make presence durable, or the feed lossy) | Presence durable violates D12 and drags cursor traffic into the funnel; the feed lossy violates ADR 2's contiguity contract, which is exactly the "filter without a watermark is a protocol break" trap ADR 2 D2 records. Shared routing, separate guarantees, is the only combination that is safe in both directions. |
| Defer rooms until after POD-308 and retrofit them onto the cutover gateway | The explicit §3.4 warning ("adding rooms later to a gateway built for two fan-out modes is the kind of retrofit this programme is trying to stop doing"), and the wire cost lands after the one migration this programme is paying for. |
| Let each feature keep routing at the send site, as browser-open does today | That code (`service.ts:2460–2464`) is the demonstration: an inline recipient rule with no visibility gate, no test for totality, and no way to add one without touching every send site. |

---

### D14 — Room joins are visibility-gated, default-closed; a refused join is indistinguishable from a nonexistent one

**Decision.**

1. **A principal may join a room only for an entity it may see.** The gate is ADR 9 D3's
   visibility classes under ADR 9 D4's default-closed totality rule (readiness §3.1.1): an entity
   kind with no declared visibility class is private, so a room over an unclassified kind is
   **not joinable**. Forgetting to classify fails toward silence, never toward exposure.
2. **For a session on a machine, the machine's `see` verb applies too** (ADR 9 D6; readiness
   §3.1.4 M1). Presence on a session must not reveal a machine the principal has no `see` on.
3. **Refusal is indistinguishable from nonexistence.** A join refused for visibility and a join
   for an id that does not exist both return the identical `presenceRoomClosed`, with no
   distinguishing reason code and no timing difference that survives ordinary jitter. This
   applies readiness §3.1.5's already-decided consistent-error rule (mailing an invisible issue
   must fail exactly as mailing a nonexistent one) at a second concrete site: a subscribe frame
   that answers differently is an existence oracle with a convenient polling interface.
4. **Visibility loss while subscribed evicts.** When a principal loses access to an entity it is
   in a room for, the server sends `presenceRoomClosed` and drops the subscription. This is the
   stream-plane sibling of ADR 2 Amendment 1's rescope/evict on control, and it is *not* the same
   frame: the control frame repairs a durable, contiguity-checked view; this one only stops a
   fan-out (D13's table).
5. **What a joined room reveals is inventoried, and the policy is open.** A successful join
   reveals: that the entity exists; who else is currently subscribed; that those principals are
   online at all; and, through the payload, what part of the entity they are looking at.
   Correlating occupancy across rooms reveals what a colleague is working on. **Whether occupancy
   is visible to every member, or only the members a principal may otherwise see, and whether a
   member may be present-but-hidden, are policy questions this ADR does not answer** — readiness
   §3.1.2 marks the existence-leak class as deliberately open. Recorded as **O1**/**O2** below.

**Rationale.** The gate must exist at the port, because a room is the one place where a
subscription *is* the disclosure: unlike an entity read, there is no payload to redact — the
membership fact is the payload. Making the refusal shape identical to nonexistence costs nothing
at implementation time and is essentially unfixable later, because clients come to depend on the
distinguishable error. And inventorying the leaks without deciding them is deliberate: §3.1.2
says which existence facts may leak is a per-surface policy call, and the wrong failure here is
an ADR silently choosing the permissive default by not mentioning it.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Allow joins on any known entity and filter what the room *shows* | The join itself is the disclosure — a successful subscribe confirms the entity exists. Filtering after admission solves the wrong half. |
| Distinguish "forbidden" from "not found" for better client errors | Turns subscribe into an existence oracle callable at cursor rates. Readiness §3.1.5 already fixed the opposite rule for `mailSend`; diverging here would make the product inconsistent about the same question. |
| Decide the occupancy-visibility policy in this ADR | Out of scope by the pack's ownership rule and explicitly open upstream (§3.1.2). ADR 7 owns transport classification; who may see whom is ADR 9 and per-feature policy. |
| Gate rooms on instance-wide role only (as `machine` access is gated today) | Readiness §3.1.4 M1 corrects exactly this for machines: the missing piece is an owner plus per-entity grants, not a coarser role check. Rooms would inherit the defect. |

---

### D15 — D1's port-semantics table amended: control · entity fan-out is **per-principal routing**, not broadcast

**Decision.** Two cells of D1's port-semantics table are restated (the table is otherwise
unchanged, and D1's three-plane decision is untouched):

| Plane · class | Fan-out — **as amended** |
|---|---|
| control · entity | Yes, post-funnel, **routed per principal** (ADR 2 Amendment 1's scoped feed). Global broadcast becomes the degenerate case where one principal may see everything. Suppressed ranges are carried by watermarks so contiguity holds (ADR 2 D2's stated precondition). |
| stream · live | Best-effort fan-out **to a named routing set**: one connection, a session-attach set, or a **room** (D10). "Raw fan-out to every client" is no longer a port affordance. |

Two normative consequences:

1. **Routing is a set lookup; the projection stays reader-independent.** Scoping decides
   *whether* a principal receives a row, **never what the row says**. One wire value, many
   destinations — per ADR 4 Amendment 1 D10.1 and ADR 4 D7.2, which forbids O(entities) work on
   the write/publish/fan-out path. Per-principal *projection* would reintroduce exactly that
   cost, multiplied by principals.
2. **`broadcastToClients`-shaped code is the migration target.** The verified global loops
   (`service.ts:3133`, `:3254`, `:3272`) and the inline recipient rule at `:2460–2464` become
   calls into the D13 primitive. POD-317's routing rule stands: no local reclassification, and
   now also **no local recipient computation**.

**Rationale.** ADR 7 defines what the ports *are*; leaving "Fan-out: Yes, post-funnel" in D1
after the feed becomes scoped would leave the pack contradicting itself at the exact table
POD-387 implements from. The second consequence matters more than it looks: a reader-dependent
wire value would break golden fixtures (POD-360) as a gate, because an entity would no longer
have *one* wire form to fixture.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Leave D1's table as-is and treat scoping as an ADR 2 detail | The table is the binding port contract for POD-387/317; if it still says "broadcast", the gateway will be built to broadcast and scoping becomes a filter bolted onto the send site — the protocol break ADR 2 D2 warns about, arriving through the ADR that was supposed to prevent it. |
| Keep broadcast and filter in the client | Ships rows the principal may not see. Not a transport option; it is the absence of one. |
| Make the projection per-principal (redact fields per reader) | O(principals) work on fan-out (ADR 4 D7.2 violation), N wire forms per entity, and golden fixtures stop being meaningful. Redaction of *command* payloads is ADR 3 D5 and stays there. |

---

### D16 — Inventory extension: the new frames, and how D6's totality obligation absorbs them

**Decision.** D6's predicate is unchanged — *every* `type` key in the four `*_MESSAGE_CLASS`
tables maps to exactly one plane·class, and the mapping must compile. The tables below extend
D6.1/D6.2 for frames that do **not yet exist in code** (verified: `CLIENT_MESSAGE_CLASS`'s live
entries today are exactly `ping`, `presence`, `viewState`). D6's baseline counts at `ca361327`
are therefore **unchanged as a statement about today's tree**; POD-387 re-derives the count at
its own baseline, per D6's existing discipline of counting the code rather than the prose.

**D16.1 — Additions to D6.2 (client → server), when POD-1078 lands them:**

| type | plane·class | Notes |
|---|---|---|
| `presenceSubscribe` | S | Join a room; visibility-gated (**D14**) |
| `presenceUnsubscribe` | S | Explicit leave; disconnect leaves are derived (**D10.6**) |
| `presenceUpdate` | S | Idempotent full-state payload; carries the reserved `visible` field (**D9.5**) |
| `presence` | S | **Existing.** Retained as a compatibility alias through the POD-308 window; deleted at cutover (**D9.5**) |

**D16.2 — Additions to D6.1 (server → client), when POD-1078 lands them:**

| type | plane·class | Notes |
|---|---|---|
| `presenceRoomState` | S | Full occupancy snapshot on join (**D10.5**) |
| `presenceRoomDelta` | S | Member joined / left / updated (**D10.6**) |
| `presenceRoomClosed` | S | Refused, evicted, or visibility lost — one shape for all (**D14.3**, **D11.5**) |

**D16.3 — Multi-user control-plane frames (semantics owned by ADR 2 Amendment 1; ADR 7
classifies the transport only):**

| Frame family | plane·class | Why this class |
|---|---|---|
| **Watermark** — "your cursor advanced to N over a suppressed range" | **C/e** | It is a contiguity-preserving statement about the ordered feed. It must ride the **same ordered pipe** as `metadataDelta` (today `sendMetadataDelta`, the funnel's sole emitter) and must never be stream: a lost watermark is an invisible permanent gap, the exact failure ADR 2 D2 documents. |
| **Rescope / evict** — per-principal visibility change | **C/e** | It changes which durable rows a replica may hold, must be ordered with respect to the feed, and resolves into ADR 2 D7's healing ladder. It is **not** `remove` (ADR 2 D5's soft-delete/tombstone warning; readiness §3.1 item 2 names this as a third member of that family) and **not** the stream-plane `presenceRoomClosed` of D14.4. |

Whether these are distinct WS frames or fields on the existing delta frame is **ADR 2's call**,
not ADR 7's; either shape is C/e, and neither may be S. When they land, D6.1/D6.3 gain rows.

> **ADR 2 has since made that call (POD-359 reconciliation, 2026-07-29).** ADR 2 Amendment 1 D13
> decides that a watermark is **not a new message class**: it is the existing delta frame with a
> covered range and an empty change list, on the funnel's one ordered pipe — which is the shape
> this table's first row required, arriving as a field rather than a frame. So **D6.1 gains no row
> for a watermark**; the existing `metadataDelta` row absorbs it, and its C/e classification is
> unchanged. `rescope` (ADR 2 Amendment 1 D14.4) **is** a new frame and gains a D6.1 row when it
> lands; `evict` (D14.1) is a new value in the change-op enum, not a frame, and gains no row.
> ADR 7 is unmoved by either: the classification above is what binds, and it is satisfied.

**D16.4 — Unchanged by this amendment:** D6.3 (server→daemon), D6.4 (daemon→server), D6.5
(handshake, 6 types), D6.6 (tRPC/HTTP), D6.7 (messaging substrate), D6.8 (workflows), **D7's
handoff message types** (ten as of 2026-08-03), and **D8's browser-open classification**. Presence introduces no
daemon-side frame: a room is a server↔client concept, and the host edge stays governed by D2.

**Rationale.** D6 is the pack's totality instrument, and its value is that it counts code rather
than intentions. Inventorying frames that do not exist yet, without moving the verified count, is
the only way to keep both properties: POD-387 gets a binding classification to implement, and no
reader mistakes a projection for a measurement.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Assert an updated total (e.g. "128 post-auth WS types") | Would be an unverified count of frames that do not exist. D6's discipline — and this pack's — is that counts are re-derived from the defining source at a named baseline. |
| Leave the new frames unclassified until POD-1078 designs them | The classification *is* the design constraint (S, not C/c — D10.4). Deferring it means the implementer decides the plane, which is the reclassification POD-317's rule forbids. |
| Classify watermark as stream because it is "just a cursor hint" | A dropped watermark is an invisible permanent gap and an endless heal loop — ADR 2 D2's documented trap. Contiguity information cannot ride a lossy plane. |
| Reuse `remove` for evict | The replica would render "you can no longer see this" as "this was deleted". ADR 2 D5 already warns that soft-delete and tombstone look identical from a distance and are not; this is the third member of that family. |

---

## 3. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` (or, for O6, are a sequencing consequence this
amendment surfaces). None is decided here.

> **Numbering is the pack's canonical open list — ADR 9 §3** (POD-359 reconciliation, 2026-07-29).
> **O5** (local credentials on a `use`-granted host are not separable from it) raises no ADR 7
> question and is therefore absent below, not closed. This amendment's sequencing item is **O6**
> in the canonical list; it was numbered O5 in the draft before reconciliation.

| # | Open question | What it changes in ADR 7's terms | Who decides | When |
|---|---|---|---|---|
| **O1** | Which existence facts may leak — counts, machine session lists, "worktree in use", lock holders, ref-letter allocation (readiness §3.1.2) | Whether room **occupancy** is visible to all members or only to members a principal may otherwise see; whether "present but hidden" exists as a member state | Feature owner + human, per surface, against ADR 9's visibility classes | Phase 3 policy (POD-290) — **before** Phase 4 ships rooms (POD-1078) |
| **O2** | Cross-boundary graph edge display: hide, or show an opaque reference (readiness §3.1.2) | Whether a room may exist over an entity a principal sees only as an opaque reference — i.e. whether "visible enough to reference" and "visible enough to join" are the same predicate | Human + feature owner | Phase 3 policy (POD-290) |
| **O3** | Is `reparent` a permission-affecting operation, given that subtree scope is dynamic (readiness §3.1.5 case 2) | Only the trigger for D14.4 eviction: a reparent can revoke visibility of an entity a principal is in a room for. The eviction **mechanism** is decided; whether reparent warrants confirmation is not | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in UI at latest |
| **O4** | Per-class owner/grant inheritance on create (readiness §3.1.2, §3.1.3 A4) | Whether a child class (comment, artifact) is room-bearing in its own right or shares its parent's room — i.e. the membership of D10.2's closed room-kind set | ADR 1 amendment (matrix annotation) + per-class feature owner | Declared per class as classes land |
| **O6** | Phase ordering of the shared primitive: the scoped feed (Phase 2, POD-1077) consumes a mechanism whose owner ships in Phase 4 (POD-387/POD-317) — see D13 | Whether POD-387's port interface is pulled forward, or POD-1077 implements against a provisional interface it must not diverge from | POD-359 (pack + phase plan) with POD-387 | Before POD-1077 starts; it is a scheduling decision, not a design one |

---

## 4. Consequences

### Positive

- Presence stops being a single anonymous bit and becomes answerable per person, which fixes a
  *shipped* feature: the notification router can ask "is **this user** watching?" instead of "is
  anybody watching?" (`notify/service.ts:201`).
- The gateway gets **one** routing primitive instead of the current two-plus-one-hand-rolled
  modes, and POD-1077 and POD-1078 have a written rule that they are consumers of it, not
  authors of two.
- Shared terminals — readiness §2's "cheapest visible collaboration win" — get their presence
  substrate without a new plane, a new port, or a durable table.
- Rooms arrive with their authorization story attached (D14), rather than as a fan-out feature
  that a later security review has to retrofit a gate onto.

### Costs

- POD-387/POD-317 grow: a subscription registry with a visibility resolver, a per-plane send
  budget, and coalescing at the send edge, none of which exist today.
- Six new WS frame types enter the wire (D16.1/D16.2), and `presence` carries a compatibility
  alias through the POD-308 window before deletion.
- D11's per-plane budget means `safeSend`'s single-limit model (`wsServer.ts:98`) is no longer
  the whole backpressure story — a second, lower presence budget has to exist and be tested.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| An implementer persists presence "for convenience" (last-seen cache, TTL row, replica cache) | D12 is normative and names the three specific shapes; the compliance checklist makes a durable presence row a review failure, not a design discussion. |
| Presence traffic starves or kills control delivery on the shared socket | D11.4/D11.5: presence gets a budget below the terminate threshold, and the terminal escalation is eviction from the room, never socket termination. Testable: flood a room, assert entity delivery is uninterrupted and the connection survives. |
| Two subscription mechanisms get built anyway, because POD-1077 lands two phases before POD-387 | Named as D13's sequencing hazard and open item **O6**, with the decision owner (POD-359 + POD-387) and the deadline (before POD-1077 starts). |
| The refused-join error is made informative during debugging and never made uniform again | D14.3 states the rule; the compliance checklist asks for a test that the two paths are indistinguishable, which is the only form that survives a helpful refactor. |
| "Rooms" is read as a fourth plane, or as multi-tenancy | D10.1 and §1: three planes stand, and ADR 1 D5 is unaffected — no `instance_id`, no tenant routing key. |
| A new entity kind acquires a room without a visibility class | D10.2 binds the room-kind set to ADR 1's matrix, where readiness §3.1.1's default-closed totality test already applies. |

---

## 5. Compliance checklist

Additive to ADR 7's existing obligations. In compliance when:

- [ ] Presence identity is derived from the connection principal (ADR 3 D7); no presence frame's
      identity field is read from payload, and a spoofed identity is unrepresentable.
- [ ] Room ids are entity references `(kind, id)` with branded ids over a closed kind set; no
      free-string room name exists anywhere in the gateway.
- [ ] A join is refused unless the principal may see the entity (and, for a session, may `see`
      its machine); refusal and nonexistence produce the identical frame.
- [ ] A successful join delivers a full occupancy snapshot in one frame; an idle room is
      distinguishable from an empty one.
- [ ] Leaves are derived from connection lifecycle (explicit, close, and heartbeat reap all
      produce the same notification); no ghost occupant survives a killed tab.
- [ ] No presence frame enters the write funnel or appends an oplog row; `seq` is unmoved by
      presence traffic under load.
- [ ] Presence has a send budget strictly below `SEND_BUFFER_LIMIT_BYTES`, and the escalation is
      coalesce → drop → `presenceRoomClosed`; a presence flood never terminates a connection and
      never delays control · entity delivery beyond its own budget.
- [ ] No durable presence exists: no table, no oplog row, no entity field, no replica row, no
      tombstone. Offline renders blank.
- [ ] One subscription registry serves both the scoped feed and presence rooms; POD-317 contains
      no second routing table and no per-send-site recipient computation.
- [ ] Watermark and rescope/evict are classified C/e and ride the ordered pipe; neither is a
      stream frame, and `remove` is not reused for evict.
- [ ] D6's totality mapping still compiles with the new frames, and the counts are re-derived
      from `message-class.ts` at the implementing baseline rather than copied from prose.
- [ ] No `instance_id` (or equivalent tenant discriminator) appears in a room key or presence
      frame.

---

## 6. Self-verification record

Checked on integration tip `2ddfec21`, 2026-07-29.

| Claim | Where verified |
|---|---|
| Presence is `{ type: 'presence', visible: boolean }`, page-visibility only | `packages/protocol/src/messages/terminal.ts:206–208` (declaration + comment) |
| Presence is classified `live` today | `packages/protocol/src/messages/message-class.ts:109`; ADR 7 D6.2 lists `presence` as **S** |
| Presence has exactly one server-side consumer, an anonymous OR | `apps/server/src/modules/sessions/service.ts:2585` (sole assignment `client.visible = msg.visible`); `apps/server/src/modules/notify/service.ts:201` `[...this.deps.clients()].some((c) => c.visible)` |
| Presence is never fanned out to other clients | No `presence` case in any broadcast path; grep for `'presence'` in `apps/server/src` returns only the service handler and tests (`relay.test.ts`) |
| Entity fan-out is global today | `apps/server/src/modules/sessions/service.ts:3272` (`sendMetadataDelta`), `:3254` (`fanOutSnapshot`), `:3133` (`broadcastToClients`, "Raw fan-out to every connected client") — each a `for (const c of this.clients.values())` loop |
| PTY fan-out is the per-session attach set | `apps/server/src/modules/sessions/session.ts:885–886` (`private broadcast()` over `this.clients`), populated at `:338–339` (`attachClient`) |
| A third routing rule is already hand-rolled inline | `apps/server/src/modules/sessions/service.ts:2460–2464` — browser-open recipients `focused` → `viewVisible` → all clients |
| A per-entity subscription set exists but is bulk-plane | `service.ts:2576–2582` (`client.transcriptSubs`); ADR 7 D6.2 classifies `transcriptSubscribe` as **B** |
| `attach` is C/c while `attached` is S (asymmetric-pair precedent) | `packages/protocol/src/messages/message-class.ts:102` (`attach: 'command'`), `:53` (`attached: 'live'`) |
| Backpressure is one shared 16MB budget per socket, and exceeding it **terminates** | `apps/server/src/wsServer.ts:98` (`SEND_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024`), `:129` (`ws.terminate()`), comment at `:95–97` |
| Heartbeat sweeps are 15s client / 10s daemon | `apps/server/src/wsServer.ts:81` (`CLIENT_HEARTBEAT_INTERVAL_MS = 15_000`), `:89` (`DAEMON_HEARTBEAT_INTERVAL_MS = 10_000`) |
| `clientCount` / `controllerId` already exist as session-control facts | `apps/server/src/modules/sessions/session.ts:840` (`clientCount: this.clients.size`), `:466–468` (controller reassignment + `controllerChanged` broadcast) |
| No room / subscription / occupancy vocabulary exists today | `packages/protocol/src/messages/message-class.ts:108–110` — the only client live types are `ping`, `presence`, `viewState` |
| ADR 7's stream plane is "best-effort, blank offline, raw fan-out OK" | `docs/adr/0007-plane-inventory.md` D1 port-semantics table |
| ADR 2 D2 ratifies an unscoped feed and requires watermarks if scoping ever arrives | `docs/adr/0002-sync-protocol.md` D2, lines 208–240 ("Adding a filter without a watermark is a protocol break, not an optimization") |
| ADR 2 D5 warns soft-delete and tombstone look identical from a distance | `docs/adr/0002-sync-protocol.md` D5; readiness §3.1 item 2 names evict as a third member of that family |
| ADR 2 D9 demotes a slow replica to resync (the analogue D11.5 mirrors) | `docs/adr/0002-sync-protocol.md` D9 |
| ADR 3 D7 takes the principal from the authenticated transport only | `docs/adr/0003-command-security.md` D7 |
| ADR 1 D5 makes `InstanceId` a deployment partition, not a row discriminator | `docs/adr/0001-authority-ownership.md` D5 |
| ADR 4 D7.2 forbids O(entities) work on write/publish/fan-out | `docs/adr/0004-representation-policy.md` D7.2 |
| ADR 4 Amendment 1 D10.1 forbids reader-dependent R4 projections | `docs/adr/0004-representation-policy-amendment-1.md` §2 D10 |
| Human decision: presence needs identity, rooms, cursor-rate fan-out, no durable rows | `docs/multi-user-readiness.md` §3.4 |
| Human decision: the room primitive is the same one scoped feeds need | `docs/multi-user-readiness.md` §3.4 (closing paragraph) and §3.1 |
| Consistent-error rule (invisible must fail as nonexistent) is already decided | `docs/multi-user-readiness.md` §3.1.5 |
| Machine access splits `see` / `use` / `manage` | `docs/multi-user-readiness.md` §3.1.4 M1 |
| Default-closed classification rule | `docs/multi-user-readiness.md` §3.1.1 rule 1 |
| Existence leaks and cross-boundary edges are deliberately open | `docs/multi-user-readiness.md` §3.1.2 |
| Phase plan puts the scoped feed in Phase 2 and gateway rooms in Phase 4 | `docs/multi-user-readiness.md` §5 sequence table |
| ADR 7 D7's handoff family is ten typed messages as of 2026-08-03 (unchanged here) | `docs/adr/0007-plane-inventory.md` D7; `packages/protocol/src/messages/handoff.ts` literals |

---

## 7. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-1074 (this amendment) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented | Phase 4 (POD-291): POD-387 port interface, POD-317 gateway, POD-1078 rooms; the shared primitive is consumed earlier by POD-1077 (Phase 2) — see D13 and open item **O6** |
