# ADR 5 — Peer topology

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-751 (leaf of POD-359 item 5)
- **Spec:** [spec:SP-0371] Hub/node federation: deferred (parent [spec:SP-3fe2])
- **Consumers:** POD-317 (gateway: common framing + role auth), POD-309 (retire upstream; prove seam), POD-327 (daemon-side gateway contract mirror), POD-308 (version negotiation permanence)
- **Deferred product work:** POD-353 (full hub/node federation design + product justification)
- **Related ADRs (forward refs only):** ADR 1 (ownership), ADR 2 (sync protocol), ADR 3 (command security), ADR 4 (representation), ADR 6 (replica storage), ADR 7 (plane inventory), ADR 8 (package topology)

---

## Context

The v3 rewrite targets **one sync kernel** (commit / pull / push / stream + outbox +
replica apply) spoken at every hop that needs ordered revisions. Today that hop is
almost entirely **local topology**: console clients and N machine daemons dial **one
server**, which is the sole home authority for the deployment.

A second hop shape — **node ↔ hub federation** — was half-built and then **deferred**
([spec:SP-0371], user decision 2026-07-13, confirmed same day): finished federation
does not justify the rewrite cost, but the rewrite **must not** make choices that
prevent a future hub.

Verified on the integrated tree at this writing:

| Fact | Evidence |
|------|----------|
| Two live WS peer entrypaths | `apps/server/src/wsServer.ts` upgrades only `pathname === '/client'` and `pathname === '/daemon'` |
| Daemon pre-auth handshake | `packages/protocol/src/messages/daemon-handshake.ts`: request union members `pair` \| `hello` (2); reply union members `paired` \| `pairRejected` \| `helloOk` \| `helloRejected` (4) |
| Console hello capabilities | `packages/protocol/src/messages/terminal.ts`: `HelloMessage.caps?: string[]`; known token `CAP_METADATA_DELTA = 'metadataDelta'` |
| Wire version | `packages/protocol/src/version.ts`: `WIRE_VERSION = 1`, `MIN_SUPPORTED_VERSION = 1`, `versionSupport` / `isProtocolCompatible` |
| Local machine auth secret | `packages/runtime/src/local-machine.ts`: `LOCAL_MACHINE_ID = 'local'`, `readOrCreateDaemonSecret` |
| Remote join payload | `packages/runtime/src/join.ts`: `JoinPayload` fields `v`, `serverUrl`, `pairCode`, optional `name` |
| Pairing codes | `apps/server/src/hub/pairing.ts`: `PairingManager` — single-use, default TTL 600_000 ms, in-memory |
| Mutation origin fields (seam seed) | `packages/protocol/src/messages/mutations.ts`: `MutationEnvelope.origin.{actor, machineId?}`, `mutationId`, `sentAt` (informational; not conflict clock) |
| Half-built federation to retire | `packages/sync/src/upstream.ts` (`UpstreamSync`, 501 lines) + `packages/sync/src/upstream-forwarder.ts` (`UpstreamForwarder`, 324 lines); cookie name shared via `packages/protocol/src/session-cookie.ts` `SESSION_COOKIE = 'podium_session'` |
| Instance isolation | `packages/runtime/src/instance.ts` + [spec:SP-15aa]: `INSTANCE_ID_PATTERN`, per-instance state/ports/units |
| Ledger adopted decisions | `docs/rearchitecture-v3.md` §1: “Two processes, one peer protocol”; “HUB DEFERRED” per [spec:SP-0371] |

The 2026-07-10 first-principles proposal (plan source named in `docs/rearchitecture-v3.md`)
and the older `docs/offline-sync-architecture.md` §3 “hub and nodes” sketch describe
aspirational multi-authority deployment. Where they conflict with this ADR or
[spec:SP-0371], **this ADR wins for rewrite scope**.

This ADR is the binding peer-topology decision for Phase 1+ (gateway, kernel ports,
retirement). POD-359 owns the pack index and human sign-off.

---

## Drift-refresh clauses (POD-359 comments) — addressed for ADR 5

Binding drift comments on POD-359 are absorbed **where they touch peer topology**.
Clauses owned entirely by other ADRs are acknowledged and **not re-decided here**.

| Drift clause | Owner | This ADR’s action |
|--------------|-------|-------------------|
| (1) drizzle-kit is decided fact (SP-4428); wire/replica protocol version ≠ server drizzle journal | ADR 2 / ADR 6 | **Out of scope for peer topology.** Peer wire version is `WIRE_VERSION` in `@podium/protocol` only; never conflated with DB migration journals. |
| (2) Instance identity (SP-15aa, `packages/runtime/src/instance.ts`): brand vs runtime; machine identity + pairing per-instance | ADR 1 / ADR 8 for brand placement; **this ADR for mesh boundary** | **DECISION D6:** every peer mesh (pairing, daemon secret, client sessions, machine rows) is **per `InstanceId`**. Two concurrent instances are two separate H1 meshes, not federation. |
| (3) Plane inventory growth (handoff, messaging, workflows, browser-open, sessionResumeRefAck); host↔server traffic ≠ agent command relay | ADR 7 | **DECISION D3** routes post-auth frames by ADR 7 planes. **DECISION D7** restates the twice-re-derived separation: peer auth / host↔server control families must not be collapsed into the agent command relay (SP-b85a / SP-fccf / SP-a43e). Classification detail stays ADR 7. |
| Build orchestration: tsgo + turbo landed; source-conditions vs project-references | ADR 8 | **Out of scope.** No package/build decision in this file. |

---

## Decision summary

1. **Two horizons (H1 / H2)** — always name which one a claim is about.
2. **H1 local peer roles** — `authority` | `console` | `machine` only.
3. **Common framing + role-specific auth modules** — not a conditional god machine.
4. **Reserved inert node-peer capability surface** for future H2.
5. **Preserved federation seam (S1–S5)** without shipping federated product behavior.
6. **Per-instance mesh boundary** (SP-15aa).
7. **Host↔server control paths stay separate from agent command relay.**

---

## Decisions

### D1 — Two horizons: local mesh vs federation

**Decision.** Peer-topology claims use exactly two horizons:

| Horizon | Name | Scope |
|---------|------|--------|
| **H1** | *Local peer mesh* | One **server** (authority) + **console** clients (browser PWA / desktop webview / mobile Expo) + **N paired machine daemons**. Sole durable arbitrator = that server. **In scope for POD-279 / the rewrite.** |
| **H2** | *Federation* | A second authority instantiation (**node**) syncing with a **hub**, plus product behaviors: node↔hub replication, upstream projection, authority transfer, loop prevention, hub-disappearance, federated soak. **Out of scope for POD-279.** Parked in POD-353. Half-built upstream code is **retired** (POD-309), not completed. |

**Rule.** Design prose, acceptance criteria, and tests that only exercise H1 must not be
worded as if H2 exists. Seam checklist items (H2-preserving structure) must not be
mistaken for shipped federation features.

**Rationale.** [spec:SP-0371] freezes product scope while requiring structural
non-prevention. Conflating the two horizons is how half-built hub code and local fleet
features got tangled.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Ship finished node↔hub in the rewrite | Explicit user deferral; value does not justify work ([spec:SP-0371]). |
| Delete all multi-authority vocabulary now | Would force a flag day later; violates “must not prevent a future hub.” |
| Treat remote daemons as “proto-nodes” | Daemons are executors, not authorities; muddies ADR 1 ownership. |

---

### D2 — H1 local peer roles

**Decision.** Every process on the wire has exactly one **peer role**. Roles partition
auth strategy and duty; they are not optional feature flags.

```text
                    ┌──────────────────────────────────────┐
                    │  SERVER  (role: authority)           │
                    │  SQLite truth · oplog · commands     │
                    │  fleet pairing · client sessions     │
                    └───────────────┬──────────────────────┘
                           WS/HTTP  │  (one public surface)
              ┌────────────────────┼────────────────────┐
              │                    │                    │
     ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
     │ CLIENT          │  │ DAEMON (local)  │  │ DAEMON (remote) │
     │ role: console   │  │ role: machine   │  │ role: machine   │
     │ /client         │  │ /daemon         │  │ /daemon         │
     └─────────────────┘  └─────────────────┘  └─────────────────┘
```

| Peer role | Processes (H1) | Duties | May arbitrate entity truth? |
|-----------|----------------|--------|------------------------------|
| **`authority`** | `podium-server` (and server half of all-in-one) | Home authority for durable entities (ADR 1); applies commands; appends oplog; pairs machines; issues client sessions | **Yes — sole arbitrator in H1** |
| **`console`** | Web PWA, Tauri/desktop webview, Expo mobile | Human UI: live streams, tRPC/command surface, thin or replica store (ADR 6); optimistic overlay only | **No** (replica never arbitrates — ADR 1 / ADR 2) |
| **`machine`** | `podium-daemon` (local or remote) | Host edge: PTY, harness adapters, inventory, file/workspace ops, agent relay loopback; dials the server | **No** for fleet metadata. Observes host facts the server records |

**Reserved names (no H1 product path):**

| Role | Future meaning (H2 / POD-353) | H1 status |
|------|-------------------------------|-----------|
| **`node`** | Full local stack that is authority for some entities and replica/client of a hub for others | Reserved; no acceptor |
| **`hub`** | Rendezvous authority for multiple nodes | Reserved. In H1 the single server already rendezvouses clients+daemons without being a multi-node hub |

**H1 deployment shapes (not federation):** all-in-one; server + browser clients + N remote
daemons; desktop server + phone PWA + remote daemon; multiple **named instances** on one
host (isolation per D6, not node↔hub).

**Rationale.** Matches shipped endpoints and auth paths; matches
`docs/rearchitecture-v3.md` (“two processes, one peer protocol”) and [spec:SP-34d7]
(server owns message substrate; daemons are executors).

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Collapse local daemon into “just another client” | Different auth, message unions (`ControlMessage` / `DaemonMessage` vs `ClientMessage` / `ServerMessage`), and duties (PTY ownership). |
| Call the server “hub” in H1 product language | Collides with deferred H2 hub; use **server** / **authority** for H1. |
| Make desktop a mandatory always-on node | Deferred with federation; H1 desktop may host the sole server without upstream. |

---

### D3 — Common peer framing

**Decision.** All peer roles share one framing contract at the transport edge
(gateway implementation: POD-317; daemon dialer mirror: POD-327):

1. **Wire version** — permanent negotiation via `WIRE_VERSION` /
   `MIN_SUPPORTED_VERSION` / `versionSupport` in `@podium/protocol`. Incompatible peers
   fail closed. The *mechanism* is permanent; any N/N−1 legacy adapter is a separately
   expiring deletion-audit item (POD-308), not a second protocol.
2. **Hello / handshake envelope** — establishes peer identity and advertised
   **capabilities**. Daemon pre-auth frames (`pair` / `hello` and replies) ride the same
   codec but stay **outside** post-auth control/daemon unions
   (`packages/protocol/src/messages/codec.ts` documents this).
3. **Capability negotiation** — additive open string tokens today (`caps?: string[]` on
   console `HelloMessage`; known example `metadataDelta`). Unknown caps are ignored;
   absence means legacy defaults. Extension point for D4.
4. **Shared codec** — one encode/parse surface for framed JSON; role does not fork
   serialization formats.
5. **Plane routing after auth** — frames route by the ADR 7 inventory (control / stream /
   bulk; command = directed request/reply **inside** control). Gateway owns ports and
   per-plane backpressure; feature modules stay vertical by feature.
6. **One peer-identity owner** — “gateway” means WS (`/client`, `/daemon`) **plus** HTTP
   surfaces (tRPC, bulk reads, auth routes) under one auth/peer-identity owner — not
   necessarily one socket.

**Forbidden:** a single conditional “god” state machine that mixes auth, identity, and
feature dispatch with `if (isDaemon) … else if (isClient) … else if (isNode)` in one
module. Auth strategies are **modules selected by role** after common framing succeeds
(D5).

**Rationale.** `docs/rearchitecture-v3.md` adopted decision: “Two processes, one peer
protocol — server and daemon speak the same peer framing; role-specific auth strategy
modules, not a conditional god machine (ADR 5, POD-317, POD-327…).”

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Separate incompatible protocols per role | Doubles versioning and conformance cost; fights “one sync kernel.” |
| One god state machine in `wsServer` forever | Blocks extraction (POD-317 AC); couples feature logic to transport. |
| Caps as a closed enum only | Breaks forward-compat; open tokens + ignore-unknown is the existing pattern (`HelloMessage.caps`). |

---

### D4 — Capability fields reserved for a future node peer

**Decision.** Hello / capability negotiation **reserves an inert extension surface** so a
future node peer can declare itself without a flag day.

1. **Open capability tokens remain the H1 wire form** (string list, additive).
2. **Reserved federation-oriented tokens / fields** (document as reserved; H1 peers
   **must not emit**; H1 acceptors **must ignore** if seen — no auth elevation, no
   routing to unimplemented modules, no product UI):

   | Reserved surface | Intent when H2 lands | H1 behavior |
   |------------------|----------------------|-------------|
   | `peerRole:node` (or structured `peerRole` when hello is versioned) | Announce node role | Ignore; never emit |
   | `feed.<id>` / feed-epoch advertisement | Bind connection to an authority feed (ADR 2) | Ignore; never emit |
   | `upstream.sync` / `upstream.push` | Node wants hub pull/push | Ignore; never emit |
   | Entity provenance flags such as `viaHub` / `upstreamStale` / `pendingSync` | Mirrored-row provenance | Data-only residue during POD-309 retirement; no new H1 product behavior; ADR 4 places provenance on envelope, not entity schemas |

3. **Optional structured peer hello fields** (when the hello schema is versioned):

   ```text
   peerRole?: "console" | "machine" | "node"   // absent => infer from endpoint (H1)
   caps: string[]
   feedId?: string                             // reserved; absent in H1
   ```

   H1 may keep endpoint-implied role (`/client` → console, `/daemon` → machine). H2
   **must not** require H1 clients to set `peerRole`.

4. **Conformance:** POD-309 (or gateway tests under POD-317) inject reserved caps and
   assert the authority neither crashes nor grants rights.

**Rationale.** Seam requirement from [spec:SP-0371] and POD-309: “peer capability
negotiation with reserved fields for a node peer.”

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Implement node acceptor “just in case” | In-scope creep into H2 product. |
| Omit reserved surface until hub returns | Forces a coordinated flag day across peers. |
| Reuse machine pair tokens for node auth | Different trust and authority boundaries; would collapse roles. |

---

### D5 — Role-specific authentication strategies (H1)

**Decision.** After common framing, authenticate with a **role-specific strategy module**.
Principal is stamped **only** from successful transport auth (ADR 3) — never from
message-body claims.

| Role | Transport entry | Auth material | Principal after success | Notes |
|------|-----------------|---------------|-------------------------|-------|
| **`console`** | HTTP session + `/client` WS (+ cookie-bearing tRPC) | Optional login password → session cookie (`SESSION_COOKIE`); open only when no password configured | Human/operator client session | Origin / CSWSH guards (`isAllowedWsOrigin` in `wsServer.ts`); password store in `@podium/runtime` auth-store |
| **`machine` (local)** | `/daemon` WS | Shared host secret from `readOrCreateDaemonSecret` presented as `hello` token for `machineId = local` | Machine principal `local` | Same hello path as remote; not a pairing ceremony. Server adopts local rows independent of daemon liveness |
| **`machine` (remote)** | `/daemon` WS | One-shot **pair code** (join token embeds `serverUrl` + `pairCode`) → long-lived **machine token**; reconnects use `hello` + token | Paired `machineId` | Fleet admin **in scope**. Codes single-use, short TTL, memory-held (`PairingManager`) |
| **`node` (reserved)** | Future server↔server endpoint(s) | Reserved credential class; **not implemented** | Future node principal + feed identity | Schema/capability only; no acceptor in H1 |

**Invariants.**

- Daemon pairing and fleet admin **stay** (H1). They are not proto-federation.
- Local secret file is per instance state dir (D6); deleting it under a running split
  daemon causes auth rejection until restart — availability blip, not data loss
  (`local-machine.ts` operational note).

**Rationale.** Codifies existing split (`wsServer` client cookie gate vs daemon
pair/hello) so POD-317 can extract modules without inventing policy.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| One shared bearer token for clients and daemons | Different blast radius and lifecycle (human session vs machine credential). |
| Pairing required for local daemon | Breaks split systemd server/daemon on one host; secret file is the intentional seam. |
| Implement hub-minted node tokens now | H2; cookie sharing comment in `session-cookie.ts` is historical for retired upstream. |

---

### D6 — Instance boundary is a hard mesh boundary

**Decision.** Peer identity, pairing, daemon secrets, client sessions, machine rows, and
endpoints are **per Podium `InstanceId`** ([spec:SP-15aa],
`packages/runtime/src/instance.ts`). A second concurrent instance on one host is a
**separate H1 mesh**, not H2 federation. Crossing instances requires explicit operator
action (e.g. `PODIUM_NO_RELAY=1` with a selected instance command) — never ambient
sharing.

**What this ADR does *not* decide:** whether `InstanceId` is a branded model type vs
runtime-only (ADR 1 ownership vocabulary + ADR 8 package placement / POD-645). Topology
only requires a hard isolation boundary at whatever type carries the id.

**Rationale.** Drift refresh (2) on POD-359: “machine identity + pairing are
per-instance.” Multi-instance is already shipped isolation, not multi-authority sync.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Treat multi-instance as federation practice | No shared feed, no upstream projection, no hub — different problem. |
| Shared pairing pool across instances | Violates SP-15aa non-collision and non-cross-mutation guarantees. |

---

### D7 — Host↔server control traffic ≠ agent command relay

**Decision.** New host↔server control families (browser-open, session resume-ref ack,
approvals, inventory, harness exec, …) and peer **auth** paths stay **separate** from
the agent command relay substrate (SP-b85a). Topology forbids smuggling peer elevation
or fleet control through the agent relay, and forbids requiring agent-relay credentials
as a substitute for peer role auth (D5).

**Rationale.** POD-359 drift refresh 2: the separation has been re-derived independently
(SP-fccf, SP-a43e, SP-b85a). ADR 7 owns full classification; this ADR binds the
topology-level non-collapse rule so gateway extraction cannot “simplify” them into one
mux with shared auth.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| One multiplexed channel with role inferred from payload | TOCTOU and confused-deputy risk; contradicts apply-time principal from transport (ADR 3). |

---

### D8 — Preserved federation seam (structure only)

**Decision.** The rewrite **preserves** the following structure so a future hub is
possible. It does **not** deliver hub product behavior.

| # | Seam element | Required property | Explicitly not required in H1 |
|---|--------------|-------------------|-------------------------------|
| **S1** | Authority / feed identity | Every durable change and command path can name which authority/feed produced it (fields per ADR 2; single feed in H1) | Multiple live feeds; feed routing UI |
| **S2** | Origin / causation / mutation identity | Mutation envelopes and oplog-adjacent records carry origin (`actor`, optional `machineId`), `mutationId`, and causation hooks as ADR 2 defines | Cross-authority causation graphs; loop-prevention algorithms |
| **S3** | Reserved node-peer capabilities | D4 surface present; ignored | Node acceptor; hub pairing UX |
| **S4** | Kernel transport/storage ports | Sync kernel depends on **ports**, not “same machine,” “one SQLite file path,” or “must be tRPC.” In-process and WS adapters both valid | A second production Authority process |
| **S5** | Parameterized conformance suite | Cross-hop tests written against *roles + ports* so a future node–hub binding can run the same suite | Federated rehearsal/soak; hub-disappearance drills |

**Retirement (not seam):** delete `UpstreamSync` / `UpstreamForwarder`, hub-mirror apply
paths, and active use of upstream outbox tables (POD-309). Schema may be archived with
operator-visible reporting of pending rows; silent discard of poison/pending work is
forbidden. **Daemon pairing is unaffected.**

**Seam proof (test-only, H1):** instantiate a **second in-memory Authority** against
kernel ports and run the parameterized suite — no product surface, config flag, or fleet
UX. That proof is the rewrite’s commitment to future federation; it is not a hub.

**Rationale.** [spec:SP-0371] in-scope seam list; POD-309 acceptance; adversarial-review
disposition on POD-279.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Keep UpstreamSync “dark” until hub returns | Maintenance and security surface without product; SP-0371 says retire. |
| Prove seam only with prose | POD-309 requires test-visible second Authority binding. |
| Bake tRPC or single-file SQLite into kernel ports | Blocks a second instantiation and future adapters. |

---

## H1 vs H2 matrix (normative distinction)

| Concern | H1 local mesh (rewrite delivers) | H2 federation (POD-353 only) |
|---------|----------------------------------|------------------------------|
| How many authorities? | **One** (the server) | Multiple (node + hub, …) |
| Who dials whom? | Clients and daemons dial the server | Nodes dial hub; daemons dial *their* authority |
| Offline agents | Unreachable **daemon** → queue/disable; server still authority | Unreachable **hub** → node keeps local authority work; remote fleet stale |
| Conflict arbitration | Server only (ADR 1) | Per-entity home authority + transfer (undesigned here) |
| Loop prevention | N/A | Required |
| Hub disappearance | N/A | Product behavior required |
| Upstream projection / viaHub UX | Retired / absent as product | Product feature |
| Auth | Cookie (console) + pair/token or local secret (machine) | + node credentials |
| Cap `peerRole:node` | Reserved, inert | Implemented |
| Soak | Local fleet / remote-daemon soaks | Federated soak |

**Messaging ([spec:SP-34d7]):** durable agent messages are owned by the **server**;
daemons execute when the target session lives on them. That is an H1 authority rule,
not a hub.

---

## Consequences

### Positive

- POD-317 can extract gateway framing vs auth modules vs plane-routed feature ports
  without inventing policy.
- ADR 1 / ADR 2 may assume a single home authority for H1 without apologizing for a hub
  that is not shipping.
- POD-353 starts from S1–S5 and a green dual-Authority proof instead of reverse-engineering
  retired upstream modules.
- Multi-instance (SP-15aa) composes as multiple H1 meshes.

### Negative / costs

- Operators expecting finished node↔hub offline in the rewrite wait on POD-353;
  `docs/offline-sync-architecture.md` hub chapter remains aspirational until then.
- Reserved fields and port abstractions carry a small ongoing design tax.
- Dual vocabulary risk (“hub” in older docs vs H1 **server**) — mitigated by H1/H2
  tables and [spec:SP-0371].

### Implementation binding

| Work item | Binding |
|-----------|---------|
| POD-317 gateway | D3 framing + D5 auth modules + D4 inert reserved fields; no god machine |
| POD-327 daemon | Mirrors gateway contract from the dialer side |
| POD-309 | Retire upstream modules; prove S1–S5; multi-machine **daemon** e2e stays green |
| POD-308 | Version negotiation permanent; legacy adapter expiry orthogonal to topology |
| Phase issues generally | Phrase ACs in H1 terms; link POD-353 for federated thoughts |

---

## Compliance checklist (later PRs)

- [ ] New peer code path names its role (`console` \| `machine` \| reserved `node`) and does not invent a fourth live role without amending this ADR.
- [ ] Auth strategy is a module (or pure functions grouped as one), not nested conditionals beside feature handlers.
- [ ] Hello/caps parsing tolerates unknown reserved tokens; H1 never **requires** node caps.
- [ ] Sync kernel ports remain free of same-machine / single-file / tRPC-only assumptions.
- [ ] No new product dependency on `UpstreamSync` / `UpstreamForwarder` / hub-mirror apply.
- [ ] Tests that only cover clients+daemons+one server are described as **local topology**, not “federation.”
- [ ] Any true multi-authority behavior is either test-only seam proof or tracked under POD-353.
- [ ] Peer/host control paths are not collapsed into the agent command relay.

---

## References

- [spec:SP-0371] Hub/node federation: deferred  
- [spec:SP-3fe2] Architecture: strangler rebuild  
- [spec:SP-15aa] Multi-instance runtime isolation  
- [spec:SP-34d7] Agent messaging (server-owned substrate; daemons as executors)  
- [spec:SP-b85a] Agent session relay naming/inheritance  
- [spec:SP-fccf] Codex session identity (host↔server control ≠ agent relay)  
- [spec:SP-a43e] Remote browser-open forwarding  
- `docs/rearchitecture-v3.md` — adopted decisions (peer protocol; hub deferred)  
- `docs/offline-sync-architecture.md` — historical hub/node sketch (aspirational H2)  
- `docs/spec/node-hub-sync.md`, `docs/spec/node-hub-issues.md` — prior P7 designs; implementation retired, intent informs POD-353  
- `packages/protocol` — wire version, daemon handshake, console hello `caps`, mutation origin envelope, session cookie name  
- `packages/runtime` — join payload, local machine id, daemon secret, instance identity  
- `packages/sync` — `UpstreamSync` / `UpstreamForwarder` (retirement targets)  
- `apps/server/src/hub/pairing.ts`, `apps/server/src/wsServer.ts`  
- POD-359 (ADR pack), POD-751 (this leaf), POD-353 (deferred federation), POD-309 (retire + seam), POD-317 (gateway), POD-327 (daemon mirror)
